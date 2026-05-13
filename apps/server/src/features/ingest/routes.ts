import { Elysia, t } from "elysia";
import { and, db, eq, isNotNull } from "@skyclad-bun/db";
import { ingestionJobs, paperDocs, papers } from "@skyclad-bun/db/schema/index";
import { $ } from "bun";
import { readdirSync } from "node:fs";
import path from "node:path";

import { parseArxivCandidates } from "./arxiv";
import {
  ensureIngestTools,
  findMainTexFile,
  splitMarkdown,
  writeSectionFiles,
  embed,
  buildSectionEmbeddingText,
  normalizeExpandedTexForPandoc,
} from "./source-ingest";

export const ingestRoutes = new Elysia({ prefix: "/api/ingest" })
  .post(
    "/resolve_ingest_target",
    async ({ body, set }) => {
      const searchQuery = `ti:"${body.paperName}"`;
      const apiUrl = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(searchQuery)}&start=0&max_results=3&sortBy=relevance&sortOrder=descending`;
      const response = await fetch(apiUrl);

      set.status = response.status;

      const rawResponse = await response.text();
      const candidates = parseArxivCandidates(rawResponse);

      return {
        ok: response.ok,
        result: candidates,
      };
    },
    {
      body: t.Object({
        paperName: t.String(),
      }),
    },
  )
  .post(
    "/ingest_paper_source",
    async ({ body, set }) => {
      const arxivId = body.arxivId.replace(/v\d+$/i, "");

      // fail before touching db or workspace when a required local tool is missing
      const missing = await ensureIngestTools();
      if (missing.length > 0) {
        set.status = 500;
        return {
          ok: false,
          result: `missing_required_tools: ${missing.join(", ")}. Install the missing command(s) and ensure they are available on PATH.`,
          missing,
        };
      }

      // repeated calls should return immediately once this exact paper finished ingesting
      const existingPaper = await db
        .select({ id: papers.id })
        .from(papers)
        .where(and(eq(papers.id, body.paperId), isNotNull(papers.ingestedAt)))
        .limit(1);

      if (existingPaper.length > 0) {
        return {
          paperId: body.paperId,
          arxivId,
          status: "already_ingested" as const,
          message: "Paper source is already ingested.",
        };
      }

      const startedAt = new Date();
      // record the request-time ingestion state before doing external work
      await db
        .insert(ingestionJobs)
        .values({
          id: body.paperId,
          status: "ingesting",
          error: null,
          startedAt,
          completedAt: null,
        })
        .onConflictDoUpdate({
          target: ingestionJobs.id,
          set: {
            status: "ingesting",
            error: null,
            startedAt,
            completedAt: null,
          },
        });

      const workspace = `.ingest/extract/${arxivId.replaceAll("/", "_")}`;
      const rawArchiveDir = path.resolve(import.meta.dir, "../../..", ".ingest/raw/zip");
      const sourceArchive = `${workspace}/source.tar.gz`;
      const sourceDir = `${workspace}/src`;
      const expandedTex = `${workspace}/expanded.tex`;
      const paperMarkdown = `${workspace}/paper.md`;
      const sectionsDir = `${workspace}/sections`;

      try {
        console.log(`[ingest] ${body.paperId} start`);
        const sourceArchiveNamePrefix = `arXiv-${arxivId}v`;
        // look for pre downloaded source archives for this arxiv id
        const sourceArchiveCandidates = (() => {
          try {
            return readdirSync(rawArchiveDir)
              .filter(
                (name) => name.startsWith(sourceArchiveNamePrefix) && name.endsWith(".tar.gz"),
              )
              .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          } catch {
            return [];
          }
        })();
        const selectedSourceArchiveName =
          sourceArchiveCandidates[sourceArchiveCandidates.length - 1];

        await $`mkdir -p ${workspace} ${sourceDir}`;
        if (selectedSourceArchiveName) {
          console.log(
            `[ingest] ${body.paperId} using local source archive: ${selectedSourceArchiveName}`,
          );
          // use the newest local archive version when available
          await $`cp ${path.join(rawArchiveDir, selectedSourceArchiveName)} ${sourceArchive}`;
        } else {
          throw new Error(
            `missing_local_source_archive: expected arXiv-${arxivId}v*.tar.gz in ${rawArchiveDir}`,
          );
        }

        await $`tar -xzf ${sourceArchive} -C ${sourceDir}`;
        console.log(`[ingest] ${body.paperId} extracted source archive`);

        // flatten included tex files so pandoc sees one complete latex document
        const mainTex = await findMainTexFile(sourceDir);
        console.log(`[ingest] ${body.paperId} main tex: ${mainTex}`);
        const latexpandBin = Bun.which("latexpand");
        if (!latexpandBin) throw new Error("missing_required_tool_at_runtime: latexpand");
        const latexpandProc = Bun.spawn([latexpandBin, path.basename(mainTex)], {
          cwd: path.dirname(mainTex),
          stdout: "pipe",
          stderr: "pipe",
        });
        const latexpandStderr = await new Response(latexpandProc.stderr).text();
        const latexpandStdout = await new Response(latexpandProc.stdout).text();
        const latexpandExitCode = await latexpandProc.exited;
        if (latexpandExitCode !== 0) {
          throw new Error(
            `latexpand failed with exit code ${latexpandExitCode}: ${latexpandStderr.trim()}`,
          );
        }
        const normalizedExpandedTex = normalizeExpandedTexForPandoc(latexpandStdout);
        await Bun.write(expandedTex, normalizedExpandedTex);
        console.log(`[ingest] ${body.paperId} wrote expanded tex`);

        // convert latex into markdown while preserving math but dropping raw html passthrough
        const pandocBin = Bun.which("pandoc");
        if (!pandocBin) throw new Error("missing_required_tool_at_runtime: pandoc");
        const pandocProc = Bun.spawn(
          [
            pandocBin,
            // cap pandoc heap to prevent latex inputs from exhausting memory
            "+RTS",
            "-M1024m",
            "-RTS",
            expandedTex,
            "-f",
            "latex-latex_macros",
            "-t",
            "markdown-raw_html-raw_attribute+tex_math_dollars",
            "--wrap=none",
            "-o",
            paperMarkdown,
          ],
          { stderr: "pipe" },
        );
        const pandocStderr = await new Response(pandocProc.stderr).text();
        const pandocExitCode = await pandocProc.exited;
        if (pandocExitCode !== 0) {
          throw new Error(`pandoc failed ${pandocStderr}`);
        }
        console.log(`[ingest] ${body.paperId} wrote markdown`);

        // store one retrieval document per markdown heading section
        const markdown = await Bun.file(paperMarkdown).text();
        const sections = splitMarkdown(markdown);
        console.log(`[ingest] ${body.paperId} split markdown into ${sections.length} sections`);

        // keep generated section files inspectable before committing rows
        await writeSectionFiles(
          { ...body, arxivId, paperId: body.paperId, sourceUrl: body.sourceUrl },
          sections,
          sectionsDir,
        );
        console.log(`[ingest] ${body.paperId} wrote section files`);

        // metadata embedding helps resolve this paper namespace later
        const metadataText = [
          `Title: ${body.title}`,
          `Authors: ${body.authors.join(", ")}`,
          `Summary: ${body.summary}`,
        ].join("\n");
        const metadataEmbedding = await embed(metadataText);
        console.log(`[ingest] ${body.paperId} embedded metadata`);
        const sectionEmbeddings: number[][] = [];
        const totalSections = sections.length;
        for (const section of sections) {
          console.log(
            `[ingest] ${body.paperId} embedding section ${section.docIndex + 1}/${totalSections}: ${section.sourceFile}`,
          );
          const sectionEmbeddingInput = buildSectionEmbeddingText(body.title, section.markdown);
          const sectionEmbedding = await embed(sectionEmbeddingInput);
          sectionEmbeddings.push(sectionEmbedding);
        }
        console.log(`[ingest] ${body.paperId} embedded all sections`);
        const completedAt = new Date();

        await db.transaction(async (tx) => {
          await tx
            .insert(papers)
            .values({
              id: body.paperId,
              arxivId,
              title: body.title,
              authors: body.authors,
              summary: body.summary,
              sourceUrl: body.sourceUrl,
              metadataEmbedding,
              ingestedAt: completedAt,
            })
            .onConflictDoUpdate({
              target: papers.id,
              set: {
                title: body.title,
                authors: body.authors,
                summary: body.summary,
                sourceUrl: body.sourceUrl,
                metadataEmbedding,
                ingestedAt: completedAt,
              },
            });

          for (const section of sections) {
            await tx
              .insert(paperDocs)
              .values({
                id: `${body.paperId}#${section.docIndex.toString().padStart(3, "0")}`,
                paperId: body.paperId,
                sectionTitle: section.sectionTitle,
                markdown: section.markdown,
                embedding: sectionEmbeddings[section.docIndex],
              })
              .onConflictDoUpdate({
                target: paperDocs.id,
                set: {
                  sectionTitle: section.sectionTitle,
                  markdown: section.markdown,
                  embedding: sectionEmbeddings[section.docIndex],
                },
              });
          }

          await tx
            .update(ingestionJobs)
            .set({ status: "completed", error: null, completedAt })
            .where(eq(ingestionJobs.id, body.paperId));
        });
        console.log(`[ingest] ${body.paperId} committed to database`);

        // only delete the per-paper workspace after the database commit succeeds
        // await $`rm -rf ${workspace}`; // currently commented out to actually see the result

        return {
          paperId: body.paperId,
          arxivId,
          status: "completed" as const,
          sectionCount: sections.length,
          message: "Paper source ingested.",
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Paper source ingestion failed.";
        console.error(`[ingest] ${body.paperId} failed: ${message}`);
        try {
          await $`rm -rf ${workspace}`;
          console.log(`[ingest] ${body.paperId} cleaned failed workspace`);
        } catch (cleanupError) {
          const cleanupMessage =
            cleanupError instanceof Error ? cleanupError.message : "unknown cleanup error";
          console.error(`[ingest] ${body.paperId} workspace cleanup failed: ${cleanupMessage}`);
        }
        await db
          .update(ingestionJobs)
          .set({ status: "failed", error: message, completedAt: new Date() })
          .where(eq(ingestionJobs.id, body.paperId));

        return {
          paperId: body.paperId,
          arxivId,
          status: "failed" as const,
          message,
        };
      }
    },
    {
      body: t.Object({
        arxivId: t.String(),
        paperId: t.String(),
        title: t.String(),
        authors: t.Array(t.String()),
        summary: t.String(),
        sourceUrl: t.String(),
      }),
    },
  );

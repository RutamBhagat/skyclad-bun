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
      const paperId = `/arxiv/${arxivId}`;
      const sourceUrl = `https://arxiv.org/src/${arxivId}`;

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
        .where(and(eq(papers.id, paperId), isNotNull(papers.ingestedAt)))
        .limit(1);

      if (existingPaper.length > 0) {
        return {
          paperId,
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
          id: paperId,
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

      const workspace = `.ingest/${arxivId.replaceAll("/", "_")}`;
      const rawArchiveDir = "apps/server/.ingest/raw/zip";
      const sourceArchive = `${workspace}/source.tar.gz`;
      const sourceDir = `${workspace}/src`;
      const expandedTex = `${workspace}/expanded.tex`;
      const paperMarkdown = `${workspace}/paper.md`;
      const sectionsDir = `${workspace}/sections`;

      try {
        const sourceArchiveNamePrefix = `arXiv-${arxivId}v`;
        // Look for pre-downloaded source archives for this arXiv id.
        const sourceArchiveCandidates = (() => {
          try {
            return readdirSync(rawArchiveDir)
              .filter((name) => name.startsWith(sourceArchiveNamePrefix) && name.endsWith(".tar.gz"))
              .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          } catch {
            return [];
          }
        })();
        const selectedSourceArchiveName = sourceArchiveCandidates[sourceArchiveCandidates.length - 1];

        await $`mkdir -p ${workspace} ${sourceDir}`;
        if (selectedSourceArchiveName) {
          // Use the newest local archive version when available.
          await $`cp ${path.join(rawArchiveDir, selectedSourceArchiveName)} ${sourceArchive}`;
        } else {
          // Fallback to arXiv download only when local archive is missing.
          const fetchTimeoutMs = 30_000;
          const sourceController = new AbortController();
          // Abort slow fetches so ingest fails fast with a clear timeout error.
          const timeoutId = setTimeout(() => sourceController.abort("fetch_timeout"), fetchTimeoutMs);
          try {
            const sourceResponse = await fetch(sourceUrl, { signal: sourceController.signal });
            // Surface rate-limit failures explicitly for callers.
            if (sourceResponse.status === 429) throw new Error(`Rate limited by arXiv (429) while fetching ${sourceUrl}`);
            // Fail on any non-success response before writing archive bytes.
            if (!sourceResponse.ok) throw new Error(`Failed to fetch source archive (${sourceResponse.status}) from ${sourceUrl}`);
            await Bun.write(sourceArchive, sourceResponse);
          } catch (error) {
            // Normalize abort/timeout errors into a clear timeout message.
            if (error instanceof Error && (error.name === "AbortError" || error.message.includes("fetch_timeout"))) {
              throw new Error(`Timed out after ${fetchTimeoutMs}ms while fetching ${sourceUrl}`);
            }
            throw error;
          } finally {
            clearTimeout(timeoutId);
          }
        }

        await $`tar -xzf ${sourceArchive} -C ${sourceDir}`;

        // flatten included tex files so pandoc sees one complete latex document
        const mainTex = await findMainTexFile(sourceDir);
        const expanded = await $`latexpand ${path.basename(mainTex)}`
          .cwd(path.dirname(mainTex))
          .text();
        await Bun.write(expandedTex, expanded);

        // convert latex into markdown while preserving math but dropping raw html passthrough
        await $`pandoc ${expandedTex} -f latex -t markdown-raw_html-raw_attribute+tex_math_dollars --wrap=none -o ${paperMarkdown}`;

        // store one retrieval document per markdown heading section
        const markdown = await Bun.file(paperMarkdown).text();
        const sections = splitMarkdown(markdown);

        // keep generated section files inspectable before committing rows
        await writeSectionFiles({ ...body, arxivId, paperId, sourceUrl }, sections, sectionsDir);

        // metadata embedding helps resolve this paper namespace later
        const metadataText = [
          `Title: ${body.title}`,
          `Authors: ${body.authors.join(", ")}`,
          `Summary: ${body.summary}`,
        ].join("\n");
        const metadataEmbedding = await embed(metadataText);
        const sectionEmbeddings: number[][] = [];
        for (const section of sections) {
          const sectionEmbeddingInput = buildSectionEmbeddingText(body.title, section.markdown);
          const sectionEmbedding = await embed(sectionEmbeddingInput);
          sectionEmbeddings.push(sectionEmbedding);
        }
        const completedAt = new Date();

        await db.transaction(async (tx) => {
          await tx
            .insert(papers)
            .values({
              id: paperId,
              arxivId,
              title: body.title,
              authors: body.authors,
              summary: body.summary,
              sourceUrl,
              metadataEmbedding,
              ingestedAt: completedAt,
            })
            .onConflictDoUpdate({
              target: papers.id,
              set: {
                title: body.title,
                authors: body.authors,
                summary: body.summary,
                sourceUrl,
                metadataEmbedding,
                ingestedAt: completedAt,
              },
            });

          for (const section of sections) {
            await tx
              .insert(paperDocs)
              .values({
                id: `${paperId}#${section.docIndex.toString().padStart(3, "0")}`,
                paperId,
                docIndex: section.docIndex,
                sectionTitle: section.sectionTitle,
                sectionPath: section.sectionPath,
                sectionLevel: section.sectionLevel,
                sectionKind: section.sectionKind,
                markdown: section.markdown,
                sourceFile: section.sourceFile,
                embedding: sectionEmbeddings[section.docIndex],
              })
              .onConflictDoUpdate({
                target: paperDocs.id,
                set: {
                  sectionTitle: section.sectionTitle,
                  sectionPath: section.sectionPath,
                  sectionLevel: section.sectionLevel,
                  sectionKind: section.sectionKind,
                  markdown: section.markdown,
                  sourceFile: section.sourceFile,
                  embedding: sectionEmbeddings[section.docIndex],
                },
              });
          }

          await tx
            .update(ingestionJobs)
            .set({ status: "completed", error: null, completedAt })
            .where(eq(ingestionJobs.id, paperId));
        });

        // only delete the per-paper workspace after the database commit succeeds
        // await $`rm -rf ${workspace}`; // currently commented out to actually see the result

        return {
          paperId,
          arxivId,
          status: "completed" as const,
          sectionCount: sections.length,
          message: "Paper source ingested.",
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Paper source ingestion failed.";
        await db
          .update(ingestionJobs)
          .set({ status: "failed", error: message, completedAt: new Date() })
          .where(eq(ingestionJobs.id, paperId));

        return {
          paperId,
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

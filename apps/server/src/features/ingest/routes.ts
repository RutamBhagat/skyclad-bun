import { Elysia, t } from "elysia";
import { and, db, eq, isNotNull } from "@skyclad-bun/db";
import { ingestionJobs, paperDocs, papers } from "@skyclad-bun/db/schema/index";
import { $ } from "bun";
import path from "node:path";

import { parseArxivCandidates } from "./arxiv";
import {
  ensureIngestTools,
  findMainTexFile,
  splitMarkdown,
  writeSectionFiles,
  embed,
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
        args: body,
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
      const sourceArchive = `${workspace}/source.tar.gz`;
      const sourceDir = `${workspace}/src`;
      const expandedTex = `${workspace}/expanded.tex`;
      const paperMarkdown = `${workspace}/paper.md`;
      const sectionsDir = `${workspace}/sections`;

      try {
        // build the source workspace from the caller-provided arxiv source archive
        await $`mkdir -p ${sourceDir}`;
        const sourceResponse = await fetch(sourceUrl);
        await Bun.write(sourceArchive, sourceResponse);
        await $`tar -xzf ${sourceArchive} -C ${sourceDir}`;

        // flatten included tex files so pandoc sees one complete latex document
        const mainTex = await findMainTexFile(sourceDir);
        const expanded = await $`latexpand ${path.basename(mainTex)}`
          .cwd(path.dirname(mainTex))
          .text();
        await Bun.write(expandedTex, expanded);

        // convert the flattened latex into section-friendly markdown with math intact
        await $`pandoc ${expandedTex} -f latex -t markdown+tex_math_dollars --wrap=none -o ${paperMarkdown}`;

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
        const sectionEmbeddings = await Promise.all(
          sections.map((section) => embed(`title: ${body.title} | text: ${section.markdown}`)),
        );
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

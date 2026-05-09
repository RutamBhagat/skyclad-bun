import { Elysia, t } from "elysia";
import { db, sql } from "@skyclad-bun/db";
import { papers } from "@skyclad-bun/db/schema/index";
import { cosineDistance, desc, isNotNull } from "@skyclad-bun/db";

import { embed } from "../ingest/source-ingest";

export const retrievalRoutes = new Elysia({ prefix: "/api/retrieval" }).post(
  "/resolve_paper_id",
  async ({ body }) => {
    const searchText = `${body.paperName}\n${body.query}`;
    const queryEmbedding = await embed(searchText);
    const similarity = sql<number>`1 - (${cosineDistance(papers.metadataEmbedding, queryEmbedding)})`;

    const rows = await db
      .select({
        paperId: papers.id,
        arxivId: papers.arxivId,
        title: papers.title,
        authors: papers.authors,
        summary: papers.summary,
        sourceUrl: papers.sourceUrl,
        ingestedAt: papers.ingestedAt,
        confidence: similarity,
      })
      .from(papers)
      .where(isNotNull(papers.metadataEmbedding))
      .orderBy((table) => desc(table.confidence))
      .limit(3);

    return {
      ok: true,
      result: rows,
      args: body,
    };
  },
  {
    body: t.Object({
      paperName: t.String(),
      query: t.String(),
    }),
  },
);

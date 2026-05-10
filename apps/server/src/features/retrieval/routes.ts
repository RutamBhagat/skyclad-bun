import { Elysia, t } from "elysia";
import { and, db, eq, sql } from "@skyclad-bun/db";
import { paperDocs, papers } from "@skyclad-bun/db/schema/index";
import { cosineDistance, desc, isNotNull } from "@skyclad-bun/db";

import { embed } from "../ingest/source-ingest";

export const retrievalRoutes = new Elysia({ prefix: "/api/retrieval" })
  .post(
    "/resolve_paper_id",
    async ({ body }) => {
      const searchText = `${body.paperName}\n${body.query}`;
      const queryEmbedding = await embed(searchText);
      const similarity = sql<number>`round((1 - (${cosineDistance(papers.metadataEmbedding, queryEmbedding)}))::numeric, 2)::float8`;

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
      };
    },
    {
      body: t.Object({
        paperName: t.String(),
        query: t.String(),
      }),
    },
  )
  .post(
    "/query_paper_docs_hybrid",
    async ({ body }) => {
      const queryEmbedding = await embed(body.query);

      // Rank chunks by one hybrid score so semantic similarity and exact term matches both contribute.
      const rows = await db
        .select({
          chunkId: paperDocs.id,
          section: paperDocs.sectionTitle,
          text: paperDocs.markdown,
          semanticScore: sql<number>`round((1 - (${cosineDistance(paperDocs.embedding, queryEmbedding)}))::numeric, 2)::float8`,
          lexicalScore: sql<number>`round(ts_rank_cd(${paperDocs.searchText}, websearch_to_tsquery('english', ${body.lexicalQuery}))::numeric, 2)::float8`,
          hybridScore: sql<number>`round(((1 - (${cosineDistance(paperDocs.embedding, queryEmbedding)})) + ts_rank_cd(${paperDocs.searchText}, websearch_to_tsquery('english', ${body.lexicalQuery})))::numeric, 2)::float8`,
        })
        .from(paperDocs)
        .where(and(eq(paperDocs.paperId, body.paperId), isNotNull(paperDocs.embedding)))
        .orderBy((table) => desc(table.hybridScore))
        .limit(3);

      return { ok: true, result: rows };
    },
    {
      body: t.Object({
        paperId: t.String(),
        query: t.String(),
        lexicalQuery: t.String(),
      }),
    },
  );

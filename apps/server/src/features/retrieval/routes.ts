import { Elysia, t } from "elysia";
import { and, asc, db, eq, sql } from "@skyclad-bun/db";
import { paperDocs, papers } from "@skyclad-bun/db/schema/index";
import { cosineDistance, desc, isNotNull } from "@skyclad-bun/db";

import { embed } from "../ingest/source-ingest";
import { addRrfCandidate, formatScore, type RetrievedChunk } from "./rag-helpers";

const markdownContentType = "text/markdown; charset=utf-8";

const paperMatchLimit = 3;
const semanticCandidateLimit = 80;
const lexicalCandidateLimit = 80;
const finalChunkLimit = 3;

export const retrievalRoutes = new Elysia({ prefix: "/api/retrieval" })
  .post(
    "/resolve_paper_id",
    async ({ body, set }) => {
      const searchText = `${body.paperName}\n${body.query}`;
      const queryEmbedding = await embed(searchText);
      const distance = cosineDistance(papers.metadataEmbedding, queryEmbedding);
      const confidence = sql<number>`1 - (${distance})`;

      const rows = await db
        .select({
          paperId: papers.id,
          arxivId: papers.arxivId,
          title: papers.title,
          authors: papers.authors,
          summary: papers.summary,
          sourceUrl: papers.sourceUrl,
          confidence,
        })
        .from(papers)
        .where(isNotNull(papers.metadataEmbedding))
        .orderBy(asc(distance))
        .limit(paperMatchLimit);

      set.headers["content-type"] = markdownContentType;

      if (rows.length === 0) return `No papers matched "${body.paperName}".`;

      return [
        `Paper matches for "${body.paperName}":`,
        `Query: ${body.query}`,
        "",
        ...rows.flatMap((row, index) => [
          ...(index > 0 ? ["---"] : []),
          [
            `- Title: ${row.title}`,
            `  Paper ID: ${row.paperId}`,
            `  arXiv ID: ${row.arxivId}`,
            `  Confidence: ${formatScore(Number(row.confidence))}`,
            `  Authors: ${row.authors.join(", ")}`,
            row.summary ? `  Summary: ${row.summary}` : undefined,
            `  Source: ${row.sourceUrl}`,
          ]
            .filter(Boolean)
            .join("\n"),
        ]),
      ].join("\n");
    },
    {
      body: t.Object({
        paperName: t.String(),
        query: t.String(),
      }),
    },
  )
  .post(
    "/query_paper_docs",
    async ({ body, set }) => {
      const queryEmbedding = await embed(body.query);
      const lexicalQuery = body.lexicalQuery.trim();

      const semanticDistance = cosineDistance(paperDocs.embedding, queryEmbedding);
      const semanticScore = sql<number>`1 - (${semanticDistance})`;

      const semanticRowsPromise = db
        .select({
          chunkId: paperDocs.id,
          section: paperDocs.sectionTitle,
          text: paperDocs.markdown,
          score: semanticScore,
        })
        .from(paperDocs)
        .where(and(eq(paperDocs.paperId, body.paperId), isNotNull(paperDocs.embedding)))
        .orderBy(asc(semanticDistance))
        .limit(semanticCandidateLimit);

      const englishLexicalScore = sql<number>`ts_rank_cd(${paperDocs.searchText}, websearch_to_tsquery('english', ${lexicalQuery}), 32)`;

      const englishLexicalRowsPromise = lexicalQuery
        ? db
            .select({
              chunkId: paperDocs.id,
              section: paperDocs.sectionTitle,
              text: paperDocs.markdown,
              score: englishLexicalScore,
            })
            .from(paperDocs)
            .where(
              and(
                eq(paperDocs.paperId, body.paperId),
                sql`${paperDocs.searchText} @@ websearch_to_tsquery('english', ${lexicalQuery})`,
              ),
            )
            .orderBy(desc(englishLexicalScore))
            .limit(lexicalCandidateLimit)
        : Promise.resolve([]);

      const simpleLexicalScore = sql<number>`ts_rank_cd(${paperDocs.searchTextSimple}, websearch_to_tsquery('simple', ${lexicalQuery}), 32)`;

      const simpleLexicalRowsPromise = lexicalQuery
        ? db
            .select({
              chunkId: paperDocs.id,
              section: paperDocs.sectionTitle,
              text: paperDocs.markdown,
              score: simpleLexicalScore,
            })
            .from(paperDocs)
            .where(
              and(
                eq(paperDocs.paperId, body.paperId),
                sql`${paperDocs.searchTextSimple} @@ websearch_to_tsquery('simple', ${lexicalQuery})`,
              ),
            )
            .orderBy(desc(simpleLexicalScore))
            .limit(lexicalCandidateLimit)
        : Promise.resolve([]);

      const [semanticRows, englishLexicalRows, simpleLexicalRows] = await Promise.all([
        semanticRowsPromise,
        englishLexicalRowsPromise,
        simpleLexicalRowsPromise,
      ]);

      const candidates = new Map<string, RetrievedChunk>();

      semanticRows.forEach((row, index) => {
        addRrfCandidate(candidates, row, index + 1, "semantic");
      });

      englishLexicalRows.forEach((row, index) => {
        addRrfCandidate(candidates, row, index + 1, "englishLexical");
      });

      simpleLexicalRows.forEach((row, index) => {
        addRrfCandidate(candidates, row, index + 1, "simpleLexical");
      });

      const rows = Array.from(candidates.values())
        .sort((left, right) => {
          const rrfDifference = right.rrfScore - left.rrfScore;
          if (rrfDifference !== 0) return rrfDifference;
          return (right.semanticScore ?? -Infinity) - (left.semanticScore ?? -Infinity);
        })
        .slice(0, finalChunkLimit);

      set.headers["content-type"] = markdownContentType;

      if (rows.length === 0) return `No document chunks matched paper ${body.paperId}.`;

      return [
        `Relevant documentation for ${body.paperId}:`,
        `Query: ${body.query}`,
        `Lexical query: ${lexicalQuery || "n/a"}`,
        "",
        ...rows.flatMap((row, index) => [
          ...(index > 0 ? ["---"] : []),
          [
            `## ${row.section}`,
            "",
            `Chunk ID: ${row.chunkId}`,
            `RRF score: ${formatScore(row.rrfScore)}`,
            `Semantic score: ${formatScore(row.semanticScore)}`,
            `English lexical score: ${formatScore(row.englishLexicalScore)}`,
            `Simple lexical score: ${formatScore(row.simpleLexicalScore)}`,
            "",
            row.text,
          ].join("\n"),
        ]),
      ].join("\n\n");
    },
    {
      body: t.Object({
        paperId: t.String(),
        query: t.String(),
        lexicalQuery: t.String(),
      }),
    },
  );
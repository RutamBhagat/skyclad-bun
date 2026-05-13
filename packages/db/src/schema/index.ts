import { sql, type SQL } from "drizzle-orm";
import { customType, index, jsonb, pgTable, text, timestamp, vector } from "drizzle-orm/pg-core";

export const embeddingDimensions = 1536;

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const papers = pgTable(
  "papers",
  {
    id: text("id").primaryKey(),
    arxivId: text("arxiv_id").notNull().unique(),
    title: text("title").notNull(),
    authors: jsonb("authors").$type<string[]>().notNull(),
    summary: text("summary"),
    sourceUrl: text("source_url").notNull(),
    // used only to resolve a paper namespace from title/authors/summary before doc search
    metadataEmbedding: vector("metadata_embedding", {
      dimensions: embeddingDimensions,
    }),
    ingestedAt: timestamp("ingested_at"),
  },
  (table) => [
    index("papers_metadata_embedding_hnsw_idx").using(
      "hnsw",
      table.metadataEmbedding.op("vector_cosine_ops"),
    ),
  ],
);

export const paperDocs = pgTable(
  "paper_docs",
  {
    id: text("id").primaryKey(),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    sectionTitle: text("section_title").notNull(),
    markdown: text("markdown").notNull(),
    // used inside a resolved paper namespace for semantic section search
    embedding: vector("embedding", { dimensions: embeddingDimensions }),
    // full-text search: preserves technical terms/acronyms
    searchText: tsvector("search_text").generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('simple', coalesce(${paperDocs.sectionTitle}, '') || ' ' || coalesce(${paperDocs.markdown}, ''))`,
    ),
  },
  (table) => [
    index("paper_docs_paper_id_idx").on(table.paperId),
    // native pgvector HNSW index
    index("paper_docs_embedding_hnsw_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
    index("paper_docs_search_text_idx").using("gin", table.searchText),
  ],
);

export const ingestionJobs = pgTable("ingestion_jobs", {
  id: text("id").primaryKey(),
  status: text("status", {
    enum: ["ingesting", "completed", "failed"],
  }).notNull(),
  error: text("error"),
  startedAt: timestamp("started_at").notNull(),
  completedAt: timestamp("completed_at"),
});

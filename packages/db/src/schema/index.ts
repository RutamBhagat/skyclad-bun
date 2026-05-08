import { sql, type SQL } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

export const embeddingDimensions = 1536;

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const papers = pgTable("papers", {
  id: text("id").primaryKey(),
  arxivId: text("arxiv_id").notNull().unique(),
  title: text("title").notNull(),
  authors: jsonb("authors").$type<string[]>().notNull(),
  summary: text("summary"),
  sourceUrl: text("source_url").notNull(),
  metadataEmbedding: vector("metadata_embedding", {
    dimensions: embeddingDimensions,
  }),
  ingestedAt: timestamp("ingested_at"),
});

export const paperDocs = pgTable(
  "paper_docs",
  {
    id: text("id").primaryKey(),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    docIndex: integer("doc_index").notNull(),
    sectionTitle: text("section_title").notNull(),
    sectionPath: jsonb("section_path").$type<string[]>().notNull(),
    sectionLevel: integer("section_level").notNull(),
    sectionKind: text("section_kind", {
      enum: ["main", "abstract", "references", "appendix"],
    }).notNull(),
    markdown: text("markdown").notNull(),
    sourceFile: text("source_file").notNull(),
    embedding: vector("embedding", { dimensions: embeddingDimensions }),
    searchText: tsvector("search_text").generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('english', coalesce(${paperDocs.sectionTitle}, '') || ' ' || coalesce(${paperDocs.markdown}, ''))`,
    ),
  },
  (table) => [
    uniqueIndex("paper_docs_paper_doc_index_unique").on(
      table.paperId,
      table.docIndex,
    ),
    uniqueIndex("paper_docs_paper_source_file_unique").on(
      table.paperId,
      table.sourceFile,
    ),
    index("paper_docs_paper_order_idx").on(table.paperId, table.docIndex),
    index("paper_docs_paper_kind_idx").on(table.paperId, table.sectionKind),
    index("paper_docs_search_idx").using("gin", table.searchText),
  ],
);

export const ingestionJobs = pgTable("ingestion_jobs", {
  id: text("id").primaryKey(),
  paperId: text("paper_id").notNull(),
  arxivId: text("arxiv_id").notNull(),
  status: text("status", {
    enum: ["ingesting", "completed", "failed"],
  }).notNull(),
  error: text("error"),
  startedAt: timestamp("started_at").notNull(),
  completedAt: timestamp("completed_at"),
});

DROP INDEX "paper_docs_search_idx";--> statement-breakpoint
DROP INDEX "paper_docs_search_simple_idx";--> statement-breakpoint
ALTER TABLE "paper_docs" drop column "search_text";--> statement-breakpoint
ALTER TABLE "paper_docs" ADD COLUMN "search_text" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("paper_docs"."section_title", '') || ' ' || coalesce("paper_docs"."markdown", ''))) STORED;--> statement-breakpoint
CREATE INDEX "paper_docs_search_text_idx" ON "paper_docs" USING gin ("search_text");--> statement-breakpoint
ALTER TABLE "paper_docs" DROP COLUMN "search_text_simple";
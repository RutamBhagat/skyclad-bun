# arXiv7

arXiv7 is a local-first retrieval system for technical arXiv papers. It is inspired by the part of Context7: ask for a specific technical ai related question and get the right source sections back and enough context to keep llm's answers grounded

The backend intentionally avoids unnecessary LLM calls. It does not run a backend agent just to decide whether a section is relevant. Instead, it makes the retrieval path explicit: resolve the paperId, search inside chunks of that paper, combine semantic and lexical scores with RRF, and return ranked Markdown sections

The only required model call in the backend retrieval path is local embedding through Ollama with `qwen3-embedding:8b`. This keeps runtime cost minimal and responses fast

## Setup

see [evals/setup.md](evals/setup.md) for detailed setup instructions

## Architecture

The server is a Elysia API with Postgres DB, pgvector, and generated full-text search indexes

Runtime flow:

1. Resolve a user-provided paper name to a paper namespace id
2. Embed the user query locally with Ollama
3. Search section chunks semantically with pgvector cosine distance
4. Search the same section chunks lexically with Postgres full-text search
5. Merge both ranked lists with Reciprocal Rank Fusion
6. Return the top Markdown sections with scores and chunk IDs

This keeps the backend deterministic, cheap, fast and inspectable. The system can explain which chunks won because every returned section includes its paper ID, chunk ID, RRF score, semantic score, and lexical score

see [apps/docs/ingestion.md](apps/docs/ingestion.md) for more detailed ingestion architechture diagram
see [apps/docs/retrieval.md](apps/docs/retrieval.md) for more detailed retrieval architechture diagram

## Ingestion

arXiv7 uses arXiv's TeX source archives instead of PDFs. PDF extraction loses too much structure in technical papers, especially around equations, tables, and section boundaries

The ingestion path is:

1. Resolve candidate papers from the arXiv API XML response (currently this is done manually because arXiv rate limits make reliable downloads difficult)
2. Read a local source archive from `.ingest/raw/zip/arXiv-<id>v*.tar.gz`
3. Extract the archive with `tar`
4. Find the main TeX file
5. Expand included TeX files with `latexpand`
6. Convert the expanded TeX to Markdown with `pandoc`
7. Split Markdown by headings into section chunks, and split chunks larger than 10k characters into smaller chunks
8. Embed paper metadata and section text locally
9. Store papers, chunks, vectors, and full-text search data in Postgres

arXiv rate limits made reliable batch source downloads difficult, thats why ingestion is local workflow: source archives are placed on disk first, then the server turns them into searchable sections

The one part that currently still needs generated metadata is initial ingestion. arXiv's API is XML-only and rate limited, so paper metadata needed for batch ingestion was generated locally with AI agents instead of repeatedly depending on remote API calls during backend ingestion.

## API Surface

Ingestion:

- `POST /api/ingest/resolve_ingest_target`
- `POST /api/ingest/ingest_paper_source`

Retrieval:

- `POST /api/retrieval/resolve_paper_id`
- `POST /api/retrieval/query_paper_docs`

`resolve_paper_id` searches paper metadata first. `query_paper_docs` then searches only inside the resolved paper. This paper-first classification is the main guard against mixing sections from different papers that happen to use similar technical vocabulary.

## Decisions

- Elysia keeps the API small and direct
- Postgres stores papers, sections, vectors, and full-text search data in one place
- pgvector HNSW indexes provide fast semantic lookup without a separate vector service
- Ollama with `qwen3-embedding:8b` avoids cloud embedding cost and rate limits
- Paper-level metadata embeddings route queries to the right paper before section search
- Lexical search catches exact terms, acronyms, method names, and formulas (formulas had to be saved as Tex format but llm's can interpret them correctly)
- RRF combines semantic and lexical rank evidence without adding an LLM reranker
- Generated `.ingest/extract/<paper_id>/sections` files make ingestion output easy to inspect

## Known Limitations

- Ingestion currently expects source archives to already exist under `.ingest/raw/zip`
- Metadata generation for initial bulk ingestion is not fully automated because arXiv API rate limits made reliable batch collection painful
- TeX-to-Markdown conversion is lossy for some equations, figures, tables, and custom macros
- Very large Markdown sections are split by character count at `\n\n` after structural heading splitting
- The backend returns retrieval context; final answer generation is left to the client tui agent layer
- The TUI is barebones and exists for demo rather than polished ui

## What I Would Do Next

1. Currently eval is manual process, would search for better way to do the evaluation in the tui
2. Improve TeX normalization around equations and tables
3. Replace the demo TUI with a focused web UI for paper selection, retrieval inspection, and answer generation

## Repository Layout

- `apps/server/src/features/ingest`: arXiv candidate parsing and source ingestion.
- `apps/server/src/features/retrieval`: paper resolution, hybrid retrieval, and RRF helpers.
- `apps/tui`: barebones terminal chat demo.
- `packages/db`: Drizzle schema, Postgres setup, pgvector indexes, and migrations.
- `packages/env`: typed server and web environment handling.

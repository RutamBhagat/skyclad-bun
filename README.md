# arXiv7

arXiv7 is a local-first retrieval system for technical arXiv papers. It is inspired by the part of Context7 that feels immediately useful: ask for a specific technical thing and get the right source sections back, with citations and enough context to keep the next answer grounded.

The backend intentionally avoids unnecessary LLM calls. It does not run a backend agent just to decide whether a section is relevant. Instead, it makes the retrieval path explicit: resolve the paper, search inside that paper, combine semantic and lexical evidence, and return ranked Markdown sections.

The only required model call in the backend retrieval path is local embedding through Ollama with `qwen3-embedding:8b`. That keeps runtime cost predictable and avoids paying for hosted LLM calls on every query.

## Architecture

The server is a Bun and Elysia API backed by Postgres, pgvector, and generated full-text indexes.

Runtime flow:

1. Resolve a user-provided paper name to a paper namespace.
2. Embed the user query locally with Ollama.
3. Search section chunks semantically with pgvector cosine distance.
4. Search the same section chunks lexically with Postgres full-text search.
5. Merge both ranked lists with Reciprocal Rank Fusion.
6. Return the top Markdown sections with scores and chunk IDs.

This keeps the backend cheap and inspectable. The system can explain which chunks won because every returned section includes its paper ID, chunk ID, RRF score, semantic score, and lexical score.

## Ingestion

arXiv7 uses arXiv TeX source archives instead of PDFs. PDF extraction loses too much structure in technical papers, especially around equations, tables, and section boundaries.

The ingestion path is:

1. Resolve candidate papers from the arXiv API XML response.
2. Read a local source archive from `.ingest/raw/zip/arXiv-<id>v*.tar.gz`.
3. Extract the archive with `tar`.
4. Find the main TeX file.
5. Expand included TeX files with `latexpand`.
6. Convert the expanded TeX to Markdown with `pandoc`.
7. Split Markdown by headings into section chunks.
8. Embed paper metadata and section text locally.
9. Store papers, chunks, vectors, and full-text search data in Postgres.

arXiv rate limits made reliable batch source downloads difficult. The backend therefore treats ingestion as a local-source workflow: source archives are placed on disk first, then the server turns them into searchable sections.

The one part that currently still needs generated metadata is initial ingestion. arXiv's API is XML-only and rate limited, so paper metadata needed for batch ingestion was generated locally with AI agents instead of repeatedly depending on remote API calls during backend ingestion.

## API Surface

Ingestion:

- `POST /api/ingest/resolve_ingest_target`
- `POST /api/ingest/ingest_paper_source`

Retrieval:

- `POST /api/retrieval/resolve_paper_id`
- `POST /api/retrieval/query_paper_docs`

`resolve_paper_id` searches paper metadata first. `query_paper_docs` then searches only inside the resolved paper. This paper-first classification is the main guard against mixing sections from different papers that happen to use similar technical vocabulary.

## Setup

Prerequisites:

- Bun `1.3.3`
- Docker
- Ollama
- `tar`
- `latexpand`
- `pandoc`

```bash
bun install
cp apps/server/.env.example apps/server/.env
bun run db:start
bun run db:push
ollama pull qwen3-embedding:8b
bun run dev:server
```

The server listens on `http://localhost:3000`.

## TUI Demo

`apps/tui` contains a barebones terminal chat app used to demonstrate the frontend-facing requirements. It is intentionally simple: the retrieval backend is the important part, and the TUI exists so the system can be driven conversationally during demos.

Run it with:

```bash
bun run dev:tui
```

Use `/login` to configure ChatGPT Codex OAuth before sending messages. The default model setting is stored by the TUI under `apps/tui/.data`.

The important TUI integration lives in `apps/tui/.pi`. That directory contains the Pi extension and skill setup used by the demo agent:

- `apps/tui/.pi/extensions/arxiv/index.ts` exposes the arXiv7 backend API as agent-callable tools.
- `apps/tui/.pi/skills/arxiv-usage/SKILL.md` guides the agent on when and how to use those tools.
- `apps/tui/.pi/settings.json` wires the local Pi runtime configuration.
- `apps/tui/.pi/npm` contains the extension runtime dependencies, including support for the external `rpiv-ask-user-question` ask-questions extension.

This keeps the backend simple while still allowing the TUI agent to retrieve paper sections, ask clarifying questions, and use external helper extensions when the conversation needs them.

## Decisions

- Bun and Elysia keep the API small and direct.
- Postgres stores papers, sections, vectors, and full-text search data in one operational database.
- pgvector HNSW indexes provide fast semantic lookup without a separate vector service.
- Ollama with `qwen3-embedding:8b` avoids hosted embedding cost and rate limits.
- Paper-level metadata embeddings route queries to the right paper before section search.
- Section-level chunks preserve citation-friendly boundaries better than fixed-size splitting alone.
- Lexical search catches exact terms, acronyms, method names, and formula-adjacent text.
- RRF combines semantic and lexical rank evidence without adding an LLM reranker.
- Generated `.ingest/<paper>/sections` files make ingestion output easy to inspect.

## Known Limitations

- Ingestion currently expects source archives to already exist under `.ingest/raw/zip`.
- Metadata generation for initial bulk ingestion is not fully automated because arXiv API rate limits made reliable batch collection painful.
- TeX-to-Markdown conversion is lossy for some equations, figures, tables, and custom macros.
- Very large Markdown sections are split by character count after structural heading splitting.
- Re-ingesting a paper can leave stale section rows if the new section count is smaller.
- The backend returns retrieval context; final answer generation is left to the client or demo layer.
- The TUI is barebones and exists for demonstration rather than as a polished user interface.

## What I Would Do Next

1. Add a stable batch ingestion manifest so local archives and generated metadata are tracked together.
2. Delete stale `paper_docs` rows during re-ingestion when a paper produces fewer sections.
3. Add a small retrieval eval set that compares semantic-only retrieval against semantic plus lexical plus RRF.
4. Add a debug page that shows paper routing, candidate chunks, and rank fusion decisions for each query.
5. Improve TeX normalization around equations and tables where retrieval quality is currently weakest.
6. Replace the demo TUI with a focused web UI for paper selection, retrieval inspection, and answer generation.

## Repository Layout

- `apps/server/src/features/ingest`: arXiv candidate parsing and source ingestion.
- `apps/server/src/features/retrieval`: paper resolution, hybrid retrieval, and RRF helpers.
- `apps/tui`: barebones terminal chat demo.
- `packages/db`: Drizzle schema, Postgres setup, pgvector indexes, and migrations.
- `packages/env`: typed server and web environment handling.

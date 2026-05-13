## Ingestion architecture

This is a **paper-source ingestion pipeline** for turning an arXiv LaTeX source package into searchable, section-level retrieval documents.

At a high level:

```txt
arXiv title / paper metadata
        │
        ▼
Resolve target candidate
        │
        ▼
Local arXiv source archive
        │
        ▼
Extract + find main .tex
        │
        ▼
latexpand: flatten included TeX
        │
        ▼
Normalize LaTeX for Pandoc
        │
        ▼
Pandoc: LaTeX → Markdown
        │
        ▼
Split Markdown into section docs
        │
        ▼
Embed metadata + each section
        │
        ▼
Postgres:
  papers
  paper_docs
  ingestion_jobs
```

## Main components

### 1. API layer

There are two ingestion-facing endpoints.

#### `POST /api/ingest/resolve_ingest_target`

This searches arXiv by title:

```ts
const searchQuery = `ti:"${body.paperName}"`;
```

It calls the arXiv API and parses up to 3 candidate papers. This endpoint only resolves likely targets; it does **not** ingest the source.

#### `POST /api/ingest/ingest_paper_source`

This is the actual ingestion endpoint. It accepts:

```ts
{
  (arxivId, paperId, title, authors, summary, sourceUrl);
}
```

It normalizes versioned arXiv IDs by stripping suffixes like `v2`, checks local tooling, records an ingestion job, processes the source archive, embeds content, and commits rows to Postgres.

## Storage model

### `papers`

This is the **paper namespace table**.

Each row represents one ingested paper:

```ts
papers {
  id
  arxivId
  title
  authors
  summary
  sourceUrl
  metadataEmbedding
  ingestedAt
}
```

Key design choice: `metadataEmbedding` is not for searching inside the paper. It is for resolving **which paper** the user is asking about from title, authors, or abstract-like metadata.

```txt
User query
   │
   ▼
Search papers.metadata_embedding
   │
   ▼
Resolve paper namespace
   │
   ▼
Search sections only inside that paper
```

The HNSW index on `metadataEmbedding` supports fast approximate vector search over papers.

### `paper_docs`

This is the **section-level retrieval table**.

Each row is one section or chunk from the converted Markdown paper:

```ts
paper_docs {
  id
  paperId
  sectionTitle
  markdown
  embedding
  searchText
}
```

It has three retrieval affordances:

| Field        | Purpose                                   |
| ------------ | ----------------------------------------- |
| `paperId`    | Restrict retrieval to one resolved paper  |
| `embedding`  | Semantic section search                   |
| `searchText` | Keyword / acronym / technical-term search |

The `searchText` column is generated from `sectionTitle + markdown` using Postgres `to_tsvector('simple', ...)`, then indexed with GIN. That is a good choice for papers because the `simple` dictionary avoids over-stemming or dropping technical terms, acronyms, model names, math symbols, and jargon.

Context7’s Drizzle docs confirm this pattern: Drizzle supports generated PostgreSQL columns using `.generatedAlwaysAs()` with custom `tsvector` types and GIN indexes, and supports pgvector columns with HNSW indexes using `vector_cosine_ops`.

### `ingestion_jobs`

This is the operational status table:

```ts
ingestion_jobs {
  id
  status: ingesting | completed | failed
  error
  startedAt
  completedAt
}
```

The job ID is the same as `paperId`, so ingestion is tracked per paper.

## Runtime ingestion flow

### 1. Validate prerequisites

Before touching the DB or workspace, ingestion checks required local tools:

```ts
const ingestTools = ["tar", "latexpand", "pandoc"];
```

If any are missing, the request fails early.

### 2. Idempotency check

Before starting expensive work, the route checks whether this exact `paperId` already has `ingestedAt` set.

If yes, it returns:

```ts
status: "already_ingested";
```

This prevents repeated ingestion of completed papers.

### 3. Create or reset the ingestion job

The system inserts or updates `ingestion_jobs` with:

```ts
status: "ingesting";
error: null;
startedAt;
completedAt: null;
```

So repeated attempts overwrite the prior job status before starting fresh.

### 4. Locate source archive

This implementation currently expects the arXiv source archive to already exist locally:

```txt
.ingest/raw/zip/arXiv-<arxivId>v*.tar.gz
```

It selects the newest local version by sorting matching archive filenames. It does **not** currently download source from `sourceUrl`; it throws if the archive is missing.

That is an important architecture point: the ingestion endpoint is really a **local-source ingestion worker**, not a full remote downloader.

### 5. Extract source

The selected `.tar.gz` archive is copied into a per-paper workspace:

```txt
.ingest/<arxivId>/
```

Then extracted into:

```txt
.ingest/<arxivId>/src
```

### 6. Find the main TeX file

The helper scans all `.tex` files and selects files containing:

```tex
\begin{document}
```

Selection rules:

1. If only one document file exists, use it.
2. Prefer common names like `main.tex`, `paper.tex`, `ms.tex`, `article.tex`, `arxiv.tex`.
3. Otherwise use the largest document file.

This is a pragmatic heuristic for messy arXiv source trees.

### 7. Expand LaTeX includes

The pipeline runs `latexpand` against the selected main TeX file.

Purpose:

```txt
multi-file LaTeX project
        │
        ▼
single expanded.tex
```

This gives Pandoc a more complete document instead of a root file full of `\input{...}` or `\include{...}` references.

### 8. Normalize LaTeX for Pandoc

Before Pandoc conversion, the code sanitizes known problematic constructs:

- toggle conditionals
- figures
- tables
- TikZ pictures
- listings / minted code blocks
- standalone `\includegraphics`
- dangling environment endings

This is a lossy but practical step. The goal is not perfect document reproduction; it is retrieval-quality text extraction.

### 9. Convert LaTeX to Markdown

Pandoc converts the normalized expanded TeX into Markdown:

```txt
expanded.tex → paper.md
```

The Pandoc settings preserve math with dollar syntax and disable raw HTML / raw attributes. It also caps the Pandoc heap with `-M1024m`, which is useful because arXiv LaTeX sources can be large or malformed.

### 10. Split Markdown into retrieval sections

The Markdown is tokenized with `marked.lexer`.

The splitter creates one document per heading section:

```txt
# Introduction
## Background
## Method
# Experiments
...
```

It tracks:

```ts
sectionTitle;
sectionPath;
sectionLevel;
sectionKind;
markdown;
sourceFile;
docIndex;
```

It drops sections whose body is shorter than 120 characters and splits oversized sections over 10,000 characters. If the converted Markdown has no headings, it stores the whole thing as an `"Abstract"` fallback section.

### 11. Write debug section files

Before committing to the DB, the system writes section Markdown files into:

```txt
.ingest/<arxivId>/sections
```

Each file includes YAML frontmatter with paper ID, arXiv ID, section path, and source file. This makes ingestion inspectable and debuggable.

### 12. Generate embeddings

There are two embedding passes.

#### Paper metadata embedding

Input:

```txt
Title: ...
Authors: ...
Summary: ...
```

Stored in:

```ts
papers.metadataEmbedding;
```

Used to resolve the paper namespace later.

#### Section embedding

For each section, the pipeline builds embedding text from:

```txt
title: <paper title> | text: <section plain text>
```

It strips tables, keeps normal text, and includes code raw text where applicable.

Embeddings are generated through Ollama:

```ts
model: "qwen3-embedding:8b";
dimensions: 1536;
```

Stored in:

```ts
paper_docs.embedding;
```

### 13. Commit transactionally

The final DB write happens inside one transaction:

1. Upsert `papers`
2. Upsert each `paper_docs` section
3. Mark `ingestion_jobs.status = "completed"`

This means the paper and its sections are committed together. If anything fails before this point, the job is marked failed and the workspace is cleaned up.

## Retrieval architecture implied by this ingestion design

The schema suggests a **two-stage retrieval system**:

```txt
Stage 1: Resolve paper
  Query → metadata embedding search on papers

Stage 2: Search within paper
  paperId filter
  + semantic search on paper_docs.embedding
  + keyword search on paper_docs.searchText
```

This is better than dumping all sections from all papers into one global vector space because paper titles and author metadata help disambiguate the target paper before section search.

## Strengths

- **Clear namespace separation:** `papers` resolves the paper; `paper_docs` searches inside it.
- **Hybrid retrieval-ready:** semantic vectors plus full-text `tsvector`.
- **Good technical-term handling:** `to_tsvector('simple', ...)` is sensible for papers.
- **Operational visibility:** `ingestion_jobs` records status and errors.
- **Idempotency for completed papers:** repeated calls do not redo completed ingestion.
- **Transactional final write:** avoids partially completed DB commits.
- **Debuggable artifacts:** section files remain inspectable in `.ingest`.

## Main weaknesses / risks

### 1. No remote source download

Despite accepting `sourceUrl`, the ingest step requires a local archive:

```txt
.ingest/raw/zip/arXiv-<id>v*.tar.gz
```

So the architecture currently depends on a separate, external pre-download process.

### 2. Job ID equals paper ID

This is simple, but it means you only retain one job record per paper. You lose historical attempts unless logs are preserved elsewhere.

A more audit-friendly design would use:

```txt
ingestion_jobs.id = unique attempt id
ingestion_jobs.paper_id = paperId
```

### 3. Section rows are not deleted if a re-ingest produces fewer sections

The code upserts current section IDs, but I do not see a delete step for stale `paper_docs` rows from prior ingestions. If a paper previously had 40 sections and now produces 35, the old `#035`–`#039` rows may remain.

### 4. Embeddings are generated before the DB transaction

That is acceptable, but if embedding 80 sections succeeds and the final transaction fails, all embedding work is lost. This is simpler but not resumable.

### 5. Single long synchronous request

The route performs extraction, conversion, splitting, embedding, and DB writes in one request lifecycle. For large papers, this can hit request timeouts or make retries awkward. Architecturally, this wants to become a background worker queue.

This ingestion architecture is a **synchronous arXiv LaTeX-to-Markdown pipeline that converts locally available source archives into section-level Postgres retrieval documents, with paper-level metadata embeddings for namespace resolution, section-level embeddings for semantic search, and generated `tsvector` columns for exact technical-term search.**

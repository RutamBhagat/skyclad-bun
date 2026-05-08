# Elysia/Postgres arXiv Source Ingestion

This document is ingestion-only.

The current app is Bun + Elysia in `apps/server` with Drizzle/Postgres in
`packages/db`. Do not build this path around PDF parsing,
GROBID, arXiv HTML, or one giant JSON blob.

Use the direct paper-source pipeline:

```text
arXiv ID or URL
  -> resolve canonical arXiv metadata
  -> download https://arxiv.org/src/<id>
  -> extract into .ingest/<paperId>/
  -> find main .tex
  -> latexpand main.tex > expanded.tex
  -> pandoc expanded.tex -f latex -t markdown+tex_math_dollars --wrap=none
  -> split Markdown by headings
  -> insert paper + section docs into Postgres
  -> delete .ingest/<paperId>/ after successful ingestion
```

Why this is the happy path:

- arXiv TeX source keeps structural context that PDF-derived text loses.
- `latexpand` flattens multi-file papers by expanding `\input` and `\include`.
- Pandoc can read LaTeX and write Markdown while preserving TeX math as `$...$`
  and `$$...$$`.
- Section Markdown is directly embeddable and inspectable. A giant JSON object is
  harder to diff, harder to debug, and not needed for retrieval.

---

## Backend Surface

Expose exactly 2 Elysia endpoints under the existing `/api/ingest` route group:

1. `POST /api/ingest/resolve_ingest_target`
2. `POST /api/ingest/ingest_paper_source`

Keep Elysia validation at the route boundary with `t.Object(...)`, matching the
current `apps/server/src/features/ingest/routes.ts` style.

---

## 1) `resolve_ingest_target`

### Purpose

Search arXiv for candidate papers before ingestion.

This endpoint currently treats `paperName` as a title/search hint, not as a
fully normalized arXiv identifier contract.

### Signature

```ts
resolve_ingest_target({ paperName: string, query: string })
```

### Behavior

1. Build the arXiv search query:
   `ti:"<paperName>" AND all:"<query>"`.
2. Call `https://export.arxiv.org/api/query` with `start=0`, `max_results=3`,
   `sortBy=relevance`, and `sortOrder=descending`.
3. Parse the Atom XML response with `parseArxivCandidates`.
4. Return the upstream response status, parsed candidate list, and original body.

### Output Shape

```ts
type ArxivCandidate = {
  arxiv_id: string;
  paper_id: string;
  title: string;
  authors: string[];
  summary: string;
  source_url: string;
};

type ResolveIngestTargetResult = {
  status: number;
  ok: boolean;
  result: ArxivCandidate[];
  args: {
    paperName: string;
    query: string;
  };
};
```

Keep this candidate shape small. It should include enough metadata to identify
the right paper, create the `papers` row, and build a paper-level metadata
embedding later.

---

## 2) `ingest_paper_source`

### Purpose

Trigger source-based ingestion for one resolved paper target.

### Signature

```ts
ingest_paper_source({
  arxivId: string;
  paperId: string;
  title: string;
  authors: string[];
  summary: string;
  sourceUrl: string;
})
```

### Request Validation

- `arxivId` must be a valid arXiv identifier with an optional version suffix.
- `paperId` must be `/arxiv/<arxivId>`.
- Do not accept arXiv URLs in this endpoint.
- Callers pass the selected candidate from `resolve_ingest_target`.

### Behavior

1. Validate `arxivId`.
2. Validate `paperId = "/arxiv/<arxivId>"`.
3. Check Postgres for an existing successfully ingested paper with that exact
   `paperId`.
4. If present, return `already_ingested`.
5. Insert or update an ingestion job row as `ingesting`.
6. Create `.ingest/<safe-paper-id>/`.
7. Download `sourceUrl` to `.ingest/<safe-paper-id>/source.tar.gz`.
8. Extract the archive into `.ingest/<safe-paper-id>/src/`.
9. Find the main TeX file.
10. Run `latexpand`.
11. Run `pandoc`.
12. Split `paper.md` into section Markdown files.
13. Build `metadataText` from `title`, `authors`, and `summary`.
14. Embed `metadataText` into `metadataEmbedding`.
15. Embed each section Markdown body.
16. Insert paper metadata, `metadataEmbedding`, and section docs into Postgres in
    one DB transaction.
17. Mark the ingestion job `completed`.
18. Delete `.ingest/<safe-paper-id>/`.

If any step fails, keep the workspace for debugging and mark the job `failed`
with the error message. Only delete files after successful DB commit.

### Response Shape

```ts
type IngestPaperSourceResult = {
  paperId: string;
  arxivId: string;
  status: "already_ingested" | "ingesting" | "completed" | "failed";
  sectionCount?: number;
  message: string;
};
```

For the first implementation, run ingestion inside the request and return
`completed` or `failed`. Add a real queue only after request timeouts become a
measured problem.

---

## Workspace Layout

Create transient ingestion files under the repo root:

```text
.ingest/
  1706.03762v7/
    source.tar.gz
    src/
    expanded.tex
    paper.md
    sections/
      000-abstract.md
      001-introduction.md
      002-background.md
      003-model-architecture.md
      004-scaled-dot-product-attention.md
```

Implementation rules:

- Add `.ingest/` to `.gitignore` when implementation starts.
- Use a safe directory name derived from `arxivId` by replacing `/` with `_`.
- Never write outside `.ingest/<safe-paper-id>/`.
- Delete only `.ingest/<safe-paper-id>/`, not the whole `.ingest/` directory.
- Keep failed workspaces so the broken source archive, Pandoc output, or splitter
  output can be inspected.

---

## Main TeX Selection

Prefer explicit, boring heuristics:

1. Find every `.tex` file containing `\begin{document}`.
2. If exactly one exists, use it.
3. If multiple exist, prefer names like `main.tex`, `paper.tex`, `ms.tex`,
   `article.tex`, or `arxiv.tex`.
4. If still ambiguous, choose the file with the largest byte size.
5. If none exist, fail with `source_not_latex`.

Do not compile the paper. The pipeline needs source text, not a generated PDF.

---

## Command Runner

Use Bun-native APIs for the runtime path:

- `Bun.spawn(...)` when command arguments must be explicit.
- Bun Shell (`import { $ } from "bun"`) for simple local scripts if it keeps the
  code clearer.
- `node:fs/promises` for mkdir/read/write/rm.

Do not add `just-bash` to the ingestion runtime. It is useful for agent-style
shell experimentation, but this server only needs deterministic calls to
`tar`, `latexpand`, and `pandoc`. Adding another command interpreter would be
extra surface area without solving the core ingestion problem.

Required host tools:

```text
tar
latexpand
pandoc
```

Fail fast at server startup or before the first ingestion if `latexpand` or
`pandoc` is missing. The remediation text should name the missing command.

Command shape:

```bash
tar -xzf source.tar.gz -C src
latexpand src/main.tex > expanded.tex
pandoc expanded.tex -f latex -t markdown+tex_math_dollars --wrap=none -o paper.md
```

In TypeScript, avoid shell redirection for `latexpand`; capture stdout and write
`expanded.tex` yourself so failures and paths stay explicit.

---

## Markdown Splitter

Split `paper.md` by Markdown headings:

```text
# Abstract
# 1 Introduction
## 1.1 Background
### 1.1.1 Detail
```

Parser behavior:

- Treat content before the first heading as `Abstract`.
- Preserve Markdown exactly inside each section.
- Preserve LaTeX equations exactly as Pandoc emitted them.
- Keep captions and tables near their surrounding section.
- Create one section record per logical heading section.
- Do not summarize text before embedding.
- Do not strip equations.
- Do not convert equations to prose.

Section file frontmatter:

```md
---
paper_id: "/arxiv/1706.03762v7"
arxiv_id: "1706.03762v7"
section: "3.2.1 Scaled Dot-Product Attention"
section_path:
  - "3 Model Architecture"
  - "3.2 Attention"
  - "3.2.1 Scaled Dot-Product Attention"
source_file: "003-002-001-scaled-dot-product-attention.md"
---

# 3.2.1 Scaled Dot-Product Attention

$$
\operatorname{Attention}(Q,K,V)
=
\operatorname{softmax}\left(\frac{QK^T}{\sqrt{d_k}}\right)V
$$
```

Embed the Markdown body, not the YAML frontmatter.

---

## Document Granularity

Use one doc per logical section. Embed the entire section Markdown body as one
unit.

Do not split oversized sections by token count, paragraph count, or overlap
windows. Modern embedding and retrieval models can handle full paper sections,
and preserving the whole section keeps equations, captions, and local context
together.

Do not put References in the main semantic index. Store references separately or
mark them as `sectionKind: "references"` so retrieval can exclude them by
default.

---

## Context7-Style Storage Model

Treat each paper like a Context7 library namespace:

```text
paperId: /arxiv/1706.03762v7
  docs:
    000 Abstract
    001 1 Introduction
    002 2 Background
    003 3 Model Architecture
    004 3.1 Encoder and Decoder Stacks
    005 3.2 Attention
    006 3.2.1 Scaled Dot-Product Attention
```

`paperId` is the stable namespace identifier. Section and subsection Markdown
files are docs inside that namespace.

This matches the retrieval contract in `docs/context7-specific-rag.md`:

```text
resolve_paper_id({ paperName, query })
  -> exact paperId
query_paper_docs({ paperId, query })
  -> snippets from docs where paper_docs.paper_id = paperId
```

The ingestion job is responsible for creating the namespace and its docs:

```text
papers.id = "/arxiv/<arxivId>"
paper_docs.paper_id = papers.id
paper_docs.id = "<paperId>#<zero-padded-doc-index>"
```

Use `paper_docs`, not `chunks`, because the stored unit is a section document.
The old word "chunk" makes the implementation drift toward arbitrary token
splitting, which is not the desired shape.

---

## Postgres Shape

### pgvector Setup

The current `packages/db/docker-compose.yml` uses the plain `postgres` image.
That image does not guarantee the pgvector extension files exist, so
`create extension vector` may fail.

Use a pgvector-enabled image for local development:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
```

Pin a concrete tag when implementation starts, for example
`pgvector/pgvector:0.8.2-pg17-trixie`.

The setup has two separate steps:

1. Docker image supplies the compiled pgvector extension.
2. SQL migration enables it in this database:

```sql
create extension if not exists vector;
```

After that, Postgres can store vectors with `embedding vector(<dimensions>)` and
query cosine distance with `embedding <=> $queryEmbedding`.

Define the schema in `packages/db/src/schema/index.ts` when implementation
starts. Keep it direct and retrieval-ready:

```ts
papers
  id text primary key                  -- "/arxiv/1706.03762v7"
  arxiv_id text unique not null
  title text not null
  authors jsonb not null
  summary text
  source_url text not null
  metadata_text text not null          -- title + authors + summary
  metadata_embedding vector(<dimensions>)
  abs_url text
  published_at timestamp
  updated_at timestamp
  ingested_at timestamp

paper_docs
  id text primary key                  -- "/arxiv/1706.03762v7#006"
  paper_id text not null references papers(id)
  doc_index integer not null
  section_title text not null
  section_path jsonb not null
  section_level integer not null
  section_kind text not null           -- main | abstract | references | appendix
  markdown text not null
  source_file text not null
  embedding vector(<dimensions>)
  search_text tsvector generated from section_title + markdown

ingestion_jobs
  id text primary key
  paper_id text not null
  arxiv_id text not null
  status text not null             -- ingesting | completed | failed
  error text
  started_at timestamp not null
  completed_at timestamp
```

Recommended constraints and indexes:

```sql
create extension if not exists vector;

alter table paper_docs
  add constraint paper_docs_paper_doc_index_unique unique (paper_id, doc_index);

alter table paper_docs
  add constraint paper_docs_paper_source_file_unique unique (paper_id, source_file);

alter table paper_docs
  add column search_text tsvector
  generated always as (
    to_tsvector('english', coalesce(section_title, '') || ' ' || coalesce(markdown, ''))
  ) stored;

create index paper_docs_paper_order_idx on paper_docs (paper_id, doc_index);
create index paper_docs_paper_kind_idx on paper_docs (paper_id, section_kind);
create index paper_docs_search_idx on paper_docs using gin (search_text);
create index paper_docs_embedding_hnsw_idx
  on paper_docs using hnsw (embedding vector_cosine_ops);
```

Use the HNSW vector index only after the embedding model and vector dimensions
are fixed. For the first implementation, a filtered exact vector order inside
one `paper_id` namespace is acceptable because one paper usually has tens of
section docs, not millions:

```sql
select id, section_title, markdown
from paper_docs
where paper_id = $1
  and section_kind <> 'references'
order by embedding <=> $2
limit 8;
```

For lexical search, keep the same namespace filter:

```sql
select id, section_title, markdown, ts_rank_cd(search_text, query) as score
from paper_docs, websearch_to_tsquery('english', $2) query
where paper_id = $1
  and section_kind <> 'references'
  and search_text @@ query
order by score desc
limit 8;
```

Use Drizzle inserts with `onConflictDoNothing` or `onConflictDoUpdate` for
idempotency. A repeated successful ingest for the same version should not create
duplicate docs.

For paper resolution, build and embed `papers.metadata_text` during ingestion.
Keep the metadata text limited to the selected candidate inputs:

```text
Title: Attention Is All You Need
Authors: Ashish Vaswani, Noam Shazeer, ...
Summary: The dominant sequence transduction models...
```

Store both fields:

```ts
const metadataText = [
  `Title: ${title}`,
  `Authors: ${authors.join(", ")}`,
  `Summary: ${summary}`,
].join("\n");

const metadataEmbedding = await embed(metadataText);
```

That embedding helps `resolve_paper_id` find the correct paper namespace. Section
embeddings in `paper_docs` are for `query_paper_docs` after the namespace is
already known.

Drizzle can define the `vector` column and HNSW index, but the `tsvector`
generated column may be clearer as SQL in a migration. Keep that explicit rather
than hiding it behind a helper.

---

## Retrieval Contract Alignment

Ingestion should store data so the retrieval API can be boring:

```ts
resolve_paper_id({ paperName, query })
query_paper_docs({ paperId, query })
```

`resolve_paper_id` should return paper candidates from `papers` first. It can
fall back to arXiv metadata search only when the paper is not already ingested.

`query_paper_docs` should require an exact `paperId`. It should not run a global
vector search first. The useful Context7 pattern is:

```text
identify namespace -> search docs inside namespace -> return compact snippets
```

For this repo:

```text
paperId -> paper_docs where paper_id = paperId
```

Return docs with citation-ready metadata:

```ts
type PaperDocSnippet = {
  docId: string;
  paperId: string;
  section: string;
  sectionPath: string[];
  markdown: string;
  score: number;
  sourceFile: string;
};
```

Use hybrid retrieval only inside the namespace:

1. Run lexical search for exact terms, symbols, equation names, and acronyms.
2. Run vector search for semantic paraphrases.
3. Merge by `docId`.
4. Return the smallest set of full-section docs that answer the query.

Do not use references docs in default retrieval. Include them only if the query
asks about bibliography, citations, or related work.

---

## Elysia Flow

Current route mount:

```ts
new Elysia()
  .use(logger())
  .use(cors(...))
  .get("/", () => "OK")
  .use(ingestRoutes)
  .listen(3000)
```

Keep ingestion routes in `apps/server/src/features/ingest/routes.ts` and move
non-route behavior into small local modules only when the code exists:

```text
apps/server/src/features/ingest/
  routes.ts        -- Elysia route definitions and validation only
  arxiv.ts         -- arXiv API parsing and ID extraction
  source.ts        -- download/extract/main-tex/latexpand/pandoc
  sections.ts      -- Markdown heading splitter
  repository.ts    -- Drizzle reads/writes for papers, docs, and ingest jobs
```

Do not create generic workflow abstractions before there are multiple workflows.

---

## Failure Policy

Return clear failures:

- `invalid_arxiv_id`
- `arxiv_metadata_not_found`
- `source_download_failed`
- `source_not_latex`
- `main_tex_not_found`
- `latexpand_failed`
- `pandoc_failed`
- `section_split_failed`
- `db_write_failed`

Failures should include:

- `paperId`
- `arxivId`
- `step`
- short user-readable `message`

Do not silently fall back to PDF, HTML scraping, MathML, or LLM repair. If source
ingestion fails, mark it failed and explain the exact step.

---

## References

- arXiv, "Why Submit TeX?": https://info.arxiv.org/help/faq/whytex.html
- arXiv API User Manual: https://info.arxiv.org/help/api/user-manual.html
- arXiv Identifier Format: https://info.arxiv.org/help/arxiv_identifier.html
- Pandoc User's Guide, `tex_math_dollars`: https://pandoc.org/MANUAL.html
- CTAN `latexpand`: https://ctan.org/pkg/latexpand
- Bun Shell docs: https://bun.com/docs/runtime/shell
- Elysia route and validation docs: https://elysiajs.com/essential/route.html
- Drizzle insert/upsert docs: https://orm.drizzle.team/docs/insert
- Drizzle pgvector guide: https://orm.drizzle.team/docs/guides/vector-similarity-search
- Drizzle PostgreSQL extensions, pg_vector: https://orm.drizzle.team/docs/extensions/pg
- pgvector README: https://github.com/pgvector/pgvector
- PostgreSQL full-text search indexes: https://www.postgresql.org/docs/current/textsearch-indexes.html
- PostgreSQL `websearch_to_tsquery`: https://www.postgresql.org/docs/current/textsearch-controls.html

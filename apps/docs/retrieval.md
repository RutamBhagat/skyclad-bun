## Retrieval architecture

This is a **two-stage hybrid retrieval architecture** for paper RAG:

```txt
User query
   │
   ▼
1. Resolve paper namespace
   │
   ▼
2. Search chunks inside that paper
   │
   ├── semantic vector search
   └── lexical full-text search
        │
        ▼
3. Fuse results with RRF
        │
        ▼
Top 3 Markdown chunks returned as RAG context
```

The uploaded retrieval route defines two main endpoints: `/resolve_paper_id` and `/query_paper_docs`, with limits of 3 paper matches, 80 semantic candidates, 80 lexical candidates, and 3 final returned chunks.

---

## 1. Paper resolution stage

Endpoint:

```ts
POST / api / retrieval / resolve_paper_id;
```

Input:

```ts
{
  paperName, query
}
```

The system combines the paper name and user query:

```ts
const searchText = `${body.paperName}\n${body.query}`;
```

Then it embeds that combined text and compares it against:

```ts
papers.metadataEmbedding;
```

using cosine distance:

```ts
const distance = cosineDistance(papers.metadataEmbedding, queryEmbedding);
const confidence = sql<number>`1 - (${distance})`;
```

So this stage answers:

> “Which paper is the user probably asking about?”

It returns the top 3 likely papers, including title, paper ID, arXiv ID, confidence, authors, summary, and source URL.

### Why this stage exists

This avoids searching every chunk from every paper globally. Instead, retrieval first resolves a **paper namespace**, then searches sections only inside that paper.

That gives you this structure:

```txt
papers
  └── paper_docs
        └── chunks for one resolved paper
```

This is a better design for academic-paper retrieval because many papers may share terms like “attention,” “alignment,” “diffusion,” “benchmark,” or “transformer.” Resolving the paper first reduces cross-paper noise

---

## 2. Chunk retrieval stage

Endpoint:

```ts
POST / api / retrieval / query_paper_docs;
```

Input:

```ts
{
  paperId, query, lexicalQuery
}
```

This searches only inside one paper:

```ts
where paperDocs.paperId = body.paperId
```

It runs two searches in parallel:

```txt
semantic search + lexical search
```

---

## 3. Semantic retrieval path

The semantic path embeds the user query:

```ts
const queryEmbedding = await embed(body.query);
```

Then compares it against section embeddings:

```ts
paperDocs.embedding;
```

using cosine distance:

```ts
const semanticDistance = cosineDistance(paperDocs.embedding, queryEmbedding);
const semanticScore = sql<number>`1 - (${semanticDistance})`;
```

Rows are ordered by nearest vector distance:

```ts
.orderBy(asc(semanticDistance))
.limit(semanticCandidateLimit)
```

---

## 4. Lexical retrieval path

The lexical path uses Postgres full-text search:

```ts
websearch_to_tsquery("simple", lexicalQuery);
```

and ranks matches using:

```ts
ts_rank_cd(...)
```

The query condition is:

```ts
paperDocs.searchText @@ websearch_to_tsquery('simple', lexicalQuery)
```

This is the exact-term / keyword channel.

It is especially useful for:

- acronyms
- method names
- benchmark names
- equations or symbols represented as text
- dataset names
- citation terms
- rare technical phrases

Example:

```txt
lexicalQuery: "DPO OR PPO"
```

can force retrieval toward chunks containing those exact technical terms.

---

## 5. Fusion layer: Reciprocal Rank Fusion

The helper code implements **RRF**, or **Reciprocal Rank Fusion**.

Constant:

```ts
const rrfK = 60;
```

Each candidate gets:

```ts
1 / (rrfK + rank);
```

So a rank-1 hit contributes:

```txt
1 / (60 + 1) = 0.0164
```

A rank-80 hit contributes:

```txt
1 / (60 + 80) = 0.0071
```

If the same chunk appears in both semantic and lexical results, it gets both contributions:

```txt
final RRF score =
  semantic rank contribution
  + lexical rank contribution
```

That means the best chunks are usually ones that are:

```txt
semantically relevant
AND/OR
lexically exact
```

But chunks appearing in both channels get a higher weightage

---

## 6. Final ranking

After semantic and lexical candidates are merged into a `Map` by `chunkId`, the system sorts by:

```ts
rrfScore desc
```

Then breaks ties using:

```ts
semanticScore desc
```

Finally it returns:

```ts
finalChunkLimit = 3;
```

So the final output is the top 3 fused chunks.

Each chunk includes:

```ts
{
  chunkId, section, text, rrfScore, semanticScore, lexicalScore
}
```

Returned as Markdown:

```md
Relevant documentation for /arxiv/...
Query: ...
Lexical query: ...

## Section name

Chunk ID: ...
RRF score: ...
Semantic score: ...
Lexical score: ...

<chunk markdown>
```

---

## Architecture diagram

![Retrieval](./retrieval.png)

---

## Retrieval System

This is a namespace-first hybrid RAG retriever, using paper-level vector resolution, section-level semantic search, section-level lexical search, and Reciprocal Rank Fusion to return the top Markdown chunks as context

Or more compactly:

```txt
paper-level semantic routing
        +
section-level hybrid retrieval
        +
RRF reranking
```

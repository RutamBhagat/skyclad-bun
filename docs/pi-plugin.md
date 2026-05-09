# PI Extension-Only Customization for arXiv Ingestion + Retrieval

This guide is extension-specific only.

It implements a strict split between ingestion and retrieval in Pi:

1. `resolve_ingest_target`
2. `ingest_paper_html`
3. `resolve_paper_id`
4. `query_paper_docs`

## Design intent

- Ingestion tools handle external discovery + HTML ingestion kickoff.
- Retrieval tools operate only on already-ingested DB corpora.
- No wrappers, aliases, or compatibility branches.

## MCP position in Pi

Pi does not treat MCP as a core built-in feature. Keep this as a direct extension implementation first. Add MCP only when a separate MCP client is needed.

## Final target behavior

Expose exactly four Pi tools from your extension:

- `resolve_ingest_target({ paperName })`
- `ingest_paper_html({ htmlUrl })`
- `resolve_paper_id({ paperName, query })`
- `query_paper_docs({ paperId, query })`

Runtime behavior:

- Ingestion route accepts only direct arXiv HTML URL.
- `resolve_ingest_target` returns arXiv candidates with `arxiv_id` (not `htmlUrl`).
- Retrieval route resolves from DB only and never triggers ingestion.
- Query route returns `NOT_INGESTED` when corpus is missing.

## Where to place extension code

Use project-local extension path:

- `.pi/extensions/paper-rag/index.ts`

## Minimal extension example

Path: `.pi/extensions/paper-rag/index.ts`

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type ResolveIngestTargetInput = { paperName: string };
type ResolveInput = { paperName: string; query: string };
type QueryInput = { paperId: string; query: string };
type IngestInput = { htmlUrl: string };

const CANONICAL_PAPER_ID = /^\/arxiv\/[A-Za-z0-9.\-\/]+(?:v\d+)?$/;
const ARXIV_HTML_URL =
  /^https:\/\/arxiv\.org\/html\/[A-Za-z0-9.\-\/]+(?:v\d+)?$/;

async function callBackend<T>(path: string, body: unknown): Promise<T> {
  const baseUrl = process.env.PAPER_RAG_BASE_URL;
  if (!baseUrl) throw new Error("PAPER_RAG_BASE_URL is not set");

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Backend error ${response.status}: ${text}`);
  }

  return (await response.json()) as T;
}

export default function setup(pi: ExtensionAPI) {
  pi.registerTool({
    name: "resolve_ingest_target",
    label: "Resolve Ingest Target",
    description:
      "Resolve title/id/url to a canonical arXiv paper target for HTML ingestion.",
    parameters: Type.Object({
      paperName: Type.String(),
    }),
    async execute(_toolCallId, params: ResolveIngestTargetInput) {
      const result = await callBackend<unknown>("/resolve_ingest_target", params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "ingest_paper_html",
    label: "Ingest Paper HTML",
    description:
      "Queue HTML-only ingestion for an arXiv paper by direct arXiv HTML URL.",
    parameters: Type.Object({
      htmlUrl: Type.String(),
    }),
    async execute(_toolCallId, params: IngestInput) {
      if (!ARXIV_HTML_URL.test(params.htmlUrl)) {
        throw new Error(
          "Invalid htmlUrl. Expected https://arxiv.org/html/<id> or https://arxiv.org/html/<id>vN.",
        );
      }

      const result = await callBackend<unknown>("/ingest_paper_html", params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "resolve_paper_id",
    label: "Resolve Ingested Paper ID",
    description:
      "Resolve user paper reference against already-ingested DB papers only.",
    parameters: Type.Object({
      paperName: Type.String(),
      query: Type.String(),
    }),
    async execute(_toolCallId, params: ResolveInput) {
      const result = await callBackend<unknown>("/resolve_paper_id", params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "query_paper_docs",
    label: "Query Paper Docs",
    description:
      "Query grounded snippets for an already-ingested canonical paperId.",
    parameters: Type.Object({
      paperId: Type.String(),
      query: Type.String(),
    }),
    async execute(_toolCallId, params: QueryInput) {
      if (!CANONICAL_PAPER_ID.test(params.paperId)) {
        throw new Error(
          "Invalid paperId. Expected /arxiv/<id> or /arxiv/<id>vN format.",
        );
      }

      const result = await callBackend<unknown>("/query_paper_docs", params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {},
      };
    },
  });
}
```

## Convex compatibility (no separate REST server required)

Use Convex HTTP Actions as your external API surface.

Define routes in `convex/http.ts` for:

- `/resolve_ingest_target`
- `/ingest_paper_html`
- `/resolve_paper_id`
- `/query_paper_docs`

If you use this pattern, set:

```bash
export PAPER_RAG_BASE_URL="https://<deployment>.convex.site"
```

## Background ingestion with Convex

Yes, Convex supports background workflows:

- In an HTTP action or mutation, schedule ingestion via `ctx.scheduler.runAfter(0, internal....)`.
- Return immediately to the Pi tool call.
- Persist ingestion state in DB and let retrieval remain read-only.

## Loading and running

Use extension-only run for validation:

```bash
pi --no-extensions -e ./.pi/extensions/paper-rag/index.ts
```

## Validation checklist

1. Resolve target and confirm returned candidates include `arxiv_id`.
2. Trigger `ingest_paper_html` and confirm immediate status (`queued` or `already_ingested`).
3. Resolve on retrieval side via `resolve_paper_id` and ensure DB-only matches.
4. Query with `query_paper_docs` and confirm grounded snippets are returned.
5. Query for a non-ingested paper and confirm `NOT_INGESTED` behavior.

## Implementation boundaries

Keep extension responsibilities narrow:

- input schema validation
- canonical ID guard
- backend invocation
- structured tool output

Do not move ranking, ingestion parsing, or retrieval logic into the Pi extension.

## Sources

- Pi coding agent README:  
  https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md
- Pi extensions docs:  
  https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- Convex HTTP Actions:  
  https://docs.convex.dev/functions/http-actions
- Convex Scheduled Functions:  
  https://docs.convex.dev/scheduling/scheduled-functions

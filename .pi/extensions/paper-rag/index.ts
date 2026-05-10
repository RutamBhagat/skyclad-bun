//@ts-ignore
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
//@ts-ignore
import { Type } from "typebox";

type ResolvePaperIdInput = {
  paperName: string;
  query: string;
};

type QueryPaperDocsHybridInput = {
  paperId: string;
  query: string;
  lexicalQuery: string;
};

const DEFAULT_PAPER_RAG_BASE_URL = "http://localhost:3000";

async function callBackend<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${DEFAULT_PAPER_RAG_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Backend error ${response.status}: ${errorText}`);
  }

  return (await response.json()) as T;
}

function weakText(value: unknown, min = 12): boolean {
  return typeof value !== "string" || value.trim().length < min;
}

export default function setup(pi: ExtensionAPI) {
  pi.registerTool({
    name: "resolve_paper_id",
    label: "Resolve Paper ID",
    description:
      "Resolve a paper reference to a canonical paperId and verify whether that paper is indexed in the DB. Use this first unless a trusted paperId is already known.",
    promptSnippet: "Resolve paper references to canonical indexed paper IDs for paper RAG.",
    promptGuidelines: [
      "Before using resolve_paper_id, ask the user a clarification question with questionnaire when paperName is incomplete, ambiguous, acronym-only, author-only, or could match multiple papers.",
      "Do not invent paperId values. If resolution is uncertain or returns multiple candidates, ask a follow-up clarification question before querying paper docs.",
    ],
    parameters: Type.Object({
      paperName: Type.String(),
      query: Type.String(),
    }),
    //@ts-ignore
    async execute(_toolCallId, params: ResolvePaperIdInput) {
      const result = await callBackend<unknown>("/api/retrieval/resolve_paper_id", params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {},
      };
    },
  });

    pi.registerTool({
    name: "query_paper_docs_hybrid",
    label: "Query Paper Docs Hybrid",
    description:
      "Retrieve grounded snippets using semantic query + lexical query. Only use lexicalQuery for exact strings like quotes, symbols, citation keys, formula tokens, or section labels.",
    promptSnippet: "Query indexed paper documents for grounded snippets after a paperId is known.",
    promptGuidelines: [
      "Before using query_paper_docs, ask the user a clarification question with questionnaire when the query is too broad or lacks target concept, claim, section, method, dataset, metric, comparison, table, figure, or output format.",
      "For paper RAG, prefer this flow: questionnaire -> resolve_paper_id -> query_paper_docs. Retry query_paper_docs with a sharper query when snippets are weak.",
    ],
    parameters: Type.Object({
      paperId: Type.String(),
      query: Type.String(),
      lexicalQuery: Type.String(),
    }),
    //@ts-ignore
    async execute(_toolCallId, params: QueryPaperDocsHybridInput) {
      const result = await callBackend<unknown>("/api/retrieval/query_paper_docs_hybrid", params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {},
      };
    },
  });

  //@ts-ignore
  pi.on("tool_call", async (event) => {
    if (event.toolName === "resolve_paper_id") {
      const paperName = event.input.paperName;
      const query = event.input.query;
      if (weakText(paperName, 8) || weakText(query, 12)) {
        return {
          block: true,
          reason:
            "Paper RAG guard: paperName/query are too underspecified. Ask clarification questions with questionnaire before calling resolve_paper_id.",
        };
      }
    }
    if (event.toolName === "query_paper_docs") {
      const paperId = event.input.paperId;
      const query = event.input.query;
      if (weakText(paperId, 4) || weakText(query, 16)) {
        return {
          block: true,
          reason:
            "Paper RAG guard: paperId/query are too underspecified. Ask clarification questions with questionnaire, or resolve paperId first.",
        };
      }
    }
  });
}

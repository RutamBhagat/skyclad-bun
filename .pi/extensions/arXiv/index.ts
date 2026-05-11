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

async function callBackend(path: string, body: unknown): Promise<string> {
  const response = await fetch(`${DEFAULT_PAPER_RAG_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      accept: "text/markdown, text/plain;q=0.9",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Backend error ${response.status}: ${errorText}`);
  }

  return response.text();
}

function weakText(value: unknown, min = 12): boolean {
  return typeof value !== "string" || value.trim().length < min;
}

export default function setup(pi: ExtensionAPI) {
  pi.registerTool({
    name: "resolve_paper_id",
    label: "Resolve Paper ID",
    description:
      "Resolve a paper reference to a canonical indexed paperId. Use this before querying paper docs unless a trusted paperId is already known.",
    promptSnippet:
      "Resolve an arXiv/paper reference to a canonical indexed paperId before fetching grounded snippets when the exact paperId is unknown.",
    promptGuidelines: [
      "Use resolve_paper_id when the user asks about a paper and you do not already know the exact indexed paperId.",
      "Before using resolve_paper_id, ask the user a clarification question with `rpiv-ask-user-question` when paperName is incomplete, ambiguous, acronym-only, author-only, or could match multiple papers.",
      "Pass paperName as the best available title, arXiv ID, citation, or author/title hint; pass query as the user's research task or intent to help rank matches.",
      "Do not invent paperId values. If resolution is uncertain or returns multiple candidates, ask a follow-up clarification question before querying paper docs.",
    ],
    parameters: Type.Object({
      paperName: Type.String({
        description: "Paper title, arXiv ID, citation, or author/title hint to resolve.",
      }),
      query: Type.String({
        description: "User's research question or intent used to rank matching papers.",
      }),
    }),
    //@ts-ignore
    async execute(_toolCallId, params: ResolvePaperIdInput) {
      const text = await callBackend("/api/retrieval/resolve_paper_id", params);
      return {
        content: [{ type: "text", text }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "query_paper_docs",
    label: "Query Paper Docs",
    description:
      "Retrieve grounded snippets from indexed paper documents using a hybrid semantic query + lexical query",
    promptSnippet:
      "Fetch grounded snippets from an indexed arXiv/paper document by paperId. Prefer resolve_paper_id first when the exact paperId is unknown.",
    promptGuidelines: [
      "Use query_paper_docs only after a paperId is known from resolve_paper_id or from a trusted user-provided paperId.",
      "Before using query_paper_docs, ask the user a clarification question with `rpiv-ask-user-question` when the query is too broad or lacks target concept, claim, section, method, dataset, metric, comparison, table, figure, or output format.",
      "Make query a focused natural-language retrieval request that includes the target concept, section, claim, method, dataset, metric, comparison, table, figure, or desired evidence.",
      "Only use lexicalQuery for exact strings like quotes, symbols, citation keys, formula tokens, acronyms, dataset names, metric names, table/figure labels, or section titles. Leave it as the best exact-term subset of the query when no quote/label is known.",
      "For paper RAG, prefer this flow: `rpiv-ask-user-question` -> resolve_paper_id -> query_paper_docs. Retry query_paper_docs with a sharper query if snippets are weak.",
      "When answering from snippets, cite the returned section/chunk context and quote exact source text when possible; do not claim evidence that is not present in the retrieved snippets.",
    ],
    parameters: Type.Object({
      paperId: Type.String({
        description: "Exact indexed paperId returned by resolve_paper_id or provided by a trusted source.",
      }),
      query: Type.String({
        description: "Focused natural-language retrieval request for the paper content.",
      }),
      lexicalQuery: Type.String({
        description:
          "Exact lexical terms for hybrid retrieval: quotes, symbols, formula tokens, acronyms, dataset/metric names, section titles, or table/figure labels.",
      }),
    }),
    //@ts-ignore
    async execute(_toolCallId, params: QueryPaperDocsHybridInput) {
      const text = await callBackend("/api/retrieval/query_paper_docs", params);
      return {
        content: [{ type: "text", text }],
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

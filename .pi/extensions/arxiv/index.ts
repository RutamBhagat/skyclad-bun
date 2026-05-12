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
      "Retrieve grounded snippets from indexed paper documents using a focused semantic query plus a PostgreSQL web-search lexical query.",
    promptSnippet:
      "Fetch grounded snippets from an indexed arXiv/paper document by paperId. Provide a focused natural-language query and an agent-formed lexicalQuery that uses OR for alternatives, acronyms, and terminology variants.",
    promptGuidelines: [
      "Use query_paper_docs only after a paperId is known from resolve_paper_id or from a trusted user-provided paperId.",
      "Before using query_paper_docs, ask the user a clarification question with `rpiv-ask-user-question` when the query is too broad or lacks target concept, claim, section, method, dataset, metric, comparison, table, figure, or output format.",
      "Make query a focused natural-language retrieval request that includes the target concept, section, claim, method, dataset, metric, comparison, table, figure, or desired evidence.",
      "Always form lexicalQuery as a separate exact-term retrieval string. Do not ask the user to handcraft lexicalQuery unless an exact term, label, metric, table, figure, or acronym is genuinely ambiguous and necessary.",
      "lexicalQuery is parsed by PostgreSQL websearch_to_tsquery. Unquoted space-separated terms behave like AND, so do not use `rnn cnn` when either term should match. Use explicit OR for alternatives: `recurrent OR convolutional OR RNN OR CNN`.",
      "Use lexicalQuery for quoted phrases, symbols, citation keys, formula tokens, acronyms, dataset names, metric names, table/figure labels, section titles, and obvious terminology variants from the user's request or paper context.",
      "Prefer 2-8 precise lexical terms or quoted phrases. Remove generic words like paper, according, what, problem, result, method, model, and approach unless they are part of an exact phrase.",
      "Include both acronym and expanded form when either may appear in the paper text, such as `RNN OR recurrent`, `CNN OR convolutional`, `NMT OR neural machine translation`, or `RLHF OR reinforcement learning from human feedback`.",
      "Use quotes for exact multi-word phrases that should stay together, such as `\"scaled dot-product attention\" OR \"multi-head attention\"` or `\"long-range dependencies\" OR \"sequential operations\"`.",
      "For exact labels, include likely variants with OR: `Table 1 OR tab:op_complexities OR O(n)`, `Figure 2 OR fig:architecture`, or `Section 3.2 OR \"scaled dot-product attention\"`.",
      "If no useful exact lexical terms are known, use a short OR expression from the core technical terms in the user's request. If even that would be noise, pass an empty string for lexicalQuery and rely on semantic retrieval.",
      "For paper RAG, prefer this flow: `rpiv-ask-user-question` -> resolve_paper_id -> query_paper_docs. Retry query_paper_docs with a sharper query and revised lexicalQuery if snippets are weak.",
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
          "Agent-formed PostgreSQL websearch lexical query. Use exact terms, quoted phrases, symbols, formula tokens, acronyms, dataset/metric names, section titles, table/figure labels, and OR-expanded variants such as `recurrent OR convolutional OR RNN OR CNN`.",
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

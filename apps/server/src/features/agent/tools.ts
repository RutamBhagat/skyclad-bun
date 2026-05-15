import type { AgentTool } from "@earendil-works/pi-agent-core";
import nerdamer from "nerdamer";
import "nerdamer/Algebra";
import { Type } from "typebox";

import { queryPaperDocsMarkdown, resolvePaperIdMarkdown } from "../retrieval/service";

const resolvePaperIdParameters = Type.Object({
  paperName: Type.String({
    description: "Paper title, arXiv ID, citation, or author/title hint to resolve.",
  }),
  query: Type.String({
    description: "User's research question or intent used to rank matching papers.",
  }),
});

const queryPaperDocsParameters = Type.Object({
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
});

const calculateParameters = Type.Object({
  expression: Type.String({
    description:
      "Mathematical expression to evaluate, simplify, or expand.",
  }),
});

function calculateExpression(expression: string) {
  return nerdamer(expression).evaluate().text();
}

export const resolvePaperIdTool: AgentTool<typeof resolvePaperIdParameters> = {
  name: "resolve_paper_id",
  label: "Resolve Paper ID",
  description:
    "Resolve a paper reference to a canonical indexed paperId. Use this before querying paper docs unless a trusted paperId is already known. Pass paperName as the best available title, arXiv ID, citation, or author/title hint, and pass query as the user's research task or intent to help rank matches. Do not invent paperId values.",
  parameters: resolvePaperIdParameters,
  execute: async (_toolCallId, params, signal) => {
    if (signal?.aborted) throw new Error("Aborted");

    const markdown = await resolvePaperIdMarkdown({
      paperName: params.paperName,
      query: params.query,
    });

    return {
      content: [{ type: "text", text: markdown }],
      details: params,
    };
  },
};

export const queryPaperDocsTool: AgentTool<typeof queryPaperDocsParameters> = {
  name: "query_paper_docs",
  label: "Query Paper Docs",
  description:
    "Retrieve grounded snippets from indexed paper documents using a focused semantic query plus a PostgreSQL web-search lexical query. Use only after a paperId is known from resolve_paper_id or from a trusted user-provided paperId. Make query focused on the target concept, claim, section, method, dataset, metric, comparison, table, figure, or desired evidence. Always form lexicalQuery as exact terms, quoted phrases, symbols, formula tokens, acronyms, dataset/metric names, section titles, table/figure labels, and OR-expanded variants. Prefer 2-8 precise lexical terms; use an empty lexicalQuery only when no useful exact terms are known.",
  parameters: queryPaperDocsParameters,
  execute: async (_toolCallId, params, signal) => {
    if (signal?.aborted) throw new Error("Aborted");

    const markdown = await queryPaperDocsMarkdown({
      paperId: params.paperId,
      query: params.query,
      lexicalQuery: params.lexicalQuery,
    });

    return {
      content: [{ type: "text", text: markdown }],
      details: params,
    };
  },
};

export const calculateTool: AgentTool<typeof calculateParameters> = {
  name: "calculate",
  label: "Calculator",
  description:
    "Evaluate numeric expressions and simplify or expand symbolic expressions.",
  parameters: calculateParameters,
  execute: async (_toolCallId, params, signal) => {
    if (signal?.aborted) throw new Error("Aborted");

    const result = calculateExpression(params.expression);

    return {
      content: [{ type: "text", text: `${params.expression} = ${result}` }],
      details: { expression: params.expression, result },
    };
  },
};

export const defaultServerTools = [resolvePaperIdTool, queryPaperDocsTool, calculateTool];

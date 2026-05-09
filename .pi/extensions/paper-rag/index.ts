//@ts-ignore
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
//@ts-ignore
import { Type } from "typebox";

type ResolveIngestTargetInput = {
  paperName: string;
};

type IngestPaperSourceInput = {
  arxivId: string;
  paperId: string;
  title: string;
  authors: string[];
  summary: string;
  sourceUrl: string;
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

export default function setup(pi: ExtensionAPI) {
  pi.registerTool({
    name: "resolve_ingest_target",
    label: "Resolve Ingest Target",
    description:
      "Resolve a paper reference to an arXiv source ingestion target. NOTE: Do not retry if you encounter 429 status code",
    parameters: Type.Object({
      paperName: Type.String(),
    }),
    //@ts-ignore
    async execute(_toolCallId, params: ResolveIngestTargetInput) {
      const result = await callBackend<unknown>("/api/ingest/resolve_ingest_target", params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "ingest_paper_source",
    label: "Ingest Paper Source",
    description:
      "Ingest a selected arXiv source target. Use this after resolve_ingest_target with one of its returned candidates unless the same fields were supplied from elsewhere.",
    parameters: Type.Object({
      arxivId: Type.String(),
      paperId: Type.String(),
      title: Type.String(),
      authors: Type.Array(Type.String()),
      summary: Type.String(),
      sourceUrl: Type.String(),
    }),
    //@ts-ignore
    async execute(_toolCallId, params: IngestPaperSourceInput) {
      const result = await callBackend<unknown>("/api/ingest/ingest_paper_source", params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {},
      };
    },
  });
}

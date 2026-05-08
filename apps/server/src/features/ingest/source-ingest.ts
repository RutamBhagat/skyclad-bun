type IngestPaperSourceInput = {
  arxivId: string;
  paperId: string;
  title: string;
  authors: string[];
  summary: string;
  sourceUrl: string;
};

export async function ingestPaperSource(input: IngestPaperSourceInput) {
  return {
    paperId: input.paperId,
    arxivId: input.arxivId,
    status: "ingesting" as const,
    message: "Paper source ingestion started.",
  };
}

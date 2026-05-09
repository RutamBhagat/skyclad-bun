import { XMLParser } from "fast-xml-parser";

type ArxivCandidate = {
  arxiv_id: string;
  paper_id: string;
  title: string;
  authors: string[];
  summary: string;
  source_url: string;
};

export function parseArxivCandidates(rawResponse: string): ArxivCandidate[] {
  const parser = new XMLParser({
    ignoreDeclaration: true,
    parseTagValue: false,
    isArray: (tagName) => tagName === "entry" || tagName === "author",
  });

  const parsedResponse = parser.parse(rawResponse) as {
    feed?: {
      entry?: Array<{
        id: string;
        title: string;
        summary: string;
        author: Array<{ name: string }>;
      }>;
    };
  };

  const entries = parsedResponse.feed?.entry;
  if (!entries) return [];

  const candidatesByPaperId = new Map<string, ArxivCandidate>();

  for (const entry of entries) {
    const arxivId = entry.id
      .replace("http://arxiv.org/abs/", "")
      .replace("https://arxiv.org/abs/", "");
    const baseArxivId = arxivId.replace(/v\d+$/i, "");
    const authors = entry.author.map((author) => author.name);

    const paperId = `/arxiv/${baseArxivId}`;
    if (candidatesByPaperId.has(paperId)) continue;

    candidatesByPaperId.set(paperId, {
      arxiv_id: baseArxivId,
      paper_id: paperId,
      title: entry.title,
      authors,
      summary: entry.summary,
      source_url: `https://arxiv.org/src/${baseArxivId}`,
    });
  }

  return [...candidatesByPaperId.values()];
}

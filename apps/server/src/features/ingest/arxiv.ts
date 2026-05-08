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

  return entries.map((entry) => {
    const arxivId = entry.id
      .replace("http://arxiv.org/abs/", "")
      .replace("https://arxiv.org/abs/", "");
    const authors = entry.author.map((author) => author.name);

    return {
      arxiv_id: arxivId,
      paper_id: `/arxiv/${arxivId}`,
      title: entry.title,
      authors,
      summary: entry.summary,
      source_url: `https://arxiv.org/src/${arxivId}`,
    };
  });
}

const rrfK = 60;

export type RetrievedChunk = {
  chunkId: string;
  section: string;
  text: string;
  rrfScore: number;
  semanticRank?: number;
  englishLexicalRank?: number;
  simpleLexicalRank?: number;
  semanticScore?: number;
  englishLexicalScore?: number;
  simpleLexicalScore?: number;
};

export function formatScore(score: number | undefined) {
  if (score === undefined || Number.isNaN(score)) return "n/a";
  return score.toFixed(4);
}

export function addRrfCandidate(
  candidates: Map<string, RetrievedChunk>,
  row: {
    chunkId: string;
    section: string;
    text: string;
    score?: number | null;
  },
  rank: number,
  source: "semantic" | "englishLexical" | "simpleLexical",
) {
  const existing = candidates.get(row.chunkId) ?? {
    chunkId: row.chunkId,
    section: row.section,
    text: row.text,
    rrfScore: 0,
  };

  existing.rrfScore += 1 / (rrfK + rank);

  const score = row.score == null ? undefined : Number(row.score);

  if (source === "semantic") {
    existing.semanticRank = rank;
    existing.semanticScore = score;
  } else if (source === "englishLexical") {
    existing.englishLexicalRank = rank;
    existing.englishLexicalScore = score;
  } else {
    existing.simpleLexicalRank = rank;
    existing.simpleLexicalScore = score;
  }

  candidates.set(row.chunkId, existing);
}
const rrfK = 60;

export type RetrievedChunk = {
  chunkId: string;
  section: string;
  text: string;
  rrfScore: number;
  semanticScore?: number;
  lexicalScore?: number;
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
  source: "semantic" | "lexical",
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
    existing.semanticScore = score;
  } else {
    existing.lexicalScore = score;
  }

  candidates.set(row.chunkId, existing);
}

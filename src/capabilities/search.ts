import type { CapabilitySummary } from "./types.js";

export interface CapabilitySearchCandidate {
  summary: CapabilitySummary;
  aliases?: string[];
}

export interface CapabilitySearchResult {
  capability: CapabilitySummary;
  score: number;
}

export function searchCapabilityCandidates(
  candidates: CapabilitySearchCandidate[],
  query: string,
  limit: number,
): CapabilitySearchResult[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const documents = candidates.map((candidate) => weightedTerms(candidate));
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(document)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0)
    / Math.max(1, documents.length);
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return candidates
    .map((candidate, index) => {
      const document = documents[index] ?? [];
      const frequencies = frequencyMap(document);
      let score = 0;
      for (const term of terms) {
        const frequency = frequencies.get(term) ?? 0;
        if (frequency === 0) continue;
        const containing = documentFrequency.get(term) ?? 0;
        const inverseFrequency = Math.log(1 + (candidates.length - containing + 0.5) / (containing + 0.5));
        const lengthScale = 1 - 0.75 + 0.75 * (document.length / Math.max(1, averageLength));
        score += inverseFrequency * ((frequency * 2.2) / (frequency + 1.2 * lengthScale));
      }
      if (candidate.summary.id === normalizedQuery) score += 100;
      if (candidate.summary.title.toLocaleLowerCase() === normalizedQuery) score += 50;
      return { capability: candidate.summary, score: roundScore(score) };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score
      || left.capability.id.localeCompare(right.capability.id))
    .slice(0, limit);
}

function weightedTerms(candidate: CapabilitySearchCandidate): string[] {
  return [
    ...repeat(tokenize(candidate.summary.id), 4),
    ...repeat(tokenize(candidate.summary.providerId), 4),
    ...repeat(tokenize(candidate.summary.title), 3),
    ...repeat(candidate.summary.tags.flatMap(tokenize), 3),
    ...repeat((candidate.aliases ?? []).flatMap(tokenize), 2),
    ...tokenize(candidate.summary.description),
  ];
}

function tokenize(value: string): string[] {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const words = normalized.match(/[a-z0-9_-]+|[\p{Script=Han}]+/gu) ?? [];
  return words.flatMap((word) => {
    if (!/^[\p{Script=Han}]+$/u.test(word)) return [word];
    const characters = [...word];
    return [
      ...characters,
      ...characters.slice(0, -1).map((character, index) => character + characters[index + 1]),
    ];
  });
}

function repeat(values: string[], count: number): string[] {
  return Array.from({ length: count }, () => values).flat();
}

function frequencyMap(values: string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const value of values) frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
  return frequencies;
}

function roundScore(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

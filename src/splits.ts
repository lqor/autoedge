import type { ResolvedExample, Split, SplitManifest } from "./types.js";

export function buildSplitManifest(examples: ResolvedExample[]): SplitManifest {
  const sorted = [...examples].sort(
    (left, right) => new Date(left.settlementTime).valueOf() - new Date(right.settlementTime).valueOf(),
  );

  const assignments: Record<string, Split> = {};
  const trainCount = computeTrainCount(sorted.length);

  sorted.forEach((example, index) => {
    assignments[example.marketId] = index < trainCount ? "train" : "holdout";
  });

  return {
    createdAt: new Date().toISOString(),
    assignments,
  };
}

export function applySplitManifest(
  examples: ResolvedExample[],
  manifest: SplitManifest,
): ResolvedExample[] {
  return examples
    .filter((example) => manifest.assignments[example.marketId])
    .map((example) => ({
      ...example,
      split: manifest.assignments[example.marketId],
    }));
}

export function selectSplit(
  examples: ResolvedExample[],
  split: Split | "all",
): ResolvedExample[] {
  if (split === "all") {
    return examples;
  }

  return examples.filter((example) => example.split === split);
}

function computeTrainCount(totalCount: number): number {
  if (totalCount <= 1) {
    return totalCount;
  }

  const proposed = Math.floor(totalCount * 0.8);
  return Math.min(totalCount - 1, Math.max(1, proposed));
}


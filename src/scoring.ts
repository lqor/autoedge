import type { EvaluationSummary, ForecastResult, ResolvedExample, ScoredForecast } from "./types.js";
import { clampProbability, roundToSix } from "./utils.js";

export function logLoss(probability: number, outcome: 0 | 1): number {
  const p = clampProbability(probability);
  const loss = outcome === 1 ? -Math.log(p) : -Math.log(1 - p);
  return roundToSix(loss);
}

export function scoreForecasts(
  forecasts: ForecastResult[],
  examples: ResolvedExample[],
  split: EvaluationSummary["split"],
): EvaluationSummary {
  if (forecasts.length !== examples.length) {
    throw new Error(
      `Forecast count ${forecasts.length} does not match example count ${examples.length}`,
    );
  }

  const scored: ScoredForecast[] = forecasts.map((forecast, index) => {
    const example = examples[index];
    const policyLogLoss = logLoss(forecast.probability, example.outcome);
    const marketLogLoss = logLoss(example.marketProbability, example.outcome);

    return {
      ...forecast,
      outcome: example.outcome,
      policyLogLoss,
      marketLogLoss,
    };
  });

  const policyLogLoss = average(scored.map((item) => item.policyLogLoss));
  const marketLogLoss = average(scored.map((item) => item.marketLogLoss));

  return {
    split,
    sampleCount: scored.length,
    policyLogLoss,
    marketLogLoss,
    deltaVsMarket: roundToSix(policyLogLoss - marketLogLoss),
    examples: scored,
  };
}

export function formatTrainingSummary(summary: EvaluationSummary, topN = 10): string {
  const hardest = [...summary.examples]
    .sort((left, right) => {
      const leftGap = left.policyLogLoss - left.marketLogLoss;
      const rightGap = right.policyLogLoss - right.marketLogLoss;
      return rightGap - leftGap;
    })
    .slice(0, topN);

  const lines = [
    `Training split sample count: ${summary.sampleCount}`,
    `Policy average log loss: ${summary.policyLogLoss.toFixed(6)}`,
    `Market average log loss: ${summary.marketLogLoss.toFixed(6)}`,
    `Delta vs market: ${summary.deltaVsMarket.toFixed(6)}`,
    "Worst policy misses relative to the market:",
  ];

  for (const example of hardest) {
    lines.push(
      `- ${example.ticker} | market ${example.marketProbability.toFixed(3)} | policy ${example.probability.toFixed(3)} | outcome ${example.outcome} | policy log loss ${example.policyLogLoss.toFixed(6)} | market log loss ${example.marketLogLoss.toFixed(6)} | rationale: ${example.rationale}`,
    );
  }

  return lines.join("\n");
}

function average(values: number[]): number {
  if (values.length === 0) {
    throw new Error("Cannot average an empty list");
  }

  return roundToSix(values.reduce((sum, value) => sum + value, 0) / values.length);
}


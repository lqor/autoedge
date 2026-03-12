import { describe, expect, it } from "vitest";

import { logLoss, scoreForecasts } from "../src/scoring.js";
import type { ForecastResult, ResolvedExample } from "../src/types.js";

describe("scoring", () => {
  it("computes log loss for yes and no outcomes", () => {
    expect(logLoss(0.8, 1)).toBeCloseTo(0.223144, 6);
    expect(logLoss(0.2, 0)).toBeCloseTo(0.223144, 6);
  });

  it("scores policy and market baselines side by side", () => {
    const examples: ResolvedExample[] = [
      {
        marketId: "m1",
        ticker: "M1",
        title: "Example",
        snapshotTime: "2026-01-01T00:00:00.000Z",
        settlementTime: "2026-01-02T00:00:00.000Z",
        marketProbability: 0.4,
        yesBid: null,
        yesAsk: null,
        noBid: null,
        noAsk: null,
        lastPrice: 0.4,
        volume: 100,
        liquidity: 1000,
        openInterest: 100,
        rawSource: "historical",
        outcome: 1,
      },
    ];

    const forecasts: ForecastResult[] = [
      {
        marketId: "m1",
        ticker: "M1",
        title: "Example",
        policyVersionHash: "hash",
        probability: 0.7,
        rationale: "test",
        marketProbability: 0.4,
        disagreement: 0.3,
        runId: "run",
        timestamp: "2026-01-01T00:00:00.000Z",
        snapshot: examples[0],
      },
    ];

    const summary = scoreForecasts(forecasts, examples, "holdout");
    expect(summary.policyLogLoss).toBeLessThan(summary.marketLogLoss);
    expect(summary.sampleCount).toBe(1);
  });
});

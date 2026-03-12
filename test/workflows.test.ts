import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  appendLiveEvent,
  ensureProjectLayout,
  readExperimentRuns,
  readLiveEvents,
  readSplitManifest,
  writeActivePolicy,
  writeResolvedExamples,
  writeSplitManifest,
} from "../src/storage.js";
import type {
  AppDeps,
} from "../src/workflows.js";
import { materializeLiveEvents, runImprove, runPublish, runSync } from "../src/workflows.js";
import type { MarketSnapshot, ResolvedExample, SplitManifest } from "../src/types.js";

describe("workflows", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoedge-test-"));
    await fs.mkdir(path.join(rootDir, "policy"), { recursive: true });
  });

  it("promotes only when candidate holdout log loss improves and never leaks holdout raw examples", async () => {
    const config = loadConfig(rootDir);
    await ensureProjectLayout(config);
    await writeActivePolicy(config, "# Baseline policy\n\nKeep close to market.");

    const examples: ResolvedExample[] = [
      buildResolvedExample({
        marketId: "train-1",
        ticker: "TRAIN1",
        title: "Train market one",
        marketProbability: 0.35,
        outcome: 1,
        settlementTime: "2026-01-01T00:00:00.000Z",
      }),
      buildResolvedExample({
        marketId: "holdout-1",
        ticker: "HOLD1",
        title: "Holdout market should stay private",
        marketProbability: 0.55,
        outcome: 1,
        settlementTime: "2026-02-01T00:00:00.000Z",
      }),
    ];

    const manifest: SplitManifest = {
      createdAt: new Date().toISOString(),
      assignments: {
        "train-1": "train",
        "holdout-1": "holdout",
      },
    };

    await writeResolvedExamples(config, examples);
    await writeSplitManifest(config, manifest);

    type RevisePolicyArgs = {
      trainingSummary: string;
      experimentHistory: string;
      currentPolicy: string;
    };

    let reviseArgs: RevisePolicyArgs | undefined;

    const deps: AppDeps = {
      kalshi: {
        async getHistoricalCutoff() {
          return null;
        },
        async fetchOpenSnapshots() {
          return [];
        },
        async fetchResolvedExamples() {
          return examples;
        },
      },
      agent: {
        async forecast(policy, snapshot) {
          const market = snapshot as { ticker: string };
          if (policy.includes("Candidate")) {
            if (market.ticker === "HOLD1") {
              return { probability: 0.85, rationale: "candidate improves holdout" };
            }

            return { probability: 0.65, rationale: "candidate train call" };
          }

          if (market.ticker === "HOLD1") {
            return { probability: 0.55, rationale: "baseline mirrors market" };
          }

          return { probability: 0.45, rationale: "baseline train call" };
        },
        async revisePolicy(args) {
          reviseArgs = args;
          return "# Candidate policy\n\nMove further from the market when evidence is strong.";
        },
      },
    };

    const result = await runImprove(config, deps);
    const activePolicy = await fs.readFile(config.policyFile, "utf8");
    const runs = await readExperimentRuns(config);

    expect(result.run.promoted).toBe(true);
    expect(activePolicy).toContain("Candidate policy");
    expect(runs).toHaveLength(1);
    const capturedArgs = reviseArgs ?? fail("Expected revisePolicy to be called");

    expect(capturedArgs.trainingSummary).toContain("TRAIN1");
    expect(capturedArgs.trainingSummary).not.toContain("Holdout market should stay private");
  });

  it("appends live predictions and later backfills resolution events", async () => {
    const config = loadConfig(rootDir);
    await ensureProjectLayout(config);
    await writeActivePolicy(config, "# Policy\n\nStay near the market.");

    const resolvedExamples: ResolvedExample[] = [
      buildResolvedExample({
        marketId: "m-resolved",
        ticker: "RESOLVED",
        title: "Resolved market",
        marketProbability: 0.4,
        outcome: 1,
        settlementTime: "2026-01-10T00:00:00.000Z",
      }),
    ];

    await writeResolvedExamples(config, resolvedExamples);
    await appendLiveEvent(config, {
      type: "prediction",
      timestamp: "2026-01-09T00:00:00.000Z",
      runId: "run-old",
      marketId: "m-resolved",
      ticker: "RESOLVED",
      title: "Resolved market",
      policyVersionHash: "policy-old",
      policyProbability: 0.7,
      marketProbability: 0.4,
      disagreement: 0.3,
      rationale: "old call",
      snapshot: buildOpenSnapshot({
        marketId: "m-resolved",
        ticker: "RESOLVED",
        title: "Resolved market",
        marketProbability: 0.4,
      }),
    });

    const openSnapshots: MarketSnapshot[] = [
      buildOpenSnapshot({
        marketId: "m-open",
        ticker: "OPEN",
        title: "Open market",
        marketProbability: 0.41,
      }),
    ];

    const deps: AppDeps = {
      kalshi: {
        async getHistoricalCutoff() {
          return null;
        },
        async fetchOpenSnapshots() {
          return openSnapshots;
        },
        async fetchResolvedExamples() {
          return resolvedExamples;
        },
      },
      agent: {
        async forecast() {
          return { probability: 0.56, rationale: "policy disagrees with market" };
        },
        async revisePolicy() {
          throw new Error("not used");
        },
      },
    };

    const result = await runPublish(config, deps);
    const events = await readLiveEvents(config);
    const materialized = materializeLiveEvents(events);

    expect(result.predictionsPublished).toBe(1);
    expect(result.resolutionEventsAdded).toBe(1);
    expect(events.some((event) => event.type === "resolution" && event.marketId === "m-resolved")).toBe(true);
    expect(materialized.some((entry) => entry.prediction.marketId === "m-open")).toBe(true);

    const liveReport = await fs.readFile(config.liveReportFile, "utf8");
    expect(liveReport).toContain("OPEN");
    expect(liveReport).toContain("RESOLVED");
  });

  it("rebuilds the split manifest when the resolved example universe changes", async () => {
    const config = loadConfig(rootDir);
    await ensureProjectLayout(config);

    const oldExample = buildResolvedExample({
      marketId: "old-1",
      ticker: "OLD1",
      title: "Old one",
      marketProbability: 0.4,
      outcome: 1,
      settlementTime: "2026-01-01T00:00:00.000Z",
    });
    const newExamples = [
      buildResolvedExample({
        marketId: "new-1",
        ticker: "NEW1",
        title: "New one",
        marketProbability: 0.3,
        outcome: 0,
        settlementTime: "2026-01-01T00:00:00.000Z",
      }),
      buildResolvedExample({
        marketId: "new-2",
        ticker: "NEW2",
        title: "New two",
        marketProbability: 0.6,
        outcome: 1,
        settlementTime: "2026-02-01T00:00:00.000Z",
      }),
    ];

    await writeResolvedExamples(config, [oldExample]);
    await writeSplitManifest(config, {
      createdAt: new Date().toISOString(),
      assignments: { "old-1": "train" },
    });

    const deps: AppDeps = {
      kalshi: {
        async getHistoricalCutoff() {
          return "2025-03-12T00:00:00.000Z";
        },
        async fetchOpenSnapshots() {
          return [];
        },
        async fetchResolvedExamples() {
          return newExamples;
        },
      },
      agent: {
        async forecast() {
          throw new Error("not used");
        },
        async revisePolicy() {
          throw new Error("not used");
        },
      },
    };

    const summary = await runSync(config, deps);
    const manifest = await readSplitManifest(config);

    expect(summary.splitCreated).toBe(true);
    expect(manifest).not.toBeNull();
    expect(manifest?.assignments["new-1"]).toBeDefined();
    expect(manifest?.assignments["new-2"]).toBeDefined();
    expect(manifest?.assignments["old-1"]).toBeUndefined();
  });
});

function buildResolvedExample(args: {
  marketId: string;
  ticker: string;
  title: string;
  marketProbability: number;
  outcome: 0 | 1;
  settlementTime: string;
}): ResolvedExample {
  return {
    marketId: args.marketId,
    ticker: args.ticker,
    title: args.title,
    snapshotTime: "2026-01-01T00:00:00.000Z",
    settlementTime: args.settlementTime,
    marketProbability: args.marketProbability,
    yesBid: null,
    yesAsk: null,
    noBid: null,
    noAsk: null,
    lastPrice: args.marketProbability,
    volume: 100,
    liquidity: 1000,
    openInterest: 100,
    rawSource: "historical",
    outcome: args.outcome,
  };
}

function buildOpenSnapshot(args: {
  marketId: string;
  ticker: string;
  title: string;
  marketProbability: number;
}): MarketSnapshot {
  return {
    marketId: args.marketId,
    ticker: args.ticker,
    title: args.title,
    snapshotTime: "2026-01-01T00:00:00.000Z",
    marketProbability: args.marketProbability,
    yesBid: null,
    yesAsk: null,
    noBid: null,
    noAsk: null,
    lastPrice: args.marketProbability,
    volume: 100,
    liquidity: 1000,
    openInterest: 100,
    rawSource: "live",
  };
}

function fail(message: string): never {
  throw new Error(message);
}

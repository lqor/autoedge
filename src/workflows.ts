import type { AppConfig } from "./config.js";
import type { KalshiClient } from "./kalshi.js";
import type { AgentRunner } from "./agent.js";
import { formatTrainingSummary, scoreForecasts } from "./scoring.js";
import { applySplitManifest, buildSplitManifest, selectSplit } from "./splits.js";
import {
  appendExperimentRun,
  appendLiveEvents,
  archivePolicy,
  ensureProjectLayout,
  readExperimentRuns,
  readHistoricalCutoff,
  readLiveEvents,
  readOpenMarkets,
  readPolicyFile,
  readResolvedExamples,
  readSplitManifest,
  writeActivePolicy,
  writeHistoricalCutoff,
  writeOpenMarkets,
  writeResolvedExamples,
  writeSplitManifest,
} from "./storage.js";
import type {
  EvaluationSummary,
  ExperimentRun,
  ForecastResult,
  LiveLedgerEvent,
  MarketSnapshot,
  MaterializedLivePrediction,
  PredictionEvent,
  ResolvedExample,
  ResolutionEvent,
  Split,
  SyncSummary,
} from "./types.js";
import { createRunId, formatPercent, mapConcurrent, roundToSix, sha256, truncate } from "./utils.js";
import { generateExperimentReport, generateLiveReport, generateTrendSvg, writeReports } from "./report.js";

export interface AppDeps {
  kalshi: Pick<KalshiClient, "getHistoricalCutoff" | "fetchOpenSnapshots" | "fetchResolvedExamples">;
  agent: Pick<AgentRunner, "forecast" | "revisePolicy">;
}

export async function runSync(config: AppConfig, deps: AppDeps): Promise<SyncSummary> {
  await ensureProjectLayout(config);

  const cutoff = await deps.kalshi.getHistoricalCutoff();
  const resolvedExamples = await deps.kalshi.fetchResolvedExamples(cutoff);
  const openMarkets = await deps.kalshi.fetchOpenSnapshots();

  await writeHistoricalCutoff(config, cutoff);
  await writeResolvedExamples(config, resolvedExamples);
  await writeOpenMarkets(config, openMarkets);

  const manifest = await readSplitManifest(config);
  let splitCreated = false;
  if (!manifest || Object.keys(manifest.assignments).length === 0) {
    await writeSplitManifest(config, buildSplitManifest(resolvedExamples));
    splitCreated = true;
  }

  return {
    historicalCutoff: cutoff,
    resolvedExamples: resolvedExamples.length,
    openMarkets: openMarkets.length,
    splitCreated,
  };
}

export async function runBacktest(
  config: AppConfig,
  deps: AppDeps,
  split: Split | "all" = "holdout",
): Promise<{ summary: EvaluationSummary; run: ExperimentRun }> {
  const { policyContent, policyHash, policyPath } = await loadActivePolicy(config, "backtest");
  const { selectedExamples } = await loadExamplesForSplit(config, split);
  const runId = createRunId("backtest");

  const summary = await evaluateExamples({
    config,
    deps,
    policyContent,
    policyHash,
    runId,
    examples: selectedExamples,
    split,
  });

  const run: ExperimentRun = {
    runId,
    mode: "backtest",
    timestamp: new Date().toISOString(),
    split,
    activePolicyHash: policyHash,
    candidatePolicyHash: policyHash,
    parentPolicyHash: policyHash,
    promoted: false,
    policyLogLoss: summary.policyLogLoss,
    marketLogLoss: summary.marketLogLoss,
    deltaVsParent: 0,
    deltaVsMarket: summary.deltaVsMarket,
    holdoutPolicyLogLoss: summary.policyLogLoss,
    holdoutMarketLogLoss: summary.marketLogLoss,
    trainPolicyLogLoss: null,
    trainMarketLogLoss: null,
    sampleCount: summary.sampleCount,
    candidatePath: policyPath,
    model: config.agentForecastModel ?? "default",
    notes: `Backtest split=${split}`,
  };

  await appendExperimentRun(config, run);
  await regenerateReports(config);

  return { summary, run };
}

export async function runImprove(
  config: AppConfig,
  deps: AppDeps,
): Promise<{
  trainSummary: EvaluationSummary;
  currentHoldout: EvaluationSummary;
  candidateHoldout: EvaluationSummary;
  run: ExperimentRun;
}> {
  const { policyContent: currentPolicy, policyHash: currentHash } = await loadActivePolicy(config, "improve-baseline");
  const runId = createRunId("improve");
  const { selectedExamples: trainExamples } = await loadExamplesForSplit(config, "train");
  const { selectedExamples: holdoutExamples } = await loadExamplesForSplit(config, "holdout");

  const trainSummary = await evaluateExamples({
    config,
    deps,
    policyContent: currentPolicy,
    policyHash: currentHash,
    runId,
    examples: trainExamples,
    split: "train",
  });

  const currentHoldout = await evaluateExamples({
    config,
    deps,
    policyContent: currentPolicy,
    policyHash: currentHash,
    runId,
    examples: holdoutExamples,
    split: "holdout",
  });

  const existingRuns = await readExperimentRuns(config);
  const candidatePolicy = await deps.agent.revisePolicy({
    currentPolicy,
    trainingSummary: formatTrainingSummary(trainSummary),
    experimentHistory: summarizeExperimentRuns(existingRuns),
  });

  const candidateVersion = await archivePolicy(config, candidatePolicy, {
    parentHash: currentHash,
    sourceRunId: runId,
  });

  const candidateHoldout = await evaluateExamples({
    config,
    deps,
    policyContent: candidatePolicy,
    policyHash: candidateVersion.hash,
    runId,
    examples: holdoutExamples,
    split: "holdout",
  });

  const deltaVsParent = roundToSix(candidateHoldout.policyLogLoss - currentHoldout.policyLogLoss);
  const promoted = deltaVsParent < 0;

  if (promoted) {
    await writeActivePolicy(config, candidatePolicy);
  }

  const run: ExperimentRun = {
    runId,
    mode: "improve",
    timestamp: new Date().toISOString(),
    split: "both",
    activePolicyHash: promoted ? candidateVersion.hash : currentHash,
    candidatePolicyHash: candidateVersion.hash,
    parentPolicyHash: currentHash,
    promoted,
    policyLogLoss: candidateHoldout.policyLogLoss,
    marketLogLoss: candidateHoldout.marketLogLoss,
    deltaVsParent,
    deltaVsMarket: candidateHoldout.deltaVsMarket,
    holdoutPolicyLogLoss: candidateHoldout.policyLogLoss,
    holdoutMarketLogLoss: candidateHoldout.marketLogLoss,
    trainPolicyLogLoss: trainSummary.policyLogLoss,
    trainMarketLogLoss: trainSummary.marketLogLoss,
    trainingSummary: formatTrainingSummary(trainSummary, 8),
    sampleCount: candidateHoldout.sampleCount,
    candidatePath: candidateVersion.filePath,
    model: config.agentRevisionModel ?? config.agentForecastModel ?? "default",
    notes: `Current holdout before candidate: ${currentHoldout.policyLogLoss.toFixed(6)}`,
  };

  await appendExperimentRun(config, run);
  await regenerateReports(config);

  return { trainSummary, currentHoldout, candidateHoldout, run };
}

export async function runPublish(
  config: AppConfig,
  deps: AppDeps,
): Promise<{
  predictionsPublished: number;
  resolutionEventsAdded: number;
  materialized: MaterializedLivePrediction[];
}> {
  const { policyContent, policyHash } = await loadActivePolicy(config, "publish");
  const runId = createRunId("publish");

  const openMarkets = await deps.kalshi.fetchOpenSnapshots();
  await writeOpenMarkets(config, openMarkets);

  const forecasts = await forecastSnapshots({
    config,
    deps,
    policyContent,
    policyHash,
    runId,
    snapshots: openMarkets,
  });

  const predictionEvents: PredictionEvent[] = forecasts.map((forecast) => ({
    type: "prediction",
    timestamp: forecast.timestamp,
    runId,
    marketId: forecast.marketId,
    ticker: forecast.ticker,
    title: forecast.title,
    policyVersionHash: forecast.policyVersionHash,
    policyProbability: forecast.probability,
    marketProbability: forecast.marketProbability,
    disagreement: forecast.disagreement,
    rationale: forecast.rationale,
    snapshot: forecast.snapshot,
  }));

  await appendLiveEvents(config, predictionEvents);

  const liveEvents = await readLiveEvents(config);
  const resolvedExamples = await readResolvedExamples(config);
  const resolutionEvents = buildResolutionEvents(liveEvents, resolvedExamples);
  await appendLiveEvents(config, resolutionEvents);

  const materialized = materializeLiveEvents([...liveEvents, ...resolutionEvents]);
  await regenerateReports(config, materialized);

  return {
    predictionsPublished: predictionEvents.length,
    resolutionEventsAdded: resolutionEvents.length,
    materialized,
  };
}

export async function regenerateReports(
  config: AppConfig,
  liveMaterialized?: MaterializedLivePrediction[],
): Promise<void> {
  const runs = await readExperimentRuns(config);
  const policyContent = await readPolicyFile(config);
  const policyHash = sha256(policyContent);
  const liveEvents = liveMaterialized ? null : await readLiveEvents(config);
  const materialized = liveMaterialized ?? materializeLiveEvents(liveEvents ?? []);

  const experimentMarkdown = generateExperimentReport({
    activePolicyHash: policyHash,
    runs,
  });
  const trendSvg = generateTrendSvg(runs);
  const liveMarkdown = generateLiveReport({
    activePolicyHash: policyHash,
    predictions: materialized,
    publishMinDelta: config.publishMinDelta,
    publishTopN: config.publishTopN,
  });

  await writeReports(config, {
    experimentMarkdown,
    trendSvg,
    liveMarkdown,
  });
}

export function materializeLiveEvents(events: LiveLedgerEvent[]): MaterializedLivePrediction[] {
  const latestPredictionByMarket = new Map<string, PredictionEvent>();
  const resolutionByMarket = new Map<string, ResolutionEvent>();

  for (const event of events) {
    if (event.type === "prediction") {
      const existing = latestPredictionByMarket.get(event.marketId);
      if (!existing || new Date(event.timestamp).valueOf() >= new Date(existing.timestamp).valueOf()) {
        latestPredictionByMarket.set(event.marketId, event);
      }
    } else {
      resolutionByMarket.set(event.marketId, event);
    }
  }

  return [...latestPredictionByMarket.values()]
    .map((prediction) => {
      const resolution = resolutionByMarket.get(prediction.marketId);
      if (!resolution) {
        return { prediction };
      }

      return {
        prediction,
        resolution,
        policyLogLoss: logLossFromEvent(prediction.policyProbability, resolution.outcome),
        marketLogLoss: logLossFromEvent(prediction.marketProbability, resolution.outcome),
      };
    })
    .sort(
      (left, right) =>
        Math.abs(right.prediction.disagreement) - Math.abs(left.prediction.disagreement),
    );
}

interface EvaluateExamplesArgs {
  config: AppConfig;
  deps: AppDeps;
  policyContent: string;
  policyHash: string;
  runId: string;
  examples: ResolvedExample[];
  split: Split | "all";
}

async function evaluateExamples(args: EvaluateExamplesArgs): Promise<EvaluationSummary> {
  const forecasts = await forecastSnapshots({
    config: args.config,
    deps: args.deps,
    policyContent: args.policyContent,
    policyHash: args.policyHash,
    runId: args.runId,
    snapshots: args.examples,
  });

  return scoreForecasts(forecasts, args.examples, args.split);
}

interface ForecastSnapshotsArgs {
  config: AppConfig;
  deps: AppDeps;
  policyContent: string;
  policyHash: string;
  runId: string;
  snapshots: MarketSnapshot[];
}

async function forecastSnapshots(args: ForecastSnapshotsArgs): Promise<ForecastResult[]> {
  return mapConcurrent(args.snapshots, args.config.forecastConcurrency, async (snapshot) => {
      const output = await args.deps.agent.forecast(args.policyContent, buildModelSnapshot(snapshot));

    return {
      marketId: snapshot.marketId,
      ticker: snapshot.ticker,
      title: snapshot.title,
      policyVersionHash: args.policyHash,
      probability: output.probability,
      rationale: truncate(output.rationale, 240),
      marketProbability: snapshot.marketProbability,
      disagreement: roundToSix(output.probability - snapshot.marketProbability),
      runId: args.runId,
      timestamp: new Date().toISOString(),
      snapshot,
    } satisfies ForecastResult;
  });
}

function buildModelSnapshot(snapshot: MarketSnapshot): Record<string, unknown> {
  return {
    ticker: snapshot.ticker,
    title: snapshot.title,
    subtitle: snapshot.subtitle,
    rules: snapshot.rules,
    category: snapshot.category,
    snapshot_time: snapshot.snapshotTime,
    close_time: snapshot.closeTime,
    resolve_time: snapshot.resolveTime,
    market_probability: snapshot.marketProbability,
    yes_bid: snapshot.yesBid,
    yes_ask: snapshot.yesAsk,
    no_bid: snapshot.noBid,
    no_ask: snapshot.noAsk,
    last_price: snapshot.lastPrice,
    volume: snapshot.volume,
    liquidity: snapshot.liquidity,
    open_interest: snapshot.openInterest,
    source: snapshot.rawSource,
  };
}

async function loadActivePolicy(
  config: AppConfig,
  sourceRunId: string,
): Promise<{ policyContent: string; policyHash: string; policyPath: string }> {
  const policyContent = await readPolicyFile(config);
  const archived = await archivePolicy(config, policyContent, { sourceRunId });
  return {
    policyContent,
    policyHash: archived.hash,
    policyPath: archived.filePath,
  };
}

async function loadExamplesForSplit(
  config: AppConfig,
  split: Split | "all",
): Promise<{ allExamples: ResolvedExample[]; selectedExamples: ResolvedExample[] }> {
  const rawExamples = await readResolvedExamples(config);
  if (rawExamples.length === 0) {
    throw new Error("No resolved examples found. Run `npm run sync` first.");
  }

  const manifest = await readSplitManifest(config);
  if (!manifest) {
    throw new Error("No split manifest found. Run `npm run sync` first.");
  }

  const examples = applySplitManifest(rawExamples, manifest);
  const selectedExamples = selectSplit(examples, split);
  if (selectedExamples.length === 0) {
    throw new Error(`No ${split} examples available.`);
  }

  return { allExamples: examples, selectedExamples };
}

function summarizeExperimentRuns(runs: ExperimentRun[]): string {
  if (runs.length === 0) {
    return "No prior runs.";
  }

  return runs
    .slice(-5)
    .map(
      (run) =>
        `${run.timestamp} | ${run.mode} | candidate ${run.candidatePolicyHash.slice(0, 12)} | promoted=${run.promoted} | holdout=${run.holdoutPolicyLogLoss.toFixed(6)} | delta_vs_parent=${run.deltaVsParent?.toFixed(6) ?? "n/a"}`,
    )
    .join("\n");
}

function buildResolutionEvents(
  liveEvents: LiveLedgerEvent[],
  resolvedExamples: ResolvedExample[],
): ResolutionEvent[] {
  const knownResolutions = new Set(
    liveEvents.filter((event) => event.type === "resolution").map((event) => event.marketId),
  );
  const predictedMarkets = new Set(
    liveEvents.filter((event) => event.type === "prediction").map((event) => event.marketId),
  );
  const resolutionEvents: ResolutionEvent[] = [];

  for (const example of resolvedExamples) {
    if (!predictedMarkets.has(example.marketId) || knownResolutions.has(example.marketId)) {
      continue;
    }

    resolutionEvents.push({
      type: "resolution",
      timestamp: new Date().toISOString(),
      marketId: example.marketId,
      ticker: example.ticker,
      outcome: example.outcome,
      settlementTime: example.settlementTime,
    });
  }

  return resolutionEvents;
}

function logLossFromEvent(probability: number, outcome: 0 | 1): number {
  return roundToSix(outcome === 1 ? -Math.log(Math.max(1e-6, probability)) : -Math.log(Math.max(1e-6, 1 - probability)));
}

export function formatEvaluationSummary(summary: EvaluationSummary): string {
  return [
    "---",
    `split:             ${summary.split}`,
    `sample_count:      ${summary.sampleCount}`,
    `policy_log_loss:   ${summary.policyLogLoss.toFixed(6)}`,
    `market_log_loss:   ${summary.marketLogLoss.toFixed(6)}`,
    `delta_vs_market:   ${summary.deltaVsMarket.toFixed(6)}`,
  ].join("\n");
}

export function formatSyncSummary(summary: SyncSummary): string {
  return [
    "---",
    `historical_cutoff: ${summary.historicalCutoff ?? "unknown"}`,
    `resolved_examples: ${summary.resolvedExamples}`,
    `open_markets:      ${summary.openMarkets}`,
    `split_created:     ${summary.splitCreated}`,
  ].join("\n");
}

export function formatImproveSummary(result: {
  trainSummary: EvaluationSummary;
  currentHoldout: EvaluationSummary;
  candidateHoldout: EvaluationSummary;
  run: ExperimentRun;
}): string {
  return [
    "---",
    `train_log_loss:       ${result.trainSummary.policyLogLoss.toFixed(6)}`,
    `current_holdout:      ${result.currentHoldout.policyLogLoss.toFixed(6)}`,
    `candidate_holdout:    ${result.candidateHoldout.policyLogLoss.toFixed(6)}`,
    `market_holdout:       ${result.candidateHoldout.marketLogLoss.toFixed(6)}`,
    `delta_vs_parent:      ${result.run.deltaVsParent?.toFixed(6) ?? "n/a"}`,
    `promoted:             ${result.run.promoted}`,
    `active_policy_hash:   ${result.run.activePolicyHash.slice(0, 12)}`,
  ].join("\n");
}

export function formatPublishSummary(result: {
  predictionsPublished: number;
  resolutionEventsAdded: number;
  materialized: MaterializedLivePrediction[];
}): string {
  const top = result.materialized[0];
  return [
    "---",
    `predictions_published: ${result.predictionsPublished}`,
    `resolution_events:     ${result.resolutionEventsAdded}`,
    `top_disagreement:      ${
      top ? `${top.prediction.ticker} ${formatPercent(top.prediction.policyProbability)} vs ${formatPercent(top.prediction.marketProbability)}` : "n/a"
    }`,
  ].join("\n");
}

import path from "node:path";

export interface AppConfig {
  rootDir: string;
  artifactsDir: string;
  cacheDir: string;
  ledgersDir: string;
  policiesDir: string;
  reportsDir: string;
  splitsDir: string;
  policyFile: string;
  resolvedExamplesFile: string;
  openMarketsFile: string;
  historicalCutoffFile: string;
  experimentLedgerFile: string;
  liveLedgerFile: string;
  policyLedgerFile: string;
  splitManifestFile: string;
  experimentReportFile: string;
  liveReportFile: string;
  trendSvgFile: string;
  kalshiBaseUrl: string;
  kalshiExtraHeaders: Record<string, string>;
  agentCli: "codex" | "claude" | "auto";
  agentForecastModel?: string;
  agentRevisionModel?: string;
  agentTimeoutMs: number;
  forecastConcurrency: number;
  syncConcurrency: number;
  resolvedMarketLimit: number;
  openMarketLimit: number;
  publishMinDelta: number;
  publishTopN: number;
}

export function loadConfig(rootDir = process.cwd()): AppConfig {
  const artifactsDir = resolveFromRoot(rootDir, process.env.AUTOEDGE_ARTIFACTS_DIR ?? "artifacts");
  const cacheDir = path.join(artifactsDir, "cache");
  const ledgersDir = path.join(artifactsDir, "ledgers");
  const policiesDir = path.join(artifactsDir, "policies");
  const reportsDir = path.join(artifactsDir, "reports");
  const splitsDir = path.join(artifactsDir, "splits");

  return {
    rootDir,
    artifactsDir,
    cacheDir,
    ledgersDir,
    policiesDir,
    reportsDir,
    splitsDir,
    policyFile: path.join(rootDir, "policy", "current.md"),
    resolvedExamplesFile: path.join(cacheDir, "resolved-examples.json"),
    openMarketsFile: path.join(cacheDir, "open-markets.json"),
    historicalCutoffFile: path.join(cacheDir, "historical-cutoff.json"),
    experimentLedgerFile: path.join(ledgersDir, "experiments.jsonl"),
    liveLedgerFile: path.join(ledgersDir, "live.jsonl"),
    policyLedgerFile: path.join(ledgersDir, "policies.jsonl"),
    splitManifestFile: path.join(splitsDir, "resolved-split.json"),
    experimentReportFile: path.join(reportsDir, "experiment-history.md"),
    liveReportFile: path.join(reportsDir, "live-disagreements.md"),
    trendSvgFile: path.join(reportsDir, "experiment-trend.svg"),
    kalshiBaseUrl: process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2",
    kalshiExtraHeaders: parseJsonObject(process.env.KALSHI_EXTRA_HEADERS_JSON),
    agentCli: parseAgentCli(process.env.AUTOEDGE_AGENT_CLI),
    agentForecastModel: process.env.AUTOEDGE_AGENT_MODEL,
    agentRevisionModel: process.env.AUTOEDGE_AGENT_REVISION_MODEL ?? process.env.AUTOEDGE_AGENT_MODEL,
    agentTimeoutMs: parsePositiveInt(process.env.AUTOEDGE_AGENT_TIMEOUT_MS, 120000),
    forecastConcurrency: parsePositiveInt(process.env.AUTOEDGE_FORECAST_CONCURRENCY, 1),
    syncConcurrency: parsePositiveInt(process.env.AUTOEDGE_SYNC_CONCURRENCY, 1),
    resolvedMarketLimit: parsePositiveInt(process.env.AUTOEDGE_RESOLVED_LIMIT, 200),
    openMarketLimit: parsePositiveInt(process.env.AUTOEDGE_OPEN_LIMIT, 100),
    publishMinDelta: parseProbability(process.env.AUTOEDGE_PUBLISH_MIN_DELTA, 0.1),
    publishTopN: parsePositiveInt(process.env.AUTOEDGE_PUBLISH_TOP_N, 20),
  };
}

function parseAgentCli(value: string | undefined): AppConfig["agentCli"] {
  if (!value) {
    return "auto";
  }

  if (value === "codex" || value === "claude" || value === "auto") {
    return value;
  }

  throw new Error(`AUTOEDGE_AGENT_CLI must be codex, claude, or auto; received ${value}`);
}

function resolveFromRoot(rootDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(rootDir, value);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }

  return parsed;
}

function parseProbability(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Expected a probability between 0 and 1, received ${value}`);
  }

  return parsed;
}

function parseJsonObject(value: string | undefined): Record<string, string> {
  if (!value) {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("KALSHI_EXTRA_HEADERS_JSON must be a JSON object");
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([key, entryValue]) => [key, String(entryValue)]),
  );
}

import fs from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "./config.js";
import type {
  ExperimentRun,
  LiveLedgerEvent,
  MarketSnapshot,
  PolicyVersion,
  ResolvedExample,
  SplitManifest,
} from "./types.js";
import { sha256 } from "./utils.js";

export async function ensureProjectLayout(config: AppConfig): Promise<void> {
  await Promise.all([
    fs.mkdir(config.artifactsDir, { recursive: true }),
    fs.mkdir(config.cacheDir, { recursive: true }),
    fs.mkdir(config.ledgersDir, { recursive: true }),
    fs.mkdir(config.policiesDir, { recursive: true }),
    fs.mkdir(config.reportsDir, { recursive: true }),
    fs.mkdir(config.splitsDir, { recursive: true }),
    fs.mkdir(path.dirname(config.policyFile), { recursive: true }),
  ]);
}

export async function readPolicyFile(config: AppConfig): Promise<string> {
  return fs.readFile(config.policyFile, "utf8");
}

export async function writeActivePolicy(config: AppConfig, content: string): Promise<void> {
  await fs.writeFile(config.policyFile, content, "utf8");
}

export async function archivePolicy(
  config: AppConfig,
  content: string,
  metadata: Omit<PolicyVersion, "hash" | "filePath" | "createdAt"> & { sourceRunId?: string },
): Promise<PolicyVersion> {
  await ensureProjectLayout(config);
  const hash = sha256(content);
  const filePath = path.join(config.policiesDir, `${hash}.md`);
  const exists = await fileExists(filePath);

  if (!exists) {
    await fs.writeFile(filePath, content, "utf8");

    const version: PolicyVersion = {
      hash,
      parentHash: metadata.parentHash,
      createdAt: new Date().toISOString(),
      sourceRunId: metadata.sourceRunId,
      filePath,
    };

    await appendJsonLine(config.policyLedgerFile, version);
    return version;
  }

  return {
    hash,
    parentHash: metadata.parentHash,
    createdAt: new Date().toISOString(),
    sourceRunId: metadata.sourceRunId,
    filePath,
  };
}

export async function writeResolvedExamples(config: AppConfig, examples: ResolvedExample[]): Promise<void> {
  await ensureProjectLayout(config);
  await fs.writeFile(config.resolvedExamplesFile, JSON.stringify(examples, null, 2), "utf8");
}

export async function readResolvedExamples(config: AppConfig): Promise<ResolvedExample[]> {
  return readJsonFile<ResolvedExample[]>(config.resolvedExamplesFile, []);
}

export async function writeOpenMarkets(config: AppConfig, markets: MarketSnapshot[]): Promise<void> {
  await ensureProjectLayout(config);
  await fs.writeFile(config.openMarketsFile, JSON.stringify(markets, null, 2), "utf8");
}

export async function readOpenMarkets(config: AppConfig): Promise<MarketSnapshot[]> {
  return readJsonFile<MarketSnapshot[]>(config.openMarketsFile, []);
}

export async function writeHistoricalCutoff(config: AppConfig, cutoff: string | null): Promise<void> {
  await ensureProjectLayout(config);
  await fs.writeFile(
    config.historicalCutoffFile,
    JSON.stringify({ historicalCutoff: cutoff }, null, 2),
    "utf8",
  );
}

export async function readHistoricalCutoff(config: AppConfig): Promise<string | null> {
  const data = await readJsonFile<{ historicalCutoff?: string | null }>(config.historicalCutoffFile, {});
  return data.historicalCutoff ?? null;
}

export async function writeSplitManifest(config: AppConfig, manifest: SplitManifest): Promise<void> {
  await ensureProjectLayout(config);
  await fs.writeFile(config.splitManifestFile, JSON.stringify(manifest, null, 2), "utf8");
}

export async function readSplitManifest(config: AppConfig): Promise<SplitManifest | null> {
  if (!(await fileExists(config.splitManifestFile))) {
    return null;
  }

  return readJsonFile<SplitManifest>(config.splitManifestFile, {
    createdAt: new Date(0).toISOString(),
    assignments: {},
  });
}

export async function appendExperimentRun(config: AppConfig, run: ExperimentRun): Promise<void> {
  await appendJsonLine(config.experimentLedgerFile, run);
}

export async function readExperimentRuns(config: AppConfig): Promise<ExperimentRun[]> {
  return readJsonLines<ExperimentRun>(config.experimentLedgerFile);
}

export async function appendLiveEvent(config: AppConfig, event: LiveLedgerEvent): Promise<void> {
  await appendJsonLine(config.liveLedgerFile, event);
}

export async function appendLiveEvents(config: AppConfig, events: LiveLedgerEvent[]): Promise<void> {
  for (const event of events) {
    await appendLiveEvent(config, event);
  }
}

export async function readLiveEvents(config: AppConfig): Promise<LiveLedgerEvent[]> {
  return readJsonLines<LiveLedgerEvent>(config.liveLedgerFile);
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  if (!(await fileExists(filePath))) {
    return fallback;
  }

  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  if (!(await fileExists(filePath))) {
    return [];
  }

  const raw = await fs.readFile(filePath, "utf8");
  if (!raw.trim()) {
    return [];
  }

  return raw
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}


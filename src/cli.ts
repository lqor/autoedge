#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { AgentRunner } from "./agent.js";
import { KalshiClient } from "./kalshi.js";
import {
  formatEvaluationSummary,
  formatImproveSummary,
  formatPublishSummary,
  formatSyncSummary,
  regenerateReports,
  runBacktest,
  runImprove,
  runPublish,
  runSync,
} from "./workflows.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const kalshi = new KalshiClient(config);
  const agent = new AgentRunner(config);
  const command = process.argv[2] ?? "help";
  const split = extractOption("--split");

  switch (command) {
    case "sync": {
      const summary = await runSync(config, { kalshi, agent });
      console.log(formatSyncSummary(summary));
      return;
    }

    case "backtest": {
      const result = await runBacktest(
        config,
        { kalshi, agent },
        isValidSplit(split) ? split : "holdout",
      );
      console.log(formatEvaluationSummary(result.summary));
      return;
    }

    case "improve": {
      const result = await runImprove(config, { kalshi, agent });
      console.log(formatImproveSummary(result));
      return;
    }

    case "publish": {
      const result = await runPublish(config, { kalshi, agent });
      console.log(formatPublishSummary(result));
      return;
    }

    case "report": {
      await regenerateReports(config);
      console.log("---\nreports: generated");
      return;
    }

    default: {
      printHelp();
    }
  }
}

function extractOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

function isValidSplit(value: string | undefined): value is "train" | "holdout" | "all" {
  return value === "train" || value === "holdout" || value === "all";
}

function printHelp(): never {
  console.log(
    [
      "Usage: npm run autoedge -- <command>",
      "",
      "Commands:",
      "  sync",
      "  backtest -- --split train|holdout|all",
      "  improve",
      "  publish",
      "  report",
    ].join("\n"),
  );
  process.exit(1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});

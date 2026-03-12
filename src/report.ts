import type { AppConfig } from "./config.js";
import { writeTextFile } from "./storage.js";
import type { ExperimentRun, MaterializedLivePrediction } from "./types.js";
import { formatPercent } from "./utils.js";

export function generateExperimentReport(args: {
  activePolicyHash: string;
  runs: ExperimentRun[];
}): string {
  const promotedRuns = args.runs.filter((run) => run.promoted);
  const lines = [
    "# Experiment History",
    "",
    `Active policy: \`${args.activePolicyHash}\``,
    `Total runs: ${args.runs.length}`,
    `Promoted candidates: ${promotedRuns.length}`,
    "",
  ];

  if (args.runs.length === 0) {
    lines.push("No experiment runs recorded yet.");
    return lines.join("\n");
  }

  const latest = args.runs[args.runs.length - 1];
  lines.push("## Latest Run", "");
  lines.push(`- Timestamp: ${latest.timestamp}`);
  lines.push(`- Mode: ${latest.mode}`);
  lines.push(`- Candidate policy: \`${latest.candidatePolicyHash}\``);
  lines.push(`- Promoted: ${latest.promoted}`);
  lines.push(`- Holdout log loss: ${latest.holdoutPolicyLogLoss.toFixed(6)}`);
  lines.push(`- Market baseline log loss: ${latest.holdoutMarketLogLoss.toFixed(6)}`);
  lines.push(`- Delta vs parent: ${latest.deltaVsParent?.toFixed(6) ?? "n/a"}`);
  lines.push("");
  lines.push("## Trend", "");
  lines.push(`![Experiment trend](./experiment-trend.svg)`);
  lines.push("");
  lines.push("## Recent Runs", "");
  lines.push("| Timestamp | Mode | Candidate | Promoted | Holdout | Market | Delta vs Parent |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");

  for (const run of [...args.runs].reverse().slice(0, 20)) {
    lines.push(
      `| ${run.timestamp} | ${run.mode} | \`${run.candidatePolicyHash.slice(0, 12)}\` | ${run.promoted ? "yes" : "no"} | ${run.holdoutPolicyLogLoss.toFixed(6)} | ${run.holdoutMarketLogLoss.toFixed(6)} | ${run.deltaVsParent?.toFixed(6) ?? "n/a"} |`,
    );
  }

  return lines.join("\n");
}

export function generateTrendSvg(runs: ExperimentRun[]): string {
  const width = 720;
  const height = 240;
  const padding = 32;
  const values = runs.map((run) => run.holdoutPolicyLogLoss);

  if (values.length === 0) {
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<rect width="${width}" height="${height}" fill="#0f172a" rx="18"/>`,
      `<text x="36" y="120" fill="#e2e8f0" font-family="Menlo, monospace" font-size="16">No runs yet</text>`,
      `</svg>`,
    ].join("");
  }

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = Math.max(0.000001, maxValue - minValue);
  const xStep = values.length === 1 ? 0 : (width - padding * 2) / (values.length - 1);
  const points = values
    .map((value, index) => {
      const x = padding + index * xStep;
      const normalizedY = (value - minValue) / range;
      const y = height - padding - normalizedY * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(" ");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="#0f172a" rx="18"/>`,
    `<path d="M ${padding} ${height - padding} H ${width - padding}" stroke="#334155" stroke-width="1"/>`,
    `<path d="M ${padding} ${padding} V ${height - padding}" stroke="#334155" stroke-width="1"/>`,
    `<polyline fill="none" stroke="#38bdf8" stroke-width="3" points="${points}"/>`,
    `<text x="${padding}" y="24" fill="#e2e8f0" font-family="Menlo, monospace" font-size="14">Holdout log loss</text>`,
    `<text x="${padding}" y="${height - 10}" fill="#94a3b8" font-family="Menlo, monospace" font-size="12">Runs: ${runs.length}</text>`,
    `<text x="${width - 160}" y="24" fill="#94a3b8" font-family="Menlo, monospace" font-size="12">best ${minValue.toFixed(6)}</text>`,
    `<text x="${width - 160}" y="${height - 10}" fill="#94a3b8" font-family="Menlo, monospace" font-size="12">worst ${maxValue.toFixed(6)}</text>`,
    `</svg>`,
  ].join("");
}

export function generateLiveReport(args: {
  activePolicyHash: string;
  predictions: MaterializedLivePrediction[];
  publishMinDelta: number;
  publishTopN: number;
}): string {
  const active = args.predictions
    .filter((entry) => !entry.resolution)
    .filter((entry) => Math.abs(entry.prediction.disagreement) >= args.publishMinDelta)
    .slice(0, args.publishTopN);
  const resolved = args.predictions.filter((entry) => entry.resolution).slice(0, 10);

  const lines = [
    "# Live Disagreements",
    "",
    `Active policy: \`${args.activePolicyHash}\``,
    `Minimum absolute disagreement: ${(args.publishMinDelta * 100).toFixed(1)}%`,
    `Top N: ${args.publishTopN}`,
    "",
    "## Current Open Markets",
    "",
  ];

  if (active.length === 0) {
    lines.push("No open disagreements above the publish threshold.");
  } else {
    lines.push("| Ticker | Market | Policy | Delta | Title | Rationale |");
    lines.push("| --- | --- | --- | --- | --- | --- |");

    for (const entry of active) {
      lines.push(
        `| \`${entry.prediction.ticker}\` | ${formatPercent(entry.prediction.marketProbability)} | ${formatPercent(entry.prediction.policyProbability)} | ${formatPercent(Math.abs(entry.prediction.disagreement))} | ${escapePipe(entry.prediction.title)} | ${escapePipe(entry.prediction.rationale)} |`,
      );
    }
  }

  lines.push("");
  lines.push("## Recently Resolved", "");

  if (resolved.length === 0) {
    lines.push("No resolved live predictions yet.");
  } else {
    lines.push("| Ticker | Outcome | Policy log loss | Market log loss | Result |");
    lines.push("| --- | --- | --- | --- | --- |");

    for (const entry of resolved) {
      const beatMarket =
        entry.policyLogLoss !== undefined &&
        entry.marketLogLoss !== undefined &&
        entry.policyLogLoss < entry.marketLogLoss;

      lines.push(
        `| \`${entry.prediction.ticker}\` | ${entry.resolution?.outcome === 1 ? "YES" : "NO"} | ${entry.policyLogLoss?.toFixed(6) ?? "n/a"} | ${entry.marketLogLoss?.toFixed(6) ?? "n/a"} | ${beatMarket ? "beat market" : "did not beat market"} |`,
      );
    }
  }

  return lines.join("\n");
}

export async function writeReports(
  config: AppConfig,
  reports: {
    experimentMarkdown: string;
    trendSvg: string;
    liveMarkdown: string;
  },
): Promise<void> {
  await Promise.all([
    writeTextFile(config.experimentReportFile, reports.experimentMarkdown),
    writeTextFile(config.trendSvgFile, reports.trendSvg),
    writeTextFile(config.liveReportFile, reports.liveMarkdown),
  ]);
}

function escapePipe(value: string): string {
  return value.replace(/\|/g, "\\|");
}


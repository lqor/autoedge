import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AppConfig } from "./config.js";
import type { ForecastOutput } from "./types.js";
import { clampProbability, truncate } from "./utils.js";

type AgentCli = "codex" | "claude";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class AgentRunner {
  constructor(
    private readonly config: AppConfig,
    private readonly commandRunner: (command: string, args: string[], options: RunOptions) => Promise<CommandResult> = runCommand,
  ) {}

  async forecast(policy: string, snapshot: unknown): Promise<ForecastOutput> {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["probability", "rationale"],
      properties: {
        probability: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
        rationale: {
          type: "string",
          minLength: 1,
          maxLength: 240,
        },
      },
    };

    const prompt = [
      "You are the active forecasting policy for a binary Kalshi market evaluator.",
      "Use the policy markdown below as the only mutable reasoning policy.",
      "Return strict JSON matching the schema and nothing else.",
      "",
      "Policy markdown:",
      policy,
      "",
      "Market snapshot JSON:",
      JSON.stringify(snapshot, null, 2),
    ].join("\n");

    const raw = await this.runStructured(prompt, schema, this.config.agentForecastModel);
    return parseForecastOutput(raw);
  }

  async revisePolicy(args: {
    currentPolicy: string;
    trainingSummary: string;
    experimentHistory: string;
  }): Promise<string> {
    const prompt = [
      "You are revising one Markdown forecasting policy for a fixed evaluation harness.",
      "You may revise only the policy text itself.",
      "Do not propose code, tooling, or harness changes.",
      "Return only the full replacement Markdown for policy/current.md.",
      "",
      "Current policy:",
      args.currentPolicy,
      "",
      "Training-only evaluator summary:",
      args.trainingSummary,
      "",
      "Recent experiment history summary:",
      args.experimentHistory,
      "",
      "Keep the policy legible. Prefer calibration and simplicity over bold complexity.",
    ].join("\n");

    const reply = await this.runText(prompt, this.config.agentRevisionModel);
    return stripMarkdownFences(reply).trim();
  }

  private async runStructured(
    prompt: string,
    schema: Record<string, unknown>,
    model?: string,
  ): Promise<string> {
    const cli = resolveAgentCli(this.config.agentCli);

    if (cli === "codex") {
      return runCodexStructured({
        config: this.config,
        commandRunner: this.commandRunner,
        prompt,
        schema,
        model,
      });
    }

    return runClaudeStructured({
      config: this.config,
      commandRunner: this.commandRunner,
      prompt,
      schema,
      model,
    });
  }

  private async runText(prompt: string, model?: string): Promise<string> {
    const cli = resolveAgentCli(this.config.agentCli);

    if (cli === "codex") {
      return runCodexText({
        config: this.config,
        commandRunner: this.commandRunner,
        prompt,
        model,
      });
    }

    return runClaudeText({
      config: this.config,
      commandRunner: this.commandRunner,
      prompt,
      model,
    });
  }
}

interface RunOptions {
  cwd: string;
  input?: string;
  timeoutMs: number;
}

interface AgentRunArgs {
  config: AppConfig;
  commandRunner: (command: string, args: string[], options: RunOptions) => Promise<CommandResult>;
  prompt: string;
  model?: string;
}

async function runCodexStructured(
  args: AgentRunArgs & { schema: Record<string, unknown> },
): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoedge-codex-"));
  const schemaPath = path.join(tempDir, "schema.json");
  const outputPath = path.join(tempDir, "output.json");

  try {
    await fs.writeFile(schemaPath, JSON.stringify(args.schema), "utf8");
    const commandArgs = [
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
    ];

    if (args.model) {
      commandArgs.push("--model", args.model);
    }

    commandArgs.push("-");

    const result = await args.commandRunner("codex", commandArgs, {
      cwd: args.config.rootDir,
      input: args.prompt,
      timeoutMs: args.config.agentTimeoutMs,
    });

    if (result.code !== 0) {
      throw new Error(`codex exec failed: ${result.stderr || result.stdout}`);
    }

    return (await fs.readFile(outputPath, "utf8")).trim();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runCodexText(args: AgentRunArgs): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoedge-codex-"));
  const outputPath = path.join(tempDir, "output.txt");

  try {
    const commandArgs = [
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--output-last-message",
      outputPath,
    ];

    if (args.model) {
      commandArgs.push("--model", args.model);
    }

    commandArgs.push("-");

    const result = await args.commandRunner("codex", commandArgs, {
      cwd: args.config.rootDir,
      input: args.prompt,
      timeoutMs: args.config.agentTimeoutMs,
    });

    if (result.code !== 0) {
      throw new Error(`codex exec failed: ${result.stderr || result.stdout}`);
    }

    return (await fs.readFile(outputPath, "utf8")).trim();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runClaudeStructured(
  args: AgentRunArgs & { schema: Record<string, unknown> },
): Promise<string> {
  const commandArgs = [
    "-p",
    "--output-format",
    "text",
    "--json-schema",
    JSON.stringify(args.schema),
    "--tools",
    "",
  ];

  if (args.model) {
    commandArgs.push("--model", args.model);
  }

  commandArgs.push(args.prompt);

  const result = await args.commandRunner("claude", commandArgs, {
    cwd: args.config.rootDir,
    timeoutMs: args.config.agentTimeoutMs,
  });

  if (result.code !== 0) {
    throw new Error(`claude -p failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout.trim();
}

async function runClaudeText(args: AgentRunArgs): Promise<string> {
  const commandArgs = ["-p", "--output-format", "text", "--tools", ""];

  if (args.model) {
    commandArgs.push("--model", args.model);
  }

  commandArgs.push(args.prompt);

  const result = await args.commandRunner("claude", commandArgs, {
    cwd: args.config.rootDir,
    timeoutMs: args.config.agentTimeoutMs,
  });

  if (result.code !== 0) {
    throw new Error(`claude -p failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout.trim();
}

export function parseForecastOutput(raw: string): ForecastOutput {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Forecast response was not valid JSON: ${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Forecast response must be a JSON object");
  }

  const probability = (parsed as { probability?: unknown }).probability;
  const rationale = (parsed as { rationale?: unknown }).rationale;

  if (typeof probability !== "number") {
    throw new Error("Forecast response must include a numeric probability");
  }

  if (typeof rationale !== "string" || rationale.trim().length === 0) {
    throw new Error("Forecast response must include a non-empty rationale");
  }

  return {
    probability: clampProbability(probability),
    rationale: truncate(rationale.trim(), 240),
  };
}

function stripMarkdownFences(text: string): string {
  const fenced = text.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i);
  return fenced ? fenced[1] : text;
}

function resolveAgentCli(preferred: AppConfig["agentCli"]): AgentCli {
  if (preferred === "auto") {
    if (commandExists("codex")) {
      return "codex";
    }

    if (commandExists("claude")) {
      return "claude";
    }

    throw new Error("Neither `codex` nor `claude` is available on PATH");
  }

  if (!commandExists(preferred)) {
    throw new Error(`Configured agent CLI \`${preferred}\` is not available on PATH`);
  }

  return preferred;
}

function commandExists(command: string): boolean {
  const result = spawnSync("which", [command], { stdio: "ignore" });
  return result.status === 0;
}

async function runCommand(command: string, args: string[], options: RunOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGTERM");
      }
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({
          code: code ?? 1,
          stdout,
          stderr,
        });
      }
    });

    if (options.input) {
      child.stdin.write(options.input);
    }

    child.stdin.end();
  });
}


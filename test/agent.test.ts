import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { AgentRunner, parsePolicyRevision } from "../src/agent.js";
import { loadConfig } from "../src/config.js";

describe("AgentRunner", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "autoedge-agent-test-"));
    await fs.mkdir(path.join(rootDir, "policy"), { recursive: true });
  });

  it("falls back to stdout when codex structured output file is missing", async () => {
    const config = loadConfig(rootDir);
    const runner = new AgentRunner(config, async () => ({
      code: 0,
      stdout: JSON.stringify({
        probability: 0.56,
        rationale: "stdout fallback",
      }),
      stderr: "",
    }));

    const result = await runner.forecast("# Policy", { ticker: "TEST" });

    expect(result).toEqual({
      probability: 0.56,
      rationale: "stdout fallback",
    });
  });

  it("revises policy from stdout JSON when codex output file is missing", async () => {
    const config = loadConfig(rootDir);
    const runner = new AgentRunner(config, async () => ({
      code: 0,
      stdout: JSON.stringify({
        policy_markdown: "# Candidate policy\n\nStay near market unless the order book is clearly stale.",
      }),
      stderr: "",
    }));

    const result = await runner.revisePolicy({
      currentPolicy: "# Current policy",
      trainingSummary: "Training summary",
      experimentHistory: "History",
    });

    expect(result).toContain("Candidate policy");
    expect(result).toContain("Stay near market");
  });

  it("parses codex json event streams when the output file is missing", async () => {
    const config = loadConfig(rootDir);
    const runner = new AgentRunner(config, async () => ({
      code: 0,
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item-1",
            type: "agent_message",
            text: JSON.stringify({
              probability: 0.61,
              rationale: "json event stream fallback",
            }),
          },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ].join("\n"),
      stderr: "",
    }));

    const result = await runner.forecast("# Policy", { ticker: "TEST" });

    expect(result).toEqual({
      probability: 0.61,
      rationale: "json event stream fallback",
    });
  });

  it("extracts policy JSON when codex wraps it with extra text", () => {
    const result = parsePolicyRevision(
      [
        "{\"policy_markdown\":\"# Candidate\\n\\nStay near market.\"}",
        "Notes: kept simple.",
      ].join("\n"),
    );

    expect(result).toContain("Candidate");
    expect(result).toContain("Stay near market");
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { materialize } from "../../src/eval/harness.js";
import { runTask } from "../../src/agent/runner.js";
import { loadConfig } from "../../src/config.js";
import { MockProvider } from "../../src/llm/mock.js";
import { buggyStatsSolver } from "../../src/eval/solver.js";
import { silentLogger } from "../../src/obs/logger.js";
import { runCommand } from "../../src/util/exec.js";

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
let workspace: string | undefined;
afterEach(async () => {
  if (workspace) await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  workspace = undefined;
});

describe("crash-resume across a real OS process boundary", () => {
  it("aborts in this process, then a SEPARATE node process resumes from the mission log on disk and finishes green", async () => {
    workspace = await materialize("buggy-stats");

    // Phase 1: this process runs the agent and is cut off mid-task (the "crash").
    const r1 = await runTask({
      goal: "fix the failing tests and commit",
      workspace,
      config: loadConfig({ provider: "mock" }),
      provider: new MockProvider(buggyStatsSolver()),
      logger: silentLogger(),
      budgets: { maxSteps: 14, maxTokens: 1e9 },
    });
    expect(r1.status).toBe("max_steps");
    const beforeResume = await runCommand("npm", ["test", "--silent"], { cwd: workspace, timeoutMs: 60_000 });
    expect(beforeResume.exitCode).not.toBe(0); // genuinely unfinished

    // Phase 2: a brand-new OS process resumes. It shares no memory with phase 1 — it can only
    // know the run state from the on-disk mission log. (Skip if tsx is unavailable in the env.)
    const which = await runCommand("npx", ["tsx", "--version"], { cwd: repoRoot, timeoutMs: 60_000 });
    if (which.exitCode !== 0) return;

    const child = await runCommand("npx", ["tsx", join("src", "eval", "resume-proc.ts"), workspace, r1.missionId], {
      cwd: repoRoot,
      timeoutMs: 120_000,
    });
    expect(child.exitCode).toBe(0); // the separate process completed and its gate passed

    const afterResume = await runCommand("npm", ["test", "--silent"], { cwd: workspace, timeoutMs: 60_000 });
    expect(afterResume.exitCode).toBe(0); // green after a true out-of-process resume
  }, 180_000);
});

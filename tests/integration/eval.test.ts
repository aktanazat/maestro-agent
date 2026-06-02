import { describe, it, expect } from "vitest";
import { MockProvider } from "../../src/llm/mock.js";
import { buggyStatsSolver } from "../../src/eval/solver.js";
import { runEval } from "../../src/eval/harness.js";
import { TASKS } from "../../src/eval/tasks.js";
import { loadConfig } from "../../src/config.js";

/**
 * The end-to-end integration test: the full agent (loop + registry + tools + subagent +
 * context manager) drives the deterministic solver against a real (temp) git repo, then the
 * fixture's own suite is run to confirm the bugs are actually fixed. This is the brief's
 * properties exercised together, not in isolation.
 */
describe("eval harness end-to-end (mock solver)", () => {
  it("fixes the failing fixture in a 20+ call session using a subagent and tool composition", async () => {
    const task = TASKS.find((t) => t.id === "buggy-stats:fix-and-verify")!;
    const report = await runEval(task, { provider: new MockProvider(buggyStatsSolver()), config: loadConfig({ provider: "mock" }) });

    expect(report.passed).toBe(true);
    expect(report.status).toBe("completed");
    expect(report.toolCalls).toBeGreaterThanOrEqual(20);
    expect(report.subagents).toBeGreaterThanOrEqual(1);
    expect(report.checkResults.find((c) => c.name === "tests_pass")!.passed).toBe(true);
    expect(report.checkResults.find((c) => c.name === "composed_run_tests_to_localize")!.passed).toBe(true);
  });

  it("keeps plan coherence and finishes the task even when context compaction fires mid-session", async () => {
    const task = TASKS.find((t) => t.id === "buggy-stats:survives-forced-compaction")!;
    const report = await runEval(task, { provider: new MockProvider(buggyStatsSolver()), config: loadConfig({ provider: "mock" }) });

    expect(report.compactions).toBeGreaterThanOrEqual(1);
    expect(report.passed).toBe(true);
    expect(report.checkResults.find((c) => c.name === "tests_pass")!.passed).toBe(true);
    expect(report.checkResults.find((c) => c.name === "plan_complete")!.passed).toBe(true);
  });
});

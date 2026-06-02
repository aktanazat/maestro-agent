import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../config.js";
import { runTask, type TaskResult } from "../agent/runner.js";
import type { ModelProvider } from "../llm/provider.js";
import { runCommand } from "../util/exec.js";
import { silentLogger } from "../obs/logger.js";
import { Tracer } from "../obs/tracing.js";
import type { ToolResultEvent } from "../tools/types.js";

const FIXTURES_ROOT = resolve(fileURLToPath(new URL("../../fixtures/repos", import.meta.url)));

export interface Check {
  name: string;
  description: string;
  evaluate: (ctx: ScoreContext) => boolean | Promise<boolean>;
}

export interface ScoreContext {
  workspace: string;
  result: TaskResult;
  /** Result of running the fixture's own test suite AFTER the agent finished. */
  finalTests: { exitCode: number; output: string };
  /** Every tool dispatch with its validated I/O, in order — lets checks assert real data flow. */
  toolEvents: ToolResultEvent[];
}

export interface EvalTask {
  id: string;
  fixture: string;
  goal: string;
  /** Optional budget/context overrides — e.g. a tiny context to force compaction. */
  config?: Partial<Config>;
  checks: Check[];
}

export interface EvalReport {
  taskId: string;
  passed: boolean;
  steps: number;
  toolCalls: number;
  compactions: number;
  subagents: number;
  status: string;
  checkResults: Array<{ name: string; passed: boolean; description: string }>;
  workspace: string;
}

/** Copy a fixture repo into an isolated temp workspace and make it a git repo. */
export async function materialize(fixture: string): Promise<string> {
  const src = join(FIXTURES_ROOT, fixture);
  const dest = await fs.mkdtemp(join(tmpdir(), `maestro-eval-${fixture}-`));
  await fs.cp(src, dest, { recursive: true });
  // A real git repo so git.* tools (and the commit step) actually work.
  const opts = { cwd: dest, timeoutMs: 15_000 };
  await runCommand("git", ["init", "-q"], opts);
  await runCommand("git", ["config", "user.email", "eval@maestro.local"], opts);
  await runCommand("git", ["config", "user.name", "maestro-eval"], opts);
  await runCommand("git", ["add", "-A"], opts);
  await runCommand("git", ["commit", "-q", "-m", "initial fixture state"], opts);
  return dest;
}

export interface RunEvalOptions {
  provider: ModelProvider;
  config?: Config;
  keepWorkspace?: boolean;
}

/** Run one eval task end-to-end and score it. */
export async function runEval(task: EvalTask, opts: RunEvalOptions): Promise<EvalReport> {
  const baseConfig = opts.config ?? loadConfig({ provider: "mock" });
  const config: Config = { ...baseConfig, ...task.config } as Config;
  const workspace = await materialize(task.fixture);
  const logger = silentLogger();
  const tracer = new Tracer({ filePath: join(workspace, ".maestro/trace.jsonl") });

  const toolEvents: ToolResultEvent[] = [];
  const result = await runTask({
    goal: task.goal,
    workspace,
    config,
    provider: opts.provider,
    logger,
    tracer,
    onToolResult: (rec) => toolEvents.push(rec),
  });

  const finalRun = await runCommand("npm", ["test", "--silent"], { cwd: workspace, timeoutMs: 60_000 });
  const finalTests = { exitCode: finalRun.exitCode, output: (finalRun.stdout + finalRun.stderr).slice(-2000) };

  const scoreCtx: ScoreContext = { workspace, result, finalTests, toolEvents };
  const checkResults = [];
  for (const check of task.checks) {
    let passed = false;
    try {
      passed = await check.evaluate(scoreCtx);
    } catch {
      passed = false;
    }
    checkResults.push({ name: check.name, passed, description: check.description });
  }

  if (!opts.keepWorkspace) await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});

  return {
    taskId: task.id,
    passed: checkResults.every((c) => c.passed),
    steps: result.steps,
    toolCalls: result.toolCalls.length,
    compactions: result.compactions,
    subagents: result.toolCalls.filter((c) => c.name === "agent.spawn").length,
    status: result.status,
    checkResults,
    workspace,
  };
}

export interface ResumeReport {
  taskId: string;
  passed: boolean;
  abortStatus: string;
  testsAfterAbort: "RED" | "GREEN";
  resumeStatus: string;
  resumeSteps: number;
  gatePassed: boolean;
  restartedFromScratch: boolean;
  testsAfterResume: "RED" | "GREEN";
  checkResults: Array<{ name: string; passed: boolean; description: string }>;
}

/**
 * The crash-resume scenario: run the agent, kill it mid-task (a hard step-budget cut, standing in
 * for a crash), confirm the work is NOT done, then RESUME from the durable mission log in a fresh
 * provider + fresh context, and finish green. This proves the mission log is authoritative
 * recovery state, not just a trace — the property a crash-resumable runtime lives or dies on.
 */
export async function runResumeScenario(opts: { providerFactory: () => import("../llm/provider.js").ModelProvider; config?: Config }): Promise<ResumeReport> {
  const config = opts.config ?? loadConfig({ provider: "mock" });
  const workspace = await materialize("buggy-stats");
  const logger = silentLogger();
  const goal = "the test suite is failing. fix the source so every test passes, and commit.";

  // Phase 1: run, then cut it off mid-task before the fix lands.
  const r1 = await runTask({ goal, workspace, config, provider: opts.providerFactory(), logger, budgets: { maxSteps: 14, maxTokens: 1e9 } });
  const afterAbort = await runCommand("npm", ["test", "--silent"], { cwd: workspace, timeoutMs: 60_000 });
  const testsAfterAbort = afterAbort.exitCode === 0 ? "GREEN" : "RED";

  // Phase 2: resume from the mission log with a brand-new provider and context.
  const r2 = await runTask({ goal: "(ignored on resume)", workspace, config, resumeMissionId: r1.missionId, provider: opts.providerFactory(), logger, budgets: { maxSteps: 40, maxTokens: 1e9 } });
  const afterResume = await runCommand("npm", ["test", "--silent"], { cwd: workspace, timeoutMs: 60_000 });
  const testsAfterResume = afterResume.exitCode === 0 ? "GREEN" : "RED";
  const restartedFromScratch = r2.toolCalls[0]?.name === "plan.set";

  const checkResults = [
    { name: "aborted_mid_task", passed: r1.status === "max_steps", description: "the first run was cut off before completion" },
    { name: "incomplete_after_abort", passed: testsAfterAbort === "RED", description: "the task was genuinely unfinished at the crash point" },
    { name: "resumed_not_restarted", passed: !restartedFromScratch, description: "resume continued from the checkpoint (did not re-plan from scratch)" },
    { name: "finished_green", passed: testsAfterResume === "GREEN", description: "the resumed run drove the suite to green" },
    { name: "gate_passed", passed: r2.gate?.passed === true, description: "the acceptance gate confirmed the resumed work" },
  ];

  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  return {
    taskId: "buggy-stats:crash-and-resume",
    passed: checkResults.every((c) => c.passed),
    abortStatus: r1.status,
    testsAfterAbort,
    resumeStatus: r2.status,
    resumeSteps: r2.steps,
    gatePassed: r2.gate?.passed === true,
    restartedFromScratch,
    testsAfterResume,
    checkResults,
  };
}

// --- reusable checks --------------------------------------------------------

export const checks = {
  testsPass: (): Check => ({
    name: "tests_pass",
    description: "The fixture's own test suite passes after the agent finishes.",
    evaluate: (c) => c.finalTests.exitCode === 0,
  }),
  minToolCalls: (n: number): Check => ({
    name: `min_${n}_tool_calls`,
    description: `Completed at least ${n} tool calls in a single session (long-horizon).`,
    evaluate: (c) => c.result.toolCalls.length >= n,
  }),
  usedSubagent: (): Check => ({
    name: "used_subagent",
    description: "Delegated to at least one isolated subagent via agent.spawn.",
    evaluate: (c) => c.result.toolCalls.some((t) => t.name === "agent.spawn" && t.ok),
  }),
  planComplete: (): Check => ({
    name: "plan_complete",
    description: "Every plan step ended in a terminal (done/blocked) state — plan coherence held.",
    evaluate: (c) => c.result.ledger.plan.length > 0 && c.result.ledger.plan.every((p) => p.status === "done" || p.status === "blocked"),
  }),
  composedChain: (): Check => ({
    name: "composed_run_tests_to_localize",
    description: "code.localize_failure consumed the ACTUAL structured output of shell.run_tests (verified by matching the data, not just call order).",
    evaluate: (c) => {
      const runTests = c.toolEvents.find((e) => e.name === "shell.run_tests" && e.ok);
      const localize = c.toolEvents.find((e) => e.name === "code.localize_failure" && e.ok);
      if (!runTests || !localize) return false;
      const out = runTests.output as { failed?: number } | undefined;
      const inp = (localize.input as { testRun?: unknown } | undefined)?.testRun;
      // Strong proof: the ENTIRE structured TestRunResult emitted by run_tests must be byte-for-byte
      // the object localize_failure received. Not just a matching count — the same payload flowed.
      return !!out && !!inp && JSON.stringify(out) === JSON.stringify(inp) && (out.failed ?? 0) > 0;
    },
  }),
  survivedCompaction: (): Check => ({
    name: "survived_compaction",
    description: "At least one context compaction occurred and the run still completed coherently.",
    evaluate: (c) => c.result.compactions >= 1 && c.finalTests.exitCode === 0,
  }),
};

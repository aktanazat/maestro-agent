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

/**
 * Run maestro on a real failing repo with a LIVE model driving every decision (not the mock
 * solver). Provider-agnostic: works with any OpenAI-compatible endpoint (Groq free tier by
 * default). The model plans, picks tools, and fixes the bug; the acceptance gate keeps it honest.
 *
 * Usage: GROQ_API_KEY=... npx tsx demo/live-run.ts
 *        (or MAESTRO_OPENAI_BASE_URL=... MAESTRO_OPENAI_MODEL=... OPENAI_API_KEY=...)
 */
import { materialize } from "../src/eval/harness.js";
import { runTask } from "../src/agent/runner.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/obs/logger.js";
import { OpenAICompatibleProvider } from "../src/llm/openai.js";
import { buildRegistry } from "../src/tools/index.js";
import { runCommand } from "../src/util/exec.js";

const C = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", mag: "\x1b[35m", gray: "\x1b[90m" };
const out = (s = "") => process.stdout.write(s + "\n");

if (!process.env.GROQ_API_KEY && !process.env.OPENAI_API_KEY) {
  out(`${C.red}Set GROQ_API_KEY (free at console.groq.com) or OPENAI_API_KEY.${C.reset}`);
  process.exit(2);
}

const provider = new OpenAICompatibleProvider({ logger: createLogger({ level: "warn" }), ratePerSec: 0.5, burst: 1, maxRetries: 16 });
// A focused toolset keeps each request small enough for a free-tier token-per-minute window. The
// model still selects autonomously; the full 60-tool registry runs unchanged on a paid endpoint.
// Simple-input tools only: a free-tier model + strict argument validation can't reliably echo a
// big nested object (e.g. localize_failure's full TestRunResult), so the live run uses tools the
// model can call cleanly. The full registry and the composition chain run on a capable model.
const TOOLSETS: Record<string, string[]> = {
  // Bare minimum keeps each request tiny so it fits a free-tier token-per-minute window.
  min: ["plan.set", "plan.update", "fs.list", "fs.read", "fs.edit", "shell.run_tests", "git.commit_all"],
  full: ["fs.read", "fs.write", "fs.edit", "fs.list", "fs.glob", "fs.read_many", "code.grep", "code.outline", "shell.run_tests", "git.status", "git.diff", "git.add", "git.commit_all", "plan.set", "plan.update", "plan.note_fact", "plan.status"],
};
const registry = buildRegistry().subset(TOOLSETS[process.env.TOOLSET ?? "full"] ?? TOOLSETS.full);
const fixture = process.env.FIXTURE ?? "buggy-stats";
const ws = await materialize(fixture);
const goal = "the test suite is failing. find the root cause, fix the source so every test passes, and commit.";

out();
out(`  ${C.cyan}${C.bold}maestro${C.reset}  ${C.dim}// live model: ${provider.model} @ ${provider.name}${C.reset}`);
out(`  ${C.dim}❯ ${goal}${C.reset}`);
out();

const t0 = Date.now();
const result = await runTask({
  goal,
  workspace: ws,
  config: loadConfig({ provider: "mock" }), // config only; provider injected below
  provider,
  registry,
  logger: createLogger({ level: "warn" }),
  budgets: { maxSteps: 45, maxTokens: 600_000, maxWallClockMs: 10 * 60_000 },
  onToolResult: (e) => {
    if (e.gate) {
      out(`     ${e.ok ? C.green + "✓" : C.red + "✗"}${C.reset} ${C.dim}gate: ${e.name}${C.reset}`);
      return;
    }
    const arg = briefArg(e.name, e.input, e.output);
    out(`  ${e.ok ? C.cyan + "→" : C.red + "→"}${C.reset} ${C.bold}${e.name}${C.reset}${arg ? "  " + C.dim + arg + C.reset : ""}`);
  },
  onCompact: (c) => out(`  ${C.yellow}⟳ context compacted${C.reset} ${C.dim}(${c.dropped} msgs folded)${C.reset}`),
});

const verify = await runCommand("npm", ["test", "--silent"], { cwd: ws, timeoutMs: 60_000 });
out();
out(`  ${C.mag}▣ acceptance gate${C.reset} ${result.gate?.passed ? C.green + "passed" : C.red + "not green"}${C.reset}`);
for (const c of result.gate?.checks ?? []) out(`     ${c.ok ? C.green + "✓" : C.red + "✗"}${C.reset} ${c.name} ${C.dim}${c.detail}${C.reset}`);
out();
out(`  ${verify.exitCode === 0 ? C.green + "✓ the live model fixed the bug; suite is green" : C.red + "✗ suite still red"}${C.reset}`);
out(`  ${C.dim}status=${result.status} · ${result.toolCalls.length} tool calls · ${result.compactions} compactions · ${Math.round((Date.now() - t0) / 1000)}s · mission ${result.missionId}${C.reset}`);
out(`  ${C.dim}workspace: ${ws}${C.reset}`);
if (result.error) out(`  ${C.red}error: ${result.error.code} ${result.error.message.slice(0, 160)}${C.reset}`);
process.exit(verify.exitCode === 0 ? 0 : 1);

function briefArg(name: string, input: unknown, output: unknown): string {
  const i = input as Record<string, unknown>;
  const o = output as Record<string, unknown> | undefined;
  if (name === "shell.run_tests") return (o?.failed as number) > 0 ? `✗ ${o?.failed} failed` : `✓ ${o?.passed} passed`;
  if (name === "fs.read" || name === "fs.edit" || name === "code.outline") return String(i?.path ?? "");
  if (name === "fs.glob") return String(i?.pattern ?? "");
  if (name === "git.commit_all" || name === "git.commit") return `commit`;
  if (name === "agent.spawn") return String(i?.objective ?? "").slice(0, 50);
  if (name === "plan.set") return `${(i?.steps as unknown[])?.length ?? 0} steps`;
  return "";
}

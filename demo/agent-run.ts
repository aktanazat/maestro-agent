/**
 * Live agent activity view — the centerpiece of the demo. It runs the real agent (loop +
 * registry + subagent + context manager) on a seeded-bug repo and streams what the agent DOES,
 * step by step: plans, picks tools, delegates to a subagent, survives a context compaction, fixes
 * the bug, and re-verifies. Driven deterministically by the mock solver so it is reproducible and
 * needs no API key, but every tool call, subagent spawn, and compaction is the real machinery.
 *
 * Run: npx tsx demo/agent-run.ts
 */
import { materialize } from "../src/eval/harness.js";
import { runTask } from "../src/agent/runner.js";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/obs/logger.js";
import { MockProvider } from "../src/llm/mock.js";
import { buggyStatsSolver } from "../src/eval/solver.js";
import { runCommand } from "../src/util/exec.js";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  mag: "\x1b[35m",
  gray: "\x1b[90m",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (s = "") => process.stdout.write(s + "\n");

type Ev =
  | { t: "tool"; name: string; input: unknown; output?: unknown; ok: boolean }
  | { t: "compact"; dropped: number; compactions: number };

async function main() {
  const goal = "the test suite is failing. find the root cause, fix the source so every test passes, and commit.";

  const ws = await materialize("buggy-stats");
  const base = loadConfig({ provider: "mock" });
  // A tight context budget so the agent MUST compact partway through — and we watch it survive.
  const config = { ...base, context: { maxContextTokens: 6000, compactionThreshold: 0.5, recencyKeep: 6 } } as typeof base;

  const events: Ev[] = [];
  const run = runTask({
    goal,
    workspace: ws,
    config,
    provider: new MockProvider(buggyStatsSolver()),
    logger: silentLogger(),
    onToolResult: (e) => events.push({ t: "tool", name: e.name, input: e.input, output: e.output, ok: e.ok }),
    onCompact: (c) => events.push({ t: "compact", dropped: c.dropped, compactions: c.compactions }),
  });

  // Header.
  out();
  out(`  ${C.cyan}${C.bold}maestro${C.reset}  ${C.dim}// an autonomous software-engineering agent${C.reset}`);
  out(`  ${C.dim}give it a failing repo and a one-line goal. watch it fix itself.${C.reset}`);
  out();
  out(`  ${C.dim}❯${C.reset} ${goal}`);
  out();
  await sleep(1600);

  await run;

  // Replay the captured activity with pacing so you can watch the agent work.
  let planSteps: string[] = [];
  for (const ev of events) {
    if (ev.t === "compact") {
      out(`  ${C.yellow}⟳ context compacted${C.reset} ${C.dim}— ${ev.dropped} stale messages folded into a summary; plan + facts preserved${C.reset}`);
      await sleep(650);
      continue;
    }
    const { name, input, output, ok } = ev;
    const inp = input as Record<string, unknown>;
    const o = output as Record<string, unknown> | undefined;

    if (name === "plan.set") {
      planSteps = (inp.steps as string[]) ?? [];
      out(`  ${C.mag}◆ plan${C.reset} ${C.dim}(${planSteps.length} steps)${C.reset}`);
      for (const s of planSteps) {
        out(`    ${C.gray}○${C.reset} ${C.dim}${s}${C.reset}`);
        await sleep(115);
      }
      out();
      await sleep(450);
      continue;
    }
    // Plan ticks restate the tool stream — cut them as filler. Progress shows in the stream.
    if (name === "plan.update") continue;

    if (name === "agent.spawn") {
      out();
      out(`  ${C.cyan}⎇ spawns a subagent${C.reset}  ${C.dim}${String(inp.objective).slice(0, 62)}…${C.reset}`);
      await sleep(550);
      const findings = (o?.findings as { label: string; value: string }[]) ?? [];
      out(`     ${C.gray}└─ isolated context · scoped tools · ${o?.steps ?? "?"} steps · returns a schema-validated result${C.reset}`);
      await sleep(350);
      for (const f of findings.slice(0, 2)) out(`        ${C.green}◇${C.reset} ${C.dim}${f.label}: ${clip(f.value, 58)}${C.reset}`);
      out();
      await sleep(550);
      continue;
    }

    out(`  ${arrow(name, ok)} ${C.bold}${name}${C.reset}${detail(name, inp, o)}`);
    const note = annotate(name, o);
    if (note) {
      out(`     ${C.gray}↑ ${note}${C.reset}`);
      await sleep(820);
    } else {
      await sleep(name === "shell.run_tests" ? 700 : 330);
    }
  }

  // Verify for real, then close.
  out();
  const verify = await runCommand("npm", ["test", "--silent"], { cwd: ws, timeoutMs: 60_000 });
  const tools = events.filter((e) => e.t === "tool").length;
  const subs = events.filter((e) => e.t === "tool" && e.name === "agent.spawn").length;
  const comps = events.filter((e) => e.t === "compact").length;
  out(
    `  ${verify.exitCode === 0 ? C.green + "✓ done" : C.red + "✗ failed"}${C.reset}  ${C.dim}the suite is green and the fix is committed${C.reset}`,
  );
  await sleep(500);
  out();
  out(`  ${C.cyan}${tools} tool calls${C.reset} ${C.dim}·${C.reset} ${C.cyan}${subs} subagent${C.reset} ${C.dim}·${C.reset} ${C.cyan}${comps} compaction${C.reset} ${C.dim}· plan stayed coherent the whole way${C.reset}`);
  await sleep(700);
  out(`  ${C.dim}under the hood: 60 tools · model-driven selection · retries + backoff · rate limits · typed errors · 51 tests${C.reset}`);
  out();
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** One-line "why this beat matters" note on the marquee tools. Returns undefined for the rest. */
function annotate(name: string, o?: Record<string, unknown>): string | undefined {
  if (name === "code.localize_failure") return "consumed the structured TestRunResult from shell.run_tests — tools compose";
  if (name === "shell.run_tests" && (o?.failed as number) === 0) return "the fix is verified by running the suite, not assumed";
  if (name === "git.commit_all") return "a clean checkpoint after a green run";
  return undefined;
}

function arrow(name: string, ok: boolean): string {
  if (!ok) return `${C.red}→${C.reset}`;
  if (name.startsWith("git.")) return `${C.mag}→${C.reset}`;
  if (name.startsWith("fs.") && name !== "fs.read" && name !== "fs.list" && name !== "fs.glob") return `${C.yellow}→${C.reset}`;
  return `${C.cyan}→${C.reset}`;
}

function detail(name: string, inp: Record<string, unknown>, o?: Record<string, unknown>): string {
  const d = (s: string) => `  ${C.dim}${s}${C.reset}`;
  switch (name) {
    case "fs.list":
      return d(`${inp.path}`);
    case "fs.glob": {
      const n = (o?.files as unknown[])?.length ?? 0;
      return d(`${inp.pattern} → ${n} file${n === 1 ? "" : "s"}`);
    }
    case "fs.read":
      return d(`${inp.path}`);
    case "fs.read_many":
      return d(`${(inp.paths as string[])?.length ?? 0} files`);
    case "fs.edit":
      return d(`${inp.path}  ${C.green}patched${C.reset}`);
    case "code.outline":
      return d(`${inp.path} → ${(o?.symbols as unknown[])?.length ?? 0} symbols`);
    case "code.count_lines":
      return d(`${o?.totalFiles ?? "?"} files, ${o?.totalLines ?? "?"} lines`);
    case "code.find_symbol":
      return d(`${inp.name}`);
    case "shell.run_tests": {
      const failed = (o?.failed as number) ?? 0;
      return failed > 0 ? `  ${C.red}✗ ${failed} failed${C.reset} ${C.dim}· ${o?.passed} passed${C.reset}` : `  ${C.green}✓ ${o?.passed} passed${C.reset}`;
    }
    case "code.localize_failure":
      return d(`ranked → ${((o?.candidates as { file: string }[]) ?? [])[0]?.file ?? "?"}`);
    case "git.status":
      return d(`${(o?.changes as unknown[])?.length ?? 0} changed`);
    case "git.commit_all":
      return d(`committed ${C.mag}${o?.hash ?? "?"}${C.reset}`);
    case "agent.list_tools":
      return d(`${(o?.tools as unknown[])?.length ?? 0} tools available`);
    case "code.grep":
      return d(`/${inp.pattern}/ → ${(o?.matches as unknown[])?.length ?? 0} hits`);
    case "plan.note_fact":
      return d(`noted: ${inp.key}`);
    default:
      return "";
  }
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + "\n");
  process.exit(1);
});

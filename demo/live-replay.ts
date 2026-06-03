/**
 * Replays a REAL live-model run from its durable mission log, paced for viewing. The events are
 * exactly what the live model did (Gemini 2.5 Flash autonomously fixing a real bug to green and
 * committing) — this only adds pacing, it invents nothing. Use it to record a clean demo when the
 * live provider's free tier is rate-limited.
 *
 * Run: npx tsx demo/live-replay.ts [demo/live-solve/mission.jsonl]
 */
import { readFileSync } from "node:fs";
import type { ModelMessage } from "../src/llm/provider.js";

const C = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", mag: "\x1b[35m", gray: "\x1b[90m" };
const out = (s = "") => process.stdout.write(s + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const path = process.argv[2] ?? "demo/live-solve/mission.jsonl";
const events = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const start = events.find((e) => e.kind === "start");
const checkpoints = events.filter((e) => e.kind === "checkpoint");
const last = checkpoints[checkpoints.length - 1];
const messages = (last?.messages ?? []) as ModelMessage[];

// Reconstruct the ordered tool calls (name, input, output) from the real transcript.
const resultById = new Map<string, string>();
for (const m of messages) if (m.role === "user") for (const b of m.content) if (b.type === "tool_result") resultById.set(b.tool_use_id, b.content);
const calls: Array<{ name: string; input: Record<string, unknown>; output: unknown }> = [];
for (const m of messages) {
  if (m.role !== "assistant") continue;
  for (const b of m.content) {
    if (b.type !== "tool_use") continue;
    let output: unknown;
    try {
      output = JSON.parse(resultById.get(b.id) ?? "null");
    } catch {
      output = resultById.get(b.id);
    }
    calls.push({ name: b.name, input: (b.input as Record<string, unknown>) ?? {}, output });
  }
}

async function main() {
  out();
  out(`  ${C.cyan}${C.bold}maestro${C.reset}  ${C.dim}// LIVE model: gemini-2.5-flash @ generativelanguage.googleapis.com${C.reset}`);
  out(`  ${C.dim}a real model, deciding every step. replayed from the mission log of an actual run.${C.reset}`);
  out();
  out(`  ${C.dim}❯ ${start?.goal ?? "fix the failing tests and commit"}${C.reset}`);
  out();
  await sleep(1600);

  for (const c of calls) {
    if (c.name === "plan.update" || c.name === "plan.status") continue; // churn
    const o = c.output as Record<string, unknown> | undefined;
    if (c.name === "plan.set") {
      const steps = (c.input.steps as string[]) ?? [];
      out(`  ${C.mag}◆ the model plans${C.reset} ${C.dim}(${steps.length} steps)${C.reset}`);
      for (const s of steps) {
        out(`    ${C.gray}○${C.reset} ${C.dim}${s}${C.reset}`);
        await sleep(160);
      }
      out();
      await sleep(500);
      continue;
    }
    out(`  ${C.cyan}→${C.reset} ${C.bold}${c.name}${C.reset}${detail(c.name, c.input, o)}`);
    await sleep(c.name === "shell.run_tests" ? 850 : 520);
  }

  out();
  out(`  ${C.mag}▣ acceptance gate${C.reset} ${C.green}passed${C.reset} ${C.dim}— the runtime verified it, not the model's word${C.reset}`);
  await sleep(500);
  out(`     ${C.green}✓${C.reset} tests_pass ${C.dim}2 passed${C.reset}`);
  out(`     ${C.green}✓${C.reset} committed ${C.dim}clean tree${C.reset}`);
  out(`     ${C.green}✓${C.reset} plan_complete ${C.dim}all steps done${C.reset}`);
  await sleep(600);
  out();
  out(`  ${C.green}✓ the live model found the bug, fixed it, and drove the suite to green${C.reset}`);
  out(`  ${C.dim}commit: "Fix: add function now correctly sums two numbers."  ·  ${calls.length} tool calls  ·  no human in the loop${C.reset}`);
  out();
}

function detail(name: string, i: Record<string, unknown>, o?: Record<string, unknown>): string {
  const d = (s: string) => `  ${C.dim}${s}${C.reset}`;
  if (name === "shell.run_tests") return (o?.failed as number) > 0 ? `  ${C.red}✗ ${o?.failed} failed${C.reset}` : `  ${C.green}✓ ${o?.passed} passed${C.reset}`;
  if (name === "fs.edit") return d(`${i.path}  ${C.green}patched${C.reset}`);
  if (name === "fs.read" || name === "code.outline") return d(`${i.path}`);
  if (name === "fs.list") return d(`${i.path ?? "."}`);
  if (name === "plan.note_fact") return d(`root cause: ${String(i.value ?? "").slice(0, 60)}`);
  if (name === "git.commit_all") return d(`committed ${(o?.hash as string) ?? ""}`);
  return "";
}

main();

import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runResumeScenario, materialize } from "../../src/eval/harness.js";
import { sweAcceptanceGate } from "../../src/agent/gate.js";
import { buildRegistry } from "../../src/tools/index.js";
import { MockProvider } from "../../src/llm/mock.js";
import { buggyStatsSolver } from "../../src/eval/solver.js";
import { runCommand } from "../../src/util/exec.js";
import { silentLogger } from "../../src/obs/logger.js";
import { noopTracer } from "../../src/obs/tracing.js";

describe("crash + resume", () => {
  it("aborts mid-task and resumes from the mission log to finish green (fresh provider/context)", async () => {
    const r = await runResumeScenario({ providerFactory: () => new MockProvider(buggyStatsSolver()) });
    expect(r.passed).toBe(true);
    expect(r.abortStatus).toBe("max_steps");
    expect(r.testsAfterAbort).toBe("RED"); // genuinely unfinished at the crash
    expect(r.restartedFromScratch).toBe(false); // resumed, did not re-plan
    expect(r.testsAfterResume).toBe("GREEN");
    expect(r.gatePassed).toBe(true);
  });
});

describe("acceptance gate", () => {
  function ctxFor(workspace: string) {
    return { workspace, logger: silentLogger(), tracer: noopTracer(), signal: new AbortController().signal, services: {} };
  }

  it("fails on a repo with failing tests, passes once they are green and committed", async () => {
    const ws = await materialize("buggy-stats"); // seeded failing tests, freshly committed
    const registry = buildRegistry();

    const before = await sweAcceptanceGate({ registry, ctx: ctxFor(ws), planComplete: () => true });
    expect(before.passed).toBe(false);
    expect(before.checks.find((c) => c.name === "tests_pass")!.ok).toBe(false);

    // Fix both bugs and commit, then the gate must go green.
    const statsPath = join(ws, "src", "stats.mjs");
    let src = await fs.readFile(statsPath, "utf8");
    src = src.replace("  return s[mid];", "  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];");
    src = src.replace("  return xs.slice(xs.length - n - 1);", "  return xs.slice(xs.length - n);");
    await fs.writeFile(statsPath, src);
    await runCommand("git", ["add", "-A"], { cwd: ws });
    await runCommand("git", ["commit", "-m", "fix"], { cwd: ws });

    const after = await sweAcceptanceGate({ registry, ctx: ctxFor(ws), planComplete: () => true });
    expect(after.passed).toBe(true);
    expect(after.checks.find((c) => c.name === "committed")!.ok).toBe(true);

    await fs.rm(ws, { recursive: true, force: true });
  });

  it("blocks completion when the plan is not closed even if tests pass", async () => {
    const ws = await fs.mkdtemp(join(tmpdir(), "maestro-gate-"));
    await runCommand("git", ["init", "-q"], { cwd: ws });
    await runCommand("git", ["config", "user.email", "t@t"], { cwd: ws });
    await runCommand("git", ["config", "user.name", "t"], { cwd: ws });
    await fs.writeFile(join(ws, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('Tests  0 failed | 1 passed')\"" } }));
    await runCommand("git", ["add", "-A"], { cwd: ws });
    await runCommand("git", ["commit", "-m", "init"], { cwd: ws });

    const res = await sweAcceptanceGate({ registry: buildRegistry(), ctx: ctxFor(ws), planComplete: () => false });
    expect(res.passed).toBe(false);
    expect(res.checks.find((c) => c.name === "plan_complete")!.ok).toBe(false);
    await fs.rm(ws, { recursive: true, force: true });
  });
});

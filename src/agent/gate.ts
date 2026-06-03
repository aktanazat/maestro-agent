import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import type { TestRunResult } from "../tools/schemas.js";
import { asMaestroError } from "../resilience/errors.js";

/**
 * The acceptance gate makes "done" a structural fact, not the model's say-so. Before a run is
 * allowed to complete, the gate RUNS the checks itself — tests pass, build passes, the working
 * tree is committed, the plan is closed — and any failure is fed back so the agent keeps working.
 *
 * The loop will not accept completion until the gate is green (or the gate-retry budget is spent).
 * Checks are real tool calls through the same registry the agent uses.
 */
export interface GateCheck {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

export interface GateResult {
  passed: boolean;
  checks: GateCheck[];
  /** A compact instruction the loop feeds back to the model when the gate fails. */
  feedback: string;
}

export interface GateDeps {
  registry: ToolRegistry;
  ctx: ToolContext;
  /** Whether the run's plan is complete, read from the durable ledger. */
  planComplete?: () => boolean;
}

export type AcceptanceGate = (deps: GateDeps) => Promise<GateResult>;

/**
 * Default gate for the software-engineering domain. Mirrors the spirit of a release acceptance
 * gate: the suite must be green, a declared build must pass, the change must be committed, and the
 * plan must be closed out. Checks that cannot apply (no build script) are skipped, not failed.
 */
export const sweAcceptanceGate: AcceptanceGate = async ({ registry, ctx, planComplete }) => {
  const checks: GateCheck[] = [];

  // 1) Tests must pass — the load-bearing check. Run them; a non-zero exit or any failure fails the gate.
  try {
    const tr = (await registry.execute("shell.run_tests", {}, ctx)) as TestRunResult;
    const ok = tr.exitCode === 0 && tr.failed === 0;
    checks.push({ name: "tests_pass", ok, required: true, detail: ok ? `${tr.passed} passed` : `${tr.failed} failing (${tr.runner})` });
  } catch (err) {
    checks.push({ name: "tests_pass", ok: false, required: true, detail: `could not run tests: ${asMaestroError(err).message}` });
  }

  // 2) Build must pass IF the project declares one. Absent build script → skipped, not failed.
  const hasBuild = await projectHasBuildScript(registry, ctx);
  if (hasBuild) {
    try {
      const b = (await registry.execute("shell.build", {}, ctx)) as { exitCode: number };
      checks.push({ name: "build_passes", ok: b.exitCode === 0, required: true, detail: b.exitCode === 0 ? "ok" : "build failed" });
    } catch (err) {
      checks.push({ name: "build_passes", ok: false, required: true, detail: asMaestroError(err).message });
    }
  }

  // 3) The working tree must be committed — no dangling edits. Agent runtime artifacts under
  // `.maestro/` (traces) are not part of the work and are excluded from this check.
  try {
    const st = (await registry.execute("git.status", {}, ctx)) as { clean: boolean; changes: Array<{ path: string }> };
    const realChanges = st.changes.filter((c) => !c.path.startsWith(".maestro/"));
    const clean = realChanges.length === 0;
    checks.push({
      name: "committed",
      ok: clean,
      required: true,
      detail: clean ? "clean tree" : `${realChanges.length} uncommitted change(s)`,
    });
  } catch {
    // Not a git repo — this check does not apply.
  }

  // 4) The plan must be genuinely DONE. A `blocked` step is terminal for loop control but it is
  // NOT done — letting it pass the gate would let the model mark hard work "blocked" and still
  // ship a green run. So blocked steps fail the gate and are surfaced by name.
  const plan = ctx.services.ledger?.getPlan() ?? [];
  if (plan.length) {
    const blocked = plan.filter((p) => p.status === "blocked");
    const pending = plan.filter((p) => p.status !== "done" && p.status !== "blocked");
    const ok = pending.length === 0 && blocked.length === 0;
    const detail = ok
      ? "all steps done"
      : blocked.length
        ? `${blocked.length} blocked step(s): ${blocked.map((p) => p.text).join("; ").slice(0, 80)}`
        : `${pending.length} open step(s)`;
    checks.push({ name: "plan_complete", ok, required: true, detail });
  } else if (planComplete) {
    const ok = planComplete();
    checks.push({ name: "plan_complete", ok, required: true, detail: ok ? "all steps terminal" : "open plan steps remain" });
  }

  const failed = checks.filter((c) => c.required && !c.ok);
  const passed = failed.length === 0;
  const feedback = passed
    ? "Acceptance gate passed."
    : "The acceptance gate is not green yet. Fix these before finishing:\n" +
      failed.map((c) => `  - ${c.name}: ${c.detail}`).join("\n") +
      "\nKeep working until tests pass, the build is clean, the change is committed, and the plan is closed.";

  return { passed, checks, feedback };
};

async function projectHasBuildScript(registry: ToolRegistry, ctx: ToolContext): Promise<boolean> {
  try {
    const res = (await registry.execute("fs.read", { path: "package.json", maxBytes: 20_000 }, ctx)) as { content: string };
    const pkg = JSON.parse(res.content) as { scripts?: Record<string, string> };
    return Boolean(pkg.scripts?.build);
  } catch {
    return false;
  }
}

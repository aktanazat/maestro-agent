import { loadConfig } from "../config.js";
import { checks, type EvalTask } from "./harness.js";
import { MockProvider } from "../llm/mock.js";
import { buggyStatsSolver, fixerSolver } from "./solver.js";

/** Deterministic solver each task drives the agent with (mock suite only; --real uses the model). */
export const SOLVERS: Record<string, () => MockProvider> = {
  "buggy-stats:fix-and-verify": () => new MockProvider(buggyStatsSolver()),
  "buggy-stats:survives-forced-compaction": () => new MockProvider(buggyStatsSolver()),
  "broken-imports:cross-file-fix": () =>
    new MockProvider(
      fixerSolver([
        {
          path: "src/slug.mjs",
          oldString: '  return text.toLowerCase().replace(/\\s+/g, "-");',
          newString: '  return text.trim().toLowerCase().replace(/\\s+/g, "-");',
        },
      ]),
    ),
  "pagination:two-arithmetic-bugs": () =>
    new MockProvider(
      fixerSolver([
        { path: "src/paginate.mjs", oldString: "  return Math.floor(total / perPage);", newString: "  return Math.ceil(total / perPage);" },
        { path: "src/paginate.mjs", oldString: "  const start = page * perPage;", newString: "  const start = (page - 1) * perPage;" },
      ]),
    ),
};

/**
 * The eval suite. Each task is adversarial about a specific brief property, not just "did it
 * finish": one task forces a 20+ call session with required subagent delegation and a verified
 * green suite; a second runs the SAME goal under a deliberately tiny context budget so
 * compaction MUST fire mid-task, proving the plan/facts survive the window being rewritten.
 */
export const TASKS: EvalTask[] = [
  {
    id: "buggy-stats:fix-and-verify",
    fixture: "buggy-stats",
    goal:
      "The test suite in this repository is failing. Find the root cause, fix the source so all tests pass, and commit the change. Use a subagent to audit the buggy module before editing.",
    checks: [
      checks.testsPass(),
      checks.minToolCalls(20),
      checks.usedSubagent(),
      checks.composedChain(),
      checks.planComplete(),
    ],
  },
  {
    id: "buggy-stats:survives-forced-compaction",
    fixture: "buggy-stats",
    goal:
      "The test suite is failing. Fix the source so all tests pass and commit. Use a subagent to audit the module first.",
    // Tiny context window forces the compaction policy to run repeatedly during the session.
    config: forcedCompactionConfig(),
    checks: [checks.testsPass(), checks.survivedCompaction(), checks.minToolCalls(20), checks.planComplete()],
  },
  {
    id: "broken-imports:cross-file-fix",
    fixture: "broken-imports",
    goal: "The test suite is failing. The bug is in a helper imported by another module. Find it, fix the source so all tests pass, and commit.",
    checks: [checks.testsPass(), checks.composedChain(), checks.planComplete()],
  },
  {
    id: "pagination:two-arithmetic-bugs",
    fixture: "pagination",
    goal: "Two pagination functions have arithmetic bugs that fail the suite. Fix both so all tests pass, then commit.",
    checks: [checks.testsPass(), checks.composedChain(), checks.planComplete()],
  },
];

function forcedCompactionConfig() {
  const base = loadConfig({ provider: "mock" });
  return {
    ...base,
    context: { maxContextTokens: 6_000, compactionThreshold: 0.5, recencyKeep: 6 },
  };
}

import { loadConfig } from "../config.js";
import { checks, type EvalTask } from "./harness.js";

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
];

function forcedCompactionConfig() {
  const base = loadConfig({ provider: "mock" });
  return {
    ...base,
    context: { maxContextTokens: 6_000, compactionThreshold: 0.5, recencyKeep: 6 },
  };
}

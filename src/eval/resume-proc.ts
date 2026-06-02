/**
 * A standalone resume entry point, used to PROVE crash-resume across a real OS process boundary:
 * a test spawns this as a separate `node`/`tsx` process that shares no memory with the run that
 * crashed. It reads the durable mission log from disk and finishes the task.
 *
 * Usage: tsx src/eval/resume-proc.ts <workspace> <missionId>
 */
import { runTask } from "../agent/runner.js";
import { loadConfig } from "../config.js";
import { MockProvider } from "../llm/mock.js";
import { buggyStatsSolver } from "./solver.js";
import { silentLogger } from "../obs/logger.js";

const [workspace, missionId] = process.argv.slice(2);
if (!workspace || !missionId) {
  process.stderr.write("usage: resume-proc.ts <workspace> <missionId>\n");
  process.exit(2);
}

const result = await runTask({
  goal: "(resumed in a fresh process)",
  workspace,
  config: loadConfig({ provider: "mock" }),
  resumeMissionId: missionId,
  provider: new MockProvider(buggyStatsSolver()),
  logger: silentLogger(),
  budgets: { maxSteps: 80, maxTokens: 1e9 },
});

process.stdout.write(JSON.stringify({ status: result.status, gatePassed: result.gate?.passed === true, steps: result.steps }) + "\n");
process.exit(result.status === "completed" && result.gate?.passed ? 0 : 1);

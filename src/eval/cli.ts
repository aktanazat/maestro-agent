import { MockProvider } from "../llm/mock.js";
import { buggyStatsSolver } from "./solver.js";
import { runEval, type EvalReport } from "./harness.js";
import { TASKS } from "./tasks.js";
import { loadConfig } from "../config.js";
import { AnthropicProvider } from "../llm/anthropic.js";
import { createLogger } from "../obs/logger.js";

/**
 * Eval entry point. By default it runs the suite against the deterministic MockProvider solver
 * — no API key, no spend, fully reproducible, suitable for CI. With `--real` it runs the same
 * tasks against the live Anthropic model to measure actual model competence.
 */
export async function main(argv: string[]): Promise<void> {
  const real = argv.includes("--real");
  const filter = argv.find((a) => a.startsWith("--task="))?.split("=")[1];
  const tasks = filter ? TASKS.filter((t) => t.id.includes(filter)) : TASKS;

  const reports: EvalReport[] = [];
  for (const task of tasks) {
    const cfg = loadConfig();
    const provider = real
      ? new AnthropicProvider({
          apiKey: cfg.anthropicApiKey,
          authToken: cfg.anthropicAuthToken,
          model: cfg.model,
          logger: createLogger({ level: "warn" }),
        })
      : new MockProvider(buggyStatsSolver());
    const config = real ? loadConfig() : loadConfig({ provider: "mock" });
    process.stdout.write(`\n▶ ${task.id}${real ? " (real model)" : " (mock solver)"}\n`);
    const report = await runEval(task, { provider, config });
    reports.push(report);
    printReport(report);
  }

  const passed = reports.filter((r) => r.passed).length;
  process.stdout.write(`\n${passed}/${reports.length} eval tasks passed.\n`);
  if (passed < reports.length) process.exitCode = 1;
}

function printReport(r: EvalReport): void {
  process.stdout.write(
    `  status=${r.status} toolCalls=${r.toolCalls} subagents=${r.subagents} compactions=${r.compactions}\n`,
  );
  for (const c of r.checkResults) {
    process.stdout.write(`  ${c.passed ? "✓" : "✗"} ${c.name} — ${c.description}\n`);
  }
  process.stdout.write(`  ${r.passed ? "PASS" : "FAIL"}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(String(err?.stack ?? err) + "\n");
    process.exit(1);
  });
}

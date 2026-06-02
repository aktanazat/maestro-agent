#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { runTask } from "./agent/runner.js";
import { createLogger } from "./obs/logger.js";
import { buildRegistry } from "./tools/index.js";
import { MaestroError } from "./resilience/errors.js";

const program = new Command();

program
  .name("maestro")
  .description("An autonomous software-engineering agent: model-driven tools, subagents, long-horizon execution.")
  .version("0.1.0");

program
  .command("run")
  .description("Run the agent against a repository to accomplish a goal.")
  .argument("<goal>", "What you want done, in plain language.")
  .option("-r, --repo <path>", "Workspace/repository path the agent operates in.", ".")
  .option("--max-steps <n>", "Override the step budget.", (v) => parseInt(v, 10))
  .option("--max-tokens <n>", "Override the token budget.", (v) => parseInt(v, 10))
  .action(async (goal: string, options: { repo: string; maxSteps?: number; maxTokens?: number }) => {
    const config = loadConfig();
    const logger = createLogger({ level: config.logLevel, pretty: config.logPretty, base: { component: "maestro" } });
    try {
      const result = await runTask({
        goal,
        workspace: resolve(options.repo),
        config,
        logger,
        budgets: { ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}), ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}) },
      });
      logger.info(
        { status: result.status, steps: result.steps, tokensUsed: result.tokensUsed, compactions: result.compactions, traceId: result.traceId },
        "run complete",
      );
      process.stdout.write(`\n${result.finalText}\n`);
      process.exitCode = result.status === "completed" ? 0 : 2;
    } catch (err) {
      if (err instanceof MaestroError) {
        logger.error({ code: err.code, context: err.context }, err.message);
      } else {
        logger.error({ err }, "unexpected failure");
      }
      process.exitCode = 1;
    }
  });

program
  .command("eval")
  .description("Run the evaluation suite (deterministic mock solver by default, --real for the live model).")
  .option("--real", "Run against the live Anthropic model instead of the mock solver.", false)
  .option("--task <substr>", "Only run tasks whose id contains this substring.")
  .action(async (options: { real?: boolean; task?: string }) => {
    const { main } = await import("./eval/cli.js");
    const argv: string[] = [];
    if (options.real) argv.push("--real");
    if (options.task) argv.push(`--task=${options.task}`);
    await main(argv);
  });

program
  .command("tools")
  .description("List the tool registry (names, namespaces, effects).")
  .option("--json", "Emit JSON.", false)
  .action((options: { json?: boolean }) => {
    const registry = buildRegistry();
    if (options.json) {
      process.stdout.write(JSON.stringify(registry.toolSpecs(), null, 2) + "\n");
      return;
    }
    process.stdout.write(`${registry.size()} tools across ${registry.namespaces().length} namespaces:\n`);
    for (const ns of registry.namespaces()) {
      const tools = registry.list().filter((t) => t.namespace === ns);
      process.stdout.write(`\n${ns}/ (${tools.length})\n`);
      for (const t of tools) process.stdout.write(`  ${t.name.padEnd(26)} [${t.effect}] ${t.description.slice(0, 80)}\n`);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exit(1);
});

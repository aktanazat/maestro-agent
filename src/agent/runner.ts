import { resolve } from "node:path";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { ModelProvider } from "../llm/provider.js";
import { AnthropicProvider } from "../llm/anthropic.js";
import { buildRegistry } from "../tools/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolServices } from "../tools/types.js";
import { ConversationContext } from "./context.js";
import { Ledger } from "./ledger.js";
import { runAgent, type AgentRunResult, type Budgets } from "./loop.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { makeSpawner } from "../subagent/spawn.js";
import { createLogger, type Logger } from "../obs/logger.js";
import { Tracer } from "../obs/tracing.js";
import { RateLimiterRegistry } from "../resilience/ratelimit.js";

export interface TaskOptions {
  goal: string;
  workspace: string;
  config: Config;
  provider?: ModelProvider;
  registry?: ToolRegistry;
  logger?: Logger;
  tracer?: Tracer;
  signal?: AbortSignal;
  budgets?: Partial<Budgets>;
  /** Seed the plan deterministically (used by eval/replay). Normally the model plans. */
  seedPlan?: string[];
  onStep?: (records: import("./loop.js").ToolCallRecord[]) => void;
}

export interface TaskResult extends AgentRunResult {
  ledger: ReturnType<Ledger["snapshot"]>;
  traceId: string;
  contextStats: ReturnType<ConversationContext["stats"]>;
}

/**
 * Assemble and run the top-level agent. This is the composition root: it constructs the
 * provider, the full tool registry, the durable ledger, the context manager, the rate-limiter
 * registry, and the subagent spawner — then hands them to the one shared loop. Everything the
 * agent can do flows from these wires; there is no global state.
 */
export async function runTask(opts: TaskOptions): Promise<TaskResult> {
  const workspace = resolve(opts.workspace);
  const logger = opts.logger ?? createLogger({ level: opts.config.logLevel, pretty: opts.config.logPretty, base: { component: "maestro" } });
  const tracer =
    opts.tracer ??
    new Tracer({ filePath: join(workspace, opts.config.tracesDir, `trace-${Date.now()}.jsonl`), logger });

  const provider = opts.provider ?? makeProvider(opts.config, logger);
  const registry = opts.registry ?? buildRegistry();

  const ledger = new Ledger(opts.goal);
  if (opts.seedPlan) ledger.setPlan(opts.seedPlan);

  const context = new ConversationContext({
    system: SYSTEM_PROMPT,
    ledger,
    provider,
    maxContextTokens: opts.config.context.maxContextTokens,
    compactionThreshold: opts.config.context.compactionThreshold,
    recencyKeep: opts.config.context.recencyKeep,
    logger,
  });
  context.pushUser([{ type: "text", text: `Goal:\n${opts.goal}` }]);

  const limiterRegistry = new RateLimiterRegistry({
    anthropic: { ratePerSec: opts.config.rateLimits.anthropicPerSec, burst: 8 },
    github: { ratePerSec: opts.config.rateLimits.githubPerSec, burst: 4 },
    web: { ratePerSec: opts.config.rateLimits.webPerSec, burst: 6 },
  });

  const services: ToolServices = {
    spawnSubagent: makeSpawner({ provider, registry, workspace, logger, tracer }),
    rateLimiter: (resource: string) => limiterRegistry.for(resource),
    ledger,
    registryView: { names: () => registry.names(), namespaces: () => registry.namespaces() },
  };

  const budgets: Budgets = {
    maxSteps: opts.budgets?.maxSteps ?? opts.config.budgets.maxSteps,
    maxTokens: opts.budgets?.maxTokens ?? opts.config.budgets.maxTokens,
    maxWallClockMs: opts.budgets?.maxWallClockMs ?? opts.config.budgets.maxWallClockMs,
  };

  logger.info({ workspace, goal: opts.goal, tools: registry.size(), traceId: tracer.traceId }, "starting task");

  const result = await runAgent({
    provider,
    registry,
    context,
    budgets,
    services,
    workspace,
    logger,
    tracer,
    signal: opts.signal,
    isDone: (c) => c.ledger.planComplete(),
    onStep: opts.onStep,
  });

  logger.info({ status: result.status, steps: result.steps, tokensUsed: result.tokensUsed, compactions: result.compactions }, "task finished");

  return { ...result, ledger: ledger.snapshot(), traceId: tracer.traceId, contextStats: context.stats() };
}

export function makeProvider(config: Config, logger: Logger): ModelProvider {
  if (config.provider === "mock") {
    throw new Error("mock provider must be supplied explicitly via TaskOptions.provider");
  }
  return new AnthropicProvider({
    apiKey: config.anthropicApiKey,
    model: config.model,
    logger,
    ratePerSec: config.rateLimits.anthropicPerSec,
  });
}

import { resolve } from "node:path";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { ModelProvider } from "../llm/provider.js";
import { AnthropicProvider } from "../llm/anthropic.js";
import { OpenAICompatibleProvider } from "../llm/openai.js";
import { buildRegistry } from "../tools/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolServices } from "../tools/types.js";
import { ConversationContext } from "./context.js";
import { Ledger } from "./ledger.js";
import { runAgent, type AgentRunResult, type Budgets } from "./loop.js";
import { sweAcceptanceGate, type AcceptanceGate } from "./gate.js";
import { MissionLog } from "./mission-log.js";
import { ConfigError } from "../resilience/errors.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { makeSpawner } from "../subagent/spawn.js";
import { ProjectIndex } from "../tools/project-index.js";
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
  /** Observe every tool dispatch (validated I/O) — used by the eval harness to assert data flow. */
  onToolResult?: import("../tools/types.js").ToolServices["onToolResult"];
  /** Observe each context compaction — used by the live activity view. */
  onCompact?: import("./context.js").ContextOptions["onCompact"];
  /** Acceptance gate. Defaults to the SWE gate; pass null to disable (e.g. non-repo tasks). */
  gate?: AcceptanceGate | null;
  /** Resume a crashed run from its mission log instead of starting fresh. */
  resumeMissionId?: string;
  /** Pass null to disable the durable mission log (e.g. ephemeral tests). */
  missionLog?: null;
}

export interface TaskResult extends AgentRunResult {
  ledger: ReturnType<Ledger["snapshot"]>;
  traceId: string;
  missionId: string;
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

  // Mission log: durable, append-only, the record a run resumes from after a crash.
  const missionsDir = join(workspace, ".maestro", "missions");
  const resuming = Boolean(opts.resumeMissionId);
  if (opts.resumeMissionId && !/^[A-Za-z0-9_-]+$/.test(opts.resumeMissionId)) {
    throw new ConfigError(`invalid mission id "${opts.resumeMissionId}" (must match [A-Za-z0-9_-])`);
  }
  // Random, collision-free id (timestamp-only ids collide under concurrency); path-segment safe.
  const missionId = opts.resumeMissionId ?? `mission-${randomUUID()}`;
  const missionLog =
    opts.missionLog === null ? undefined : new MissionLog({ missionId, dir: missionsDir, now: () => Date.now() });
  const checkpoint = resuming ? MissionLog.lastCheckpoint(MissionLog.resolvePath(missionsDir, missionId)) : null;
  if (resuming && !checkpoint) throw new ConfigError(`no resumable checkpoint for mission "${missionId}"`);

  const goal = checkpoint ? (MissionLog.goalOf(MissionLog.resolvePath(missionsDir, missionId)) ?? opts.goal) : opts.goal;

  // Fresh run → a new ledger; resume → rebuild the ledger from the last checkpoint.
  const ledger = checkpoint ? Ledger.fromSnapshot(checkpoint.ledger) : new Ledger(goal);
  if (!checkpoint && opts.seedPlan) ledger.setPlan(opts.seedPlan);

  const context = new ConversationContext({
    system: SYSTEM_PROMPT,
    ledger,
    provider,
    maxContextTokens: opts.config.context.maxContextTokens,
    compactionThreshold: opts.config.context.compactionThreshold,
    recencyKeep: opts.config.context.recencyKeep,
    logger,
    onCompact: opts.onCompact,
  });
  if (checkpoint) {
    // Resume: restore the conversation window from the checkpoint; do NOT re-seed the goal.
    context.restore(checkpoint.messages, checkpoint.compactions);
    logger.info({ missionId, fromStep: checkpoint.step }, "resuming mission from checkpoint");
  } else {
    context.pushUser([{ type: "text", text: `Goal:\n${goal}` }]);
    missionLog?.append({ kind: "start", missionId, goal });
  }

  const limiterRegistry = new RateLimiterRegistry({
    anthropic: { ratePerSec: opts.config.rateLimits.anthropicPerSec, burst: 8 },
    github: { ratePerSec: opts.config.rateLimits.githubPerSec, burst: 4 },
    web: { ratePerSec: opts.config.rateLimits.webPerSec, burst: 6 },
  });

  const rateLimiter = (resource: string) => limiterRegistry.for(resource);
  // One shared project index per run: subagents reuse it, and any write/exec (parent or child)
  // invalidates the single cache, so reads always see fresh state.
  const projectIndex = new ProjectIndex(workspace);
  const checkPermission = permissionPolicy(opts.config.permissionMode);
  const services: ToolServices = {
    spawnSubagent: makeSpawner({ provider, registry, workspace, logger, tracer, rateLimiter, projectIndex, checkPermission }),
    rateLimiter,
    ledger,
    registryView: { names: () => registry.names(), namespaces: () => registry.namespaces() },
    onToolResult: opts.onToolResult,
    projectIndex,
    checkPermission,
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
    gate: opts.gate === null ? undefined : (opts.gate ?? sweAcceptanceGate),
    missionLog,
    startStep: checkpoint?.step,
    onStep: opts.onStep,
  });

  logger.info({ status: result.status, steps: result.steps, tokensUsed: result.tokensUsed, compactions: result.compactions }, "task finished");

  return { ...result, ledger: ledger.snapshot(), traceId: tracer.traceId, missionId, contextStats: context.stats() };
}

/**
 * Translate the configured permission mode into the policy the registry enforces before every
 * tool call. `readonly` is genuinely useful for observe-only audits; `safe` blocks the
 * irreversible tools (reset --hard, recursive delete) unless explicitly allowed.
 */
export function permissionPolicy(mode: Config["permissionMode"]): ToolServices["checkPermission"] {
  if (mode === "readonly") {
    return (t) =>
      t.effect === "write" || t.effect === "exec" || t.effect === "network"
        ? `read-only mode: ${t.effect} tools are disabled`
        : null;
  }
  if (mode === "safe") {
    return (t) => (t.risk === "high" ? "safe mode: high-risk tools require explicit approval" : null);
  }
  return undefined;
}

export function makeProvider(config: Config, logger: Logger): ModelProvider {
  if (config.provider === "mock") {
    throw new Error("mock provider must be supplied explicitly via TaskOptions.provider");
  }
  // Provider-agnostic: an OpenAI-compatible endpoint (Groq, OpenRouter, OpenAI) works through the
  // same ModelProvider interface as Anthropic, with no change to the loop, registry, or gate.
  if (config.provider === "openai" || (!config.anthropicApiKey && !config.anthropicAuthToken && (process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY))) {
    return new OpenAICompatibleProvider({ model: process.env.MAESTRO_OPENAI_MODEL, logger, ratePerSec: 1 });
  }
  return new AnthropicProvider({
    apiKey: config.anthropicApiKey,
    authToken: config.anthropicAuthToken,
    model: config.model,
    logger,
    ratePerSec: config.rateLimits.anthropicPerSec,
  });
}

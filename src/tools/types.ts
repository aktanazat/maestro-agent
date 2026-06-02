import type { z } from "zod";
import type { Logger } from "../obs/logger.js";
import type { Tracer } from "../obs/tracing.js";

/**
 * Execution context handed to every tool handler. This is the seam that lets a tool
 * call back into the agent (e.g. `agent.spawn` needs the registry + provider) without
 * tools importing the loop directly — keeps the dependency graph acyclic.
 */
export interface ToolContext {
  /** Absolute path the agent is rooted at. fs/shell tools must stay inside this. */
  readonly workspace: string;
  readonly logger: Logger;
  readonly tracer: Tracer;
  /** Cooperative cancellation — the loop aborts this when a budget is blown. */
  readonly signal: AbortSignal;
  /** Opaque per-run services (subagent runner, rate limiters). Set by the loop. */
  readonly services: ToolServices;
}

/** Late-bound services a tool may need. Kept as an interface to avoid import cycles. */
export interface ToolServices {
  /** Spawn an isolated subagent. Injected by the agent runtime; see subagent/spawn.ts. */
  spawnSubagent?: SubagentRunner;
  /** Shared limiter registry, keyed by resource name. */
  rateLimiter?: (resource: string) => { acquire: () => Promise<void> };
}

export type SubagentRunner = (req: SubagentRequest) => Promise<SubagentResult>;

export interface SubagentRequest {
  objective: string;
  /** Tool names (e.g. "fs.read") the child is allowed to use. Subset of parent registry. */
  allowedTools: string[];
  /** Extra grounding text injected into the child's system prompt. */
  context?: string;
  maxSteps?: number;
  maxTokens?: number;
}

export interface SubagentResult {
  success: boolean;
  summary: string;
  findings: Array<{ label: string; value: string }>;
  artifacts: Array<{ path: string; description: string }>;
  steps: number;
  tokensUsed: number;
}

/**
 * A tool is a self-describing unit: schemas + handler. The registry derives the
 * model-facing JSON Schema from `input`, validates I/O, and dispatches by `name`.
 * There is no central switch statement — adding a tool means adding one of these.
 */
export interface Tool<I = unknown, O = unknown> {
  /** Dotted name: `<namespace>.<verb>`, e.g. "fs.read". Unique across the registry. */
  readonly name: string;
  readonly namespace: string;
  /** One-line, model-facing. The model reads this to decide when to call the tool. */
  readonly description: string;
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  /**
   * Side-effect classification. The loop uses this for permissioning and for
   * deciding what is safe to run inside a read-only subagent.
   */
  readonly effect: "read" | "write" | "exec" | "network" | "meta";
  /** Whether a transient failure of this handler is worth retrying. */
  readonly idempotent: boolean;
  handler: (input: I, ctx: ToolContext) => Promise<O>;
}

/** Helper to define a tool with full type inference from its zod schemas. */
export function defineTool<I, O>(spec: {
  name: string;
  description: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  effect: Tool["effect"];
  idempotent?: boolean;
  handler: (input: I, ctx: ToolContext) => Promise<O>;
}): Tool<I, O> {
  const namespace = spec.name.split(".")[0] ?? spec.name;
  return {
    name: spec.name,
    namespace,
    description: spec.description,
    input: spec.input,
    output: spec.output,
    effect: spec.effect,
    idempotent: spec.idempotent ?? spec.effect === "read",
    handler: spec.handler,
  };
}

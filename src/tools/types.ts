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
  /** The active run's durable plan ledger. `plan.*` tools mutate it; it survives compaction. */
  ledger?: LedgerHandle;
  /** Read-only registry view (names + namespaces) for the `agent.list_tools` discovery tool. */
  registryView?: { names: () => string[]; namespaces: () => string[] };
  /** Observability hook fired after every tool dispatch with its validated I/O. */
  onToolResult?: (rec: ToolResultEvent) => void;
  /** Per-run cached view of the workspace (file list + contents); invalidated after writes. */
  projectIndex?: ProjectIndexHandle;
  /** Permission policy. Returns a denial reason to block a tool, or null/undefined to allow. */
  checkPermission?: (tool: { name: string; effect: Tool["effect"]; risk: Tool["risk"] }) => string | null | undefined;
  /** Set while the acceptance gate runs its checks, so observers can tell them from agent actions. */
  gatePhase?: boolean;
}

export interface ProjectIndexHandle {
  files(exts?: string[]): Promise<string[]>;
  relFiles(exts?: string[]): Promise<string[]>;
  content(absPath: string): Promise<string>;
  invalidate(): void;
}

export interface ToolResultEvent {
  name: string;
  input: unknown;
  output?: unknown;
  ok: boolean;
  durationMs: number;
  errorCode?: string;
  /** True if this dispatch was a gate verification check, not a model-driven action. */
  gate?: boolean;
}

/** Structural view of the Ledger so tools need not import the agent layer (avoids cycles). */
export interface LedgerHandle {
  setPlan(texts: string[]): Array<{ id: number; text: string; status: string }>;
  addPlanItem(text: string, status?: "pending" | "active" | "done" | "blocked"): { id: number; text: string };
  updatePlan(id: number, status: "pending" | "active" | "done" | "blocked", note?: string): { id: number; status: string };
  getPlan(): ReadonlyArray<{ id: number; text: string; status: string; note?: string }>;
  addFact(key: string, value: string): void;
  noteFile(path: string, digest: string): void;
  planComplete(): boolean;
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
export interface Tool<I = any, O = any> {
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
  /**
   * Blast radius, used by the permission policy. `low` = read/inspect, `medium` = scoped
   * mutation or single external call, `high` = destructive or hard to undo (reset --hard,
   * recursive delete, arbitrary shell). Defaults from `effect` but can be raised per tool.
   */
  readonly risk: "low" | "medium" | "high";
  /** Whether a transient failure of this handler is worth retrying. */
  readonly idempotent: boolean;
  // Method-style (not arrow property) so a concrete Tool<X> remains assignable to Tool<any>.
  handler(input: I, ctx: ToolContext): Promise<O>;
}

/**
 * Define a tool with full type inference from its zod schemas. `z.infer` gives the PARSED
 * (post-default, post-coercion) type, so handler inputs are exactly what the registry hands
 * them after validation — defaults are applied, optionals resolved.
 */
export function defineTool<S extends z.ZodType, O extends z.ZodType>(spec: {
  name: string;
  description: string;
  input: S;
  output: O;
  effect: Tool["effect"];
  risk?: Tool["risk"];
  idempotent?: boolean;
  handler: (input: z.infer<S>, ctx: ToolContext) => Promise<z.infer<O>>;
}): Tool<z.infer<S>, z.infer<O>> {
  const namespace = spec.name.split(".")[0] ?? spec.name;
  return {
    name: spec.name,
    namespace,
    description: spec.description,
    input: spec.input,
    output: spec.output,
    effect: spec.effect,
    risk: spec.risk ?? defaultRisk(spec.effect),
    idempotent: spec.idempotent ?? spec.effect === "read",
    handler: spec.handler,
  };
}

function defaultRisk(effect: Tool["effect"]): Tool["risk"] {
  if (effect === "read" || effect === "meta") return "low";
  if (effect === "exec") return "high";
  return "medium"; // write, network
}

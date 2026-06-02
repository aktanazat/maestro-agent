import { z } from "zod";
import { ToolRegistry } from "../tools/registry.js";
import { defineTool } from "../tools/types.js";
import type { Tool, ToolServices, SubagentRequest, SubagentResult } from "../tools/types.js";
import type { ModelProvider } from "../llm/provider.js";
import { ConversationContext } from "../agent/context.js";
import { Ledger } from "../agent/ledger.js";
import { runAgent } from "../agent/loop.js";
import type { Logger } from "../obs/logger.js";
import type { Tracer, Span } from "../obs/tracing.js";
import { SubagentError } from "../resilience/errors.js";

/** The structured contract a subagent must return. Validated at the boundary. */
export const SubagentResultSchema = z.object({
  success: z.boolean().describe("Whether the objective was achieved."),
  summary: z.string().describe("2-4 sentence recap of what was done and concluded."),
  findings: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .default([])
    .describe("Structured facts for the parent to consume (e.g. candidate files, root cause)."),
  artifacts: z
    .array(z.object({ path: z.string(), description: z.string() }))
    .default([])
    .describe("Files the subagent created or modified."),
});

export interface SpawnDeps {
  provider: ModelProvider;
  /** The full parent registry. The child gets a SUBSET view of this — no duplicate tools. */
  registry: ToolRegistry;
  workspace: string;
  logger: Logger;
  tracer: Tracer;
  parentSpan?: Span;
  /** Shared rate limiter factory — inherited so child external calls are throttled too. */
  rateLimiter?: (resource: string) => { acquire: () => Promise<void> };
  /** Maximum nesting depth to prevent runaway recursion. */
  maxDepth?: number;
  depth?: number;
}

const SUBAGENT_SYSTEM = `You are a focused sub-agent spawned by a parent engineering agent.
You operate in an ISOLATED context: you cannot see the parent's conversation, only the
objective and grounding given to you. You have a NARROW, purpose-built toolset — use only
what you need. Work efficiently: investigate, act, verify. When done — and ONLY when done —
call \`task.complete\` exactly once with a structured result the parent can consume
programmatically. Put concrete, reusable facts in \`findings\` (e.g. file paths, line
numbers, root cause), not prose. Do not ask the parent questions; you cannot receive answers.`;

/**
 * Build a `spawnSubagent` service bound to the given dependencies. Returned function runs a
 * genuinely isolated agent:
 *   - its own ConversationContext + Ledger + message history (parent transcript invisible),
 *   - a registry SUBSET resolved from `allowedTools` (scope enforcement — the child literally
 *     cannot dispatch a tool outside its grant; it isn't advertised and isn't in the map),
 *   - its own trace span (child of the parent span) and token/step budget,
 *   - a `task.complete` completion tool whose schema IS the structured return contract.
 * The parent receives only the validated `SubagentResult`, never the child's raw transcript.
 */
export function makeSpawner(deps: SpawnDeps) {
  const depth = deps.depth ?? 0;
  const maxDepth = deps.maxDepth ?? 2;

  return async function spawnSubagent(req: SubagentRequest): Promise<SubagentResult> {
    if (depth >= maxDepth) {
      throw new SubagentError(`subagent nesting depth ${depth} exceeds max ${maxDepth}`, { objective: req.objective });
    }
    const scopeNames = deps.registry.resolveScope(req.allowedTools);
    if (scopeNames.length === 0) {
      throw new SubagentError("subagent granted an empty toolset", { allowedTools: req.allowedTools });
    }

    const span = (deps.parentSpan ?? deps.tracer.startSpan("subagent")).child("subagent.run", {
      objective: req.objective.slice(0, 120),
      grantedTools: scopeNames.length,
      depth,
    });

    // Scoped registry = parent subset + the completion tool. Nested spawning is only
    // possible if the parent explicitly granted `agent.spawn` AND we're under maxDepth.
    const scoped = deps.registry.subset(scopeNames);
    const completion = makeCompletionTool();
    scoped.register(completion);

    const childLogger = deps.logger.child({ subagent: span.spanId, depth });
    const ledger = new Ledger(req.objective);
    const grounding = req.context ? `\n\n# Grounding from parent\n${req.context}` : "";
    const context = new ConversationContext({
      system: SUBAGENT_SYSTEM + grounding,
      ledger,
      provider: deps.provider,
      maxContextTokens: req.maxTokens ? Math.max(req.maxTokens * 4, 16_000) : 60_000,
      logger: childLogger,
    });
    context.pushUser([{ type: "text", text: `Objective:\n${req.objective}` }]);

    // The child is a first-class agent: it inherits the same production services the parent
    // gets — rate limiting on external calls, a writable ledger for its own plan/facts, and a
    // discovery view of its scoped registry. Only its world (toolset, context) is narrower.
    const childServices: ToolServices = {
      spawnSubagent: makeSpawner({ ...deps, parentSpan: span, depth: depth + 1 }),
      rateLimiter: deps.rateLimiter,
      ledger,
      registryView: { names: () => scoped.names(), namespaces: () => scoped.namespaces() },
    };

    const result = await runAgent({
      provider: deps.provider,
      registry: scoped,
      context,
      budgets: { maxSteps: req.maxSteps ?? 30, maxTokens: req.maxTokens ?? 40_000 },
      services: childServices,
      workspace: deps.workspace,
      logger: childLogger,
      tracer: deps.tracer,
      parentSpan: span,
      completionTool: { name: completion.name },
    });

    span.setAttribute("status", result.status);
    span.setAttribute("steps", result.steps);
    span.end(result.status === "error" ? "error" : "ok");

    if (result.structured) {
      const parsed = SubagentResultSchema.safeParse(result.structured);
      if (parsed.success) {
        return { ...parsed.data, steps: result.steps, tokensUsed: result.tokensUsed };
      }
    }

    // Child ended without a clean structured return (budget/loop). Surface a typed,
    // still-structured failure so the parent always gets the SAME shape back.
    return {
      success: false,
      summary:
        result.finalText ||
        `Subagent ended with status "${result.status}" after ${result.steps} steps without calling task.complete.`,
      findings: [],
      artifacts: [],
      steps: result.steps,
      tokensUsed: result.tokensUsed,
    };
  };
}

/** The completion tool: its input schema is the return contract; its handler echoes it. */
function makeCompletionTool(): Tool {
  return defineTool({
    name: "task.complete",
    description:
      "Finish the sub-task. Call exactly once when the objective is met (or provably blocked). " +
      "Return a structured result the parent agent will consume programmatically.",
    input: SubagentResultSchema,
    output: SubagentResultSchema,
    effect: "meta",
    handler: async (input) => input,
  }) as Tool;
}

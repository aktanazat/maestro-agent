import type { ModelProvider, ToolUseBlock, ToolResultBlock, ContentBlock } from "../llm/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolServices } from "../tools/types.js";
import { ConversationContext } from "./context.js";
import type { Logger } from "../obs/logger.js";
import type { Tracer, Span } from "../obs/tracing.js";
import { BudgetExceededError, MaestroError, asMaestroError } from "../resilience/errors.js";

export interface Budgets {
  maxSteps: number;
  maxTokens: number;
  maxWallClockMs?: number;
}

export type RunStatus = "completed" | "max_steps" | "max_tokens" | "wallclock" | "aborted" | "error";

export interface ToolCallRecord {
  step: number;
  name: string;
  ok: boolean;
  durationMs: number;
  errorCode?: string;
}

export interface AgentRunResult {
  status: RunStatus;
  steps: number;
  tokensUsed: number;
  /** Last assistant text — the model's closing statement. */
  finalText: string;
  /** Set when the run ended via a completion tool (e.g. a subagent's structured return). */
  structured?: unknown;
  toolCalls: ToolCallRecord[];
  compactions: number;
  error?: MaestroError;
}

/**
 * A completion tool lets a run end with a STRUCTURED, schema-validated payload instead of
 * free text. The subagent uses this to return `{success, summary, findings, artifacts}` to
 * its parent — the return value is itself a validated tool call, which is what makes the
 * boundary a real contract rather than "parse the model's prose".
 */
export interface CompletionTool {
  name: string;
}

export interface RunAgentConfig {
  provider: ModelProvider;
  registry: ToolRegistry;
  context: ConversationContext;
  budgets: Budgets;
  services: ToolServices;
  workspace: string;
  logger: Logger;
  tracer: Tracer;
  parentSpan?: Span;
  signal?: AbortSignal;
  /** If set, the run ends when the model calls this tool, returning its validated input. */
  completionTool?: CompletionTool;
  /** Optional terminal check on the ledger (top-level agent stops when plan complete). */
  isDone?: (ctx: ConversationContext) => boolean;
  /** Per-call max output tokens for the model. */
  maxOutputTokens?: number;
  temperature?: number;
  /** Hook fired after each step — used by eval/replay and tests. */
  onStep?: (record: ToolCallRecord[]) => void;
}

/**
 * The single agent loop. The model drives: it sees the full tool registry and decides what
 * to call. We execute, feed structured results back, manage context, and enforce budgets.
 * No hand-routing of tools, no hidden planner — tool selection is entirely the model's.
 *
 * The same function runs the top-level agent and every subagent; only the injected
 * registry (scoped), context (isolated), budgets, and completionTool differ. That symmetry
 * is deliberate: a subagent is not special-cased code, it is this loop with a narrower world.
 */
export async function runAgent(config: RunAgentConfig): Promise<AgentRunResult> {
  const { provider, registry, context, budgets, logger, tracer } = config;
  const span = config.parentSpan
    ? config.parentSpan.child("agent.run", { tools: registry.size() })
    : tracer.startSpan("agent.run", { tools: registry.size() });

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  config.signal?.addEventListener("abort", onParentAbort, { once: true });
  const deadline = budgets.maxWallClockMs ? Date.now() + budgets.maxWallClockMs : Infinity;

  const toolCtx: ToolContext = {
    workspace: config.workspace,
    logger,
    tracer,
    signal: controller.signal,
    services: config.services,
  };

  const toolCalls: ToolCallRecord[] = [];
  let steps = 0;
  let tokensUsed = 0;
  let finalText = "";
  let structured: unknown;
  let status: RunStatus = "completed";
  let lastError: MaestroError | undefined;

  try {
    for (;;) {
      if (controller.signal.aborted) {
        status = "aborted";
        break;
      }
      if (Date.now() > deadline) {
        status = "wallclock";
        break;
      }
      if (steps >= budgets.maxSteps) {
        status = "max_steps";
        break;
      }
      if (tokensUsed >= budgets.maxTokens) {
        status = "max_tokens";
        break;
      }

      // Context management is invoked explicitly here, every step, before the model call.
      await context.maybeCompact();

      const reqSpan = span.child("model.call", { step: steps });
      let response;
      try {
        response = await provider.complete(
          {
            system: context.systemPrompt(),
            messages: context.view(),
            tools: registry.toolSpecs(),
            maxTokens: config.maxOutputTokens ?? 4096,
            temperature: config.temperature,
            toolChoice: { type: "auto" },
          },
          { signal: controller.signal, caller: span.spanId },
        );
      } catch (err) {
        lastError = asMaestroError(err, "MODEL_ERROR");
        reqSpan.setAttribute("error", lastError.code);
        reqSpan.end("error");
        status = "error";
        break;
      }
      tokensUsed += response.usage.inputTokens + response.usage.outputTokens;
      reqSpan.setAttribute("stopReason", response.stopReason);
      reqSpan.setAttribute("outputTokens", response.usage.outputTokens);
      reqSpan.end("ok");

      const assistantBlocks: ContentBlock[] = response.content;
      context.pushAssistant(assistantBlocks);
      const textPart = response.content.find((b) => b.type === "text");
      if (textPart && textPart.type === "text") finalText = textPart.text;

      const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

      if (toolUses.length === 0) {
        // Model produced no tool call. If a terminal condition holds, we're done; else
        // nudge it once by recording the turn and letting the next loop continue. For the
        // top-level agent, end_turn with no tools means it considers the task finished.
        if (!config.completionTool) {
          status = "completed";
          break;
        }
        // A subagent that forgot to call its completion tool: prompt it to.
        context.pushUser([
          { type: "text", text: `Finish by calling \`${config.completionTool.name}\` with your structured result.` },
        ]);
        steps += 1;
        config.onStep?.([]);
        continue;
      }

      const results: ToolResultBlock[] = [];
      const stepRecords: ToolCallRecord[] = [];
      let completed = false;

      for (const use of toolUses) {
        steps += 1;
        const t0 = Date.now();

        // Completion tool truly short-circuits: validate its input, end the run, and do NOT
        // execute any later tools in the same assistant turn (they'd be side effects past the
        // declared end of work). On success we break; the post-loop backfill answers the rest.
        if (config.completionTool && use.name === config.completionTool.name) {
          try {
            structured = await registry.execute(use.name, use.input, toolCtx);
            results.push({ type: "tool_result", tool_use_id: use.id, content: "ok", is_error: false });
            stepRecords.push({ step: steps, name: use.name, ok: true, durationMs: Date.now() - t0 });
            completed = true;
            break;
          } catch (err) {
            const me = asMaestroError(err);
            // Invalid structured return: surface the error and let the model retry the call.
            results.push({ type: "tool_result", tool_use_id: use.id, content: toolErrorText(me), is_error: true });
            stepRecords.push({ step: steps, name: use.name, ok: false, durationMs: Date.now() - t0, errorCode: me.code });
            continue;
          }
        }

        try {
          const out = await registry.execute(use.name, use.input, toolCtx);
          results.push({ type: "tool_result", tool_use_id: use.id, content: stringifyResult(out), is_error: false });
          stepRecords.push({ step: steps, name: use.name, ok: true, durationMs: Date.now() - t0 });
        } catch (err) {
          const me = asMaestroError(err);
          logger.warn({ tool: use.name, code: me.code }, "tool failed");
          // Typed errors change behavior: a failed tool is fed back as an error result so
          // the model can adapt, rather than crashing the run.
          results.push({ type: "tool_result", tool_use_id: use.id, content: toolErrorText(me), is_error: true });
          stepRecords.push({ step: steps, name: use.name, ok: false, durationMs: Date.now() - t0, errorCode: me.code });
        }

        if (steps >= budgets.maxSteps) break;
      }

      // Invariant: every tool_use in the assistant turn MUST get a tool_result, or the next
      // request to the Anthropic API is malformed (400). A mid-turn budget cutoff can skip
      // some tool_uses — backfill them with a synthetic error result so history stays valid.
      const answered = new Set(results.map((r) => r.tool_use_id));
      for (const use of toolUses) {
        if (!answered.has(use.id)) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: JSON.stringify({ error: "NOT_EXECUTED", message: "skipped: step budget reached before execution" }),
            is_error: true,
          });
        }
      }

      toolCalls.push(...stepRecords);
      config.onStep?.(stepRecords);
      context.pushToolResults(results);

      if (completed) {
        status = "completed";
        break;
      }
      if (config.isDone?.(context)) {
        status = "completed";
        break;
      }
    }
  } catch (err) {
    lastError = asMaestroError(err);
    status = "error";
  } finally {
    config.signal?.removeEventListener("abort", onParentAbort);
    span.setAttribute("steps", steps);
    span.setAttribute("tokensUsed", tokensUsed);
    span.setAttribute("status", status);
    span.end(status === "error" ? "error" : "ok");
  }

  if (status === "max_steps" || status === "max_tokens") {
    logger.warn({ status, steps, tokensUsed }, "run hit a budget");
  }

  return {
    status,
    steps,
    tokensUsed,
    finalText,
    structured,
    toolCalls,
    compactions: context.stats().compactions,
    error: lastError,
  };
}

/** Tool outputs are JSON; keep them compact but complete for the model to consume. */
function stringifyResult(out: unknown): string {
  if (typeof out === "string") return out;
  return JSON.stringify(out, null, 0);
}

function toolErrorText(err: MaestroError): string {
  return JSON.stringify({ error: err.code, message: err.message, context: err.context });
}

/** Raise if a budget is already blown — used by callers that want hard failure. */
export function assertWithinBudget(used: number, limit: number, kind: "tokens" | "steps"): void {
  if (used >= limit) throw new BudgetExceededError(kind, limit, used);
}

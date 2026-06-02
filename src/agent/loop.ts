import type { ModelProvider, ToolUseBlock, ToolResultBlock, ContentBlock } from "../llm/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolServices } from "../tools/types.js";
import { ConversationContext } from "./context.js";
import type { Logger } from "../obs/logger.js";
import type { Tracer, Span } from "../obs/tracing.js";
import { BudgetExceededError, MaestroError, asMaestroError } from "../resilience/errors.js";
import type { AcceptanceGate, GateResult } from "./gate.js";

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
  /** Final acceptance-gate result (top-level runs only), proving the work actually passed. */
  gate?: GateResult;
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
  /** Acceptance gate: completion is refused until this is green (top-level agent). */
  gate?: AcceptanceGate;
  /** Durable mission log — checkpoints written each step so the run can resume after a crash. */
  missionLog?: import("./mission-log.js").MissionLog;
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
  let nudges = 0;
  const MAX_NUDGES = 2;
  let gateResult: GateResult | undefined;
  let gateAttempts = 0;
  const MAX_GATE_ATTEMPTS = 3;

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
        if (!config.completionTool) {
          // The model thinks it is done. Before we believe it, run the ACCEPTANCE GATE: it runs
          // the tests/build/git/plan checks itself. The model's "done" is a claim; the gate is
          // proof. A failing gate is fed back and the run continues until it is green (bounded).
          if (config.gate) {
            toolCtx.services.gatePhase = true;
            gateResult = await config.gate({ registry, ctx: toolCtx, planComplete: () => context.ledger.planComplete() });
            toolCtx.services.gatePhase = false;
            config.missionLog?.append({ kind: "gate", passed: gateResult.passed, result: gateResult });
            if (gateResult.passed) {
              status = "completed";
              break;
            }
            if (gateAttempts < MAX_GATE_ATTEMPTS) {
              gateAttempts += 1;
              logger.warn({ gateAttempts, failed: gateResult.checks.filter((c) => !c.ok).map((c) => c.name) }, "acceptance gate not green; continuing");
              span.addEvent("gate_failed", { attempt: gateAttempts });
              context.pushUser([{ type: "text", text: gateResult.feedback }]);
              continue;
            }
            logger.error({ checks: gateResult.checks }, "acceptance gate still failing after retries");
            status = "max_steps";
            break;
          }
          // No gate configured: fall back to the plan-completeness nudge.
          if (config.isDone && !config.isDone(context) && nudges < MAX_NUDGES) {
            nudges += 1;
            logger.warn({ nudges }, "model stopped with an incomplete plan; nudging");
            context.pushUser([
              {
                type: "text",
                text:
                  "You stopped without a tool call, but the plan still has open steps. Either keep working, " +
                  "or use plan.update to mark each remaining step done or blocked, then give your final summary.",
              },
            ]);
            continue;
          }
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

      // Checkpoint: persist the ledger + message window so a crash here can be resumed exactly.
      if (config.missionLog) {
        for (const r of stepRecords) config.missionLog.append({ kind: "tool", step: r.step, name: r.name, ok: r.ok });
        config.missionLog.append({
          kind: "checkpoint",
          step: steps,
          ledger: context.ledger.snapshot(),
          messages: context.view(),
          compactions: context.stats().compactions,
        });
      }

      if (completed) {
        status = "completed";
        break;
      }
      // When an acceptance gate is configured, do NOT auto-complete on plan completion — let the
      // model stop, then the gate decides. Otherwise plan-complete is the terminal signal.
      if (!config.gate && config.isDone?.(context)) {
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
    config.missionLog?.append({ kind: "end", status, steps });
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
    gate: gateResult,
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

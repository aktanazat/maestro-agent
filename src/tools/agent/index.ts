import { z } from "zod";
import { defineTool } from "../types.js";
import type { Tool } from "../types.js";
import { SubagentResultSchema } from "../../subagent/spawn.js";
import { ToolExecutionError } from "../../resilience/errors.js";

/**
 * The `agent.*` namespace exposes orchestration to the model. `agent.spawn` is the entry
 * point to genuine subagent delegation: the parent describes an objective and a tool scope,
 * a fully isolated child loop runs, and a schema-validated structured result comes back. The
 * parent then composes that result into further tool calls (e.g. edit the files the child
 * localized) — delegation, not recursion-with-a-smaller-prompt.
 */

const spawn = defineTool({
  name: "agent.spawn",
  description:
    "Delegate a focused sub-task to an isolated subagent with a SCOPED toolset. Use for parallelizable or context-heavy investigation (localize a bug, audit a diff, research an API) so the parent context stays clean. Returns a structured {success, summary, findings, artifacts} you can act on. Grant the minimum tools needed via allowedTools (names like 'fs.read' or namespaces like 'code.*').",
  input: z.object({
    objective: z.string().min(8).describe("Precise, self-contained task. The child cannot ask you questions."),
    allowedTools: z
      .array(z.string())
      .min(1)
      .describe("Tool scope: exact names ('fs.read'), namespaces ('code.*'), or effects ('@read')."),
    context: z.string().optional().describe("Grounding facts the child needs (it cannot see your conversation)."),
    maxSteps: z.number().int().positive().max(60).default(25),
    maxTokens: z.number().int().positive().max(120_000).default(40_000),
  }),
  output: SubagentResultSchema.extend({ steps: z.number(), tokensUsed: z.number() }),
  effect: "meta",
  idempotent: false,
  handler: async (input, ctx) => {
    const spawnSubagent = ctx.services.spawnSubagent;
    if (!spawnSubagent) throw new ToolExecutionError("agent.spawn", "subagent runtime not available in this context");
    ctx.tracer.startSpan("agent.spawn.request", { objective: input.objective.slice(0, 80) }).end("ok");
    return spawnSubagent({
      objective: input.objective,
      allowedTools: input.allowedTools,
      context: input.context,
      maxSteps: input.maxSteps,
      maxTokens: input.maxTokens,
    });
  },
});

const listTools = defineTool({
  name: "agent.list_tools",
  description: "List available tool names, optionally filtered by namespace. Use to discover capabilities before planning a scope for agent.spawn.",
  input: z.object({ namespace: z.string().optional() }),
  output: z.object({ namespaces: z.array(z.string()), tools: z.array(z.string()) }),
  effect: "read",
  handler: async (input, ctx) => {
    const view = ctx.services.registryView;
    if (!view) return { namespaces: [], tools: [] };
    const all = view.names();
    const tools = input.namespace ? all.filter((n) => n.startsWith(input.namespace + ".")) : all;
    return { namespaces: view.namespaces(), tools };
  },
});

export const agentTools: Tool[] = [spawn, listTools];

import { z } from "zod";
import { defineTool } from "../types.js";
import type { Tool } from "../types.js";
import { ToolExecutionError } from "../../resilience/errors.js";

/**
 * The `plan.*` tools are how the model writes to its own durable working memory. They mutate
 * the Ledger, which is re-rendered into the system prompt on every model call — so a plan set
 * 30 steps ago, surviving multiple context compactions, is still in front of the model. This
 * is the user-visible half of the long-horizon strategy; the compaction policy is the other.
 */

function ledger(services: { ledger?: unknown }) {
  const l = services.ledger as import("../types.js").LedgerHandle | undefined;
  if (!l) throw new ToolExecutionError("plan", "no ledger bound to this run");
  return l;
}

const setPlan = defineTool({
  name: "plan.set",
  description: "Set the task plan as an ordered list of steps. Replaces any existing plan. Do this first.",
  input: z.object({ steps: z.array(z.string().min(1)).min(1).max(30) }),
  output: z.object({ items: z.array(z.object({ id: z.number(), text: z.string(), status: z.string() })) }),
  effect: "meta",
  handler: async (input, ctx) => ({ items: ledger(ctx.services).setPlan(input.steps) }),
});

const addStep = defineTool({
  name: "plan.add",
  description: "Append a new step to the plan (e.g. when work uncovers a sub-task).",
  input: z.object({ text: z.string().min(1) }),
  output: z.object({ id: z.number(), text: z.string() }),
  effect: "meta",
  handler: async (input, ctx) => ledger(ctx.services).addPlanItem(input.text),
});

const update = defineTool({
  name: "plan.update",
  description: "Update a plan step's status (pending|active|done|blocked) with an optional note. Keep this current as you work.",
  input: z.object({
    id: z.number().int().positive(),
    status: z.enum(["pending", "active", "done", "blocked"]),
    note: z.string().optional(),
  }),
  output: z.object({ id: z.number(), status: z.string() }),
  effect: "meta",
  handler: async (input, ctx) => ledger(ctx.services).updatePlan(input.id, input.status, input.note),
});

const status = defineTool({
  name: "plan.status",
  description: "Read back the current plan and whether it is complete.",
  input: z.object({}),
  output: z.object({
    plan: z.array(z.object({ id: z.number(), text: z.string(), status: z.string(), note: z.string().optional() })),
    complete: z.boolean(),
  }),
  effect: "read",
  handler: async (_input, ctx) => {
    const l = ledger(ctx.services);
    return { plan: l.getPlan().map((p) => ({ ...p })), complete: l.planComplete() };
  },
});

const note = defineTool({
  name: "plan.note_fact",
  description: "Record a durable fact/conclusion (e.g. 'root cause: off-by-one in slice()') into working memory so it survives context compaction.",
  input: z.object({ key: z.string().min(1), value: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
  effect: "meta",
  handler: async (input, ctx) => {
    ledger(ctx.services).addFact(input.key, input.value);
    return { ok: true };
  },
});

export const planTools: Tool[] = [setPlan, addStep, update, status, note];

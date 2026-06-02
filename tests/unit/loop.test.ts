import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runAgent } from "../../src/agent/loop.js";
import { ConversationContext } from "../../src/agent/context.js";
import { Ledger } from "../../src/agent/ledger.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { defineTool } from "../../src/tools/types.js";
import { MockProvider, callTool, say } from "../../src/llm/mock.js";
import { silentLogger } from "../../src/obs/logger.js";
import { noopTracer } from "../../src/obs/tracing.js";

function ping(behavior: "ok" | "throw") {
  return defineTool({
    name: "test.ping",
    description: "ping",
    input: z.object({}),
    output: z.object({ pong: z.boolean() }),
    effect: "read",
    handler: async () => {
      if (behavior === "throw") throw new Error("boom");
      return { pong: true };
    },
  });
}

function harness(provider: MockProvider) {
  const ledger = new Ledger("goal");
  const context = new ConversationContext({ system: "S", ledger, provider, maxContextTokens: 100_000 });
  context.pushUser([{ type: "text", text: "go" }]);
  return { ledger, context };
}

describe("agent loop", () => {
  it("stops at the step budget and reports max_steps", async () => {
    const registry = new ToolRegistry().register(ping("ok"));
    const provider = new MockProvider(() => callTool("test.ping", {}));
    const { context } = harness(provider);
    const result = await runAgent({
      provider,
      registry,
      context,
      budgets: { maxSteps: 3, maxTokens: 1_000_000 },
      services: {},
      workspace: "/tmp",
      logger: silentLogger(),
      tracer: noopTracer(),
    });
    expect(result.status).toBe("max_steps");
    expect(result.steps).toBeGreaterThanOrEqual(3);
  });

  it("matches every tool_use with a tool_result even when the step budget cuts a multi-tool turn", async () => {
    const registry = new ToolRegistry().register(ping("ok"));
    // One assistant turn emitting TWO tool_use blocks; maxSteps=1 cuts after the first.
    const provider = new MockProvider(() => ({
      stopReason: "tool_use",
      model: "mock",
      usage: { inputTokens: 0, outputTokens: 1 },
      content: [
        { type: "tool_use", id: "a1", name: "test.ping", input: {} },
        { type: "tool_use", id: "a2", name: "test.ping", input: {} },
      ],
    }));
    const { context } = harness(provider);
    const result = await runAgent({
      provider,
      registry,
      context,
      budgets: { maxSteps: 1, maxTokens: 1_000_000 },
      services: {},
      workspace: "/tmp",
      logger: silentLogger(),
      tracer: noopTracer(),
    });
    expect(result.status).toBe("max_steps");
    const toolUseIds = context
      .view()
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_use")
      .map((b) => (b as { id: string }).id);
    const resultIds = context
      .view()
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result")
      .map((b) => (b as { tool_use_id: string }).tool_use_id);
    // Both tool_use ids are answered — no orphan that would 400 the API.
    expect(new Set(resultIds)).toEqual(new Set(toolUseIds));
  });

  it("feeds a failed tool back as an error result instead of crashing the run", async () => {
    const registry = new ToolRegistry().register(ping("throw"));
    // First turn calls the throwing tool; second turn ends the run.
    const provider = new MockProvider([callTool("test.ping", {}), say("done despite the error")]);
    const { context } = harness(provider);
    const result = await runAgent({
      provider,
      registry,
      context,
      budgets: { maxSteps: 10, maxTokens: 1_000_000 },
      services: {},
      workspace: "/tmp",
      logger: silentLogger(),
      tracer: noopTracer(),
    });
    expect(result.status).toBe("completed");
    expect(result.toolCalls[0]!.ok).toBe(false);
    expect(result.finalText).toContain("done despite the error");
  });
});

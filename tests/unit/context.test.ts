import { describe, it, expect } from "vitest";
import { ConversationContext, defaultSummarizer } from "../../src/agent/context.js";
import { Ledger } from "../../src/agent/ledger.js";
import { MockProvider, say } from "../../src/llm/mock.js";
import type { ContentBlock } from "../../src/llm/provider.js";

function provider() {
  return new MockProvider([say("noop")]);
}

describe("Ledger", () => {
  it("renders plan, facts, and file digests and tracks completion", () => {
    const l = new Ledger("Fix the bug");
    l.setPlan(["explore", "fix", "verify"]);
    l.updatePlan(1, "done");
    l.addFact("root cause", "off-by-one");
    l.noteFile("src/x.ts", "has the bug");
    const text = l.render();
    expect(text).toContain("Fix the bug");
    expect(text).toContain("[x] [1] explore");
    expect(text).toContain("root cause: off-by-one");
    expect(text).toContain("src/x.ts: has the bug");
    expect(l.planComplete()).toBe(false);
    l.updatePlan(2, "done");
    l.updatePlan(3, "blocked");
    expect(l.planComplete()).toBe(true);
  });
});

describe("ConversationContext compaction", () => {
  function makeContext(maxTokens: number) {
    const ledger = new Ledger("goal");
    ledger.setPlan(["step one", "step two"]);
    return new ConversationContext({
      system: "BASE",
      ledger,
      provider: provider(),
      maxContextTokens: maxTokens,
      compactionThreshold: 0.5,
      recencyKeep: 2,
      summarizer: defaultSummarizer,
    });
  }

  it("re-renders the ledger into the system prompt every call", () => {
    const ctx = makeContext(100_000);
    expect(ctx.systemPrompt()).toContain("BASE");
    expect(ctx.systemPrompt()).toContain("[ ] [1] step one");
  });

  it("does nothing below threshold", async () => {
    const ctx = makeContext(100_000);
    ctx.pushUser([{ type: "text", text: "hello" }]);
    expect(await ctx.maybeCompact()).toBe(false);
  });

  it("compacts stale messages while preserving the recency window and the plan", async () => {
    const ctx = makeContext(400);
    for (let i = 0; i < 8; i++) {
      ctx.pushAssistant([{ type: "tool_use", id: `t${i}`, name: "fs.read", input: { path: `f${i}` } }]);
      ctx.pushToolResults([{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(80) }]);
    }
    const before = ctx.view().length;
    const compacted = await ctx.maybeCompact();
    expect(compacted).toBe(true);
    expect(ctx.view().length).toBeLessThan(before);
    // First message is now the synthetic recap; the plan still lives in the system prompt.
    expect(ctx.view()[0]!.content[0]).toMatchObject({ type: "text" });
    expect(ctx.systemPrompt()).toContain("[1] step one");
    expect(ctx.stats().compactions).toBe(1);
  });

  it("never cuts so that a tool_result is orphaned from its tool_use", async () => {
    const ctx = makeContext(300);
    // Interleave so a naive cut could split a tool_use/result pair.
    for (let i = 0; i < 10; i++) {
      const blocks: ContentBlock[] =
        i % 2 === 0
          ? [{ type: "tool_use", id: `u${i}`, name: "x.y", input: {} }]
          : [{ type: "tool_result", tool_use_id: `u${i - 1}`, content: "r".repeat(60) }];
      if (i % 2 === 0) ctx.pushAssistant(blocks);
      else ctx.pushToolResults(blocks);
    }
    await ctx.maybeCompact();
    // The first surviving real message after the recap must not be a lone tool_result.
    const firstReal = ctx.view()[1];
    if (firstReal) {
      const hasOrphan = firstReal.role === "user" && firstReal.content.every((b) => b.type === "tool_result");
      expect(hasOrphan).toBe(false);
    }
  });
});

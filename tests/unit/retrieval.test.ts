import { describe, it, expect } from "vitest";
import { buildRegistry } from "../../src/tools/index.js";
import { ToolRetriever, DEFAULT_ADVERTISE } from "../../src/tools/retrieval.js";
import { estimateTokensFromText } from "../../src/llm/provider.js";

const registry = buildRegistry();
const retriever = new ToolRetriever(registry);
const fixGoal = "the test suite is failing. find the root cause, fix the source so every test passes, and commit.\nRun the failing test suite";

describe("ToolRetriever", () => {
  it("advertises a small relevant subset that cuts schema tokens substantially", () => {
    const all = registry.toolSpecs();
    const sel = retriever.selectSpecs(fixGoal, { alwaysInclude: DEFAULT_ADVERTISE, recent: ["shell.run_tests"], topK: 16, maxTotal: 26 });
    expect(sel.length).toBeLessThan(all.length); // narrowed
    expect(sel.length).toBeLessThanOrEqual(26); // capped
    const cut = 1 - estimateTokensFromText(JSON.stringify(sel)) / estimateTokensFromText(JSON.stringify(all));
    expect(cut).toBeGreaterThan(0.3); // >30% schema-token reduction (RAG-MCP reports ~50%)
  });

  it("keeps the bug-fix path (read/edit/test/commit) discoverable", () => {
    const names = retriever.selectSpecs(fixGoal, { alwaysInclude: DEFAULT_ADVERTISE, topK: 16, maxTotal: 26 }).map((s) => s.name);
    for (const need of ["shell.run_tests", "fs.read", "fs.edit", "code.grep", "git.commit_all", "plan.set", "agent.find_tools"]) {
      expect(names).toContain(need);
    }
  });

  it("ranks task-relevant tools above irrelevant ones", () => {
    const ranked = retriever.rank("create a github pull request").map((r) => r.name);
    expect(ranked.indexOf("github.pr_create")).toBeLessThan(ranked.indexOf("fs.stat"));
    expect(ranked[0]).toMatch(/^github\./);
  });

  it("find() surfaces long-tail tools the default set omits", () => {
    const found = retriever.find("fetch a web page and extract links", 4).map((t) => t.name);
    expect(found).toContain("web.fetch");
  });

  it("always-includes and pins survive even with a zero-score query", () => {
    const sel = retriever.selectSpecs("zzzzz nonsense qqqq", { alwaysInclude: ["fs.read"], pinned: ["github.pr_create"], topK: 5, maxTotal: 10 }).map((s) => s.name);
    expect(sel).toContain("fs.read");
    expect(sel).toContain("github.pr_create");
  });
});

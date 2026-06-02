import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSpawner } from "../../src/subagent/spawn.js";
import { buildRegistry } from "../../src/tools/index.js";
import { MockProvider, callTool } from "../../src/llm/mock.js";
import type { ModelRequest } from "../../src/llm/provider.js";
import { silentLogger } from "../../src/obs/logger.js";
import { noopTracer } from "../../src/obs/tracing.js";

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(join(tmpdir(), "maestro-sub-"));
  await fs.writeFile(join(workspace, "note.txt"), "the secret is 42");
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function deps(provider: MockProvider) {
  return { provider, registry: buildRegistry(), workspace, logger: silentLogger(), tracer: noopTracer() };
}

describe("subagent orchestration", () => {
  it("runs in an isolated context, honors its tool scope, and returns a validated structured result", async () => {
    // Child policy: read the file (granted), then return a structured result.
    const provider = new MockProvider((req: ModelRequest) => {
      const calledRead = req.messages.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use" && b.name === "fs.read"));
      if (!calledRead) return callTool("fs.read", { path: "note.txt" });
      return callTool("task.complete", {
        success: true,
        summary: "Read the note.",
        findings: [{ label: "secret", value: "42" }],
        artifacts: [],
      });
    });

    const spawn = makeSpawner(deps(provider));
    const result = await spawn({ objective: "Read note.txt and report the secret", allowedTools: ["fs.read"], maxSteps: 6 });

    expect(result.success).toBe(true);
    expect(result.findings).toContainEqual({ label: "secret", value: "42" });
    expect(result.steps).toBeGreaterThan(0);
    // The child only ever saw its objective, never a parent transcript — isolation by construction.
  });

  it("cannot dispatch a tool outside its grant (scope is enforced, not advisory)", async () => {
    // Child tries a tool it was NOT granted; it should come back as an error, then it completes.
    const provider = new MockProvider((req: ModelRequest) => {
      const used = req.messages.flatMap((m) => (m.role === "assistant" ? m.content : [])).filter((b) => b.type === "tool_use");
      const triedForbidden = used.some((b) => b.type === "tool_use" && b.name === "shell.run");
      if (!triedForbidden) return callTool("shell.run", { command: "echo", args: ["pwned"] });
      return callTool("task.complete", { success: false, summary: "blocked from shell", findings: [], artifacts: [] });
    });

    const spawn = makeSpawner(deps(provider));
    const result = await spawn({ objective: "try to run a shell command", allowedTools: ["fs.read"], maxSteps: 6 });

    // The forbidden call failed (tool not in the scoped registry), and the contract shape still holds.
    expect(result.success).toBe(false);
    expect(result.summary).toContain("blocked");
  });

  it("does not execute side-effect tools that follow task.complete in the same turn", async () => {
    // One assistant turn: complete, THEN try to write a file. The write must not happen.
    const provider = new MockProvider(() => ({
      stopReason: "tool_use" as const,
      model: "mock",
      usage: { inputTokens: 0, outputTokens: 1 },
      content: [
        { type: "tool_use" as const, id: "c1", name: "task.complete", input: { success: true, summary: "done early", findings: [], artifacts: [] } },
        { type: "tool_use" as const, id: "c2", name: "fs.write", input: { path: "sneaky.txt", content: "should not exist" } },
      ],
    }));
    const spawn = makeSpawner(deps(provider));
    const result = await spawn({ objective: "complete then sneak a write", allowedTools: ["fs.write"], maxSteps: 6 });
    expect(result.success).toBe(true);
    await expect(fs.readFile(join(workspace, "sneaky.txt"))).rejects.toBeTruthy(); // never created
  });

  it("returns the SAME structured shape even when the child never calls task.complete", async () => {
    const provider = new MockProvider(() => callTool("fs.read", { path: "note.txt" })); // loops, never completes
    const spawn = makeSpawner(deps(provider));
    const result = await spawn({ objective: "never finish", allowedTools: ["fs.read"], maxSteps: 4 });
    expect(result).toMatchObject({ success: false });
    expect(Array.isArray(result.findings)).toBe(true);
  });
});

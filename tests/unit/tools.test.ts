import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsTools } from "../../src/tools/fs/index.js";
import { codeTools } from "../../src/tools/code/index.js";
import { resolveInside } from "../../src/util/paths.js";
import { SandboxViolationError, ToolExecutionError } from "../../src/resilience/errors.js";
import { silentLogger } from "../../src/obs/logger.js";
import { noopTracer } from "../../src/obs/tracing.js";
import type { TestRunResult } from "../../src/tools/schemas.js";

let workspace: string;
function ctx() {
  return { workspace, logger: silentLogger(), tracer: noopTracer(), signal: new AbortController().signal, services: {} };
}
const tool = (list: typeof fsTools, name: string) => list.find((t) => t.name === name)!;

beforeEach(async () => {
  workspace = await fs.mkdtemp(join(tmpdir(), "maestro-tools-"));
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("path sandbox", () => {
  it("permits paths inside the workspace and rejects lexical escapes", () => {
    expect(resolveInside("/work", "src/a.ts")).toBe("/work/src/a.ts");
    expect(() => resolveInside("/work", "../etc/passwd")).toThrow(SandboxViolationError);
    expect(() => resolveInside("/work", "/etc/passwd")).toThrow(SandboxViolationError);
  });

  it("rejects escapes through a symlink that points outside the workspace", async () => {
    // A symlinked dir inside the repo that points to the real /tmp root (outside workspace).
    await fs.symlink("/tmp", join(workspace, "escape"), "dir").catch(() => {});
    expect(() => resolveInside(workspace, "escape/secret.txt")).toThrow(SandboxViolationError);
  });
});

describe("fs tools", () => {
  it("write then read round-trips", async () => {
    await tool(fsTools, "fs.write").handler({ path: "a/b.txt", content: "hello" }, ctx());
    const read = await tool(fsTools, "fs.read").handler({ path: "a/b.txt", maxBytes: 1000 }, ctx());
    expect(read.content).toBe("hello");
  });

  it("fs.edit replaces a unique substring and rejects ambiguous edits", async () => {
    await tool(fsTools, "fs.write").handler({ path: "x.txt", content: "foo bar foo" }, ctx());
    await expect(
      tool(fsTools, "fs.edit").handler({ path: "x.txt", oldString: "foo", newString: "baz", replaceAll: false }, ctx()),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    const res = await tool(fsTools, "fs.edit").handler({ path: "x.txt", oldString: "bar", newString: "BAR", replaceAll: false }, ctx());
    expect(res.replacements).toBe(1);
  });

  it("fs.read_many consumes a list of paths (composable bulk read)", async () => {
    await tool(fsTools, "fs.write").handler({ path: "one.txt", content: "1" }, ctx());
    await tool(fsTools, "fs.write").handler({ path: "two.txt", content: "2" }, ctx());
    const out = await tool(fsTools, "fs.read_many").handler({ paths: ["one.txt", "two.txt", "missing.txt"], maxBytesEach: 100 }, ctx());
    expect(out.files).toHaveLength(3);
    expect(out.files[0]!.content).toBe("1");
    expect(out.files[2]!.error).toBeTruthy();
  });
});

describe("code.localize_failure (consumes shell.run_tests output)", () => {
  it("ranks the sibling source file of a failing spec highest", async () => {
    await fs.mkdir(join(workspace, "src"), { recursive: true });
    await fs.writeFile(join(workspace, "src", "stats.mjs"), "export function median(xs){ return xs[0]; }\n");
    await fs.writeFile(join(workspace, "src", "other.mjs"), "export const k = 1;\n");
    const testRun: TestRunResult = {
      runner: "node",
      command: "npm test",
      passed: 1,
      failed: 1,
      exitCode: 1,
      durationMs: 10,
      failures: [{ test: "median works", file: "src/stats.test.mjs", line: null, message: "median returned wrong value" }],
      outputTail: "",
    };
    const out = await tool(codeTools, "code.localize_failure").handler({ testRun, maxCandidates: 5 }, ctx());
    expect(out.fromFailures).toBe(1);
    expect(out.candidates[0]!.file).toContain("stats.mjs");
  });
});

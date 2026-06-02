import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ToolRegistry } from "../../src/tools/registry.js";
import { defineTool } from "../../src/tools/types.js";
import { ProjectIndex } from "../../src/tools/project-index.js";
import { permissionPolicy } from "../../src/agent/runner.js";
import { parseTestOutput } from "../../src/tools/exec/index.js";
import { runCommand } from "../../src/util/exec.js";
import { ToolDeniedError, TimeoutError } from "../../src/resilience/errors.js";
import { silentLogger } from "../../src/obs/logger.js";
import { noopTracer } from "../../src/obs/tracing.js";

function ctx(services: object = {}) {
  return { workspace: "/tmp", logger: silentLogger(), tracer: noopTracer(), signal: new AbortController().signal, services };
}

const writer = defineTool({
  name: "io.write",
  description: "w",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  effect: "write",
  handler: async () => ({ ok: true }),
});
const danger = defineTool({
  name: "io.nuke",
  description: "d",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  effect: "write",
  risk: "high",
  handler: async () => ({ ok: true }),
});
const reader = defineTool({
  name: "io.read",
  description: "r",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  effect: "read",
  handler: async () => ({ ok: true }),
});

describe("permission policy", () => {
  it("readonly mode blocks write/exec/network but allows read/meta", async () => {
    const reg = new ToolRegistry().registerAll([writer, reader]);
    const services = { checkPermission: permissionPolicy("readonly") };
    await expect(reg.execute("io.write", {}, ctx(services))).rejects.toBeInstanceOf(ToolDeniedError);
    await expect(reg.execute("io.read", {}, ctx(services))).resolves.toEqual({ ok: true });
  });

  it("safe mode blocks only high-risk tools", async () => {
    const reg = new ToolRegistry().registerAll([writer, danger]);
    const services = { checkPermission: permissionPolicy("safe") };
    await expect(reg.execute("io.write", {}, ctx(services))).resolves.toEqual({ ok: true }); // medium risk ok
    await expect(reg.execute("io.nuke", {}, ctx(services))).rejects.toBeInstanceOf(ToolDeniedError);
  });

  it("auto mode allows everything", () => {
    expect(permissionPolicy("auto")).toBeUndefined();
  });
});

describe("ProjectIndex", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "maestro-idx-"));
    await fs.writeFile(join(dir, "a.ts"), "export const a = 1;");
    await fs.writeFile(join(dir, "b.js"), "module.exports = 2;");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("walks once and filters by extension; invalidate picks up new files", async () => {
    const idx = new ProjectIndex(dir);
    expect(await idx.files([".ts"])).toHaveLength(1);
    expect(await idx.files()).toHaveLength(2);
    await fs.writeFile(join(dir, "c.ts"), "export const c = 3;");
    expect(await idx.files([".ts"])).toHaveLength(1); // cached, new file not seen yet
    idx.invalidate();
    expect(await idx.files([".ts"])).toHaveLength(2); // re-walked
  });

  it("memoizes content and serves it after invalidate re-reads", async () => {
    const idx = new ProjectIndex(dir);
    const p = join(dir, "a.ts");
    expect(await idx.content(p)).toContain("a = 1");
    await fs.writeFile(p, "export const a = 99;");
    expect(await idx.content(p)).toContain("a = 1"); // memoized
    idx.invalidate();
    expect(await idx.content(p)).toContain("a = 99");
  });
});

describe("parseTestOutput corpus", () => {
  it("parses vitest summary + failures", () => {
    const out = "× src/foo.test.ts > adds numbers\n  expected 3 but got 4\nTests  1 failed | 4 passed (5)";
    const r = parseTestOutput("vitest", out, "");
    expect(r.failed).toBe(1);
    expect(r.passed).toBe(4);
    expect(r.failures.length).toBeGreaterThanOrEqual(1);
  });

  it("parses pytest FAILED node ids", () => {
    const out = "FAILED tests/test_math.py::test_add - AssertionError: 3 != 4\n1 failed, 2 passed in 0.1s";
    const r = parseTestOutput("pytest", out, "");
    expect(r.failed).toBe(1);
    expect(r.failures[0]!.file).toBe("tests/test_math.py");
    expect(r.failures[0]!.test).toBe("test_add");
  });

  it("reports zero failures for an all-pass run", () => {
    const r = parseTestOutput("vitest", "Tests  6 passed (6)", "");
    expect(r.failed).toBe(0);
    expect(r.passed).toBe(6);
  });
});

describe("runCommand timeout", () => {
  it("throws a typed TimeoutError when the command exceeds its timeout", async () => {
    await expect(
      runCommand("node", ["-e", "setTimeout(()=>{}, 5000)"], { cwd: process.cwd(), timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
});

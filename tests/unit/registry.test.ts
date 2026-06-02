import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../../src/tools/registry.js";
import { defineTool } from "../../src/tools/types.js";
import { silentLogger } from "../../src/obs/logger.js";
import { noopTracer } from "../../src/obs/tracing.js";
import { ToolInputError, ToolNotFoundError } from "../../src/resilience/errors.js";

function ctx() {
  return { workspace: "/tmp", logger: silentLogger(), tracer: noopTracer(), signal: new AbortController().signal, services: {} };
}

const echo = defineTool({
  name: "ns.echo",
  description: "echo input",
  input: z.object({ value: z.string() }),
  output: z.object({ value: z.string() }),
  effect: "read",
  handler: async (input) => ({ value: input.value }),
});

const adder = defineTool({
  name: "ns.add",
  description: "add",
  input: z.object({ a: z.number(), b: z.number() }),
  output: z.object({ sum: z.number() }),
  effect: "read",
  handler: async (input) => ({ sum: input.a + input.b }),
});

const writer = defineTool({
  name: "io.write",
  description: "write",
  input: z.object({ p: z.string() }),
  output: z.object({ ok: z.boolean() }),
  effect: "write",
  handler: async () => ({ ok: true }),
});

describe("ToolRegistry", () => {
  it("dispatches by name through a single path and validates I/O", async () => {
    const reg = new ToolRegistry().registerAll([echo, adder]);
    expect(reg.size()).toBe(2);
    const out = await reg.execute("ns.add", { a: 2, b: 3 }, ctx());
    expect(out).toEqual({ sum: 5 });
  });

  it("rejects invalid input with a typed ToolInputError before the handler runs", async () => {
    const reg = new ToolRegistry().register(adder);
    await expect(reg.execute("ns.add", { a: "x" }, ctx())).rejects.toBeInstanceOf(ToolInputError);
  });

  it("throws ToolNotFoundError for unknown tools", () => {
    const reg = new ToolRegistry();
    expect(() => reg.get("nope.tool")).toThrow(ToolNotFoundError);
  });

  it("rejects duplicate and malformed names", () => {
    const reg = new ToolRegistry().register(echo);
    expect(() => reg.register(echo)).toThrow();
    const bad = { ...echo, name: "NotValid" } as typeof echo;
    expect(() => reg.register(bad)).toThrow();
  });

  it("generates JSON schema specs from zod for the model", () => {
    const reg = new ToolRegistry().register(adder);
    const spec = reg.toolSpecs()[0]!;
    expect(spec.name).toBe("ns.add");
    expect(spec.input_schema.type).toBe("object");
    expect((spec.input_schema as { properties: object }).properties).toHaveProperty("a");
  });

  it("resolves scopes by exact name, namespace glob, and effect filter", () => {
    const reg = new ToolRegistry().registerAll([echo, adder, writer]);
    expect(reg.resolveScope(["ns.*"])).toEqual(["ns.add", "ns.echo"]);
    expect(reg.resolveScope(["io.write"])).toEqual(["io.write"]);
    expect(reg.resolveScope(["@write"])).toEqual(["io.write"]);
    expect(reg.resolveScope(["@read"])).toEqual(["ns.add", "ns.echo"]);
  });

  it("produces a restricted subset view that shares tool definitions", async () => {
    const reg = new ToolRegistry().registerAll([echo, adder, writer]);
    const sub = reg.subset(["ns.echo"]);
    expect(sub.names()).toEqual(["ns.echo"]);
    expect(sub.has("io.write")).toBe(false);
    expect(await sub.execute("ns.echo", { value: "hi" }, ctx())).toEqual({ value: "hi" });
  });
});

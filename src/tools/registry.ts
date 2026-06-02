import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool, ToolContext } from "./types.js";
import {
  ToolInputError,
  ToolNotFoundError,
  ToolOutputError,
  ToolExecutionError,
  ToolDeniedError,
  asMaestroError,
} from "../resilience/errors.js";

/** Model-facing tool spec: the JSON the provider advertises to the model. */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface RegisteredCall {
  tool: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

/**
 * The ToolRegistry is the answer to "stay coherent at 50 tools, don't collapse into 50
 * conditional dispatches". Tools are values in a Map keyed by name. Selection is the
 * model's job (it sees `toolSpecs()` and emits a tool_use block); the registry only
 * validates and dispatches. There is no `switch (toolName)` anywhere — `execute` is a
 * single code path for all 50+ tools.
 *
 * Scoping (`subset`) is how the subagent gets a reduced toolset without duplicating any
 * tool definitions: it is a view over the same registry, not a second registry.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  /** Cache derived JSON schemas — zodToJsonSchema is not free and the set is stable. */
  private readonly specCache = new Map<string, ToolSpec>();

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new ToolExecutionError(tool.name, "duplicate tool registration");
    }
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new ToolExecutionError(tool.name, "name must be <namespace>.<verb> (snake_case)");
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: Iterable<Tool>): this {
    for (const t of tools) this.register(t);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool {
    const t = this.tools.get(name);
    if (!t) throw new ToolNotFoundError(name);
    return t;
  }

  size(): number {
    return this.tools.size;
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  namespaces(): string[] {
    return [...new Set([...this.tools.values()].map((t) => t.namespace))].sort();
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /**
   * Resolve a scope expression to a concrete tool-name set. Supports exact names
   * ("fs.read"), whole namespaces ("fs.*"), and effect filters ("@read"). This is
   * what `agent.spawn` uses to hand a child a narrow, purpose-built toolset.
   */
  resolveScope(scope: string[]): string[] {
    const out = new Set<string>();
    for (const expr of scope) {
      if (expr.endsWith(".*")) {
        const ns = expr.slice(0, -2);
        for (const t of this.tools.values()) if (t.namespace === ns) out.add(t.name);
      } else if (expr.startsWith("@")) {
        const effect = expr.slice(1);
        for (const t of this.tools.values()) if (t.effect === effect) out.add(t.name);
      } else if (this.tools.has(expr)) {
        out.add(expr);
      }
    }
    return [...out].sort();
  }

  /** A read-only view restricted to `names`. Throws if any name is unknown. */
  subset(names: string[]): ToolRegistry {
    const sub = new ToolRegistry();
    for (const name of names) sub.tools.set(name, this.get(name));
    return sub;
  }

  /** Model-facing specs for the provider. Cached per tool. */
  toolSpecs(): ToolSpec[] {
    return this.list().map((t) => {
      const cached = this.specCache.get(t.name);
      if (cached) return cached;
      const json = zodToJsonSchema(t.input, { target: "openApi3", $refStrategy: "none" }) as Record<string, unknown>;
      // Anthropic wants a plain object schema at the top level.
      delete json.$schema;
      const spec: ToolSpec = {
        name: t.name,
        description: t.description,
        input_schema: { type: "object", ...json },
      };
      this.specCache.set(t.name, spec);
      return spec;
    });
  }

  /**
   * The single dispatch path. Validates input against the tool's zod schema, runs the
   * handler, validates output, and surfaces typed errors. No per-tool branching.
   */
  async execute(name: string, rawInput: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.get(name);
    const span = ctx.tracer.startSpan("tool.execute", { tool: name, effect: tool.effect, risk: tool.risk });
    const t0 = Date.now();

    // Permission policy runs BEFORE input validation or the handler — a denied tool never executes.
    const denial = ctx.services.checkPermission?.({ name, effect: tool.effect, risk: tool.risk });
    if (denial) {
      span.setAttribute("denied", denial);
      span.end("error");
      throw new ToolDeniedError(name, denial);
    }

    const parsedInput = tool.input.safeParse(rawInput);
    if (!parsedInput.success) {
      span.setAttribute("error", "input_invalid");
      span.end("error");
      throw new ToolInputError(name, parsedInput.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; "), {
        received: rawInput,
      });
    }

    try {
      const result = await tool.handler(parsedInput.data, ctx);
      const parsedOutput = tool.output.safeParse(result);
      if (!parsedOutput.success) {
        throw new ToolOutputError(name, parsedOutput.error.issues.map((i) => i.message).join("; "));
      }
      const durationMs = Date.now() - t0;
      span.setAttribute("durationMs", durationMs);
      span.end("ok");
      // A write/exec tool may have changed the tree; drop the cached project index so later
      // reads see fresh state. Centralizing this here means no individual tool has to remember.
      if (tool.effect === "write" || tool.effect === "exec") ctx.services.projectIndex?.invalidate();
      ctx.services.onToolResult?.({ name, input: parsedInput.data, output: parsedOutput.data, ok: true, durationMs });
      return parsedOutput.data;
    } catch (err) {
      const me = asMaestroError(err, "TOOL_EXECUTION_FAILED");
      span.setAttribute("error", me.code);
      span.addEvent("tool_error", { code: me.code, message: me.message });
      span.end("error");
      ctx.services.onToolResult?.({ name, input: parsedInput.data, ok: false, durationMs: Date.now() - t0, errorCode: me.code });
      throw me;
    }
  }
}

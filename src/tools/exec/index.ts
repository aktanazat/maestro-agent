import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "../types.js";
import type { Tool, ToolContext } from "../types.js";
import { runCommand } from "../../util/exec.js";
import { resolveInside } from "../../util/paths.js";
import { TestRunResultSchema, type TestFailure } from "../schemas.js";

/** Block obviously destructive/unscoped commands even though argv form already prevents shell injection. */
const DENY = [/\brm\b\s+-rf?\s+\//, /\bgit\b.*\bpush\b/, /\bnpm\b.*\bpublish\b/, /\bsudo\b/, /:\(\)\{/];

async function detectRunner(ctx: ToolContext): Promise<{ runner: string; file: string; args: string[] }> {
  try {
    const pkg = JSON.parse(await fs.readFile(resolveInside(ctx.workspace, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const deps = { ...pkg.devDependencies, ...pkg.dependencies };
    if (deps?.vitest) return { runner: "vitest", file: "npx", args: ["--no-install", "vitest", "run", "--reporter=verbose"] };
    if (deps?.jest) return { runner: "jest", file: "npx", args: ["--no-install", "jest", "--verbose"] };
    if (pkg.scripts?.test) return { runner: "npm-test", file: "npm", args: ["test", "--silent"] };
  } catch {
    /* fall through */
  }
  // Python fallback.
  return { runner: "pytest", file: "python3", args: ["-m", "pytest", "-q"] };
}

export function parseTestOutput(_runner: string, stdout: string, stderr: string): { passed: number; failed: number; failures: TestFailure[] } {
  const text = stdout + "\n" + stderr;
  const failures: TestFailure[] = [];
  let passed = 0;
  let failed = 0;

  // Summary counts (vitest/jest style: "Tests  2 failed | 5 passed").
  const vitestSummary = /Tests\s+(?:(\d+)\s+failed[^\d]*)?(\d+)\s+passed/i.exec(text);
  if (vitestSummary) {
    failed = Number(vitestSummary[1] ?? 0);
    passed = Number(vitestSummary[2] ?? 0);
  }
  const pytestSummary = /(\d+)\s+failed.*?(\d+)\s+passed|(\d+)\s+passed/i.exec(text);
  if (!vitestSummary && pytestSummary) {
    failed = Number(pytestSummary[1] ?? 0);
    passed = Number(pytestSummary[2] ?? pytestSummary[3] ?? 0);
  }

  // Per-failure extraction.
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // vitest/jest: "FAIL  src/foo.test.ts > suite > case" or "× case"
    const failMatch = /^\s*(?:FAIL|×|✗|✕)\s+(.+?)(?:\s+\d+ms)?$/.exec(line) || /^\s*(.+?\.(?:test|spec)\.[tj]sx?)\s*>\s*(.+)$/.exec(line);
    if (failMatch) {
      const located = /([\w./-]+\.(?:test|spec)\.\w+|[\w./-]+\.py):?(\d+)?/.exec(line);
      const message = (lines[i + 1] ?? "").trim() || line.trim();
      failures.push({
        test: failMatch[2] ?? failMatch[1] ?? line.trim(),
        file: located?.[1] ?? null,
        line: located?.[2] ? Number(located[2]) : null,
        message: message.slice(0, 300),
      });
    }
    // pytest: "FAILED tests/test_x.py::test_y - AssertionError: ..."
    const pytestFail = /^FAILED\s+([\w./-]+)::(\S+)\s*(?:-\s*(.*))?$/.exec(line);
    if (pytestFail) {
      failures.push({ test: pytestFail[2]!, file: pytestFail[1]!, line: null, message: (pytestFail[3] ?? "assertion failed").slice(0, 300) });
    }
  }
  if (failed === 0 && failures.length) failed = failures.length;
  return { passed, failed, failures };
}

const runTests = defineTool({
  name: "shell.run_tests",
  description:
    "Detect and run the project's test suite, returning a STRUCTURED result: pass/fail counts and parsed failures (test, file, line, message). Feed this directly into code.localize_failure.",
  input: z.object({
    pattern: z.string().optional().describe("Optional test name/path filter passed to the runner."),
    timeoutMs: z.number().int().positive().max(600_000).default(180_000),
  }),
  output: TestRunResultSchema,
  effect: "exec",
  handler: async (input, ctx) => {
    const { runner, file, args } = await detectRunner(ctx);
    const fullArgs = input.pattern ? [...args, input.pattern] : args;
    const res = await runCommand(file, fullArgs, { cwd: ctx.workspace, signal: ctx.signal, timeoutMs: input.timeoutMs });
    const parsed = parseTestOutput(runner, res.stdout, res.stderr);
    return {
      runner,
      command: res.command,
      passed: parsed.passed,
      failed: parsed.failed,
      exitCode: res.exitCode,
      durationMs: res.durationMs,
      failures: parsed.failures,
      outputTail: (res.stdout + res.stderr).slice(-4000),
    };
  },
});

const run = defineTool({
  name: "shell.run",
  description: "Run a command (argv form, no shell). Bounded output and timeout. Destructive commands are denied.",
  input: z.object({
    command: z.string().describe("Executable name."),
    args: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive().max(600_000).default(120_000),
  }),
  output: z.object({ command: z.string(), exitCode: z.number(), stdout: z.string(), stderr: z.string(), durationMs: z.number() }),
  effect: "exec",
  handler: async (input, ctx) => {
    const full = [input.command, ...input.args].join(" ");
    if (DENY.some((re) => re.test(full))) {
      throw new (await import("../../resilience/errors.js")).ToolDeniedError("shell.run", `command matches a deny pattern: ${full}`);
    }
    const res = await runCommand(input.command, input.args, { cwd: ctx.workspace, signal: ctx.signal, timeoutMs: input.timeoutMs });
    return { command: res.command, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, durationMs: res.durationMs };
  },
});

const build = defineTool({
  name: "shell.build",
  description: "Run the project build (npm run build) if defined.",
  input: z.object({ timeoutMs: z.number().int().positive().max(600_000).default(300_000) }),
  output: z.object({ exitCode: z.number(), output: z.string(), durationMs: z.number() }),
  effect: "exec",
  handler: async (input, ctx) => {
    const res = await runCommand("npm", ["run", "build", "--silent"], { cwd: ctx.workspace, signal: ctx.signal, timeoutMs: input.timeoutMs });
    return { exitCode: res.exitCode, output: (res.stdout + res.stderr).slice(0, 20_000), durationMs: res.durationMs };
  },
});

const install = defineTool({
  name: "shell.install",
  description: "Install dependencies (npm ci / npm install). Use sparingly.",
  input: z.object({ clean: z.boolean().default(false), timeoutMs: z.number().int().positive().max(600_000).default(300_000) }),
  output: z.object({ exitCode: z.number(), output: z.string() }),
  effect: "exec",
  handler: async (input, ctx) => {
    const res = await runCommand("npm", [input.clean ? "ci" : "install", "--silent"], { cwd: ctx.workspace, signal: ctx.signal, timeoutMs: input.timeoutMs });
    return { exitCode: res.exitCode, output: (res.stdout + res.stderr).slice(0, 10_000) };
  },
});

const which = defineTool({
  name: "shell.which",
  description: "Check whether an executable is available on PATH.",
  input: z.object({ name: z.string() }),
  output: z.object({ name: z.string(), found: z.boolean(), path: z.string().nullable() }),
  effect: "read",
  handler: async (input, ctx) => {
    const res = await runCommand("which", [input.name], { cwd: ctx.workspace, signal: ctx.signal, timeoutMs: 5000 });
    const path = res.stdout.trim();
    return { name: input.name, found: res.exitCode === 0 && path.length > 0, path: path || null };
  },
});

const nodeVersion = defineTool({
  name: "shell.node_version",
  description: "Report the Node.js and npm versions available in the environment.",
  input: z.object({}),
  output: z.object({ node: z.string(), npm: z.string() }),
  effect: "read",
  handler: async (_input, ctx) => {
    const node = await runCommand("node", ["-v"], { cwd: ctx.workspace, signal: ctx.signal, timeoutMs: 5000 });
    const npm = await runCommand("npm", ["-v"], { cwd: ctx.workspace, signal: ctx.signal, timeoutMs: 8000 });
    return { node: node.stdout.trim(), npm: npm.stdout.trim() };
  },
});

export const execTools: Tool[] = [runTests, run, build, install, which, nodeVersion];

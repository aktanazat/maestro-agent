import { promises as fs } from "node:fs";
import { join, relative, resolve, extname, basename } from "node:path";
import { z } from "zod";
import { defineTool } from "../types.js";
import type { Tool, ToolContext } from "../types.js";
import { resolveInside } from "../../util/paths.js";
import { runCommand } from "../../util/exec.js";
import { GrepResultSchema, LocalizationSchema, TestRunResultSchema } from "../schemas.js";

const IGNORE = new Set(["node_modules", ".git", "dist", "coverage", ".maestro"]);

/**
 * Absolute file paths, served from the per-run ProjectIndex when present (one cached walk),
 * else an uncached walk. Every `code.*` tool reads through here, so the tree is walked once per
 * run rather than once per call.
 */
async function listFiles(ctx: ToolContext, exts: string[] | null, limit = 5000): Promise<string[]> {
  const idx = ctx.services.projectIndex;
  if (idx) return idx.files(exts ?? undefined);
  return walkUncached(resolve(ctx.workspace), exts, limit);
}

/** Memoized file content via the index, else a direct read. */
async function readCached(ctx: ToolContext, abs: string): Promise<string> {
  const idx = ctx.services.projectIndex;
  if (idx) return idx.content(abs);
  return fs.readFile(abs, "utf8").catch(() => "");
}

async function walkUncached(root: string, exts: string[] | null, limit: number): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    if (out.length >= limit) return;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (out.length >= limit) return;
      if (IGNORE.has(d.name)) continue;
      const abs = join(dir, d.name);
      if (d.isDirectory()) await walk(abs);
      else if (d.isFile() && (!exts || exts.includes(extname(d.name)))) out.push(abs);
    }
  }
  await walk(root);
  return out;
}

const grep = defineTool({
  name: "code.grep",
  description:
    "Search file contents by regex across the workspace. Returns {file,line,text} matches — feed the files into fs.read_many to inspect them.",
  input: z.object({
    pattern: z.string(),
    flags: z.string().default("g"),
    include: z.string().optional().describe("Only files whose path contains this substring."),
    limit: z.number().int().positive().max(500).default(100),
  }),
  output: GrepResultSchema,
  effect: "read",
  handler: async (input, ctx) => {
    const root = resolve(ctx.workspace);
    const files = await listFiles(ctx, null, 5000);
    const re = new RegExp(input.pattern, input.flags.includes("g") ? input.flags : input.flags + "g");
    const matches: Array<{ file: string; line: number; text: string }> = [];
    for (const abs of files) {
      const rel = relative(root, abs);
      if (input.include && !rel.includes(input.include)) continue;
      let content: string;
      try {
        content = await readCached(ctx, abs);
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i]!)) {
          matches.push({ file: rel, line: i + 1, text: lines[i]!.slice(0, 240) });
          if (matches.length >= input.limit) return { pattern: input.pattern, matches, truncated: true };
        }
      }
    }
    return { pattern: input.pattern, matches, truncated: false };
  },
});

const findSymbol = defineTool({
  name: "code.find_symbol",
  description: "Find likely definitions of a symbol (function/class/const/def) by name across JS/TS/Python.",
  input: z.object({ name: z.string().regex(/^[A-Za-z_$][\w$]*$/), limit: z.number().int().positive().max(100).default(50) }),
  output: z.object({ name: z.string(), definitions: z.array(z.object({ file: z.string(), line: z.number(), text: z.string() })) }),
  effect: "read",
  handler: async (input, ctx) => {
    const root = resolve(ctx.workspace);
    const files = await listFiles(ctx, [".ts", ".tsx", ".js", ".jsx", ".mjs", ".py"], 5000);
    const n = input.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b(function|class|const|let|var|def|interface|type|enum)\\s+${n}\\b|\\b${n}\\s*[:=]\\s*(async\\s+)?(function|\\()`);
    const definitions: Array<{ file: string; line: number; text: string }> = [];
    for (const abs of files) {
      const lines = (await readCached(ctx, abs)).split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          definitions.push({ file: relative(root, abs), line: i + 1, text: lines[i]!.trim().slice(0, 200) });
          if (definitions.length >= input.limit) break;
        }
      }
    }
    return { name: input.name, definitions };
  },
});

const listByExt = defineTool({
  name: "code.list_files_by_ext",
  description: "List all files with a given extension (e.g. '.ts').",
  input: z.object({ ext: z.string(), limit: z.number().int().positive().max(5000).default(1000) }),
  output: z.object({ ext: z.string(), files: z.array(z.string()), count: z.number() }),
  effect: "read",
  handler: async (input, ctx) => {
    const root = resolve(ctx.workspace);
    const ext = input.ext.startsWith(".") ? input.ext : "." + input.ext;
    const files = (await listFiles(ctx, [ext], input.limit)).map((a) => relative(root, a));
    return { ext, files, count: files.length };
  },
});

const countLines = defineTool({
  name: "code.count_lines",
  description: "Count files and lines per extension across the workspace — a quick size profile.",
  input: z.object({}),
  output: z.object({ totalFiles: z.number(), totalLines: z.number(), byExt: z.array(z.object({ ext: z.string(), files: z.number(), lines: z.number() })) }),
  effect: "read",
  handler: async (_input, ctx) => {
    const files = await listFiles(ctx, null, 20000);
    const map = new Map<string, { files: number; lines: number }>();
    let totalLines = 0;
    for (const abs of files) {
      const ext = extname(abs) || "(none)";
      const content = await readCached(ctx, abs);
      const lines = content ? content.split("\n").length : 0;
      totalLines += lines;
      const cur = map.get(ext) ?? { files: 0, lines: 0 };
      cur.files += 1;
      cur.lines += lines;
      map.set(ext, cur);
    }
    const byExt = [...map.entries()].map(([ext, v]) => ({ ext, ...v })).sort((a, b) => b.lines - a.lines);
    return { totalFiles: files.length, totalLines, byExt };
  },
});

const findTodos = defineTool({
  name: "code.find_todos",
  description: "Find TODO/FIXME/HACK/XXX markers across the codebase.",
  input: z.object({ limit: z.number().int().positive().max(500).default(100) }),
  output: z.object({ items: z.array(z.object({ file: z.string(), line: z.number(), marker: z.string(), text: z.string() })) }),
  effect: "read",
  handler: async (input, ctx) => {
    const root = resolve(ctx.workspace);
    const files = await listFiles(ctx, [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".md"], 5000);
    const re = /\b(TODO|FIXME|HACK|XXX)\b:?(.*)/;
    const items: Array<{ file: string; line: number; marker: string; text: string }> = [];
    for (const abs of files) {
      const lines = (await readCached(ctx, abs)).split("\n");
      for (let i = 0; i < lines.length; i++) {
        const m = re.exec(lines[i]!);
        if (m) {
          items.push({ file: relative(root, abs), line: i + 1, marker: m[1]!, text: (m[2] ?? "").trim().slice(0, 160) });
          if (items.length >= input.limit) return { items };
        }
      }
    }
    return { items };
  },
});

const outline = defineTool({
  name: "code.outline",
  description: "Cheap structural outline of a source file: its top-level functions/classes/exports with line numbers.",
  input: z.object({ path: z.string() }),
  output: z.object({ path: z.string(), symbols: z.array(z.object({ kind: z.string(), name: z.string(), line: z.number() })) }),
  effect: "read",
  handler: async (input, ctx) => {
    const abs = resolveInside(ctx.workspace, input.path);
    const lines = (await fs.readFile(abs, "utf8")).split("\n");
    const re = /^\s*(export\s+)?(async\s+)?(function|class|interface|type|enum|const|def)\s+([A-Za-z_$][\w$]*)/;
    const symbols: Array<{ kind: string; name: string; line: number }> = [];
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]!);
      if (m) symbols.push({ kind: m[3]!, name: m[4]!, line: i + 1 });
    }
    return { path: input.path, symbols };
  },
});

const depList = defineTool({
  name: "code.dep_list",
  description: "List declared dependencies from package.json (deps, devDeps) if present.",
  input: z.object({}),
  output: z.object({ found: z.boolean(), dependencies: z.array(z.object({ name: z.string(), version: z.string(), dev: z.boolean() })) }),
  effect: "read",
  handler: async (_input, ctx) => {
    const abs = resolveInside(ctx.workspace, "package.json");
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(await fs.readFile(abs, "utf8"));
    } catch {
      return { found: false, dependencies: [] };
    }
    const dependencies = [
      ...Object.entries(pkg.dependencies ?? {}).map(([name, version]) => ({ name, version, dev: false })),
      ...Object.entries(pkg.devDependencies ?? {}).map(([name, version]) => ({ name, version, dev: true })),
    ];
    return { found: true, dependencies };
  },
});

const lint = defineTool({
  name: "code.lint",
  description: "Run the project linter (eslint) if configured; returns the issue list.",
  input: z.object({ path: z.string().default(".") }),
  output: z.object({ ran: z.boolean(), exitCode: z.number(), output: z.string() }),
  effect: "exec",
  handler: async (input, ctx) => {
    const res = await runCommand("npx", ["--no-install", "eslint", input.path, "-f", "compact"], {
      cwd: ctx.workspace,
      signal: ctx.signal,
      timeoutMs: 120_000,
    });
    return { ran: res.exitCode !== 127, exitCode: res.exitCode, output: (res.stdout + res.stderr).slice(0, 20_000) };
  },
});

/**
 * THE composability showcase. Input includes `testRun: TestRunResultSchema` — the exact
 * output schema of `shell.run_tests`. The model (or a script) runs tests, then pipes the
 * structured result straight into this tool, which scores source files by how strongly the
 * failure messages/paths point at them. Output ranks candidate files for fs.edit to target.
 */
const localizeFailure = defineTool({
  name: "code.localize_failure",
  description:
    "Given the structured output of shell.run_tests, rank the source files most likely responsible for the failures. Consumes a TestRunResult and emits ranked candidates — chain it between run_tests and fs.edit.",
  input: z.object({
    testRun: TestRunResultSchema,
    maxCandidates: z.number().int().positive().max(20).default(5),
  }),
  output: LocalizationSchema,
  effect: "read",
  handler: async (input, ctx) => {
    const root = resolve(ctx.workspace);
    const srcFiles = await listFiles(ctx, [".ts", ".tsx", ".js", ".jsx", ".mjs", ".py"], 5000);
    const scores = new Map<string, { score: number; reasons: string[] }>();
    const bump = (file: string, by: number, reason: string) => {
      const rel = relative(root, file);
      const cur = scores.get(rel) ?? { score: 0, reasons: [] };
      cur.score += by;
      if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
      scores.set(rel, cur);
    };

    for (const f of input.testRun.failures) {
      // 1) Direct file reference from the failure.
      if (f.file) {
        const hit = srcFiles.find((s) => relative(root, s) === f.file || basename(s) === basename(f.file!));
        if (hit) bump(hit, 5, `failure references ${f.file}`);
      }
      // 2) The spec file's sibling source (foo.test.ts -> foo.ts).
      if (f.file && /\.(test|spec)\./.test(f.file)) {
        const sourceName = basename(f.file).replace(/\.(test|spec)\./, ".");
        const sibling = srcFiles.find((s) => basename(s) === sourceName);
        if (sibling) bump(sibling, 4, `sibling source of spec ${basename(f.file)}`);
      }
      // 3) Identifiers in the failure message that match symbol-bearing source files.
      const idents = [...new Set((f.message.match(/[A-Za-z_$][\w$]{2,}/g) ?? []).slice(0, 12))];
      for (const abs of srcFiles) {
        if (/\.(test|spec)\./.test(abs)) continue;
        const content = await readCached(ctx, abs);
        for (const id of idents) {
          if (new RegExp(`\\b(function|class|const|def|export)\\b[^\\n]*\\b${id}\\b`).test(content)) {
            bump(abs, 2, `defines '${id}' from failure message`);
          }
        }
      }
    }

    const candidates = [...scores.entries()]
      .map(([file, v]) => ({ file, score: v.score, reasons: v.reasons }))
      .sort((a, b) => b.score - a.score)
      .slice(0, input.maxCandidates);
    return { candidates, fromFailures: input.testRun.failures.length };
  },
});

export const codeTools: Tool[] = [grep, findSymbol, listByExt, countLines, findTodos, outline, depList, lint, localizeFailure];

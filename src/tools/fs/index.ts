import { promises as fs } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "../types.js";
import type { Tool } from "../types.js";
import { resolveInside, relInside } from "../../util/paths.js";
import { walkFiles } from "../../util/walk.js";
import { ToolExecutionError } from "../../resilience/errors.js";

const PathInput = z.object({ path: z.string().describe("Workspace-relative path.") });

async function statSafe(abs: string) {
  try {
    return await fs.stat(abs);
  } catch {
    return null;
  }
}

const read = defineTool({
  name: "fs.read",
  description: "Read a UTF-8 text file. Returns content plus line count. Use before editing.",
  input: PathInput.extend({
    maxBytes: z.number().int().positive().max(1_000_000).default(200_000).describe("Cap on bytes read."),
  }),
  output: z.object({ path: z.string(), content: z.string(), lines: z.number(), truncated: z.boolean() }),
  effect: "read",
  handler: async (input, ctx) => {
    const abs = resolveInside(ctx.workspace, input.path);
    const buf = await fs.readFile(abs);
    const truncated = buf.byteLength > input.maxBytes;
    const content = buf.subarray(0, input.maxBytes).toString("utf8");
    return { path: relInside(ctx.workspace, abs), content, lines: content.split("\n").length, truncated };
  },
});

const readMany = defineTool({
  name: "fs.read_many",
  description:
    "Read several files at once. Consumes a list of paths (e.g. from code.grep matches) and returns each file's content — a composable bulk reader.",
  input: z.object({ paths: z.array(z.string()).min(1).max(25), maxBytesEach: z.number().int().positive().max(200_000).default(40_000) }),
  output: z.object({
    files: z.array(z.object({ path: z.string(), content: z.string(), error: z.string().nullable() })),
  }),
  effect: "read",
  handler: async (input, ctx) => {
    const files = await Promise.all(
      input.paths.map(async (p) => {
        try {
          const abs = resolveInside(ctx.workspace, p);
          const buf = await fs.readFile(abs);
          return { path: relInside(ctx.workspace, abs), content: buf.subarray(0, input.maxBytesEach).toString("utf8"), error: null };
        } catch (err) {
          return { path: p, content: "", error: (err as Error).message };
        }
      }),
    );
    return { files };
  },
});

const write = defineTool({
  name: "fs.write",
  description: "Create or overwrite a text file (creates parent dirs). Returns bytes written.",
  input: PathInput.extend({ content: z.string() }),
  output: z.object({ path: z.string(), bytes: z.number() }),
  effect: "write",
  handler: async (input, ctx) => {
    const abs = resolveInside(ctx.workspace, input.path);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, input.content, "utf8");
    return { path: relInside(ctx.workspace, abs), bytes: Buffer.byteLength(input.content) };
  },
});

const edit = defineTool({
  name: "fs.edit",
  description:
    "Replace an exact substring in a file (the first occurrence, or all with replaceAll). Fails if oldString is absent or ambiguous — the safe way to make targeted edits.",
  input: PathInput.extend({
    oldString: z.string().min(1),
    newString: z.string(),
    replaceAll: z.boolean().default(false),
  }),
  output: z.object({ path: z.string(), replacements: z.number() }),
  effect: "write",
  handler: async (input, ctx) => {
    const abs = resolveInside(ctx.workspace, input.path);
    const content = await fs.readFile(abs, "utf8");
    const count = content.split(input.oldString).length - 1;
    if (count === 0) throw new ToolExecutionError("fs.edit", "oldString not found", { context: { path: input.path } });
    if (count > 1 && !input.replaceAll) {
      throw new ToolExecutionError("fs.edit", `oldString is ambiguous (${count} matches); set replaceAll or add context`, { context: { path: input.path } });
    }
    const next = input.replaceAll ? content.split(input.oldString).join(input.newString) : content.replace(input.oldString, input.newString);
    await fs.writeFile(abs, next, "utf8");
    return { path: relInside(ctx.workspace, abs), replacements: input.replaceAll ? count : 1 };
  },
});

const append = defineTool({
  name: "fs.append",
  description: "Append text to a file (creates it if missing).",
  input: PathInput.extend({ content: z.string() }),
  output: z.object({ path: z.string(), bytes: z.number() }),
  effect: "write",
  handler: async (input, ctx) => {
    const abs = resolveInside(ctx.workspace, input.path);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.appendFile(abs, input.content, "utf8");
    return { path: relInside(ctx.workspace, abs), bytes: Buffer.byteLength(input.content) };
  },
});

const remove = defineTool({
  name: "fs.delete",
  description: "Delete a file or directory (recursive). Stays inside the workspace.",
  input: PathInput.extend({ recursive: z.boolean().default(false) }),
  output: z.object({ path: z.string(), deleted: z.boolean() }),
  effect: "write",
  risk: "high",
  handler: async (input, ctx) => {
    const abs = resolveInside(ctx.workspace, input.path);
    await fs.rm(abs, { recursive: input.recursive, force: true });
    return { path: relInside(ctx.workspace, abs), deleted: true };
  },
});

const move = defineTool({
  name: "fs.move",
  description: "Move/rename a file or directory within the workspace.",
  input: z.object({ from: z.string(), to: z.string() }),
  output: z.object({ from: z.string(), to: z.string() }),
  effect: "write",
  handler: async (input, ctx) => {
    const from = resolveInside(ctx.workspace, input.from);
    const to = resolveInside(ctx.workspace, input.to);
    await fs.mkdir(dirname(to), { recursive: true });
    await fs.rename(from, to);
    return { from: relInside(ctx.workspace, from), to: relInside(ctx.workspace, to) };
  },
});

const copy = defineTool({
  name: "fs.copy",
  description: "Copy a file or directory within the workspace.",
  input: z.object({ from: z.string(), to: z.string() }),
  output: z.object({ from: z.string(), to: z.string() }),
  effect: "write",
  handler: async (input, ctx) => {
    const from = resolveInside(ctx.workspace, input.from);
    const to = resolveInside(ctx.workspace, input.to);
    await fs.cp(from, to, { recursive: true });
    return { from: relInside(ctx.workspace, from), to: relInside(ctx.workspace, to) };
  },
});

const mkdir = defineTool({
  name: "fs.mkdir",
  description: "Create a directory (recursive).",
  input: PathInput,
  output: z.object({ path: z.string() }),
  effect: "write",
  handler: async (input, ctx) => {
    const abs = resolveInside(ctx.workspace, input.path);
    await fs.mkdir(abs, { recursive: true });
    return { path: relInside(ctx.workspace, abs) };
  },
});

const list = defineTool({
  name: "fs.list",
  description: "List directory entries (one level). Returns names with type and size.",
  input: PathInput.extend({ path: z.string().default(".") }),
  output: z.object({
    path: z.string(),
    entries: z.array(z.object({ name: z.string(), type: z.enum(["file", "dir", "other"]), size: z.number() })),
  }),
  effect: "read",
  handler: async (input, ctx) => {
    const abs = resolveInside(ctx.workspace, input.path);
    const dirents = await fs.readdir(abs, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map(async (d) => {
        const st = await statSafe(join(abs, d.name));
        return {
          name: d.name,
          type: d.isDirectory() ? ("dir" as const) : d.isFile() ? ("file" as const) : ("other" as const),
          size: st?.size ?? 0,
        };
      }),
    );
    return { path: relInside(ctx.workspace, abs), entries };
  },
});

const glob = defineTool({
  name: "fs.glob",
  description: "Find files matching a glob (e.g. 'src/**/*.ts'). Returns workspace-relative paths.",
  input: z.object({ pattern: z.string(), limit: z.number().int().positive().max(2000).default(500) }),
  output: z.object({ pattern: z.string(), files: z.array(z.string()), truncated: z.boolean() }),
  effect: "read",
  handler: async (input, ctx) => {
    const root = resolve(ctx.workspace);
    const matcher = globToRegExp(input.pattern);
    const idx = ctx.services.projectIndex;
    const rels = idx
      ? (await idx.relFiles()).filter((rel) => matcher.test(rel))
      : (await walkFiles(root, { match: (rel) => matcher.test(rel) })).map((a) => relative(root, a));
    return { pattern: input.pattern, files: rels.slice(0, input.limit), truncated: rels.length > input.limit };
  },
});

const stat = defineTool({
  name: "fs.stat",
  description: "Stat a path: exists, type, size, mtime.",
  input: PathInput,
  output: z.object({ path: z.string(), exists: z.boolean(), type: z.string(), size: z.number(), mtimeMs: z.number() }),
  effect: "read",
  handler: async (input, ctx) => {
    const abs = resolveInside(ctx.workspace, input.path);
    const st = await statSafe(abs);
    return {
      path: relInside(ctx.workspace, abs),
      exists: !!st,
      type: st ? (st.isDirectory() ? "dir" : st.isFile() ? "file" : "other") : "none",
      size: st?.size ?? 0,
      mtimeMs: st?.mtimeMs ?? 0,
    };
  },
});

const head = defineTool({
  name: "fs.head",
  description: "Read the first N lines of a file.",
  input: PathInput.extend({ lines: z.number().int().positive().max(2000).default(50) }),
  output: z.object({ path: z.string(), content: z.string() }),
  effect: "read",
  handler: async (input, ctx) => {
    const abs = resolveInside(ctx.workspace, input.path);
    const content = await fs.readFile(abs, "utf8");
    return { path: relInside(ctx.workspace, abs), content: content.split("\n").slice(0, input.lines).join("\n") };
  },
});

const tail = defineTool({
  name: "fs.tail",
  description: "Read the last N lines of a file.",
  input: PathInput.extend({ lines: z.number().int().positive().max(2000).default(50) }),
  output: z.object({ path: z.string(), content: z.string() }),
  effect: "read",
  handler: async (input, ctx) => {
    const abs = resolveInside(ctx.workspace, input.path);
    const content = await fs.readFile(abs, "utf8");
    const arr = content.split("\n");
    return { path: relInside(ctx.workspace, abs), content: arr.slice(Math.max(0, arr.length - input.lines)).join("\n") };
  },
});

// --- glob helpers -----------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(re + "$");
}

export const fsTools: Tool[] = [read, readMany, write, edit, append, remove, move, copy, mkdir, list, glob, stat, head, tail];

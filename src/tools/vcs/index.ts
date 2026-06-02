import { z } from "zod";
import { defineTool } from "../types.js";
import type { Tool, ToolContext } from "../types.js";
import { runCommand } from "../../util/exec.js";
import { DiffResultSchema } from "../schemas.js";
import { ToolExecutionError } from "../../resilience/errors.js";

async function git(ctx: ToolContext, args: string[], timeoutMs = 30_000) {
  const res = await runCommand("git", args, { cwd: ctx.workspace, timeoutMs, signal: ctx.signal });
  return res;
}

function ensureOk(res: { exitCode: number; stderr: string; command: string }) {
  if (res.exitCode !== 0) throw new ToolExecutionError("git", `${res.command} exited ${res.exitCode}: ${res.stderr.trim().slice(0, 400)}`);
}

const status = defineTool({
  name: "git.status",
  description: "Porcelain working-tree status: staged, unstaged, and untracked paths.",
  input: z.object({}),
  output: z.object({
    branch: z.string(),
    clean: z.boolean(),
    changes: z.array(z.object({ status: z.string(), path: z.string() })),
  }),
  effect: "read",
  handler: async (_input, ctx) => {
    const res = await git(ctx, ["status", "--porcelain=v1", "--branch"]);
    ensureOk(res);
    const lines = res.stdout.split("\n").filter(Boolean);
    let branch = "unknown";
    const changes: Array<{ status: string; path: string }> = [];
    for (const line of lines) {
      if (line.startsWith("##")) {
        branch = line.slice(3).split("...")[0]!.trim();
      } else {
        changes.push({ status: line.slice(0, 2).trim(), path: line.slice(3) });
      }
    }
    return { branch, clean: changes.length === 0, changes };
  },
});

const diff = defineTool({
  name: "git.diff",
  description:
    "Unified diff of the working tree (or staged with staged=true). Returns per-file add/del counts and the patch — consumable by a code-review subagent or git.apply_patch.",
  input: z.object({ staged: z.boolean().default(false), path: z.string().optional() }),
  output: DiffResultSchema,
  effect: "read",
  handler: async (input, ctx) => {
    const args = ["diff", "--no-color"];
    if (input.staged) args.push("--cached");
    if (input.path) args.push("--", input.path);
    const res = await git(ctx, args);
    ensureOk(res);
    const statRes = await git(ctx, [...["diff", "--numstat"], ...(input.staged ? ["--cached"] : []), ...(input.path ? ["--", input.path] : [])]);
    const files = statRes.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [add, del, path] = l.split("\t");
        return { path: path ?? "", additions: Number(add) || 0, deletions: Number(del) || 0 };
      });
    return { files, patch: res.stdout, empty: res.stdout.trim() === "" };
  },
});

const log = defineTool({
  name: "git.log",
  description: "Recent commit log (subject + short hash).",
  input: z.object({ limit: z.number().int().positive().max(100).default(15) }),
  output: z.object({ commits: z.array(z.object({ hash: z.string(), subject: z.string() })) }),
  effect: "read",
  handler: async (input, ctx) => {
    const res = await git(ctx, ["log", `-n${input.limit}`, "--pretty=%h%x09%s"]);
    ensureOk(res);
    const commits = res.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [hash, subject] = l.split("\t");
        return { hash: hash ?? "", subject: subject ?? "" };
      });
    return { commits };
  },
});

const show = defineTool({
  name: "git.show",
  description: "Show a commit's metadata and diff.",
  input: z.object({ ref: z.string().default("HEAD") }),
  output: z.object({ ref: z.string(), content: z.string() }),
  effect: "read",
  handler: async (input, ctx) => {
    const res = await git(ctx, ["show", "--no-color", input.ref]);
    ensureOk(res);
    return { ref: input.ref, content: res.stdout.slice(0, 50_000) };
  },
});

const branchList = defineTool({
  name: "git.branch_list",
  description: "List local branches.",
  input: z.object({}),
  output: z.object({ branches: z.array(z.string()), current: z.string() }),
  effect: "read",
  handler: async (_input, ctx) => {
    const res = await git(ctx, ["branch", "--list", "--no-color"]);
    ensureOk(res);
    const branches: string[] = [];
    let current = "";
    for (const line of res.stdout.split("\n").filter(Boolean)) {
      const name = line.replace(/^\*?\s+/, "").trim();
      if (line.startsWith("*")) current = name;
      branches.push(name);
    }
    return { branches, current };
  },
});

const currentBranch = defineTool({
  name: "git.current_branch",
  description: "Name of the current branch.",
  input: z.object({}),
  output: z.object({ branch: z.string() }),
  effect: "read",
  handler: async (_input, ctx) => {
    const res = await git(ctx, ["rev-parse", "--abbrev-ref", "HEAD"]);
    ensureOk(res);
    return { branch: res.stdout.trim() };
  },
});

const branchCreate = defineTool({
  name: "git.branch_create",
  description: "Create and switch to a new branch.",
  input: z.object({ name: z.string().regex(/^[\w./-]+$/) }),
  output: z.object({ branch: z.string() }),
  effect: "write",
  handler: async (input, ctx) => {
    const res = await git(ctx, ["checkout", "-b", input.name]);
    ensureOk(res);
    return { branch: input.name };
  },
});

const checkout = defineTool({
  name: "git.checkout",
  description: "Switch to an existing branch or restore a path.",
  input: z.object({ target: z.string() }),
  output: z.object({ target: z.string(), ok: z.boolean() }),
  effect: "write",
  handler: async (input, ctx) => {
    const res = await git(ctx, ["checkout", input.target]);
    ensureOk(res);
    return { target: input.target, ok: true };
  },
});

const add = defineTool({
  name: "git.add",
  description: "Stage paths (or all with '.').",
  input: z.object({ paths: z.array(z.string()).min(1) }),
  output: z.object({ staged: z.array(z.string()) }),
  effect: "write",
  handler: async (input, ctx) => {
    const res = await git(ctx, ["add", "--", ...input.paths]);
    ensureOk(res);
    return { staged: input.paths };
  },
});

const commit = defineTool({
  name: "git.commit",
  description: "Commit staged changes with a message. Returns the new commit hash.",
  input: z.object({ message: z.string().min(1) }),
  output: z.object({ hash: z.string(), message: z.string() }),
  effect: "write",
  handler: async (input, ctx) => {
    const res = await git(ctx, ["commit", "-m", input.message]);
    ensureOk(res);
    const hash = await git(ctx, ["rev-parse", "--short", "HEAD"]);
    return { hash: hash.stdout.trim(), message: input.message };
  },
});

const commitAll = defineTool({
  name: "git.commit_all",
  description:
    "Stage every change and commit in one step (composes git.add + git.commit). Use for a clean checkpoint after a verified fix.",
  input: z.object({ message: z.string().min(1) }),
  output: z.object({ hash: z.string(), filesChanged: z.number() }),
  effect: "write",
  handler: async (input, ctx) => {
    const st = await git(ctx, ["status", "--porcelain=v1"]);
    const filesChanged = st.stdout.split("\n").filter(Boolean).length;
    if (filesChanged === 0) throw new ToolExecutionError("git.commit_all", "nothing to commit");
    ensureOk(await git(ctx, ["add", "-A"]));
    ensureOk(await git(ctx, ["commit", "-m", input.message]));
    const hash = await git(ctx, ["rev-parse", "--short", "HEAD"]);
    return { hash: hash.stdout.trim(), filesChanged };
  },
});

const applyPatch = defineTool({
  name: "git.apply_patch",
  description: "Apply a unified diff patch to the working tree (git apply). Validates before applying.",
  input: z.object({ patch: z.string().min(1), check: z.boolean().default(true) }),
  output: z.object({ applied: z.boolean() }),
  effect: "write",
  handler: async (input, ctx) => {
    if (input.check) {
      const chk = await runCommand("git", ["apply", "--check", "-"], { cwd: ctx.workspace, signal: ctx.signal, input: input.patch });
      if (chk.exitCode !== 0) throw new ToolExecutionError("git.apply_patch", `patch does not apply: ${chk.stderr.slice(0, 300)}`);
    }
    const res = await runCommand("git", ["apply", "-"], { cwd: ctx.workspace, signal: ctx.signal, input: input.patch });
    ensureOk(res);
    return { applied: true };
  },
});

const reset = defineTool({
  name: "git.reset",
  description: "Reset working tree. mode=soft|mixed|hard, default mixed.",
  input: z.object({ ref: z.string().default("HEAD"), mode: z.enum(["soft", "mixed", "hard"]).default("mixed") }),
  output: z.object({ ref: z.string(), mode: z.string() }),
  effect: "write",
  risk: "high",
  handler: async (input, ctx) => {
    ensureOk(await git(ctx, ["reset", `--${input.mode}`, input.ref]));
    return { ref: input.ref, mode: input.mode };
  },
});

const blame = defineTool({
  name: "git.blame",
  description: "Blame a line range of a file to find who/which commit last touched it.",
  input: z.object({ path: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive() }),
  output: z.object({ path: z.string(), content: z.string() }),
  effect: "read",
  handler: async (input, ctx) => {
    const res = await git(ctx, ["blame", "-L", `${input.startLine},${input.endLine}`, "--", input.path]);
    ensureOk(res);
    return { path: input.path, content: res.stdout.slice(0, 20_000) };
  },
});

const stash = defineTool({
  name: "git.stash",
  description: "Stash or restore working-tree changes. action=push|pop|list.",
  input: z.object({ action: z.enum(["push", "pop", "list"]).default("push"), message: z.string().optional() }),
  output: z.object({ action: z.string(), output: z.string() }),
  effect: "write",
  handler: async (input, ctx) => {
    const args = input.action === "push" ? ["stash", "push", ...(input.message ? ["-m", input.message] : [])] : ["stash", input.action];
    const res = await git(ctx, args);
    return { action: input.action, output: (res.stdout || res.stderr).trim() };
  },
});

export const vcsTools: Tool[] = [
  status, diff, log, show, branchList, currentBranch, branchCreate, checkout, add, commit, commitAll, applyPatch, reset, blame, stash,
];

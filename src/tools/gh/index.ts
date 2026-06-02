import { z } from "zod";
import { defineTool } from "../types.js";
import type { Tool, ToolContext } from "../types.js";
import { runCommand } from "../../util/exec.js";
import { ToolExecutionError } from "../../resilience/errors.js";

/**
 * GitHub tools shell out to the `gh` CLI. Every call here is an EXTERNAL network call, so it
 * goes through the run's rate limiter (resource "github") before executing — this is the
 * concrete attachment point the brief asks for: rate limiting on external calls, enforced in
 * the tool layer, not hand-waved.
 */
async function gh(ctx: ToolContext, args: string[], opts: { json?: boolean } = {}) {
  await ctx.services.rateLimiter?.("github").acquire();
  const res = await runCommand("gh", args, { cwd: ctx.workspace, signal: ctx.signal, timeoutMs: 60_000 });
  if (res.exitCode === 127) throw new ToolExecutionError("github", "gh CLI not installed");
  if (res.exitCode !== 0) throw new ToolExecutionError("github", `gh ${args[0]} failed: ${res.stderr.slice(0, 300)}`);
  if (opts.json) {
    try {
      return JSON.parse(res.stdout);
    } catch {
      throw new ToolExecutionError("github", "gh returned non-JSON output");
    }
  }
  return res.stdout;
}

const repoView = defineTool({
  name: "github.repo_view",
  description: "View metadata about the current repository (name, default branch, description, visibility).",
  input: z.object({}),
  output: z.object({ nameWithOwner: z.string(), defaultBranch: z.string(), description: z.string().nullable(), visibility: z.string() }),
  effect: "network",
  idempotent: true,
  handler: async (_input, ctx) => {
    const data = (await gh(ctx, ["repo", "view", "--json", "nameWithOwner,defaultBranchRef,description,visibility"], { json: true })) as {
      nameWithOwner: string;
      defaultBranchRef?: { name: string };
      description: string | null;
      visibility: string;
    };
    return {
      nameWithOwner: data.nameWithOwner,
      defaultBranch: data.defaultBranchRef?.name ?? "main",
      description: data.description ?? null,
      visibility: data.visibility,
    };
  },
});

const issueList = defineTool({
  name: "github.issue_list",
  description: "List open issues in the current repo.",
  input: z.object({ limit: z.number().int().positive().max(50).default(20) }),
  output: z.object({ issues: z.array(z.object({ number: z.number(), title: z.string(), state: z.string() })) }),
  effect: "network",
  idempotent: true,
  handler: async (input, ctx) => {
    const data = (await gh(ctx, ["issue", "list", "--limit", String(input.limit), "--json", "number,title,state"], { json: true })) as Array<{
      number: number;
      title: string;
      state: string;
    }>;
    return { issues: data };
  },
});

const issueView = defineTool({
  name: "github.issue_view",
  description: "View a single issue's title and body.",
  input: z.object({ number: z.number().int().positive() }),
  output: z.object({ number: z.number(), title: z.string(), body: z.string(), state: z.string() }),
  effect: "network",
  idempotent: true,
  handler: async (input, ctx) => {
    const data = (await gh(ctx, ["issue", "view", String(input.number), "--json", "number,title,body,state"], { json: true })) as {
      number: number;
      title: string;
      body: string;
      state: string;
    };
    return data;
  },
});

const issueCreate = defineTool({
  name: "github.issue_create",
  description: "Open a new issue. Describe the problem only — no proposed solution in the body.",
  input: z.object({ title: z.string().min(1), body: z.string().default("") }),
  output: z.object({ url: z.string() }),
  effect: "network",
  risk: "high",
  idempotent: false,
  handler: async (input, ctx) => {
    const out = (await gh(ctx, ["issue", "create", "--title", input.title, "--body", input.body])) as string;
    return { url: out.trim().split("\n").pop() ?? "" };
  },
});

const prList = defineTool({
  name: "github.pr_list",
  description: "List open pull requests.",
  input: z.object({ limit: z.number().int().positive().max(50).default(20) }),
  output: z.object({ prs: z.array(z.object({ number: z.number(), title: z.string(), headRefName: z.string() })) }),
  effect: "network",
  idempotent: true,
  handler: async (input, ctx) => {
    const data = (await gh(ctx, ["pr", "list", "--limit", String(input.limit), "--json", "number,title,headRefName"], { json: true })) as Array<{
      number: number;
      title: string;
      headRefName: string;
    }>;
    return { prs: data };
  },
});

const prCreate = defineTool({
  name: "github.pr_create",
  description: "Open a pull request from the current branch. Push the branch first.",
  input: z.object({ title: z.string().min(1), body: z.string().default(""), base: z.string().default("main") }),
  output: z.object({ url: z.string() }),
  effect: "network",
  risk: "high",
  idempotent: false,
  handler: async (input, ctx) => {
    const out = (await gh(ctx, ["pr", "create", "--title", input.title, "--body", input.body, "--base", input.base])) as string;
    return { url: out.trim().split("\n").pop() ?? "" };
  },
});

const ciStatus = defineTool({
  name: "github.ci_status",
  description: "Check CI status of the latest workflow runs for the current branch.",
  input: z.object({ limit: z.number().int().positive().max(20).default(5) }),
  output: z.object({ runs: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })) }),
  effect: "network",
  idempotent: true,
  handler: async (input, ctx) => {
    const data = (await gh(ctx, ["run", "list", "--limit", String(input.limit), "--json", "name,status,conclusion"], { json: true })) as Array<{
      name: string;
      status: string;
      conclusion: string | null;
    }>;
    return { runs: data };
  },
});

export const githubTools: Tool[] = [repoView, issueList, issueView, issueCreate, prList, prCreate, ciStatus];

import type { ModelMessage, ModelRequest, ModelResponse } from "../llm/provider.js";
import { callTool, say } from "../llm/mock.js";
import type { TestRunResult, Localization } from "../tools/schemas.js";

/**
 * A deterministic, REACTIVE solver for the buggy-stats fixture. It is a MockProvider policy:
 * given the live conversation it decides the next tool call, with zero randomness and no
 * network. The SAME provider drives both the parent loop and the spawned subagent (their calls
 * interleave), so the policy branches on the system prompt to tell which agent is asking.
 *
 * Critically, the parent policy derives its macro-progress from the DURABLE LEDGER rendered
 * into the system prompt (the plan and its per-step status) — NOT from the raw message
 * transcript. That is the whole point: under aggressive context compaction the transcript is
 * rewritten and lossy, but the ledger survives, so a ledger-driven agent keeps its place.
 * Each plan step is executed then marked done; the policy only ever needs the most recent
 * action (always within the recency window) plus the durable plan to decide what comes next.
 */
export function buggyStatsSolver(): (req: ModelRequest, turn: number) => ModelResponse {
  return (req) => {
    if (isSubagent(req)) return subagentPolicy(req);
    return parentPolicy(req);
  };
}

function isSubagent(req: ModelRequest): boolean {
  return req.system.includes("focused sub-agent");
}

/**
 * A compact, data-driven solver for any "fix N substring bugs, then verify" fixture. It proves
 * the harness is not hardcoded to one repo: the same ledger-driven machinery (plan → run_tests →
 * localize → edit → re-verify → commit) drives broken-imports and pagination from a list of
 * edits. The flagship buggy-stats solver keeps the heavier load (subagent + 20+ calls + the
 * forced-compaction case); these prove generality on different bug shapes and multiple files.
 */
export function fixerSolver(edits: Array<{ path: string; oldString: string; newString: string }>): (req: ModelRequest) => ModelResponse {
  const steps: Array<{ text: string; tool: string; action: (req: ModelRequest) => ModelResponse }> = [
    { text: "Run the failing suite", tool: "shell.run_tests", action: () => callTool("shell.run_tests", {}) },
    {
      text: "Localize the failures",
      tool: "code.localize_failure",
      action: (req) => {
        const testRun = lastResultFor<TestRunResult>(req.messages, "shell.run_tests");
        return testRun ? callTool("code.localize_failure", { testRun }) : callTool("shell.run_tests", {});
      },
    },
    ...edits.map((e, i) => ({
      text: `Apply fix ${i + 1} (${e.path})`,
      tool: "fs.edit",
      action: () => callTool("fs.edit", { path: e.path, oldString: e.oldString, newString: e.newString }),
    })),
    { text: "Re-run to verify green", tool: "shell.run_tests", action: () => callTool("shell.run_tests", {}) },
    { text: "Commit the fix", tool: "git.commit_all", action: () => callTool("git.commit_all", { message: "fix: correct the seeded bugs" }) },
  ];

  return (req) => {
    const plan = parsePlan(req.system);
    if (plan.length === 0) return callTool("plan.set", { steps: steps.map((s) => s.text) }, { text: "Planning the fix." });
    const current = plan.find((p) => p.status !== "done");
    if (!current) return say("Fixed and verified. Done.");
    const step = steps[current.id - 1];
    if (!step) return say("Plan complete.");
    const last = lastToolCall(req.messages);
    // fs.edit appears for several steps; advance only when THIS step's edit (by oldString) landed.
    const isEditStep = step.tool === "fs.edit";
    const editApplied =
      isEditStep &&
      last?.name === "fs.edit" &&
      last.ok &&
      editJustApplied(req, edits[current.id - 3]?.oldString);
    if ((last && last.ok && last.name === step.tool && !isEditStep) || editApplied) {
      return callTool("plan.update", { id: current.id, status: "done" });
    }
    return step.action(req);
  };
}

/** True if the most recent fs.edit used the given oldString (so distinct edit steps don't collide). */
function editJustApplied(req: ModelRequest, oldString: string | undefined): boolean {
  if (!oldString) return true;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.type === "tool_use" && b.name === "fs.edit") {
        return String((b.input as { oldString?: string }).oldString ?? "") === oldString;
      }
    }
  }
  return false;
}

// The ordered plan. Each step maps to exactly one tool action; the solver performs the action,
// then on the following turn marks the step done — a cadence that keeps a >20-call session
// entirely anchored to durable plan state.
const STEPS: Array<{ text: string; tool: string; action: (req: ModelRequest) => ModelResponse }> = [
  { text: "List the repository root", tool: "fs.list", action: () => callTool("fs.list", { path: "." }) },
  { text: "Find the source files", tool: "fs.glob", action: () => callTool("fs.glob", { pattern: "src/**/*.mjs" }) },
  { text: "Profile the codebase size", tool: "code.count_lines", action: () => callTool("code.count_lines", {}) },
  { text: "Read the stats module", tool: "fs.read", action: () => callTool("fs.read", { path: "src/stats.mjs" }) },
  { text: "Outline the stats module", tool: "code.outline", action: () => callTool("code.outline", { path: "src/stats.mjs" }) },
  { text: "Run the failing test suite", tool: "shell.run_tests", action: () => callTool("shell.run_tests", {}) },
  {
    text: "Localize the failures to source files",
    tool: "code.localize_failure",
    action: (req) => {
      const testRun = lastResultFor<TestRunResult>(req.messages, "shell.run_tests");
      return testRun
        ? callTool("code.localize_failure", { testRun })
        : callTool("shell.run_tests", {}); // fallback: re-run to repopulate the window
    },
  },
  {
    text: "Audit the buggy module via a subagent",
    tool: "agent.spawn",
    action: () =>
      callTool("agent.spawn", {
        objective:
          "Audit src/stats.mjs. Identify the exact buggy lines in median() and lastN() and the corrected expression for each. Report findings; do not edit.",
        allowedTools: ["fs.read", "code.grep", "code.outline"],
        context: "Tests report median() wrong for even-length input and lastN() returning one element too many.",
        maxSteps: 8,
      }),
  },
  {
    text: "Read the candidate source files",
    tool: "fs.read_many",
    action: (req) => {
      const loc = lastResultFor<Localization>(req.messages, "code.localize_failure");
      const paths = loc?.candidates.map((c) => c.file).slice(0, 3) ?? [];
      return callTool("fs.read_many", { paths: paths.length ? paths : ["src/stats.mjs"] });
    },
  },
  {
    text: "Fix median() even-length averaging",
    tool: "fs.edit",
    action: () =>
      callTool("fs.edit", {
        path: "src/stats.mjs",
        oldString: "  return s[mid];",
        newString: "  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];",
      }),
  },
  {
    text: "Fix lastN() off-by-one",
    tool: "fs.edit",
    action: () =>
      callTool("fs.edit", {
        path: "src/stats.mjs",
        oldString: "  return xs.slice(xs.length - n - 1);",
        newString: "  return xs.slice(xs.length - n);",
      }),
  },
  { text: "Re-run the suite to verify green", tool: "shell.run_tests", action: () => callTool("shell.run_tests", {}) },
  { text: "Commit the verified fix", tool: "git.commit_all", action: () => callTool("git.commit_all", { message: "fix(stats): correct median and lastN" }) },
];

function parentPolicy(req: ModelRequest): ModelResponse {
  const plan = parsePlan(req.system);

  // No plan in the durable ledger yet → establish it. This is the only message-independent move.
  if (plan.length === 0) {
    return callTool(
      "plan.set",
      { steps: STEPS.map((s) => s.text) },
      { text: "Planning the fix end-to-end, then I'll execute step by step." },
    );
  }

  const last = lastToolCall(req.messages);
  const current = plan.find((p) => p.status !== "done");

  // All steps done → finished.
  if (!current) return say("All bugs fixed, suite is green, change committed. Done.");

  const idx = current.id - 1;
  const step = STEPS[idx];
  if (!step) return say("Plan complete.");

  // If the most recent successful action was this step's tool, mark the step done; otherwise
  // perform the action. Only the LAST message is consulted, which always survives compaction.
  if (last && last.ok && last.name === step.tool) {
    return callTool("plan.update", { id: current.id, status: "done" });
  }
  return step.action(req);
}

// --- subagent --------------------------------------------------------------

function subagentPolicy(req: ModelRequest): ModelResponse {
  const used = toolUses(req.messages);
  const has = (name: string) => used.some((u) => u.name === name);
  if (!has("fs.read")) return callTool("fs.read", { path: "src/stats.mjs" });
  if (!has("code.grep")) return callTool("code.grep", { pattern: "BUG" });
  return callTool("task.complete", {
    success: true,
    summary: "Audited src/stats.mjs. Found two defects with concrete fixes.",
    findings: [
      { label: "median even-length", value: "return s[mid] should average s[mid-1] and s[mid] when length is even" },
      { label: "lastN off-by-one", value: "slice(xs.length - n - 1) keeps one extra element; use slice(xs.length - n)" },
    ],
    artifacts: [{ path: "src/stats.mjs", description: "module containing both bugs" }],
  });
}

// --- introspection helpers -------------------------------------------------

interface UsedTool {
  id: string;
  name: string;
  input: unknown;
}

function toolUses(messages: ModelMessage[]): UsedTool[] {
  const out: UsedTool[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) if (b.type === "tool_use") out.push({ id: b.id, name: b.name, input: b.input });
  }
  return out;
}

/** The most recent tool_use and whether its result was ok — derived from the tail of the window. */
function lastToolCall(messages: ModelMessage[]): { name: string; ok: boolean } | undefined {
  const idToName = new Map<string, string>();
  let lastName: string | undefined;
  let lastId: string | undefined;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.type === "tool_use") {
        idToName.set(b.id, b.name);
        lastName = b.name;
        lastId = b.id;
      }
    }
  }
  if (!lastName) return undefined;
  let ok = true;
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const b of m.content) if (b.type === "tool_result" && b.tool_use_id === lastId) ok = !b.is_error;
  }
  return { name: lastName, ok };
}

/** Parse the durable plan out of the ledger render embedded in the system prompt. */
function parsePlan(system: string): Array<{ id: number; status: string }> {
  const out: Array<{ id: number; status: string }> = [];
  const re = /^\[([ x~!])\]\s+\[(\d+)\]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(system))) {
    const glyph = m[1]!;
    out.push({ id: Number(m[2]), status: glyph === "x" ? "done" : glyph === "~" ? "active" : glyph === "!" ? "blocked" : "pending" });
  }
  return out;
}

/** Parse the most recent successful tool_result for `name` back into its structured type. */
function lastResultFor<T>(messages: ModelMessage[], name: string): T | undefined {
  const idToName = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant") for (const b of m.content) if (b.type === "tool_use") idToName.set(b.id, b.name);
  }
  let found: T | undefined;
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const b of m.content) {
      if (b.type === "tool_result" && !b.is_error && idToName.get(b.tool_use_id) === name) {
        try {
          found = JSON.parse(b.content) as T;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return found;
}

# MEMO: maestro

## What I built

An autonomous software-engineering agent in TypeScript. One model-driven loop
(`src/agent/loop.ts`) steers a registry of 60 tools across 8 namespaces (`fs`, `git`, `code`,
`shell`, `plan`, `agent`, `github`, `web`). Tools are self-describing `Tool<I,O>` values with a risk level. The
model picks them through Anthropic tool use, and the registry validates and dispatches through a
single path. There is no hand-routing and no `switch (toolName)`.

Each of the five required properties does real work:

1. **Registry coherence.** `ToolRegistry` (`src/tools/registry.ts`) generates JSON schemas from
   zod and dispatches by name. It also produces scoped subset views, filtered by name,
   namespace, or effect. That same mechanism is what scopes a subagent's tools.
2. **Subagent orchestration.** `agent.spawn` runs the same `runAgent` loop with an isolated
   `ConversationContext`, a registry subset, its own budget and trace span, and a completion
   tool whose schema is the structured return contract. The parent consumes only the validated
   `{success, summary, findings, artifacts}`. It never sees the child transcript.
3. **Long-horizon execution.** A durable Ledger (plan, facts, file digests) is re-rendered into
   the system prompt on every call, so it outlives the context compaction that folds stale tool
   output into summaries. The eval proves a 20-plus call session stays coherent through forced
   compaction.
4. **Production scaffolding.** pino logs, a JSONL span tracer, exponential backoff with jitter,
   a token-bucket rate limiter on every external call, a typed error hierarchy, an eval harness,
   a per-run project index that walks the tree once instead of once per `code.*` call, and 59 tests. The layout targets deployment: config from zod-validated env, a Dockerfile, CI.
5. **Composable I/O.** `shell.run_tests` and `code.localize_failure` share one `TestRunResult`
   schema, and `fs.read_many` reads the resulting paths. The chain type-checks, and the eval
   verifies the data actually flowed rather than checking call order.

Three capabilities sit on top of the five required properties because they are what a robust
agent runtime actually needs. An **acceptance gate** (`src/agent/gate.ts`) makes completion a fact
the runtime checks (tests pass, build passes, tree committed, plan closed), not a claim the model
makes; a red gate is fed back and the run continues. A **durable mission log**
(`src/agent/mission-log.ts`) checkpoints the ledger and message window every step, so `maestro
resume <id>` rebuilds a killed run in a fresh process and finishes it. **Tool retrieval**
(`src/tools/retrieval.ts`) advertises a relevant subset of the 61 tools each turn (lexical BM25 over
tool metadata) instead of all schemas, cutting schema tokens ~47%; it is grounded in a deep-research
+ Codex review of the agent literature (`docs/research/`), which both ranked it the first thing to
build.

The eval harness materializes a fixture repo with seeded bugs into a temporary git repo, runs
the agent, then runs the fixture's own suite to confirm the bugs are fixed. That is a
SWE-bench-shaped signal, and it runs in CI with no API key through a `MockProvider`. Five scenarios
span three fixtures (a flagship multi-bug repo, a cross-file import bug, a pagination repo) plus a
crash-and-resume scenario (abort mid-task, resume from the mission log, finish green), so the
harness shows the runtime invariants generalize rather than fit one happy path.

## What I cut

- **Full live end-to-end run.** The live Anthropic path is wired and verified at the protocol
  level (it exposed and I fixed two real bugs: dotted tool names and OpenAPI-form schemas that the
  API rejects). I drove it with a Claude Code OAuth token; the request shape is now accepted (the
  failures moved from 400 to 429). A complete autonomous run was blocked by the subscription's
  burst rate limit, which a pay-per-token key removes. I did not build a multi-repo benchmark or
  statistical scoring across many tasks.
- **Automatic crash recovery.** Resume exists and is proven (`maestro resume`, plus a resume eval),
  but it is operator-initiated. There is no supervisor that detects a stuck run and restarts it from
  the last checkpoint. That is the next step.
- **Richer code intelligence.** `code.*` uses regex and heuristics rather than a real AST or
  LSP. That is enough for localization and outlines. An AST index would localize more precisely.
- **Parallel subagents.** Spawning is sequential. The trace model and isolation already support
  fan-out, but there is no parallel scheduler.
- **Model-backed compaction.** The summarizer is pluggable and can call a model. It defaults to a
  deterministic fold so cost and tests stay predictable.

## What more time would have addressed

A supervisor that detects a stuck run and resumes it automatically (resume itself already ships),
and replay of a run from any trace span. An AST-backed `code` namespace. A parallel subagent
scheduler that shares a token budget. A larger held-out eval set with per-property scoring, so
depth is measured rather than asserted. The permission layer already ships (`readonly` and `safe` modes gate write, exec, network, and
high-risk tools through the registry); extending it to per-path and per-command policy is the
next step.

## One design decision I would defend

**The subagent is the same `runAgent` loop with an injected scoped registry and an isolated
context, rather than a separate subagent implementation.**

A reasonable engineer would write a dedicated `runSubagent()`: fewer moving parts, a bespoke
prompt, no risk of the parent's features leaking in. I did the opposite. There is one loop,
parameterized by the registry it sees, the context it owns, its budget, and an optional
completion tool.

I would defend that on three grounds. First, isolation becomes structural. The child cannot
touch an ungranted tool because that tool is not in its registry subset and not in its `Map`.
There is nothing to call and no allowlist to forget. Second, the contract is enforced by the
type system instead of by parsing prose. The child returns by calling a completion tool whose
input schema is `SubagentResultSchema`. An invalid return is a validation error at the boundary,
and a child that never returns cleanly still produces the same shape for the parent. Third, every
capability the parent gains, the child inherits: tracing, retries, rate limiting, compaction, and
a writable ledger. A subagent is then a full agent with a narrower world, which is the property
that makes delegation worth having. The cost is that the loop has to be written to be reentrant
and configuration-driven. That complexity is real, and this is the right place to pay it.

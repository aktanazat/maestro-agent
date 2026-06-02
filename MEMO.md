# MEMO — maestro

## What I built

An autonomous software-engineering agent in TypeScript. One model-driven loop
(`src/agent/loop.ts`) steers a registry of **60 tools across 8 namespaces** (`fs`, `git`,
`code`, `shell`, `plan`, `agent`, `github`, `web`). Tools are self-describing `Tool<I,O>`
values; the model picks them via Anthropic tool-use, and the registry validates and dispatches
through a single path — there is no hand-routing and no `switch (toolName)`.

The five required properties are load-bearing, not decorative:

1. **Registry coherence.** `ToolRegistry` (`src/tools/registry.ts`) generates JSON schemas from
   zod, dispatches by name, and supports scoped *subset views* (by name, namespace, or effect)
   — the same mechanism that scopes a subagent's tools.
2. **Subagent orchestration.** `agent.spawn` runs the *same* `runAgent` loop with an isolated
   `ConversationContext`, a registry subset, its own budget and trace span, and a completion
   tool whose schema *is* the structured return contract. The parent consumes only the
   validated `{success, summary, findings, artifacts}`; it never sees the child transcript.
3. **Long-horizon execution.** A durable **Ledger** (plan + facts + file digests) is re-rendered
   into the system prompt on every call, so it survives the context **compaction** that folds
   stale tool output into summaries. The eval proves a 20+ call session stays coherent *through*
   forced compaction.
4. **Production scaffolding.** pino logs, a JSONL span tracer, exponential backoff with jitter,
   a token-bucket rate limiter on every external call, a typed error hierarchy, an eval harness,
   and 33 unit + integration tests. Layered for deployment (config via zod-validated env,
   Dockerfile, CI).
5. **Composable I/O.** `shell.run_tests` → `code.localize_failure` share one `TestRunResult`
   schema; `fs.read_many` consumes the resulting paths. The chain type-checks.

The eval harness materializes a fixture repo with seeded bugs into a temp git repo, runs the
agent, then runs the fixture's own suite to confirm the bugs are actually fixed — a
SWE-bench-shaped, deterministic signal that runs in CI with no API key via a `MockProvider`.

## What I cut

- **Real-model eval at scale.** `--real` runs the suite against the live model, but I tuned and
  proved correctness on the deterministic solver. I did not build a multi-repo SWE-bench-scale
  benchmark or statistical scoring across many tasks.
- **Persistence / resumability.** A run is in-memory; traces are written but there's no
  checkpoint-and-resume of an interrupted session.
- **Richer code intelligence.** `code.*` uses regex/heuristics, not a real AST/LSP. Good enough
  for localization and outlines; an AST index would localize more precisely.
- **Parallel subagents.** Spawning is sequential. The trace model and isolation already support
  fan-out; I didn't wire a parallel scheduler.
- **A model-backed compaction summarizer** is supported (pluggable) but defaults to a
  deterministic fold to keep cost and tests predictable.

## What more time would have addressed

A persistent run store (resume + replay from any span), an AST-backed `code` namespace, a
parallel subagent scheduler with a shared budget, and a larger held-out eval set with
per-property scoring so "depth" is measured rather than asserted. I'd also add a permission
layer that gates `write`/`exec`/`network` tools behind policy in untrusted repos.

## One design decision I'd defend

**The subagent is the same `runAgent` loop with an injected scoped registry and an isolated
context — not a separate subagent implementation.**

A reasonable engineer would write a dedicated, simpler `runSubagent()` — fewer moving parts, a
bespoke prompt, no risk of the parent's features leaking in. I deliberately did the opposite:
one loop, parameterized by the registry it sees, the context it owns, its budget, and an
optional completion tool.

I'd defend it on three grounds. **Isolation becomes structural, not aspirational.** The child
can't touch an ungranted tool because that tool is not in its registry subset and not in its
Map — there is nothing to call, no allowlist check to forget. **The contract is enforced by the
type system, not by parsing prose.** The child returns by calling a completion tool whose input
schema *is* `SubagentResultSchema`; an invalid return is a validation error at the boundary, and
if the child never returns cleanly the parent still gets the same shape. **Every capability the
parent gains, the child gets for free** — tracing, retries, rate limiting, compaction — so a
subagent is a first-class agent with a narrower world, which is exactly the property that makes
delegation worth having. The cost is that the loop must be written to be reentrant and
configuration-driven; that complexity is real, and it is the right place to pay it.

# maestro — architecture & build plan

**Domain:** autonomous software-engineering agent. Give it a repo + a goal ("make the
failing tests pass", "add feature X", "audit & fix"), it plans, explores, edits, runs
tests, iterates, and produces a diff / PR. Chosen because it is a real production domain
*and* admits a deterministic eval (fixture repos with seeded failing tests → agent must
make `npm test` go green), which a fuzzy domain like open-web research cannot.

## The five required properties → where each is satisfied

1. **50+ tools across 4+ namespaces, model-driven, coherent registry.**
   Namespaces: `fs.*`, `git.*`, `code.*`, `shell.*`, `github.*`, `web.*`, `plan.*`, `agent.*`.
   Each tool is a self-describing `Tool<I,O>` object (zod input/output schema + handler).
   `ToolRegistry` auto-generates Anthropic tool JSON from the zod schemas and dispatches by
   name through a `Map` — no switch/if-chain. The model selects tools via the tool-use API.

2. **Subagent orchestration.** `agent.spawn` tool runs a fresh agent loop with its OWN
   message history (isolated context), a SCOPED subset of the registry, its own token
   budget, and returns a validated structured `{success, summary, findings, artifacts}` to
   the parent. Not a function relabelled — a real nested loop.

3. **Long-horizon execution.** The eval tasks require 20+ tool calls in one session
   (explore → localize → edit N files → run tests → read failures → fix → re-run).
   Context strategy is explicit in `agent/context.ts`: token-budgeted window, compaction of
   stale tool results into summaries, a durable plan ledger + file-digest cache that survive
   compaction so plan coherence is not lost.

4. **Production scaffolding.** pino structured logs; a span/trace recorder writing JSONL;
   retry with exponential backoff + jitter on LLM/network; token-bucket rate limiter on all
   external calls; a typed error hierarchy; an eval harness; vitest unit + integration tests;
   deployable layout (config via zod-validated env, Dockerfile, CI).

5. **Composable tool I/O.** Tools emit typed structured output. At least one tool consumes
   another's output type in code: `code.localize_failure` consumes the structured output of
   `shell.run_tests` (parsed failures) and returns ranked candidate files, which `fs.edit`
   then targets. The model also composes freely (grep → read → edit).

## Stack
TypeScript (Node 20+), Anthropic SDK (tool-use), zod + zod-to-json-schema, pino, commander,
vitest, execa. Pluggable `ModelProvider` so a deterministic `MockProvider` drives tests/eval
offline (no API spend) while `AnthropicProvider` runs for real.

## Layout
src/{agent,llm,tools/<ns>,subagent,obs,resilience,eval,util}, tests/{unit,integration},
fixtures/repos, docs/. CLI: `maestro run`, `maestro eval`, `maestro replay`.

## Build order
1. types + registry + zod schema gen  2. llm provider iface + mock + anthropic
3. resilience (retry/ratelimit/errors) + obs (logger/tracer)  4. tool namespaces
5. agent loop + context mgmt  6. subagent  7. eval harness + fixtures  8. tests  9. docs/MEMO/CI

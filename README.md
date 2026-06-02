# maestro

An autonomous software-engineering agent. Point it at a repository with a goal — *"make the
failing tests pass", "add feature X", "audit and fix"* — and it plans, explores, edits, runs
the tests, iterates, and produces a verified diff. The model drives; the runtime gives it a
coherent toolset, isolated subagents, durable working memory, and production-grade guardrails.

```
maestro run "the test suite is failing — find the root cause, fix it, and commit" --repo ./some-project
maestro eval            # deterministic eval suite (no API key needed)
maestro tools           # list the 60-tool registry
```

## Why it's shaped this way

The agent is one loop (`src/agent/loop.ts`) that the **model** steers via tool use. Everything
else is structure that keeps a long, autonomous run correct:

| Concern | Where | What it does |
| --- | --- | --- |
| **Tool registry** | `src/tools/registry.ts` | 60 tools across 8 namespaces are self-describing `Tool<I,O>` values in a `Map`. Anthropic JSON schemas are generated from zod; dispatch is one validated code path — no `switch (toolName)`. |
| **Subagent orchestration** | `src/subagent/spawn.ts` | `agent.spawn` runs the *same loop* with an isolated context, a registry **subset** scoped to granted tools, its own budget and trace span, and a schema-validated structured return. The parent sees only that return, never the child's transcript. |
| **Long-horizon execution** | `src/agent/ledger.ts`, `src/agent/context.ts` | A durable **plan ledger** (plan + facts + file digests) is re-rendered into the system prompt every call, so it survives the **compaction** that summarizes stale tool output away. Plan coherence is held in code, not in prompt wishes. |
| **Composable I/O** | `src/tools/schemas.ts` | `shell.run_tests` emits a `TestRunResult`; `code.localize_failure` declares the *same* schema as input and ranks candidate files; `fs.read_many` consumes those paths. Tools chain at the type level. |
| **Production scaffolding** | `src/obs/`, `src/resilience/` | pino structured logs, a JSONL span tracer, exponential backoff + jitter, a token-bucket rate limiter on every external call, a typed error hierarchy, an eval harness, and a unit + integration test suite. |

## The canonical chain

```
shell.run_tests ─▶ code.localize_failure(testRun) ─▶ fs.read_many(candidates) ─▶ fs.edit ─▶ shell.run_tests
```

`code.localize_failure` literally takes the structured output of `shell.run_tests` as input
(`src/tools/schemas.ts` defines the shared `TestRunResultSchema`), scores source files against
the parsed failures, and returns ranked candidates the editor targets.

## Namespaces (60 tools)

`fs.*` (14) · `git.*` (15) · `code.*` (9) · `shell.*` (6) · `plan.*` (5) · `agent.*` (2) ·
`github.*` (7) · `web.*` (2). Run `maestro tools` for the full annotated list.

## Architecture at a glance

```
CLI (commander) ─▶ runTask (composition root)
                     ├─ AnthropicProvider | MockProvider     (src/llm)
                     ├─ ToolRegistry  (60 tools, 8 namespaces)
                     ├─ ConversationContext + Ledger          (context mgmt + durable memory)
                     ├─ RateLimiterRegistry / retry / errors   (resilience)
                     ├─ Tracer + pino logger                   (observability)
                     └─ runAgent (the one loop) ──spawns──▶ runAgent (subagent, scoped + isolated)
```

## Running

```bash
npm install
cp .env.example .env        # set ANTHROPIC_API_KEY for live runs

npm run test                # 33 unit + integration tests
npm run eval                # deterministic eval suite (mock solver, no API key)
npm run eval -- --real      # same tasks against the live model
npm run build && node dist/index.js run "fix the failing tests" --repo ./path
```

The **eval suite** is deliberately adversarial: one task requires a 20+ tool-call session with
mandatory subagent delegation and the run_tests→localize composition; a second runs the same
goal under a tiny context budget that *forces* compaction mid-session, then asserts the plan
survived and the tests are green. Both run with zero network via the deterministic solver, so
CI verifies the whole machine on every push.

## Observability

Every run writes a JSONL trace (`.maestro/traces/`) of nested spans — model calls, tool calls,
subagent runs — reconstructable into the full causal tree. Logs are structured (pino); set
`MAESTRO_LOG_PRETTY=1` for human-readable output.

See [`MEMO.md`](./MEMO.md) for what was built, what was cut, and the design decision I'd defend.

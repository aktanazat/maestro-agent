# maestro

An autonomous software-engineering agent. Point it at a repository with a goal, like "make
the failing tests pass" or "add feature X", and it plans, edits, runs the tests, and iterates
until the goal is verifiably met. The model decides what to do. The runtime gives it a coherent
toolset, isolated subagents, durable working memory, and production guardrails.

```
maestro run "the test suite is failing; find the root cause, fix it, and commit" --repo ./some-project
maestro eval            # deterministic eval suite (no API key needed)
maestro tools           # list the 60-tool registry
```

## Why it's shaped this way

The agent is one loop (`src/agent/loop.ts`) that the model steers through tool use. Everything
else is structure that keeps a long autonomous run correct.

| Concern | Where | What it does |
| --- | --- | --- |
| **Tool registry** | `src/tools/registry.ts` | 60 tools across 8 namespaces are self-describing `Tool<I,O>` values in a `Map`. Anthropic JSON schemas are generated from zod. Dispatch is one validated code path, so there is no `switch (toolName)` to grow. |
| **Subagent orchestration** | `src/subagent/spawn.ts` | `agent.spawn` runs the same loop with an isolated context, a registry subset scoped to the granted tools, its own budget and trace span, and a schema-validated return. The parent sees only that return, never the child's transcript. |
| **Long-horizon execution** | `src/agent/ledger.ts`, `src/agent/context.ts` | A durable plan ledger holds the plan, established facts, and file digests. It is re-rendered into the system prompt on every call, so it outlives the compaction that summarizes stale tool output away. Plan coherence lives in code, not in a prompt instruction. |
| **Composable I/O** | `src/tools/schemas.ts` | `shell.run_tests` emits a `TestRunResult`. `code.localize_failure` declares that same schema as its input and ranks candidate files. `fs.read_many` then reads them. The chain type-checks. |
| **Production scaffolding** | `src/obs/`, `src/resilience/` | pino structured logs, a JSONL span tracer, exponential backoff with jitter, a token-bucket rate limiter on every external call, a typed error hierarchy, an eval harness, and a unit + integration test suite. |

## The canonical chain

```
shell.run_tests -> code.localize_failure(testRun) -> fs.read_many(candidates) -> fs.edit -> shell.run_tests
```

`code.localize_failure` takes the structured output of `shell.run_tests` as input. The shared
`TestRunResultSchema` in `src/tools/schemas.ts` is what makes that connection a compile-time
type, not a convention. The tool scores source files against the parsed failures and returns
ranked candidates for the editor to target. The eval verifies the actual data flowed through,
not just the call order.

## Namespaces (60 tools)

`fs.*` (14), `git.*` (15), `code.*` (9), `shell.*` (6), `plan.*` (5), `agent.*` (2),
`github.*` (7), `web.*` (2). Run `maestro tools` for the full annotated list.

## Architecture at a glance

```
CLI (commander) -> runTask (composition root)
                     |- AnthropicProvider | MockProvider     (src/llm)
                     |- ToolRegistry  (60 tools, 8 namespaces)
                     |- ConversationContext + Ledger          (context mgmt + durable memory)
                     |- RateLimiterRegistry / retry / errors   (resilience)
                     |- Tracer + pino logger                   (observability)
                     +- runAgent (the one loop) --spawns--> runAgent (subagent, scoped + isolated)
```

## Running

```bash
npm install
cp .env.example .env        # set ANTHROPIC_API_KEY for live runs

npm run test                # 46 unit + integration tests
npm run eval                # deterministic eval suite (mock solver, no API key)
npm run eval -- --real      # same tasks against the live model
npm run build && node dist/index.js run "fix the failing tests" --repo ./path
node dist/index.js run "audit this repo" --repo ./path --permission readonly   # observe-only run
```

The eval suite is built to be hard to fake. One task requires a session of more than 20 tool
calls with mandatory subagent delegation and the run_tests-to-localize composition. A second
task runs the same goal under a tiny context budget that forces compaction partway through, then
asserts the plan survived and the tests are green. Both run with no network through the
deterministic solver, so CI exercises the whole machine on every push.

## Observability

Every run writes a JSONL trace under `.maestro/traces/`. The spans nest by parent id, so a
trace reconstructs the full causal tree of model calls, tool calls, and subagent runs. Logs are
structured through pino. Set `MAESTRO_LOG_PRETTY=1` for human-readable output.

See [`MEMO.md`](./MEMO.md) for what was built, what was cut, and the design decision I would
defend.

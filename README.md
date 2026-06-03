# maestro

An autonomous software-engineering agent. Give it a repo and a goal ("make the failing tests
pass", "add feature X") and it works the problem until the goal verifiably holds: planning,
editing, running the tests, looping on whatever broke. The model decides every move. Around it
sits the runtime that keeps a long run from drifting — a coherent toolset, isolated subagents,
durable working memory, real guardrails.

### A real model actually solving it

![Gemini fixing a real bug](demo/live-solve.gif)

> Not the mock. A **live model** — Gemini 2.5 Flash, through the provider-agnostic adapter — drives
> every decision here. It plans, runs the tests, reads the source, works out that `add` is
> subtracting instead of adding, patches it, re-runs to green, commits. 19 tool calls, no human in
> the loop, acceptance-gate verified. The clip replays the run's own mission log
> (`demo/live-solve/mission.jsonl`), so the events you see are exactly what the model did. Reproduce
> with a free Gemini or Groq key: `OPENAI_API_KEY=… MAESTRO_OPENAI_BASE_URL=… npx tsx demo/live-run.ts`.

### The full machinery (deterministic, CI-verified)

![maestro fixing a repo](demo/agent-demo.gif)

> The same agent on a harder repo, driven by the mock provider so CI can run it with no API key: it
> plans 13 steps, runs the tests, composes `run_tests` into `localize_failure`, delegates an audit to
> an isolated subagent, survives a context compaction mid-run, patches both bugs, re-verifies green,
> and commits. 27 tool calls, plan coherent throughout
> ([`demo/agent-run.ts`](demo/agent-run.ts)). There's also a
> [code tour](demo/maestro-demo.gif) of the registry, subagent, and compaction internals.

```
maestro run "the test suite is failing; find the root cause, fix it, and commit" --repo ./some-project
maestro eval            # deterministic eval suite (no API key needed)
maestro tools           # list the 61-tool registry
```

## Why it's shaped this way

The agent is one loop (`src/agent/loop.ts`) that the model steers through tool use. Everything
else is structure that keeps a long autonomous run correct.

| Concern | Where | What it does |
| --- | --- | --- |
| **Tool registry** | `src/tools/registry.ts` | 61 tools across 8 namespaces are self-describing `Tool<I,O>` values in a `Map`. Anthropic JSON schemas are generated from zod. Dispatch is one validated code path, so there is no `switch (toolName)` to grow. |
| **Tool retrieval** | `src/tools/retrieval.ts` | At 61 tools, advertising every schema each call is costly and hits provider token limits. A lexical BM25 selector advertises a relevant subset per turn (control plane + coding essentials + top-ranked + recently-used), cutting schema tokens ~47%; `agent.find_tools` surfaces the long tail. Grounded in RAG-MCP / ToolLLM (see `docs/research/`). |
| **Subagent orchestration** | `src/subagent/spawn.ts` | `agent.spawn` runs the same loop with an isolated context, a registry subset scoped to the granted tools, its own budget and trace span, and a schema-validated return. The parent sees only that return, never the child's transcript. |
| **Long-horizon execution** | `src/agent/ledger.ts`, `src/agent/context.ts` | A durable plan ledger holds the plan, established facts, and file digests. It is re-rendered into the system prompt on every call, so it outlives the compaction that summarizes stale tool output away. The plan stays coherent because code enforces it, not because the prompt asks nicely. |
| **Acceptance gate** | `src/agent/gate.ts` | The runtime decides when a run is done, not the model. Before a run can finish, the loop re-runs the checks itself — do the tests pass, does the build pass, is the tree committed, is the plan closed — and keeps working, with the failures fed back, until they're all green. |
| **Crash-resume** | `src/agent/mission-log.ts` | An append-only mission log checkpoints the ledger snapshot + message window every step. `maestro resume <id>` rebuilds a killed run in a fresh process from the last checkpoint and finishes it. |
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

## Namespaces (61 tools)

`fs.*` (14), `git.*` (15), `code.*` (9), `shell.*` (6), `plan.*` (5), `agent.*` (3),
`github.*` (7), `web.*` (2). Run `maestro tools` for the full annotated list.

## Architecture at a glance

```
CLI (commander) -> runTask (composition root)
                     |- AnthropicProvider | MockProvider     (src/llm)
                     |- ToolRegistry  (61 tools, 8 namespaces)
                     |- ConversationContext + Ledger          (context mgmt + durable memory)
                     |- RateLimiterRegistry / retry / errors   (resilience)
                     |- Tracer + pino logger                   (observability)
                     +- runAgent (the one loop) --spawns--> runAgent (subagent, scoped + isolated)
```

## Running

```bash
npm install
cp .env.example .env        # set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) for live runs

npm run test                # 69 unit + integration tests
npm run eval                # 5 deterministic eval scenarios across 3 fixtures (no API key)
npm run eval -- --real      # same tasks against the live model
npm run build && node dist/index.js run "fix the failing tests" --repo ./path
node dist/index.js resume <missionId> --repo ./path                            # resume a crashed run
node dist/index.js run "audit this repo" --repo ./path --permission readonly   # observe-only run
```

A note on what the eval does and doesn't prove. The suite drives the **real** loop, registry,
subagent, acceptance gate, and mission log, but the model underneath is a **deterministic mock**.
So CI re-checks the runtime **invariants** on every push, offline: a 20+ call session that has to
delegate to a subagent and route `run_tests`→`localize`; the same task squeezed under a context
budget so tiny it forces a compaction, then asserting the plan still survived; a cross-file bug and
a multi-bug repo; and a crash-and-resume run that aborts mid-task and has to come back from the
mission log in a fresh process and still finish green. That's a lot of proof about the machinery.
It says nothing about whether a real model can drive it — which is what `--real` is for (see
[Authentication](#authentication); the live path is wire-verified, a full run just needs a
non-throttled key). [`docs/XARC.md`](docs/XARC.md) has the honest map: what's deep, what's
deliberately small, how it got built.

## Authentication

Live runs use one of two credentials, read from the environment:

- `ANTHROPIC_API_KEY` for a standard pay-per-token API key.
- `ANTHROPIC_AUTH_TOKEN` for a Claude Code OAuth (subscription) token. In this mode the provider
  sends a Bearer token with the oauth beta header and prepends the Claude Code identity that the
  API requires. Subscription tokens are rate-limited for burst use, so a long autonomous run may
  throttle; a pay-per-token key runs without that limit.

## Observability

Every run writes a JSONL trace under `.maestro/traces/`. The spans nest by parent id, so a
trace reconstructs the full causal tree of model calls, tool calls, and subagent runs. Logs are
structured through pino. Set `MAESTRO_LOG_PRETTY=1` for human-readable output.

See [`MEMO.md`](./MEMO.md) for what was built, what was cut, and the design decision I would
defend.

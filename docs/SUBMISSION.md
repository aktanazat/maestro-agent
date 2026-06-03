# Submission guide

**Repository:** https://github.com/aktanazat/maestro-agent (public)

## How each required property is satisfied (with code pointers)

| # | Property | Evidence |
| --- | --- | --- |
| 1 | 50+ tools, 4+ namespaces, model-driven, coherent registry | 61 tools / 8 namespaces. `src/tools/registry.ts` (schema-gen + single dispatch, no switch), `src/tools/index.ts`. `maestro tools` to list. |
| 2 | Real subagent orchestration | `src/subagent/spawn.ts` isolated `ConversationContext`, registry **subset**, own budget/trace, schema-validated return. Tests: `tests/integration/subagent.test.ts` (scope enforcement, isolation, contract shape). |
| 3 | Long-horizon 20+ calls, context strategy in code | `src/agent/ledger.ts` + `src/agent/context.ts` (durable ledger + compaction). Eval `buggy-stats:fix-and-verify` runs 27 tool calls; `buggy-stats:survives-forced-compaction` proves plan survives compaction; `broken-imports` and `pagination` show the harness generalizes. |
| 4 | Production scaffolding | `src/obs/` (pino + JSONL tracer), `src/resilience/` (retry/backoff, token-bucket rate limit, typed errors), `src/eval/` (harness), `tests/` (69 tests), Dockerfile, `.github/workflows/ci.yml`. |
| 5 | Composable tool I/O | `src/tools/schemas.ts` shared `TestRunResultSchema`: `shell.run_tests` → `code.localize_failure` → `fs.read_many` → `fs.edit`. Eval check `composed_run_tests_to_localize`. |

## Reproduce

```bash
npm install
npm run typecheck && npm run lint && npm run test                # 69 tests
npm run eval                # 5/5 deterministic eval tasks, no API key
npm run build && node dist/index.js tools   # 61 tools
# live run (Anthropic): set ANTHROPIC_API_KEY, then:
node dist/index.js run "fix the failing tests and commit" --repo <path>
# provider-agnostic path used for the headline demo (free Gemini/Groq key):
OPENAI_API_KEY=… MAESTRO_OPENAI_BASE_URL=… npx tsx demo/live-run.ts
```

## Convergence with Codex

This was built in a paired loop with Codex (`gpt-5.5`, high reasoning) running adversarial `/grill-me`-style reviews. The reviews and how they changed the build are in `docs/reviews/`:
- `01-codex-grill-plan.txt`: Codex's grill of the initial plan ("reads like checklist compliance"), which drove: subagent built early with a real isolation contract, the ledger
 modeled as a durable state machine (not a summarizer), and the forced-compaction eval.

## Session traces (native format)

Run `scripts/export-session.sh` to copy this build's Claude Code session JSONL into
`submission/session-trace.jsonl`, which is gitignored. Attach it to the email rather than committing
the full trace to a public repo. The native files live at
`~/.claude/projects/-Users-aktanazat/<session-uuid>.jsonl`.

## Video walkthrough

See `demo/NARRATION.md` for the spoken script. The arc, in ~3-5 min:

1. **Open on the live solve** (`demo/live-solve.gif`) — Gemini 2.5 Flash driving the real loop end
   to end on a failing test. This is the headline: a real model, not the mock.
2. **The full machinery** (`demo/agent-demo.gif`) — the harder repo under the deterministic provider
   so it's reproducible: 20+ calls, an isolated subagent, a mid-run compaction, acceptance gate.
3. **Walk the substance** — `src/agent/loop.ts` (the one loop) and `src/subagent/spawn.ts` (the
   isolation boundary), then a divergence moment: the mock said everything passed, but the real
   endpoint rejected dotted tool names and OpenAPI-form schemas, forcing a provider-boundary fix.

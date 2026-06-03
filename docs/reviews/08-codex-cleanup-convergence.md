# Codex cleanup convergence (gpt-5.5, xhigh)

Final adversarial pass after the deslop/consolidation work. Codex grilled the cleaned tree;
every HIGH/MED finding below was fixed in the same session, then re-verified.

## Findings → fixes

| Sev | Finding | Fix |
|-----|---------|-----|
| HIGH | `git.commit_all` runs `git add -A` — can stage unrelated edits | Marked `risk: "high"` so the permission policy gates it |
| MED | `git.stash` ignored non-zero exits — a `stash pop` conflict looked successful | `ensureOk(res)` before returning |
| MED | `anthropic` mapped `toolChoice: none` to `auto`, breaking the contract | Map to the SDK's real `{type:"none"}` |
| MED | `openai` silently coerced malformed tool-call JSON to `{}` | Throw a retryable `ModelError` (re-prompts via `withRetry`) |
| MED | `fs.glob` bypassed `ProjectIndex` — discovery wasn't one path in truth | Route through `projectIndex.relFiles()` when bound, else `walkFiles` |
| LOW | `ToolSpec` defined in `tools/registry` but consumed by `llm` (wrong layer) | Moved to `llm/provider`; registry re-exports it |
| LOW | `assertCliOk` dropped stdout, losing diagnostics for stdout-reporting CLIs | Fall back to stdout |
| LOW | `relFiles` / `IGNORED_DIRS` dead/over-exported | `relFiles` now used by `fs.glob`; `IGNORED_DIRS` un-exported |
| LOW | Submission-defense comments | Trimmed in `retrieval`, `gate`, `gh`, `openai`, `code` |

The `openai` single-tool forcing (`tool_choice: auto` downgrade) and the drifted doc counts
(60→61 tools, 51→69 tests, 4/4→5/5 eval) were fixed earlier in the same pass.

## Verification

- `npm run typecheck` · `npm run lint` · `npx vitest run` (69 tests) · `npx tsx src/eval/cli.ts` (5/5) — all green.
- `fs.glob` proven by direct call: index-bound and walk-bound paths return identical, correct,
  pattern-matched results; `limit` honored (`limit=3` → 3 files, `truncated:true`).
- `openai` malformed-JSON throw confirmed to land inside the `withRetry` callback with `retryable:true`.

A second independent codex convergence pass was attempted but blocked by an expired codex auth
token; the checklist above was closed by hand instead.

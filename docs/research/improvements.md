# Research-grounded improvements

Two independent passes (a deep-research web survey and a Codex xhigh code-grounded review)
converged on the same first build: **retrieval-gate the tool registry**. Raw outputs in
`deep-research-raw.txt` and `codex-improvement-grill.txt`.

## Ranked shortlist (benefit / effort, no fine-tuning)

| # | Technique | Papers | Maps onto | Effort | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | **Tool retrieval over the registry** | RAG-MCP (2505.03275), ToolLLM (2307.16789), Gorilla (2305.15334), ToolRet (2503.01763) | `registry.toolSpecs()` sends all 60 schemas every call (`loop.ts`). Add a selector that advertises a relevant subset per turn. | M | **Build first.** RAG-MCP reports >50% prompt-token cut and ~3x selection accuracy (43% vs 14%). Directly fixes the token wall hit on a free provider tier. |
| 2 | Gate-failure CRITIC / Reflexion memo | Reflexion (2303.11366), CRITIC (2305.11738), Self-Debugging (2304.05128) | On a failed gate / repeated tool error, write a concise lesson into the ledger + mission log. Run only after real feedback, never every turn. | S/M | Worth it. Reflexion: 91% pass@1 HumanEval, no fine-tuning. |
| 3 | Agentless localization → repair → validate | Agentless (2407.01489), SWE-agent ACI (2405.15793) | A stronger default chain `run_tests → localize → read_many → edit → run_tests`; richer `code.*` (import graph, range reads). | M | Good. Complements the model-driven loop. |
| 4 | Query-aware compaction | LLMLingua (2310.05736) | Upgrade `defaultSummarizer` to keep failing-test output, edited files, current plan, latest gate feedback; drop low-value tokens. | M | Good for long runs; no heavy dependency. |
| 5 | ADaPT adaptive decomposition | ADaPT (2311.05772) | Suggest `agent.spawn` only when gate/tool failure repeats, not always. | S/M | Good. Avoids always-on multi-agent token burn. |

## Deliberately NOT building (cargo-cult for a verifier-gated coding agent)

- **ToT / LATS full tree search** — many extra calls; the acceptance gate already provides the
  external signal that search would chase. Narrow read-only branch search at most.
- **Self-Refine as a completion gate** — ungrounded self-talk is unreliable; the runtime gate is
  the real verifier.
- **LLM-as-judge as pass/fail** — biased; fine as review comments, not as the gate.
- **Toolformer / fine-tuned tool use** — training-based; out of scope (inference-only).
- **Embedding tool retrieval as the only retriever** — ToolRet shows off-the-shelf embedders are
  weak at tool retrieval (best nDCG@10 ~34), which is why #1 starts lexical/BM25, not embeddings.

## What I implemented from this

**#1, tool retrieval** (`src/tools/retrieval.ts`): a lexical BM25 selector that, each turn, scores
tools against a rolling query (goal + active plan step + recent tool names) over each tool's
name/namespace/description/input-property/effect, and advertises the top-K plus an always-visible
control set (`plan.*`, `agent.*`) and the model's recently-used tools. A new `agent.find_tools`
tool lets the model pull in anything the selector missed. Applies only when the registry is large
(subagents keep their full small scoped set). See the eval check that the advertised schemas stay
under a token budget while the tools needed to fix the bug remain discoverable.

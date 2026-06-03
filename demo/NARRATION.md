# Narration script — maestro walkthrough (~3.5 min)

Two clips, two acts. Play `demo/agent-demo.mp4` first (the agent working), then
`demo/maestro-demo.mp4` (the code tour). Pause when you need a beat to land — both clips are
short, the narration is the spine. Read at a natural pace and it runs about 3.5 minutes.

---

## Act 1 — watch it work  ·  over `agent-demo.mp4`

**[open]**
This is maestro, an autonomous software-engineering agent I built from scratch. I'm going to
give it a repository where the tests are failing, and a one-line goal, and just watch it work.
The loop, the tool registry, the subagent, the compaction — all real, running step by step. This
clip is driven by a deterministic provider so it replays identically; the live-model proof (Gemini
2.5 Flash solving a real bug) is the GIF at the top of the README.

**[the plan appears]**
First thing it does is decompose the goal into a thirteen-step plan. That plan isn't decoration.
It lives in a durable ledger that gets re-injected into the model's context on every single turn,
which is what lets it stay coherent over a long run.

**[the tool stream]**
Now it executes. It orients itself in the repo, then runs the test suite and sees two failures.
Watch this line: `localize_failure` consumes the *structured output* of `run_tests` directly.
That's real composition — one tool eating another tool's typed result, not the model re-deriving
it from text.

**[the subagent]**
Here's the part I'm proudest of. It spawns a subagent to audit the buggy module. That child runs
in a completely isolated context, with only the tools it was granted, and returns a
schema-validated result — those two findings. The parent never sees the child's transcript, only
the structured answer.

**[the compaction]**
And right here, mid-run, the context got too big and the agent compacted it — folded thirty-one
stale messages into a summary. The transcript is lossy on purpose; the plan and the facts survive.
It doesn't lose its place.

**[the fix and close]**
Then it patches both bugs, re-runs the suite to *verify* green rather than assume it, and commits.
One subagent, one compaction, plan coherent the whole way. And under it: sixty-plus tools, retries
with backoff, rate limits, typed errors, a full passing test suite.

## Act 2 — how it's built  ·  over `maestro-demo.mp4`

**[the subagent code]** *(pause here)*
Quickly, the substance. The subagent is not a function I relabelled. It's the *same* agent loop,
given a registry subset scoped to its granted tools, its own isolated context, and a completion
tool whose schema is the return contract. The child literally can't call a tool it wasn't
granted — it isn't in its map. Isolation is structural.

**[the dispatch code]** *(pause here)*
And there's no giant switch over sixty tools. Every call goes through one path: validate the
input, run the permission policy, dispatch, validate the output.

**[the divergence]**
Last thing — the moment the model and I diverged. Everything passed against my mock provider.
Then I ran it against the live Anthropic API for the first time, and it returned a 400. Two real
bugs the mock could never catch: the API rejects tool names with dots, and my schema generator
emitted a field it doesn't accept. I fixed both at the provider boundary. A green mock is not a
green endpoint. That's maestro.

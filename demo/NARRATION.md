# Narration script — maestro walkthrough

Read this over `demo/maestro-demo.mp4`. At a natural pace it runs ~3.5 minutes, which fits the
3-5 minute ask. Pause the video on the code frames (the `bat` sections) while you talk through
them; the cast holds each one for ~8 seconds, but you can stop and linger. Timestamps are
approximate.

---

**[0:00 — title]**
This is maestro. It's an autonomous software-engineering agent I built from scratch. You point
it at a repository and give it a goal in plain language, like "the tests are failing, fix them,"
and it plans, edits the code, runs the tests, and iterates until the goal is actually verified.
The model drives every decision. Everything around it is the structure that keeps a long,
autonomous run correct.

**[0:05 — the registry]**
First property: tools. There are sixty of them across eight namespaces. The model selects which
tool to call through the Anthropic tool-use API. The important part is that they stay coherent at
sixty: every tool is a self-describing value with a zod schema, and there's a single dispatch
path. There is no giant switch statement that grows with each tool.

**[0:15 — composable I/O]**
Tools compose. `shell.run_tests` emits a structured result, and `code.localize_failure` declares
that exact same type as its input and ranks the likely-broken files. So the failure data flows
from one tool into the next, and that connection is a compile-time type, not a convention.

**[0:25 — the eval works]**
Here's the agent actually working. The eval harness drops a fixture repo with seeded bugs into a
real temporary git repo, runs the full agent, then runs the repo's own test suite to confirm the
bugs are gone. Four tasks across three fixtures, all green, with no network.

**[0:35 — long-horizon]**
This one task is a twenty-seven tool-call session. The agent plans, delegates a piece of the work
to a subagent, and survives context compaction in the middle of the run without losing the plan.
The second line is the same task under a deliberately tiny context budget that forces compaction,
proving the plan holds.

**[0:45 — code: the subagent]** *(pause here)*
This is the most substantive part. The subagent is not a function I relabelled. It's the same
agent loop, given a registry subset scoped to only the tools it's granted, its own isolated
context and budget, and a completion tool whose schema is the structured contract it returns to
the parent. The child can't call a tool outside its grant, because that tool literally isn't in
its map. Isolation is structural, not a checklist.

**[0:55 — code: dispatch]** *(pause here)*
And this is that single dispatch path. Every one of the sixty tools goes through here: validate
the input against its schema, run the permission policy, run the handler, validate the output.
One code path, no per-tool branching.

**[1:05 — code: compaction]** *(pause here)*
This is the long-horizon mechanism. The plan ledger gets re-rendered into the system prompt on
every model call, so when compaction summarizes away the old tool output to save tokens, the plan
and the established facts survive. The lossy part is the transcript; the durable part is the
ledger.

**[1:15 — divergence]**
And here's the moment the model and I diverged. I'd built everything against a deterministic mock
provider, and every test passed. Then I ran it against the live Anthropic API for the first time,
and it returned a 400. Two real bugs the mock could never catch: the API rejects tool names with
dots, and the schema generator was emitting an OpenAPI-form field the API doesn't accept. I fixed
both at the provider boundary. The lesson: a green mock is not a green endpoint.

**[1:25 — tested, close]**
The whole thing is fifty-one unit and integration tests, typecheck and lint clean, with an eval
harness and a CI pipeline. It's built to deploy, not to sit in a notebook. That's maestro.

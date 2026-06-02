# Notes for X-ARC

I read CCX before finishing this. maestro is my own, smaller take on the same problem CCX
addresses: the engineering layer above a frontier model that closes its scope limits. This page
is the honest map of where the two line up, where I chose a different path on purpose, and what I
did not get to.

## Where maestro converges with CCX

I built to the brief independently and landed on the same primitives, which I take as a good sign
the problem pushes everyone toward them:

- **Durable state that survives crashes and compaction.** CCX has the mission log; maestro has an
  append-only mission log (`src/agent/mission-log.ts`) that checkpoints the ledger snapshot plus
  the message window after every tool. `maestro resume <id>` rebuilds a killed run in a fresh
  process from the last checkpoint and finishes it. Proven two ways: an in-process eval (abort at
  tool 14, resume, finish green, continues from the checkpoint rather than re-planning), and a test
  that spawns a **separate OS process** which resumes from the on-disk log alone
  (`tests/integration/resume-process.test.ts`). Semantics are honest at-least-once: resume restarts
  from the last complete checkpoint, and `restore()` repairs any tool_use a crash left unanswered,
  so tools should be (and are) replay-safe: `fs.edit` errors if its `oldString` is gone,
  `git.commit_all` errors on nothing-to-commit. Exactly-once across a crash would need 2-phase
  commit, which I did not claim.
- **Acceptance as a verifier, not a prompt.** CCX has the 8-point gate; maestro has an acceptance
  gate (`src/agent/gate.ts`) the loop runs itself before it will accept "done": tests pass, build
  passes, the tree is committed, the plan is closed. A red gate is fed back and the run continues.
  Completion is a fact the runtime checks, not a claim the model makes.
- **Durable working memory across compaction.** The plan ledger is re-rendered into the system
  prompt every call, so it outlives the compaction that summarizes raw tool output away.
- **A real isolation boundary for sub-work.** `agent.spawn` runs the same loop with a registry
  subset and a schema-validated return; the child cannot call a tool it was not granted.
- **A budget meter and a permission policy** on the external boundary, in the spirit of CCX's
  enclosures (`src/resilience/ratelimit.ts`, the registry permission gate).

## What I deliberately did NOT copy

- **The full RPTIV five-agent split.** maestro's subagent is generic and real; renaming it into
  ResearchAgent/PlanAgent/… without different behavior would be cosplay. I kept one honest
  subagent primitive and a plan/act/verify loop instead of five named phases.
- **The Manager/Worker process split.** It is the right shape at CCX's scale; at this size it would
  be architecture for its own sake. I noted it as the next step rather than half-building it.
- **A small-model message-screening enclosure.** I did not stub a fake one. The budget meter and
  permission policy are real; the message screen is honestly absent.
- **Visual verification in the gate** for non-UI fixtures: marked not-applicable rather than faked.

## What is honestly smaller / unfinished

- **No completed live-model run.** The Anthropic path is wired and verified to the point the API
  accepts the request (I drove it with a Claude Code OAuth token and fixed two real wire-format
  bugs the mock never caught: dotted tool names, draft-2020-12 schemas. The actual API responses
  are in `docs/reviews/live-integration-evidence.md`, a 400→400→429 progression). A full autonomous
  run was blocked by the subscription's burst rate limit; a pay-per-token key removes it
  (`npm run eval -- --real`). So the deterministic eval proves runtime **invariants** (gate, resume,
  compaction, composition), and the evidence proves the **live wire**; the one thing not captured is
  a full autonomous run on the real model. I did not oversell that.
- **One domain, scripted solver.** The eval drives the real loop/registry/subagent/gate/mission-log
  through a deterministic mock provider. That is strong proof of the machinery, weak proof of model
  autonomy. A held-out, multi-domain, real-model benchmark is the next thing I would build.
- **No Manager/Worker, no crash-recovery supervisor** that restarts a stuck worker. Resume is
  manual (`maestro resume`), not automatic.

## How it was built

I built this by directing Claude Code, making the architecture and convergence calls myself,
including running Codex as an adversarial reviewer (`/grill-me`) across the plan, the code, and
this X-ARC-specific pass; the reviews and how they changed the build are in `docs/reviews/`. Given
that X-ARC staffs its own lab with agents, I figured the honest thing was to show the orchestration
rather than hide it.

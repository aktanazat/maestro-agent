import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionLog } from "../../src/agent/mission-log.js";
import { Ledger } from "../../src/agent/ledger.js";
import { ConversationContext, repairToolPairing } from "../../src/agent/context.js";
import { MockProvider, say } from "../../src/llm/mock.js";
import type { ModelMessage } from "../../src/llm/provider.js";

let dir: string;
let clock = 1000;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "maestro-mlog-"));
  clock = 1000;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function log(id = "m1") {
  return new MissionLog({ missionId: id, dir, now: () => ++clock });
}

describe("MissionLog", () => {
  it("appends events and reads them back in order", () => {
    const l = log();
    l.append({ kind: "start", missionId: "m1", goal: "fix it" });
    l.append({ kind: "tool", step: 1, name: "fs.read", ok: true });
    l.append({ kind: "end", status: "completed", steps: 1 });
    const events = MissionLog.read(l.path);
    expect(events.map((e) => e.kind)).toEqual(["start", "tool", "end"]);
    expect(MissionLog.goalOf(l.path)).toBe("fix it");
  });

  it("returns the most recent checkpoint", () => {
    const l = log();
    const led = new Ledger("g");
    led.setPlan(["a", "b"]);
    l.append({ kind: "checkpoint", step: 2, ledger: led.snapshot(), messages: [], compactions: 0 });
    led.updatePlan(1, "done");
    l.append({ kind: "checkpoint", step: 4, ledger: led.snapshot(), messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], compactions: 1 });
    const cp = MissionLog.lastCheckpoint(l.path)!;
    expect(cp.step).toBe(4);
    expect(cp.compactions).toBe(1);
    expect(cp.ledger.plan[0]!.status).toBe("done");
    expect(cp.messages).toHaveLength(1);
  });

  it("tolerates a half-written trailing line from a hard kill mid-write", () => {
    const l = log();
    l.append({ kind: "start", missionId: "m1", goal: "g" });
    l.append({ kind: "checkpoint", step: 1, ledger: new Ledger("g").snapshot(), messages: [], compactions: 0 });
    appendFileSync(l.path, '{"kind":"checkpoint","step":2,"ledger":{ partial'); // truncated write
    const events = MissionLog.read(l.path);
    expect(events.map((e) => e.kind)).toEqual(["start", "checkpoint"]); // partial line ignored
    expect(MissionLog.lastCheckpoint(l.path)!.step).toBe(1);
  });
});

describe("Ledger.fromSnapshot", () => {
  it("round-trips plan, facts, digests, and keeps id allocation monotonic", () => {
    const l = new Ledger("goal");
    l.setPlan(["one", "two"]);
    l.updatePlan(2, "done", "fixed");
    l.addFact("root cause", "off-by-one");
    l.noteFile("src/x.ts", "buggy");
    const restored = Ledger.fromSnapshot(l.snapshot());
    expect(restored.getPlan()).toHaveLength(2);
    expect(restored.getPlan()[1]).toMatchObject({ status: "done", note: "fixed" });
    expect(restored.getFacts()[0]).toEqual({ key: "root cause", value: "off-by-one" });
    // Next id must not collide with restored ids.
    const added = restored.addPlanItem("three");
    expect(added.id).toBe(3);
  });
});

describe("repairToolPairing (crash mid-batch)", () => {
  const ids = (msgs: ModelMessage[]) =>
    msgs.flatMap((m) => m.content).filter((b) => b.type === "tool_result").map((b) => (b as { tool_use_id: string }).tool_use_id);

  it("backfills tool_uses left unanswered by a crash so the resumed stream is API-valid", () => {
    const msgs: ModelMessage[] = [
      { role: "assistant", content: [
        { type: "tool_use", id: "a", name: "fs.read", input: {} },
        { type: "tool_use", id: "b", name: "fs.edit", input: {} },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] }, // only "a" answered
    ];
    const repaired = repairToolPairing(msgs);
    expect(new Set(ids(repaired))).toEqual(new Set(["a", "b"])); // "b" backfilled
    const bResult = repaired[1]!.content.find((c) => c.type === "tool_result" && c.tool_use_id === "b");
    expect((bResult as { is_error?: boolean }).is_error).toBe(true);
  });

  it("appends a results message when the crash left the assistant turn with no answers at all", () => {
    const msgs: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "x", name: "shell.run", input: {} }] },
    ];
    const repaired = repairToolPairing(msgs);
    expect(repaired).toHaveLength(2);
    expect(ids(repaired)).toEqual(["x"]);
  });

  it("is a no-op when every tool_use is already answered", () => {
    const msgs: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "fs.read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] },
    ];
    expect(repairToolPairing(msgs)).toHaveLength(2);
    expect(ids(repairToolPairing(msgs))).toEqual(["a"]);
  });
});

describe("ConversationContext.restore", () => {
  it("restores the message window and compaction count for resume", () => {
    const ctx = new ConversationContext({ system: "S", ledger: new Ledger("g"), provider: new MockProvider([say("x")]) });
    ctx.restore([{ role: "user", content: [{ type: "text", text: "earlier" }] }], 2);
    expect(ctx.view()).toHaveLength(1);
    expect(ctx.stats().compactions).toBe(2);
  });
});

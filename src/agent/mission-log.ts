import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelMessage } from "../llm/provider.js";
import type { LedgerSnapshot } from "./ledger.js";
import type { GateResult } from "./gate.js";

/**
 * The durable mission log. This is the authoritative record a run can be RESUMED from after a
 * crash — not the trace (which is evidence). It is append-only JSONL: each line is one event, and
 * a `checkpoint` event carries the full ledger snapshot plus the message window, which together
 * are everything needed to rebuild the run's state in a fresh process. The ledger is the durable
 * half (plan + facts), the messages are the lossy half; persisting both makes resume exact.
 *
 * Append-only matters: a half-written final line is simply ignored on read, so a hard kill mid-run
 * still leaves a readable log up to the last complete checkpoint.
 */
export type MissionEvent =
  | { kind: "start"; missionId: string; goal: string; ts: number }
  | { kind: "checkpoint"; step: number; ledger: LedgerSnapshot; messages: ModelMessage[]; compactions: number; ts: number }
  | { kind: "tool"; step: number; name: string; ok: boolean; ts: number }
  | { kind: "gate"; passed: boolean; result: GateResult; ts: number }
  | { kind: "end"; status: string; steps: number; ts: number };

/** Omit applied across each union member, so per-variant fields survive. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface Checkpoint {
  step: number;
  ledger: LedgerSnapshot;
  messages: ModelMessage[];
  compactions: number;
}

export class MissionLog {
  readonly missionId: string;
  readonly path: string;

  constructor(opts: { missionId: string; dir: string; now: () => number }) {
    this.missionId = opts.missionId;
    this.path = join(opts.dir, `${opts.missionId}.jsonl`);
    this.now = opts.now;
    mkdirSync(dirname(this.path), { recursive: true });
  }

  private readonly now: () => number;

  append(event: DistributiveOmit<MissionEvent, "ts">): void {
    const line = JSON.stringify({ ...event, ts: this.now() }) + "\n";
    appendFileSync(this.path, line);
  }

  /** All complete events; a trailing partial line (hard kill mid-write) is skipped. */
  static read(path: string): MissionEvent[] {
    if (!existsSync(path)) return [];
    const out: MissionEvent[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as MissionEvent);
      } catch {
        break; // partial trailing line from an interrupted write — stop here.
      }
    }
    return out;
  }

  /** The most recent checkpoint — the state a resume starts from. */
  static lastCheckpoint(path: string): Checkpoint | null {
    let cp: Checkpoint | null = null;
    for (const ev of MissionLog.read(path)) {
      if (ev.kind === "checkpoint") cp = { step: ev.step, ledger: ev.ledger, messages: ev.messages, compactions: ev.compactions };
    }
    return cp;
  }

  static goalOf(path: string): string | null {
    for (const ev of MissionLog.read(path)) if (ev.kind === "start") return ev.goal;
    return null;
  }

  static resolvePath(dir: string, missionId: string): string {
    return join(dir, `${missionId}.jsonl`);
  }

  static list(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""));
  }
}

/**
 * The Ledger is the agent's durable working memory. It is the answer to "20+ tool calls
 * without losing plan coherence": everything here is re-rendered into the system prompt on
 * EVERY model call, so it survives context compaction that drops raw tool output. The
 * rolling message window is lossy by design; the ledger is not.
 *
 * Three sections:
 *  - plan:        the task decomposition, with per-step status. Mutated by `plan.*` tools.
 *  - facts:       durable conclusions ("root cause is X", "tests live in Y"). Append-mostly.
 *  - fileDigests: one-line notes per file the agent has inspected, so it need not re-read.
 */

export type PlanStatus = "pending" | "active" | "done" | "blocked";

export interface PlanItem {
  id: number;
  text: string;
  status: PlanStatus;
  note?: string;
}

export interface Fact {
  key: string;
  value: string;
}

export class Ledger {
  goal: string;
  private plan: PlanItem[] = [];
  private facts: Fact[] = [];
  private fileDigests = new Map<string, string>();
  private nextId = 1;

  constructor(goal: string) {
    this.goal = goal;
  }

  addPlanItem(text: string, status: PlanStatus = "pending"): PlanItem {
    const item: PlanItem = { id: this.nextId++, text, status };
    this.plan.push(item);
    return item;
  }

  setPlan(texts: string[]): PlanItem[] {
    this.plan = [];
    this.nextId = 1;
    return texts.map((t) => this.addPlanItem(t));
  }

  updatePlan(id: number, status: PlanStatus, note?: string): PlanItem {
    const item = this.plan.find((p) => p.id === id);
    if (!item) throw new Error(`no plan item ${id}`);
    item.status = status;
    if (note !== undefined) item.note = note;
    return item;
  }

  getPlan(): readonly PlanItem[] {
    return this.plan;
  }

  /** True once every plan item is terminal (done or blocked). */
  planComplete(): boolean {
    return this.plan.length > 0 && this.plan.every((p) => p.status === "done" || p.status === "blocked");
  }

  addFact(key: string, value: string): void {
    const existing = this.facts.find((f) => f.key === key);
    if (existing) existing.value = value;
    else this.facts.push({ key, value });
  }

  getFacts(): readonly Fact[] {
    return this.facts;
  }

  noteFile(path: string, digest: string): void {
    this.fileDigests.set(path, digest);
  }

  getFileDigests(): ReadonlyMap<string, string> {
    return this.fileDigests;
  }

  /** Compact text rendering injected into the system prompt every model call. */
  render(): string {
    const lines: string[] = [];
    lines.push(`## Mission`);
    lines.push(this.goal.trim());
    if (this.plan.length) {
      lines.push("", "## Plan");
      for (const p of this.plan) {
        lines.push(`${statusGlyph(p.status)} [${p.id}] ${p.text}${p.note ? ` — ${p.note}` : ""}`);
      }
    }
    if (this.facts.length) {
      lines.push("", "## Established facts");
      for (const f of this.facts) lines.push(`- ${f.key}: ${f.value}`);
    }
    if (this.fileDigests.size) {
      lines.push("", "## Files inspected");
      for (const [path, digest] of this.fileDigests) lines.push(`- ${path}: ${digest}`);
    }
    return lines.join("\n");
  }

  snapshot(): LedgerSnapshot {
    return {
      goal: this.goal,
      plan: this.plan.map((p) => ({ ...p })),
      facts: this.facts.map((f) => ({ ...f })),
      fileDigests: Object.fromEntries(this.fileDigests),
    };
  }

  /** Rebuild a ledger from a snapshot — the durable half of crash-resumable execution. */
  static fromSnapshot(snap: LedgerSnapshot): Ledger {
    const l = new Ledger(snap.goal);
    l.plan = snap.plan.map((p) => ({ ...p }));
    l.facts = snap.facts.map((f) => ({ ...f }));
    l.fileDigests = new Map(Object.entries(snap.fileDigests));
    l.nextId = l.plan.reduce((m, p) => Math.max(m, p.id), 0) + 1;
    return l;
  }
}

export interface LedgerSnapshot {
  goal: string;
  plan: PlanItem[];
  facts: Fact[];
  fileDigests: Record<string, string>;
}

function statusGlyph(s: PlanStatus): string {
  return { pending: "[ ]", active: "[~]", done: "[x]", blocked: "[!]" }[s];
}

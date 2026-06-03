import type { ToolRegistry, ToolSpec } from "./registry.js";

/**
 * Retrieval-gating over the registry. Advertising all 60 tool schemas every model call is costly
 * and hits token limits on smaller providers, so this selects a relevant subset per turn. Scoring
 * is lexical BM25 over each tool's name, namespace, description, input field names, and effect — no
 * embedding dependency, deterministic, fast.
 *
 * The model is never trapped: a control set (`plan.*`, `agent.*`) is always visible, recently-used
 * and explicitly-pinned tools stay visible, and `agent.find_tools` lets the model pull in anything
 * the selector missed.
 */
const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "by", "is", "are", "be",
  "this", "that", "it", "as", "at", "from", "into", "use", "using", "via", "if", "then", "so",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

interface Doc {
  name: string;
  terms: string[];
  tf: Map<string, number>;
  len: number;
}

export interface SelectOptions {
  /** Tool names always advertised regardless of score (the agent's control plane). */
  alwaysInclude?: string[];
  /** Recently-used tool names to keep visible (the working set). */
  recent?: string[];
  /** Tools the model explicitly pinned via agent.find_tools. */
  pinned?: Iterable<string>;
  /** How many score-ranked tools to add on top of the always/recent/pinned sets. */
  topK?: number;
  /** Hard cap on the advertised set. */
  maxTotal?: number;
}

export class ToolRetriever {
  private readonly docs: Doc[] = [];
  private readonly df = new Map<string, number>();
  private readonly avgdl: number;
  private readonly n: number;
  private static readonly k1 = 1.5;
  private static readonly b = 0.75;

  constructor(private readonly registry: ToolRegistry) {
    for (const spec of registry.toolSpecs()) {
      const tool = registry.get(spec.name);
      const props = Object.keys((spec.input_schema.properties as Record<string, unknown>) ?? {});
      const text = `${spec.name.replace(/\./g, " ")} ${tool.namespace} ${spec.description} ${props.join(" ")} ${tool.effect}`;
      const terms = tokenize(text);
      const tf = new Map<string, number>();
      for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of new Set(terms)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ name: spec.name, terms, tf, len: terms.length });
    }
    this.n = this.docs.length;
    this.avgdl = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.n);
  }

  private idf(term: string): number {
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
  }

  private score(queryTerms: string[], doc: Doc): number {
    let s = 0;
    for (const q of queryTerms) {
      const tf = doc.tf.get(q);
      if (!tf) continue;
      const idf = this.idf(q);
      s += idf * ((tf * (ToolRetriever.k1 + 1)) / (tf + ToolRetriever.k1 * (1 - ToolRetriever.b + ToolRetriever.b * (doc.len / this.avgdl))));
    }
    return s;
  }

  /** Rank all tools against a query; returns [{name, score}] descending. */
  rank(query: string): Array<{ name: string; score: number }> {
    const qterms = tokenize(query);
    return this.docs
      .map((d) => ({ name: d.name, score: this.score(qterms, d) }))
      .sort((a, b) => b.score - a.score);
  }

  /** For agent.find_tools: top-`limit` matches as {name, description}. */
  find(query: string, limit = 8): Array<{ name: string; description: string }> {
    return this.rank(query)
      .filter((r) => r.score > 0)
      .slice(0, limit)
      .map((r) => ({ name: r.name, description: this.registry.get(r.name).description }));
  }

  /** The advertised tool subset for a turn: control plane + recent + pinned + top score-ranked. */
  selectSpecs(query: string, opts: SelectOptions = {}): ToolSpec[] {
    const names = new Set<string>();
    const add = (n: string) => {
      if (this.registry.has(n)) names.add(n);
    };
    for (const n of opts.alwaysInclude ?? []) add(n);
    for (const n of opts.pinned ?? []) add(n);
    for (const n of (opts.recent ?? []).slice(-5)) add(n);

    const maxTotal = opts.maxTotal ?? 24;
    const ranked = this.rank(query).filter((r) => r.score > 0);
    for (const r of ranked.slice(0, opts.topK ?? 16)) {
      if (names.size >= maxTotal) break;
      add(r.name);
    }
    const order = new Map(this.registry.toolSpecs().map((s, i) => [s.name, i]));
    return this.registry
      .subset([...names])
      .toolSpecs()
      .sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
  }
}

/** The always-visible control plane: plan memory + tool discovery + delegation. */
const CONTROL_PLANE = [
  "plan.set",
  "plan.update",
  "plan.note_fact",
  "plan.status",
  "agent.list_tools",
  "agent.find_tools",
  "agent.spawn",
];

/**
 * Core coding tools kept always-visible for the software-engineering domain. Lexical retrieval
 * misses tools whose descriptions don't share vocabulary with the goal (e.g. `fs.edit` says
 * "replace a substring", not "fix"), so the bread-and-butter read/edit/test/commit path is pinned.
 * The long tail (github, web, blame, lint, stash, …) is what retrieval and `agent.find_tools`
 * surface on demand.
 */
const CODING_ESSENTIALS = [
  "fs.read",
  "fs.write",
  "fs.edit",
  "fs.list",
  "fs.read_many",
  "code.grep",
  "shell.run_tests",
  "git.status",
  "git.diff",
  "git.add",
  "git.commit_all",
];

/** Default always-advertised set for a coding agent: control plane + coding essentials. */
export const DEFAULT_ADVERTISE = [...CONTROL_PLANE, ...CODING_ESSENTIALS];

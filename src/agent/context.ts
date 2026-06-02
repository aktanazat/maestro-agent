import type { ContentBlock, ModelMessage, ModelProvider } from "../llm/provider.js";
import { estimateMessageTokens } from "../llm/provider.js";
import { Ledger } from "./ledger.js";
import type { Logger } from "../obs/logger.js";

/**
 * A summarizer compresses a slice of stale messages into a single recap string.
 * Pluggable so tests use a deterministic fold and production can use a cheap model
 * call. Either way the compaction POLICY (what to drop, when, what to keep) lives
 * here in code, not implicitly in prompt instructions.
 */
export type Summarizer = (messages: ModelMessage[]) => Promise<string> | string;

export interface ContextOptions {
  system: string;
  ledger: Ledger;
  provider: ModelProvider;
  /** Hard ceiling we budget against (model context minus headroom for the reply). */
  maxContextTokens?: number;
  /** Fraction of maxContextTokens that triggers compaction. */
  compactionThreshold?: number;
  /** Always keep this many of the most recent messages verbatim. */
  recencyKeep?: number;
  summarizer?: Summarizer;
  logger?: Logger;
}

export interface ContextStats {
  messages: number;
  estimatedTokens: number;
  compactions: number;
  budget: number;
}

/**
 * Owns the conversation window and the compaction strategy. The system prompt the model
 * sees is `base + ledger.render()` rebuilt every call, so plan/facts persist even as raw
 * tool output is summarized away. Compaction folds the OLDEST messages (outside the
 * recency window) into one synthetic user note, preserving token budget over a long run.
 */
export class ConversationContext {
  private readonly base: string;
  readonly ledger: Ledger;
  private readonly provider: ModelProvider;
  private readonly maxContextTokens: number;
  private readonly compactionThreshold: number;
  private readonly recencyKeep: number;
  private readonly summarizer: Summarizer;
  private readonly logger?: Logger;

  private messages: ModelMessage[] = [];
  private compactions = 0;

  constructor(opts: ContextOptions) {
    this.base = opts.system;
    this.ledger = opts.ledger;
    this.provider = opts.provider;
    this.maxContextTokens = opts.maxContextTokens ?? 150_000;
    this.compactionThreshold = opts.compactionThreshold ?? 0.7;
    this.recencyKeep = opts.recencyKeep ?? 8;
    this.summarizer = opts.summarizer ?? defaultSummarizer;
    this.logger = opts.logger;
  }

  /** System prompt = static base + live ledger. Rebuilt each turn so it never goes stale. */
  systemPrompt(): string {
    return `${this.base}\n\n# Working memory (durable across context compaction)\n${this.ledger.render()}`;
  }

  pushUser(blocks: ContentBlock[]): void {
    this.messages.push({ role: "user", content: blocks });
  }

  pushAssistant(blocks: ContentBlock[]): void {
    this.messages.push({ role: "assistant", content: blocks });
  }

  /** Tool results are user-role blocks per the content protocol. */
  pushToolResults(blocks: ContentBlock[]): void {
    if (blocks.length) this.messages.push({ role: "user", content: blocks });
  }

  view(): ModelMessage[] {
    return this.messages;
  }

  estimatedTokens(): number {
    return estimateMessageTokens(this.messages) + this.provider.estimateTokens(this.systemPrompt());
  }

  stats(): ContextStats {
    return {
      messages: this.messages.length,
      estimatedTokens: this.estimatedTokens(),
      compactions: this.compactions,
      budget: this.maxContextTokens,
    };
  }

  /**
   * If the window exceeds the threshold, fold the oldest messages (outside the recency
   * window, and never splitting a tool_use from its tool_result) into one recap. Returns
   * true if a compaction happened. Idempotent below threshold.
   */
  async maybeCompact(): Promise<boolean> {
    const budget = this.maxContextTokens * this.compactionThreshold;
    if (this.estimatedTokens() <= budget) return false;
    if (this.messages.length <= this.recencyKeep + 1) return false;

    let cut = this.messages.length - this.recencyKeep;
    // Don't cut between an assistant tool_use and the following tool_result.
    cut = this.safeCutPoint(cut);
    if (cut <= 0) return false;

    const stale = this.messages.slice(0, cut);
    const recap = await this.summarizer(stale);
    this.compactions += 1;
    this.logger?.info(
      { compactions: this.compactions, dropped: stale.length, tokensBefore: this.estimatedTokens() },
      "compacting context",
    );
    this.messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `[context compacted — ${stale.length} earlier messages summarized below; full plan/facts are in working memory]\n\n${recap}`,
          },
        ],
      },
      ...this.messages.slice(cut),
    ];
    return true;
  }

  /** Walk the cut point earlier until it does not orphan a tool_result from its tool_use. */
  private safeCutPoint(cut: number): number {
    let c = cut;
    while (c > 0 && this.startsWithToolResult(this.messages[c])) c -= 1;
    return c;
  }

  private startsWithToolResult(msg: ModelMessage | undefined): boolean {
    return !!msg && msg.role === "user" && msg.content.some((b) => b.type === "tool_result");
  }
}

/**
 * Deterministic fallback summarizer: lists the tool calls and clips their results.
 * Zero model spend, fully reproducible — used by tests and as a safe default. A
 * model-backed summarizer can be injected for higher-fidelity recaps in production.
 */
export function defaultSummarizer(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text" && b.text.trim()) {
        lines.push(`- ${m.role}: ${clip(b.text, 160)}`);
      } else if (b.type === "tool_use") {
        lines.push(`- called ${b.name}(${clip(JSON.stringify(b.input), 120)})`);
      } else if (b.type === "tool_result") {
        lines.push(`  → ${b.is_error ? "ERROR " : ""}${clip(b.content, 160)}`);
      }
    }
  }
  return lines.join("\n");
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

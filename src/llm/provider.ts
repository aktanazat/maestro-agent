/** Model-facing tool spec: the JSON a provider advertises to the model. */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Provider-agnostic message shape. Modeled on Anthropic's content-block protocol
 * (the richest of the common ones) so the mapping to the real API is lossless, while
 * staying decoupled enough that a deterministic MockProvider can satisfy the same
 * contract for tests and the eval harness — no API key, no spend, fully reproducible.
 */
export type Role = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ModelMessage {
  role: Role;
  content: ContentBlock[];
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  temperature?: number;
  /** Force a tool call, force none, or let the model decide (default). */
  toolChoice?: { type: "auto" } | { type: "any" } | { type: "tool"; name: string } | { type: "none" };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  stopReason: StopReason;
  /** Only output blocks the model can emit: text and tool_use. */
  content: Array<TextBlock | ToolUseBlock>;
  usage: Usage;
  model: string;
}

export interface CompleteOptions {
  signal?: AbortSignal;
  /** Opaque label for tracing which loop/subagent made the call. */
  caller?: string;
}

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  complete(req: ModelRequest, opts?: CompleteOptions): Promise<ModelResponse>;
  /** Cheap token estimate for context budgeting. Need not be exact. */
  estimateTokens(text: string): number;
}

/**
 * Tool names must be dot-free on the wire: both the Anthropic and OpenAI tool APIs require
 * `^[a-zA-Z0-9_-]+$`. The registry keeps dotted `<namespace>.<verb>` names, so providers encode
 * the dot when advertising tools and decode it on the model's tool calls.
 */
export const toApiName = (n: string): string => n.replace(".", "__");
export const fromApiName = (n: string): string => n.replace("__", ".");

/** Rough token estimate (~4 chars/token). Good enough for budget thresholds. */
export function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate tokens for a whole message list — used by the context manager. */
export function estimateMessageTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type === "text") total += estimateTokensFromText(block.text);
      else if (block.type === "tool_use") total += estimateTokensFromText(JSON.stringify(block.input)) + 8;
      else if (block.type === "tool_result") total += estimateTokensFromText(block.content) + 8;
    }
  }
  return total;
}

import { estimateTokensFromText, type CompleteOptions, type ModelMessage, type ModelProvider, type ModelRequest, type ModelResponse, type StopReason, type TextBlock, type ToolUseBlock } from "./provider.js";
import { toApiName, fromApiName } from "./anthropic.js";
import { withRetry, withTimeout } from "../resilience/retry.js";
import { RateLimiter } from "../resilience/ratelimit.js";
import { ModelError, ModelOverloadedError, RateLimitError } from "../resilience/errors.js";
import type { Logger } from "../obs/logger.js";

export interface OpenAICompatibleOptions {
  apiKey?: string;
  /** Endpoint base, e.g. https://api.groq.com/openai/v1 or https://api.openai.com/v1. */
  baseURL?: string;
  model?: string;
  logger?: Logger;
  ratePerSec?: number;
  burst?: number;
  maxRetries?: number;
}

/**
 * A provider for any OpenAI-compatible chat-completions API (Groq, OpenRouter, OpenAI, etc.).
 * It exists to prove maestro is model-agnostic: the loop, registry, gate, and mission log are
 * unchanged — only this adapter differs from the Anthropic one. It maps maestro's content-block
 * messages to the OpenAI tool-calling shape and back, reusing the same dot-free tool-name encoding
 * (`.`→`__`) the Anthropic provider needs, since OpenAI function names also forbid dots.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly limiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly logger?: Logger;

  constructor(opts: OpenAICompatibleOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.GROQ_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    if (!this.apiKey) throw new ModelError("set GROQ_API_KEY or OPENAI_API_KEY (or pass apiKey)", { retryable: false });
    this.baseURL = (opts.baseURL ?? process.env.MAESTRO_OPENAI_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/$/, "");
    this.model = opts.model ?? process.env.MAESTRO_OPENAI_MODEL ?? "llama-3.3-70b-versatile";
    this.name = new URL(this.baseURL).hostname;
    this.limiter = new RateLimiter({ ratePerSec: opts.ratePerSec ?? 2, burst: opts.burst ?? 4, resource: this.name });
    this.maxRetries = opts.maxRetries ?? 5;
    this.logger = opts.logger;
  }

  estimateTokens(text: string): number {
    return estimateTokensFromText(text);
  }

  async complete(req: ModelRequest, opts: CompleteOptions = {}): Promise<ModelResponse> {
    return withRetry(
      async () => {
        await this.limiter.acquire();
        const body = {
          model: this.model,
          max_tokens: req.maxTokens,
          temperature: req.temperature ?? 1,
          messages: mapMessagesOut(req.system, req.messages),
          tools: req.tools.map((t) => ({ type: "function", function: { name: toApiName(t.name), description: t.description, parameters: t.input_schema } })),
          tool_choice: mapToolChoice(req.toolChoice),
        };
        const res = await withTimeout(
          fetch(`${this.baseURL}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify(body),
            signal: opts.signal,
          }),
          120_000,
          "openai.complete",
          opts.signal,
        );
        if (!res.ok) throw await httpError(res);
        return mapResponse((await res.json()) as ChatCompletion);
      },
      { maxAttempts: this.maxRetries, signal: opts.signal, logger: this.logger, baseDelayMs: 600, maxDelayMs: 30_000 },
    );
  }
}

interface ChatCompletion {
  model: string;
  choices: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

function mapToolChoice(choice: ModelRequest["toolChoice"]): string {
  if (!choice || choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  return "auto"; // single-tool forcing is provider-specific; auto is a safe fallback
}

function mapMessagesOut(system: string, messages: ModelMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("");
      const toolCalls = m.content
        .filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: toApiName(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
      const msg: Record<string, unknown> = { role: "assistant", content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      // A user message may carry tool_results (→ separate `tool` messages) and/or text.
      const text = m.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("");
      for (const b of m.content) {
        if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
      }
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}

function mapResponse(cc: ChatCompletion): ModelResponse {
  const choice = cc.choices[0];
  const content: Array<TextBlock | ToolUseBlock> = [];
  if (choice?.message.content) content.push({ type: "text", text: choice.message.content });
  for (const tc of choice?.message.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: tc.id, name: fromApiName(tc.function.name), input });
  }
  return {
    stopReason: mapFinish(choice?.finish_reason),
    content,
    usage: { inputTokens: cc.usage?.prompt_tokens ?? 0, outputTokens: cc.usage?.completion_tokens ?? 0 },
    model: cc.model,
  };
}

function mapFinish(reason: string | undefined): StopReason {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

async function httpError(res: Response): Promise<Error> {
  const body = await res.text().catch(() => "");
  if (res.status === 429) return new RateLimitError(new URL(res.url).hostname);
  if (res.status === 529 || res.status >= 500) return new ModelOverloadedError(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  return new ModelError(`HTTP ${res.status}: ${body.slice(0, 300)}`, { retryable: false, context: { status: res.status } });
}

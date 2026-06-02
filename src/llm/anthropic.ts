import Anthropic from "@anthropic-ai/sdk";
import { estimateTokensFromText } from "./provider.js";
import type {
  CompleteOptions,
  ContentBlock,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StopReason,
  TextBlock,
  ToolUseBlock,
} from "./provider.js";
import { withRetry } from "../resilience/retry.js";
import { RateLimiter } from "../resilience/ratelimit.js";
import { ModelError, ModelOverloadedError, RateLimitError } from "../resilience/errors.js";
import type { Logger } from "../obs/logger.js";

export interface AnthropicProviderOptions {
  apiKey?: string;
  /** OAuth bearer token (e.g. a Claude Code subscription token). Used if no apiKey is given. */
  authToken?: string;
  model?: string;
  maxRetries?: number;
  logger?: Logger;
  /** Sustained requests/sec to the API. Protects against 429s. */
  ratePerSec?: number;
  burst?: number;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

// OAuth (subscription) tokens authenticate as Claude Code: the request must carry the oauth
// beta header and the system prompt must begin with this identity line, or the API rejects it.
const OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

// The Anthropic API restricts tool names to ^[a-zA-Z0-9_-]+$ — no dots. maestro names tools
// `<namespace>.<verb>` for a coherent registry, so we encode the dot on the wire and decode it
// back on the model's tool_use blocks. The registry only ever sees the dotted names.
export const toApiName = (n: string): string => n.replace(".", "__");
export const fromApiName = (n: string): string => n.replace("__", ".");

/**
 * Real provider. Wraps the Anthropic Messages API and is the place where all the
 * resilience primitives converge: a token-bucket limiter guards the endpoint, and
 * every call is wrapped in exponential backoff that distinguishes retryable
 * (overloaded / 429 / 5xx) from terminal (4xx) failures via the typed error layer.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly client: Anthropic;
  private readonly limiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly logger?: Logger;
  private readonly oauth: boolean;

  constructor(opts: AnthropicProviderOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    const authToken = opts.authToken ?? process.env.ANTHROPIC_AUTH_TOKEN;
    if (!apiKey && !authToken) throw new ModelError("set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN", { retryable: false });
    this.model = opts.model ?? process.env.MAESTRO_MODEL ?? DEFAULT_MODEL;
    this.oauth = !apiKey && !!authToken;
    // We own retries (maxRetries: 0). OAuth mode authenticates via Bearer + the oauth beta header.
    this.client = this.oauth
      ? new Anthropic({ authToken, defaultHeaders: { "anthropic-beta": OAUTH_BETA }, maxRetries: 0 })
      : new Anthropic({ apiKey, maxRetries: 0 });
    this.limiter = new RateLimiter({
      ratePerSec: opts.ratePerSec ?? 4,
      burst: opts.burst ?? 8,
      resource: "anthropic",
    });
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
        try {
          const res = await this.client.messages.create(
            {
              model: this.model,
              max_tokens: req.maxTokens,
              temperature: req.temperature ?? 1,
              system: this.oauth ? `${CLAUDE_CODE_IDENTITY}\n\n${req.system}` : req.system,
              tools: req.tools.map((t) => ({
                name: toApiName(t.name),
                description: t.description,
                input_schema: t.input_schema as Anthropic.Tool.InputSchema,
              })),
              tool_choice: mapToolChoice(req.toolChoice),
              messages: req.messages.map(mapMessageOut),
            },
            { signal: opts.signal },
          );
          return mapResponse(res);
        } catch (err) {
          throw mapSdkError(err);
        }
      },
      {
        maxAttempts: this.maxRetries,
        signal: opts.signal,
        logger: this.logger,
        baseDelayMs: 500,
        maxDelayMs: 30_000,
      },
    );
  }
}

function mapToolChoice(choice: ModelRequest["toolChoice"]): Anthropic.MessageCreateParams["tool_choice"] {
  if (!choice || choice.type === "auto") return { type: "auto" };
  if (choice.type === "any") return { type: "any" };
  if (choice.type === "none") return { type: "auto" }; // SDK lacks "none"; emulate by not forcing
  return { type: "tool", name: toApiName(choice.name) };
}

function mapMessageOut(m: ModelMessage): Anthropic.MessageParam {
  return {
    role: m.role,
    content: m.content.map((b): Anthropic.ContentBlockParam => {
      if (b.type === "text") return { type: "text", text: b.text };
      if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: toApiName(b.name), input: b.input as Record<string, unknown> };
      return {
        type: "tool_result",
        tool_use_id: b.tool_use_id,
        content: b.content,
        is_error: b.is_error ?? false,
      };
    }) as Anthropic.ContentBlockParam[],
  };
}

function mapResponse(res: Anthropic.Message): ModelResponse {
  const content: Array<TextBlock | ToolUseBlock> = [];
  for (const block of res.content) {
    if (block.type === "text") content.push({ type: "text", text: block.text });
    else if (block.type === "tool_use") content.push({ type: "tool_use", id: block.id, name: fromApiName(block.name), input: block.input });
  }
  return {
    stopReason: mapStopReason(res.stop_reason),
    content,
    usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    model: res.model,
  };
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

function mapSdkError(err: unknown): Error {
  const status = (err as { status?: number })?.status;
  const message = (err as { message?: string })?.message ?? String(err);
  if (status === 429) {
    const retryAfter = Number((err as { headers?: Record<string, string> })?.headers?.["retry-after"]) * 1000;
    return new RateLimitError("anthropic", Number.isFinite(retryAfter) ? retryAfter : undefined);
  }
  if (status === 529 || /overloaded/i.test(message)) return new ModelOverloadedError(message);
  if (status != null && status >= 500) return new ModelError(message, { retryable: true, cause: err });
  return new ModelError(message, { retryable: false, cause: err, context: { status } });
}

/** Treat ContentBlock list as opaque pass-through for callers that need it. */
export type { ContentBlock };

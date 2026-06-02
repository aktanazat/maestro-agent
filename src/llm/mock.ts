import { estimateTokensFromText } from "./provider.js";
import type {
  CompleteOptions,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  TextBlock,
  ToolUseBlock,
} from "./provider.js";

let toolUseCounter = 0;
function toolUseId(): string {
  toolUseCounter += 1;
  return `mock_tu_${toolUseCounter}`;
}

/** Convenience constructors for scripting deterministic model behavior. */
export function say(text: string): ModelResponse {
  return resp("end_turn", [{ type: "text", text }]);
}

export function callTool(name: string, input: unknown, opts: { text?: string } = {}): ModelResponse {
  const blocks: Array<TextBlock | ToolUseBlock> = [];
  if (opts.text) blocks.push({ type: "text", text: opts.text });
  blocks.push({ type: "tool_use", id: toolUseId(), name, input });
  return resp("tool_use", blocks);
}

function resp(stopReason: ModelResponse["stopReason"], content: Array<TextBlock | ToolUseBlock>): ModelResponse {
  const out = content.map((b) => (b.type === "text" ? b.text : JSON.stringify(b.input))).join("");
  return {
    stopReason,
    content,
    usage: { inputTokens: 0, outputTokens: estimateTokensFromText(out) },
    model: "mock",
  };
}

export type ScriptStep = ModelResponse | ((req: ModelRequest, turn: number) => ModelResponse);

/**
 * Deterministic provider. Either replays a fixed script of responses, or delegates to
 * a policy function that inspects the conversation and decides the next move. This is
 * what makes the agent loop, subagent orchestration, and eval harness testable without
 * any network — the model becomes a pure function we control.
 */
export class MockProvider implements ModelProvider {
  readonly name = "mock";
  readonly model = "mock";
  private turn = 0;
  readonly calls: ModelRequest[] = [];

  constructor(
    private readonly script: ScriptStep[] | ((req: ModelRequest, turn: number) => ModelResponse),
  ) {}

  estimateTokens(text: string): number {
    return estimateTokensFromText(text);
  }

  async complete(req: ModelRequest, _opts?: CompleteOptions): Promise<ModelResponse> {
    this.calls.push(req);
    const t = this.turn;
    this.turn += 1;
    if (typeof this.script === "function") return this.script(req, t);
    const step = this.script[t];
    if (!step) {
      // Default terminal behavior once the script is exhausted: end the turn.
      return say("(mock: script exhausted)");
    }
    return typeof step === "function" ? step(req, t) : step;
  }
}

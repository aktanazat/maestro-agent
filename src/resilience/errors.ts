/**
 * Typed error hierarchy. Every failure in maestro is one of these — never a bare
 * `Error` or a string. Carries a stable `code` for programmatic handling, a
 * `retryable` hint the resilience layer reads, and structured `context` for traces.
 */

export type ErrorCode =
  | "CONFIG_INVALID"
  | "TOOL_NOT_FOUND"
  | "TOOL_INPUT_INVALID"
  | "TOOL_OUTPUT_INVALID"
  | "TOOL_EXECUTION_FAILED"
  | "TOOL_DENIED"
  | "MODEL_ERROR"
  | "MODEL_OVERLOADED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "BUDGET_EXCEEDED"
  | "SUBAGENT_FAILED"
  | "CONTEXT_OVERFLOW"
  | "SANDBOX_VIOLATION"
  | "INTERNAL";

export interface ErrorContext {
  [key: string]: unknown;
}

export class MaestroError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly context: ErrorContext;
  readonly cause?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryable?: boolean; context?: ErrorContext; cause?: unknown } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.context = opts.context ?? {};
    this.cause = opts.cause;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      context: this.context,
    };
  }
}

export class ConfigError extends MaestroError {
  constructor(message: string, context?: ErrorContext) {
    super("CONFIG_INVALID", message, { retryable: false, context });
  }
}

export class ToolNotFoundError extends MaestroError {
  constructor(name: string) {
    super("TOOL_NOT_FOUND", `No tool registered with name "${name}"`, {
      retryable: false,
      context: { name },
    });
  }
}

export class ToolInputError extends MaestroError {
  constructor(tool: string, detail: string, context?: ErrorContext) {
    super("TOOL_INPUT_INVALID", `Invalid input for "${tool}": ${detail}`, {
      retryable: false,
      context: { tool, ...context },
    });
  }
}

export class ToolOutputError extends MaestroError {
  constructor(tool: string, detail: string, context?: ErrorContext) {
    super("TOOL_OUTPUT_INVALID", `Tool "${tool}" produced invalid output: ${detail}`, {
      retryable: false,
      context: { tool, ...context },
    });
  }
}

export class ToolExecutionError extends MaestroError {
  constructor(tool: string, detail: string, opts: { retryable?: boolean; cause?: unknown; context?: ErrorContext } = {}) {
    super("TOOL_EXECUTION_FAILED", `Tool "${tool}" failed: ${detail}`, {
      retryable: opts.retryable ?? false,
      cause: opts.cause,
      context: { tool, ...opts.context },
    });
  }
}

export class ToolDeniedError extends MaestroError {
  constructor(tool: string, reason: string) {
    super("TOOL_DENIED", `Tool "${tool}" denied: ${reason}`, {
      retryable: false,
      context: { tool, reason },
    });
  }
}

export class ModelError extends MaestroError {
  constructor(message: string, opts: { retryable?: boolean; cause?: unknown; context?: ErrorContext } = {}) {
    super("MODEL_ERROR", message, {
      retryable: opts.retryable ?? false,
      cause: opts.cause,
      context: opts.context,
    });
  }
}

export class ModelOverloadedError extends MaestroError {
  constructor(message = "Model temporarily overloaded", context?: ErrorContext) {
    super("MODEL_OVERLOADED", message, { retryable: true, context });
  }
}

export class RateLimitError extends MaestroError {
  readonly retryAfterMs?: number;
  constructor(resource: string, retryAfterMs?: number) {
    super("RATE_LIMITED", `Rate limited on ${resource}`, {
      retryable: true,
      context: { resource, retryAfterMs },
    });
    this.retryAfterMs = retryAfterMs;
  }
}

export class TimeoutError extends MaestroError {
  constructor(what: string, ms: number) {
    super("TIMEOUT", `${what} timed out after ${ms}ms`, {
      retryable: true,
      context: { what, ms },
    });
  }
}

export class BudgetExceededError extends MaestroError {
  constructor(kind: "tokens" | "steps" | "wallclock" | "cost", limit: number, used: number) {
    super("BUDGET_EXCEEDED", `${kind} budget exceeded (limit ${limit}, used ${used})`, {
      retryable: false,
      context: { kind, limit, used },
    });
  }
}

export class SubagentError extends MaestroError {
  constructor(message: string, context?: ErrorContext) {
    super("SUBAGENT_FAILED", message, { retryable: false, context });
  }
}

export class SandboxViolationError extends MaestroError {
  constructor(message: string, context?: ErrorContext) {
    super("SANDBOX_VIOLATION", message, { retryable: false, context });
  }
}

/** Normalize anything thrown into a MaestroError so the loop has one shape to reason about. */
export function asMaestroError(err: unknown, fallbackCode: ErrorCode = "INTERNAL"): MaestroError {
  if (err instanceof MaestroError) return err;
  if (err instanceof Error) {
    return new MaestroError(fallbackCode, err.message, { cause: err });
  }
  return new MaestroError(fallbackCode, String(err), { cause: err });
}

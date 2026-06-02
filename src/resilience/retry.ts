import { MaestroError, TimeoutError, asMaestroError } from "./errors.js";
import type { Logger } from "../obs/logger.js";

export interface RetryOptions {
  /** Max attempts including the first. */
  maxAttempts?: number;
  /** Base delay in ms; attempt N waits ~base * factor^(N-1). */
  baseDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  /** Full-jitter randomization to avoid thundering herds. 0..1. */
  jitter?: number;
  /** Per-attempt timeout. Omit for none. */
  attemptTimeoutMs?: number;
  signal?: AbortSignal;
  logger?: Logger;
  /** Decide retryability for a thrown error. Defaults to MaestroError.retryable. */
  isRetryable?: (err: MaestroError) => boolean;
  /** Called before each backoff sleep — used in tests to assert/skip waits. */
  onRetry?: (info: { attempt: number; delayMs: number; error: MaestroError }) => void;
  /** Injectable sleep so tests run instantly. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable RNG so jitter is deterministic in tests. Returns 0..1. */
  random?: () => number;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new MaestroError("TIMEOUT", "aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new MaestroError("TIMEOUT", "aborted"));
      },
      { once: true },
    );
  });

export function computeBackoff(attempt: number, opts: Required<Pick<RetryOptions, "baseDelayMs" | "factor" | "maxDelayMs" | "jitter">>, random: () => number): number {
  const raw = opts.baseDelayMs * Math.pow(opts.factor, attempt - 1);
  const capped = Math.min(raw, opts.maxDelayMs);
  // Full jitter: sample uniformly in [capped*(1-jitter), capped].
  const low = capped * (1 - opts.jitter);
  return Math.round(low + random() * (capped - low));
}

/**
 * Run `fn` with exponential backoff + jitter. Retries only errors the policy deems
 * retryable (transient model/network/rate-limit failures), never logic errors.
 * `RateLimitError.retryAfterMs` is honored when present.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const cfg = {
    baseDelayMs: options.baseDelayMs ?? 250,
    factor: options.factor ?? 2,
    maxDelayMs: options.maxDelayMs ?? 15_000,
    jitter: options.jitter ?? 1,
  };
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const isRetryable = options.isRetryable ?? ((e: MaestroError) => e.retryable);

  let lastErr: MaestroError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) throw new MaestroError("TIMEOUT", "aborted before attempt");
    try {
      if (options.attemptTimeoutMs != null) {
        return await withTimeout(fn(attempt), options.attemptTimeoutMs, `attempt ${attempt}`, options.signal);
      }
      return await fn(attempt);
    } catch (raw) {
      const err = asMaestroError(raw, "MODEL_ERROR");
      lastErr = err;
      const canRetry = isRetryable(err) && attempt < maxAttempts;
      if (!canRetry) throw err;
      const retryAfter = (err as { retryAfterMs?: number }).retryAfterMs;
      const delayMs = retryAfter ?? computeBackoff(attempt, cfg, random);
      options.logger?.warn({ attempt, delayMs, code: err.code }, "retrying after transient error");
      options.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs, options.signal);
    }
  }
  throw lastErr ?? new MaestroError("INTERNAL", "retry exhausted with no error");
}

/** Reject if `p` does not settle within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, what = "operation", signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MaestroError("TIMEOUT", `${what} aborted`));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

import { RateLimitError } from "./errors.js";

/**
 * Token-bucket rate limiter. Smooths bursts to a sustained rate with a bucket
 * for headroom — the standard shape for protecting an external API (the Anthropic
 * endpoint, `gh`, web fetches). `acquire()` waits for a slot; `tryAcquire()` fails
 * fast. Time is injectable so tests are deterministic and instant.
 */
export interface RateLimiterOptions {
  /** Sustained refill rate, tokens per second. */
  ratePerSec: number;
  /** Bucket capacity — max burst. */
  burst: number;
  /** Cap on how long acquire() will wait before throwing RateLimitError. */
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  resource?: string;
}

export class RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly ratePerSec: number;
  private readonly maxWaitMs: number;
  private last: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly resource: string;
  private waiters = 0;

  constructor(opts: RateLimiterOptions) {
    this.capacity = opts.burst;
    this.tokens = opts.burst;
    this.ratePerSec = opts.ratePerSec;
    this.maxWaitMs = opts.maxWaitMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.resource = opts.resource ?? "external";
    this.last = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = (t - this.last) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerSec);
    this.last = t;
  }

  /** Non-blocking: consume one token if available. */
  tryAcquire(cost = 1): boolean {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  /** Block (cooperatively) until a token is available or maxWaitMs elapses. */
  async acquire(cost = 1): Promise<void> {
    const deadline = this.now() + this.maxWaitMs;
    this.waiters += 1;
    try {
      // Serialize waiters by spreading their wakeups so they don't all consume the
      // same refilled token simultaneously.
      for (;;) {
        this.refill();
        if (this.tokens >= cost) {
          this.tokens -= cost;
          return;
        }
        const needed = cost - this.tokens;
        const waitMs = Math.max(5, Math.ceil((needed / this.ratePerSec) * 1000) * this.waiters);
        if (this.now() + waitMs > deadline) {
          throw new RateLimitError(this.resource, Math.ceil((needed / this.ratePerSec) * 1000));
        }
        await this.sleep(waitMs);
      }
    } finally {
      this.waiters -= 1;
    }
  }

  /** Current available tokens (after refill). Exposed for metrics/tests. */
  available(): number {
    this.refill();
    return this.tokens;
  }
}

/** Registry of named limiters so every external resource gets one shared bucket. */
export class RateLimiterRegistry {
  private readonly limiters = new Map<string, RateLimiter>();

  constructor(private readonly defaults: Record<string, RateLimiterOptions> = {}) {}

  for(resource: string): RateLimiter {
    let limiter = this.limiters.get(resource);
    if (!limiter) {
      const opts = this.defaults[resource] ?? { ratePerSec: 5, burst: 10, resource };
      limiter = new RateLimiter({ ...opts, resource });
      this.limiters.set(resource, limiter);
    }
    return limiter;
  }
}

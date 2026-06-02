import { describe, it, expect } from "vitest";
import { withRetry, computeBackoff } from "../../src/resilience/retry.js";
import { RateLimiter } from "../../src/resilience/ratelimit.js";
import { ModelError, RateLimitError, MaestroError } from "../../src/resilience/errors.js";

describe("withRetry", () => {
  it("retries retryable errors and eventually succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new ModelError("transient", { retryable: true });
        return "ok";
      },
      { maxAttempts: 5, sleep: async () => {}, random: () => 0 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new ModelError("fatal", { retryable: false });
        },
        { maxAttempts: 5, sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(MaestroError);
    expect(calls).toBe(1);
  });

  it("honors RateLimitError.retryAfterMs over computed backoff", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new RateLimitError("api", 1234);
        return "done";
      },
      { maxAttempts: 3, sleep: async (ms) => void delays.push(ms), random: () => 0 },
    );
    expect(delays[0]).toBe(1234);
  });

  it("computeBackoff grows exponentially and respects the cap", () => {
    const cfg = { baseDelayMs: 100, factor: 2, maxDelayMs: 1000, jitter: 0 };
    expect(computeBackoff(1, cfg, () => 0)).toBe(100);
    expect(computeBackoff(2, cfg, () => 0)).toBe(200);
    expect(computeBackoff(10, cfg, () => 0)).toBe(1000);
  });
});

describe("RateLimiter (token bucket)", () => {
  it("allows a burst then blocks until refill", async () => {
    let now = 0;
    const limiter = new RateLimiter({ ratePerSec: 10, burst: 2, now: () => now, sleep: async () => {}, maxWaitMs: 10_000 });
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false); // bucket empty
    now += 100; // 0.1s -> 1 token at 10/s
    expect(limiter.tryAcquire()).toBe(true);
  });

  it("acquire throws RateLimitError when the wait would exceed maxWaitMs", async () => {
    const now = 0;
    const limiter = new RateLimiter({ ratePerSec: 1, burst: 1, now: () => now, sleep: async () => {}, maxWaitMs: 50 });
    await limiter.acquire(); // consume the one token
    await expect(limiter.acquire()).rejects.toBeInstanceOf(RateLimitError);
  });
});

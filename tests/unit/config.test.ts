import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../../src/config.js";
import { ConfigError } from "../../src/resilience/errors.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("loadConfig", () => {
  it("applies defaults for absent values, including nested objects", () => {
    const cfg = loadConfig({ provider: "mock" });
    expect(cfg.provider).toBe("mock");
    expect(cfg.budgets.maxSteps).toBeGreaterThan(0);
    expect(cfg.context.compactionThreshold).toBeGreaterThan(0);
    expect(cfg.rateLimits.anthropicPerSec).toBeGreaterThan(0);
  });

  it("reads numeric env overrides", () => {
    process.env.MAESTRO_MAX_STEPS = "7";
    process.env.MAESTRO_RL_GITHUB = "9";
    const cfg = loadConfig();
    expect(cfg.budgets.maxSteps).toBe(7);
    expect(cfg.rateLimits.githubPerSec).toBe(9);
  });

  it("throws a typed ConfigError on invalid values", () => {
    expect(() => loadConfig({ provider: "not-a-provider" })).toThrow(ConfigError);
  });
});

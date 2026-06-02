import { z } from "zod";
import { ConfigError } from "./resilience/errors.js";

/**
 * All runtime configuration in one zod-validated place. Env is parsed once at startup and a
 * typed, frozen config is threaded through the app — no `process.env` reads scattered across
 * modules, no untyped strings. Invalid config fails fast with a typed ConfigError.
 */
export const ConfigSchema = z.object({
  provider: z.enum(["anthropic", "mock"]).default("anthropic"),
  model: z.string().default("claude-sonnet-4-6"),
  anthropicApiKey: z.string().optional(),
  /** auto = allow all; readonly = block write/exec/network; safe = block high-risk tools. */
  permissionMode: z.enum(["auto", "readonly", "safe"]).default("auto"),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  logPretty: z.boolean().default(true),
  tracesDir: z.string().default(".maestro/traces"),
  budgets: z
    .object({
      maxSteps: z.number().int().positive().default(60),
      maxTokens: z.number().int().positive().default(400_000),
      maxWallClockMs: z.number().int().positive().default(15 * 60_000),
    })
    .default({}),
  context: z
    .object({
      maxContextTokens: z.number().int().positive().default(150_000),
      compactionThreshold: z.number().min(0.1).max(0.95).default(0.7),
      recencyKeep: z.number().int().positive().default(8),
    })
    .default({}),
  rateLimits: z
    .object({
      anthropicPerSec: z.number().positive().default(4),
      githubPerSec: z.number().positive().default(2),
      webPerSec: z.number().positive().default(3),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(overrides: Partial<Record<string, unknown>> = {}): Config {
  const env = process.env;
  const raw = {
    provider: env.MAESTRO_PROVIDER ?? overrides.provider,
    model: env.MAESTRO_MODEL ?? overrides.model,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    permissionMode: env.MAESTRO_PERMISSION_MODE ?? overrides.permissionMode,
    logLevel: env.MAESTRO_LOG_LEVEL,
    logPretty: env.MAESTRO_LOG_PRETTY ? env.MAESTRO_LOG_PRETTY === "1" : undefined,
    tracesDir: env.MAESTRO_TRACES_DIR,
    budgets: {
      maxSteps: numEnv(env.MAESTRO_MAX_STEPS),
      maxTokens: numEnv(env.MAESTRO_MAX_TOKENS),
      maxWallClockMs: numEnv(env.MAESTRO_MAX_WALLCLOCK_MS),
    },
    context: {
      maxContextTokens: numEnv(env.MAESTRO_MAX_CONTEXT_TOKENS),
      compactionThreshold: numEnv(env.MAESTRO_COMPACTION_THRESHOLD),
      recencyKeep: numEnv(env.MAESTRO_RECENCY_KEEP),
    },
    rateLimits: {
      anthropicPerSec: numEnv(env.MAESTRO_RL_ANTHROPIC),
      githubPerSec: numEnv(env.MAESTRO_RL_GITHUB),
      webPerSec: numEnv(env.MAESTRO_RL_WEB),
    },
    ...overrides,
  };
  const cleaned = stripUndefined(raw);
  const parsed = ConfigSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError("invalid configuration", { issues: parsed.error.issues });
  }
  return Object.freeze(parsed.data);
}

function numEnv(v: string | undefined): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function stripUndefined<T>(obj: T): T {
  if (Array.isArray(obj)) return obj;
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const cleaned = stripUndefined(v as T);
      if (cleaned !== undefined && !(typeof cleaned === "object" && cleaned !== null && Object.keys(cleaned).length === 0)) {
        out[k] = cleaned;
      }
    }
    return out as T;
  }
  return obj;
}

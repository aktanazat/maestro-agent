import pino from "pino";

export type Logger = pino.Logger;

export interface LoggerOptions {
  level?: string;
  /** Pretty multi-line output for local dev; JSON lines for prod/CI. */
  pretty?: boolean;
  /** Static fields attached to every line (run id, agent id). */
  base?: Record<string, unknown>;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? process.env.MAESTRO_LOG_LEVEL ?? "info";
  const pretty = opts.pretty ?? process.env.MAESTRO_LOG_PRETTY === "1";
  return pino({
    level,
    base: opts.base ?? {},
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? {
          transport: {
            target: "pino/file",
            options: { destination: 2 },
          },
        }
      : { transport: undefined }),
  });
}

/** A logger that discards everything — for tests that should stay silent. */
export function silentLogger(): Logger {
  return pino({ level: "silent" });
}

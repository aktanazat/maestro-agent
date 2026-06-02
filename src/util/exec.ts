import { execa } from "execa";
import { ToolExecutionError, TimeoutError } from "../resilience/errors.js";

export interface RunResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /** Cap captured output so a noisy command can't blow the context window. */
  maxOutputBytes?: number;
  input?: string;
}

/**
 * Sandboxed command runner. No shell interpolation (argv form), bounded output, hard
 * timeout, cooperative abort. Tools never call execa directly — they go through here so
 * the timeout/limit/abort policy is enforced in exactly one place.
 */
export async function runCommand(file: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxOutputBytes = opts.maxOutputBytes ?? 200_000;
  const t0 = Date.now();
  try {
    const result = await execa(file, args, {
      cwd: opts.cwd,
      timeout: timeoutMs,
      signal: opts.signal,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      reject: false,
      all: false,
      stripFinalNewline: false,
      input: opts.input,
    });
    return {
      command: [file, ...args].join(" "),
      exitCode: result.exitCode ?? (result.failed ? 1 : 0),
      stdout: clipBytes(result.stdout ?? "", maxOutputBytes),
      stderr: clipBytes(result.stderr ?? "", maxOutputBytes),
      durationMs: Date.now() - t0,
      timedOut: Boolean(result.timedOut),
    };
  } catch (err) {
    const e = err as { timedOut?: boolean; signal?: string; message?: string };
    if (e.timedOut) throw new TimeoutError(`command ${file}`, timeoutMs);
    if (e.signal === "SIGTERM" || e.signal === "SIGKILL") {
      throw new ToolExecutionError(file, "aborted", { context: { signal: e.signal } });
    }
    throw new ToolExecutionError(file, e.message ?? "spawn failed", { cause: err });
  }
}

function clipBytes(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  const clipped = Buffer.from(s).subarray(0, max).toString("utf8");
  return clipped + `\n…[output truncated at ${max} bytes]`;
}

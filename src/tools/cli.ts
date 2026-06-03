import { ToolExecutionError } from "../resilience/errors.js";
import type { RunResult } from "../util/exec.js";

/** Throw on a missing binary (exit 127) or a non-zero exit; otherwise return the result. */
export function assertCliOk(tool: string, res: RunResult): RunResult {
  if (res.exitCode === 127) throw new ToolExecutionError(tool, `${tool} CLI not installed`);
  if (res.exitCode !== 0) {
    const detail = (res.stderr.trim() || res.stdout.trim() || "no output").slice(0, 400);
    throw new ToolExecutionError(tool, `${res.command} exited ${res.exitCode}: ${detail}`);
  }
  return res;
}

/** assertCliOk, then parse stdout as JSON. Throws a clear error if the CLI emitted non-JSON. */
export function cliJson<T>(tool: string, res: RunResult): T {
  assertCliOk(tool, res);
  try {
    return JSON.parse(res.stdout) as T;
  } catch {
    throw new ToolExecutionError(tool, `${tool} returned non-JSON output`);
  }
}

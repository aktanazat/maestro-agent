import { ToolExecutionError } from "../resilience/errors.js";
import type { RunResult } from "../util/exec.js";

/**
 * Shared interpretation of a CLI invocation. Both the git and github tool families shell out
 * and face the same three concerns — missing binary (exit 127), non-zero exit, and parsing
 * JSON output — so they converge here instead of re-implementing the checks per tool.
 */
export function assertCliOk(tool: string, res: RunResult): RunResult {
  if (res.exitCode === 127) throw new ToolExecutionError(tool, `${tool} CLI not installed`);
  if (res.exitCode !== 0) throw new ToolExecutionError(tool, `${res.command} exited ${res.exitCode}: ${res.stderr.trim().slice(0, 400)}`);
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

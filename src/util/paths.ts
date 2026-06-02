import { resolve, relative, isAbsolute, sep } from "node:path";
import { SandboxViolationError } from "../resilience/errors.js";

/**
 * Resolve a user/model-supplied path against the workspace root and REFUSE to escape it.
 * Every fs/shell tool routes through here — this is the sandbox boundary that keeps an
 * autonomous agent from reading or writing outside the repo it was pointed at.
 */
export function resolveInside(workspace: string, p: string): string {
  const root = resolve(workspace);
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, abs);
  if (rel === "" ) return abs;
  if (rel.startsWith("..") || rel.split(sep)[0] === "..") {
    throw new SandboxViolationError(`path escapes workspace: ${p}`, { workspace: root, resolved: abs });
  }
  return abs;
}

/** Workspace-relative display path, for stable tool output regardless of absolute root. */
export function relInside(workspace: string, abs: string): string {
  const rel = relative(resolve(workspace), abs);
  return rel === "" ? "." : rel;
}

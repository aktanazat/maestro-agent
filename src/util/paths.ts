import { resolve, relative, isAbsolute, sep, dirname, basename, join } from "node:path";
import { realpathSync } from "node:fs";
import { SandboxViolationError } from "../resilience/errors.js";

/**
 * Resolve a user/model-supplied path against the workspace root and REFUSE to escape it.
 * Every fs/shell tool routes through here — this is the sandbox boundary that keeps an
 * autonomous agent from reading or writing outside the repo it was pointed at.
 *
 * Containment is checked on the REAL path: symlinks in existing path components are resolved
 * first (via realpath of the deepest existing ancestor), so a `link -> /etc` inside the repo
 * cannot smuggle access outside it. When a path or the workspace does not exist on disk yet
 * (e.g. a brand-new file, or a synthetic root in a unit test) the check degrades to the lexical
 * resolution, which is still safe — there is no symlink to follow.
 */
export function resolveInside(workspace: string, p: string): string {
  const root = realpathish(resolve(workspace));
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const real = realpathOfNearestAncestor(abs);
  assertContained(root, real, p);
  return real;
}

function assertContained(root: string, abs: string, original: string): void {
  const rel = relative(root, abs);
  if (rel === "") return;
  if (rel.startsWith("..") || rel.split(sep)[0] === "..") {
    throw new SandboxViolationError(`path escapes workspace: ${original}`, { workspace: root, resolved: abs });
  }
}

/** realpath if the path exists, else return it untouched (no symlink to resolve). */
function realpathish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Resolve symlinks on the longest existing prefix of `abs`, then re-append the non-existent
 * tail. This catches a symlinked directory in the middle of the path without requiring the
 * leaf to exist (needed for writes that create new files).
 */
function realpathOfNearestAncestor(abs: string): string {
  const tail: string[] = [];
  let probe = abs;
  for (;;) {
    try {
      const real = realpathSync(probe);
      return tail.length ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return abs; // reached the filesystem root without an existing ancestor
      tail.unshift(basename(probe));
      probe = parent;
    }
  }
}

/** Workspace-relative display path, for stable tool output regardless of absolute root. */
export function relInside(workspace: string, abs: string): string {
  const rel = relative(resolve(workspace), abs);
  return rel === "" ? "." : rel;
}

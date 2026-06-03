import { promises as fs } from "node:fs";
import { join, relative, resolve, extname } from "node:path";

/** Directories never descended into during workspace discovery. */
export const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".maestro"]);

export interface WalkOptions {
  /** Stop after this many files. */
  limit?: number;
  /** Keep only files with one of these extensions (e.g. [".ts", ".js"]). */
  exts?: string[];
  /** Keep only files whose workspace-relative path satisfies this predicate. */
  match?: (relPath: string) => boolean;
}

/**
 * The one workspace file-discovery path. Every `code.*`/`fs.*` tool and the project index walk
 * the tree through here, so the ignore set and traversal live in exactly one place.
 */
export async function walkFiles(root: string, opts: WalkOptions = {}): Promise<string[]> {
  const abs = resolve(root);
  const limit = opts.limit ?? 20_000;
  const exts = opts.exts ? new Set(opts.exts) : undefined;
  const out: string[] = [];

  async function rec(dir: string): Promise<void> {
    if (out.length >= limit) return;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (out.length >= limit) return;
      if (IGNORED_DIRS.has(d.name)) continue;
      const path = join(dir, d.name);
      if (d.isDirectory()) {
        await rec(path);
      } else if (d.isFile()) {
        if (exts && !exts.has(extname(d.name))) continue;
        if (opts.match && !opts.match(relative(abs, path))) continue;
        out.push(path);
      }
    }
  }

  await rec(abs);
  return out;
}

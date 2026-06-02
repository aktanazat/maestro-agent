import { promises as fs } from "node:fs";
import { join, relative, resolve, extname } from "node:path";

const IGNORE = new Set(["node_modules", ".git", "dist", "coverage", ".maestro"]);

/**
 * A per-run cache of the workspace. Before this, every `code.*` call re-walked the whole tree,
 * and `code.localize_failure` re-read every source file once per failure — O(failures × files ×
 * size). The index walks once, memoizes file contents, and is invalidated centrally whenever a
 * write/exec tool runs (see registry dispatch). Reads during exploration (the common case) are
 * then close to free. Tools fall back to an uncached walk when no index is bound, so unit tests
 * that call handlers directly still work.
 */
export class ProjectIndex {
  private fileList?: string[];
  private readonly contentCache = new Map<string, string>();

  constructor(
    private readonly root: string,
    private readonly maxFiles = 20_000,
  ) {}

  /** Absolute paths of all non-ignored files, filtered by extension if given. Cached. */
  async files(exts?: string[]): Promise<string[]> {
    if (!this.fileList) this.fileList = await walk(this.root, this.maxFiles);
    if (!exts) return this.fileList;
    const set = new Set(exts);
    return this.fileList.filter((f) => set.has(extname(f)));
  }

  /** Workspace-relative paths, optionally filtered by extension. */
  async relFiles(exts?: string[]): Promise<string[]> {
    return (await this.files(exts)).map((f) => relative(this.root, f));
  }

  /** File content, memoized. Empty string on read error (binary/deleted). */
  async content(absPath: string): Promise<string> {
    const cached = this.contentCache.get(absPath);
    if (cached !== undefined) return cached;
    const text = await fs.readFile(absPath, "utf8").catch(() => "");
    this.contentCache.set(absPath, text);
    return text;
  }

  /** Drop all caches. Called after any tool that may have mutated the tree. */
  invalidate(): void {
    this.fileList = undefined;
    this.contentCache.clear();
  }
}

async function walk(root: string, limit: number): Promise<string[]> {
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
      if (IGNORE.has(d.name)) continue;
      const abs = join(dir, d.name);
      if (d.isDirectory()) await rec(abs);
      else if (d.isFile()) out.push(abs);
    }
  }
  await rec(resolve(root));
  return out;
}

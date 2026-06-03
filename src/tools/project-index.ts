import { promises as fs } from "node:fs";
import { relative, extname } from "node:path";
import { walkFiles } from "../util/walk.js";

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
    if (!this.fileList) this.fileList = await walkFiles(this.root, { limit: this.maxFiles });
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

import { z } from "zod";
import { defineTool } from "../types.js";
import type { Tool } from "../types.js";
import { withRetry, withTimeout } from "../../resilience/retry.js";
import { ToolExecutionError, ModelError } from "../../resilience/errors.js";

/**
 * Minimal web namespace. `web.fetch` is a real, rate-limited, retried HTTP GET; `web.extract_links`
 * consumes its body — another typed composition chain (fetch → extract). External calls go through
 * the run rate limiter (resource "web") and exponential backoff, same discipline as github.
 */

const fetchUrl = defineTool({
  name: "web.fetch",
  description: "HTTP GET a URL and return status + text body (truncated). Rate-limited and retried on transient failures.",
  input: z.object({ url: z.string().url(), maxBytes: z.number().int().positive().max(500_000).default(100_000) }),
  output: z.object({ url: z.string(), status: z.number(), contentType: z.string(), body: z.string(), truncated: z.boolean() }),
  effect: "network",
  idempotent: true,
  handler: async (input, ctx) => {
    await ctx.services.rateLimiter?.("web").acquire();
    return withRetry(
      async () => {
        const res = await withTimeout(fetch(input.url, { signal: ctx.signal, redirect: "follow" }), 20_000, "web.fetch", ctx.signal);
        if (res.status >= 500) throw new ModelError(`upstream ${res.status}`, { retryable: true });
        if (!res.ok && res.status !== 404) throw new ToolExecutionError("web.fetch", `HTTP ${res.status}`);
        const text = await res.text();
        const truncated = text.length > input.maxBytes;
        return {
          url: input.url,
          status: res.status,
          contentType: res.headers.get("content-type") ?? "",
          body: text.slice(0, input.maxBytes),
          truncated,
        };
      },
      { maxAttempts: 3, baseDelayMs: 400, logger: ctx.logger, signal: ctx.signal },
    );
  },
});

const extractLinks = defineTool({
  name: "web.extract_links",
  description: "Extract hyperlinks (href) from an HTML body — consumes the output of web.fetch.",
  input: z.object({ body: z.string(), limit: z.number().int().positive().max(500).default(100) }),
  output: z.object({ links: z.array(z.string()), count: z.number() }),
  effect: "read",
  handler: async (input) => {
    const links = new Set<string>();
    const re = /href\s*=\s*["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input.body)) && links.size < input.limit) {
      if (m[1] && !m[1].startsWith("#")) links.add(m[1]);
    }
    return { links: [...links], count: links.size };
  },
});

export const webTools: Tool[] = [fetchUrl, extractLinks];

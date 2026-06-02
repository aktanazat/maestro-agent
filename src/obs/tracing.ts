import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "./logger.js";

/**
 * Minimal span tracer. Every interesting unit of work (model call, tool call,
 * subagent run, the loop itself) opens a span and closes it; spans nest via
 * parent ids so a trace reconstructs the full causal tree of a run. Spans are
 * emitted as JSONL — cheap, greppable, and replayable by the eval harness.
 *
 * Deliberately not OpenTelemetry: no collector to stand up for a CLI, but the
 * shape (traceId/spanId/parentId/attributes/events) maps onto OTel 1:1 if we
 * ever want to export.
 */

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export type SpanStatus = "ok" | "error";

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentId: string | null;
  name: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  events: Array<{ ts: number; name: string; data?: Record<string, unknown> }>;
}

export interface Span {
  readonly spanId: string;
  setAttribute(key: string, value: unknown): void;
  addEvent(name: string, data?: Record<string, unknown>): void;
  child(name: string, attributes?: Record<string, unknown>): Span;
  end(status?: SpanStatus): void;
}

export interface TracerOptions {
  traceId?: string;
  /** File to append JSONL span records to. If unset, spans are kept in-memory only. */
  filePath?: string;
  logger?: Logger;
}

export class Tracer {
  readonly traceId: string;
  private readonly filePath?: string;
  private readonly logger?: Logger;
  private readonly buffer: SpanRecord[] = [];

  constructor(opts: TracerOptions = {}) {
    this.traceId = opts.traceId ?? nextId("trace");
    this.filePath = opts.filePath;
    this.logger = opts.logger;
    if (this.filePath) mkdirSync(dirname(this.filePath), { recursive: true });
  }

  startSpan(name: string, attributes: Record<string, unknown> = {}, parentId: string | null = null): Span {
    return this.makeSpan(name, attributes, parentId);
  }

  /** All recorded spans (in-memory mirror), useful for assertions in tests. */
  spans(): readonly SpanRecord[] {
    return this.buffer;
  }

  private record(rec: SpanRecord): void {
    this.buffer.push(rec);
    if (this.filePath) {
      try {
        appendFileSync(this.filePath, JSON.stringify(rec) + "\n");
      } catch (err) {
        this.logger?.warn({ err }, "failed to write span");
      }
    }
  }

  private makeSpan(name: string, attributes: Record<string, unknown>, parentId: string | null): Span {
    const spanId = nextId("span");
    const start = now();
    const attrs: Record<string, unknown> = { ...attributes };
    const events: SpanRecord["events"] = [];
    let ended = false;
    const tracer = this;
    return {
      spanId,
      setAttribute(key, value) {
        attrs[key] = value;
      },
      addEvent(evtName, data) {
        events.push({ ts: now(), name: evtName, ...(data ? { data } : {}) });
      },
      child(childName, childAttrs) {
        return tracer.makeSpan(childName, childAttrs ?? {}, spanId);
      },
      end(status: SpanStatus = "ok") {
        if (ended) return;
        ended = true;
        const end = now();
        tracer.record({
          traceId: tracer.traceId,
          spanId,
          parentId,
          name,
          startMs: start,
          endMs: end,
          durationMs: end - start,
          status,
          attributes: attrs,
          events,
        });
      },
    };
  }
}

function now(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** A tracer that records nothing — for unit tests of pure logic. */
export function noopTracer(): Tracer {
  return new Tracer();
}

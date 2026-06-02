import { z } from "zod";

/**
 * Shared, named schemas that more than one tool references. Composability is enforced at the
 * TYPE level here: `shell.run_tests` declares its output as `TestRunResultSchema`, and
 * `code.localize_failure` declares the SAME schema as part of its input. The chain therefore
 * type-checks at compile time, not just by convention — one tool literally consumes another's
 * structured output type.
 */

export const TestFailureSchema = z.object({
  test: z.string().describe("Test name or describe-block path."),
  file: z.string().nullable().describe("Source/spec file the failure points at, if parseable."),
  line: z.number().nullable(),
  message: z.string().describe("Assertion / error message."),
});
export type TestFailure = z.infer<typeof TestFailureSchema>;

export const TestRunResultSchema = z.object({
  runner: z.string().describe("Detected test runner, e.g. 'vitest', 'jest', 'pytest'."),
  command: z.string(),
  passed: z.number(),
  failed: z.number(),
  exitCode: z.number(),
  durationMs: z.number(),
  failures: z.array(TestFailureSchema),
  /** Tail of raw output, for the model when the structured parse is insufficient. */
  outputTail: z.string(),
});
export type TestRunResult = z.infer<typeof TestRunResultSchema>;

export const GrepMatchSchema = z.object({
  file: z.string(),
  line: z.number(),
  text: z.string(),
});
export const GrepResultSchema = z.object({
  pattern: z.string(),
  matches: z.array(GrepMatchSchema),
  truncated: z.boolean(),
});
export type GrepResult = z.infer<typeof GrepResultSchema>;

export const FileRefSchema = z.object({
  path: z.string(),
  reason: z.string().optional(),
});

export const LocalizationSchema = z.object({
  candidates: z
    .array(
      z.object({
        file: z.string(),
        score: z.number().describe("Heuristic relevance score, higher = more likely culprit."),
        reasons: z.array(z.string()),
      }),
    )
    .describe("Ranked source files most likely responsible for the failures."),
  fromFailures: z.number().describe("How many failures informed this localization."),
});
export type Localization = z.infer<typeof LocalizationSchema>;

export const DiffResultSchema = z.object({
  files: z.array(z.object({ path: z.string(), additions: z.number(), deletions: z.number() })),
  patch: z.string(),
  empty: z.boolean(),
});
export type DiffResult = z.infer<typeof DiffResultSchema>;

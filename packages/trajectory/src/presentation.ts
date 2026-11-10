import { z } from 'zod';
import { decimal64Schema } from './cursor';

/** Owner-sealed display data, never an arbitrary ToolResult.details object. */
const text = z.string();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const compressionAccountingSchema = z.strictObject({
  basis: z.literal('local-context-estimate-v1'),
  beforeTokens: count,
  afterTokens: count,
});
export type CompressionAccounting = z.infer<typeof compressionAccountingSchema>;
export const compressionPresentationSchema = z.strictObject({
  adopted: z.boolean(),
  accounting: compressionAccountingSchema.optional(),
  triggerTokens: count.optional(),
  triggerBasis: z.enum(['reported_baseline', 'local_estimate']).optional(),
  measuredInputTokens: count.optional(),
  estimatedInputTokens: count.optional(),
  thresholdTokens: count.optional(),
});
export type CompressionPresentation = z.infer<typeof compressionPresentationSchema>;
const operation = { operation: text };
export const toolResultPresentationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('file'),
    ...operation,
    path: text.optional(),
    text: text.optional(),
    truncated: z.boolean().optional(),
    bytes: count.optional(),
    startLine: count.optional(),
    endLine: count.optional(),
  }),
  z.strictObject({
    kind: z.literal('shell'),
    ...operation,
    executionId: text.optional(),
    shellId: text.optional(),
    status: text.optional(),
    accepted: z.boolean().optional(),
    cancelRequested: z.boolean().optional(),
    timedOut: z.boolean().optional(),
    exitCode: z.number().int().optional(),
    stdout: text.optional(),
    stderr: text.optional(),
    truncated: z.boolean().optional(),
    droppedBytes: decimal64Schema.optional(),
    nextCursor: text.optional(),
    caughtUp: z.boolean().optional(),
    terminal: z.boolean().optional(),
    output: z
      .array(
        z.strictObject({
          sequence: decimal64Schema,
          throughSequence: decimal64Schema,
          stream: z.enum(['stdout', 'stderr', 'progress', 'gap']),
          content: text,
          droppedBytes: decimal64Schema.optional(),
        }),
      )
      .optional(),
  }),
  z.strictObject({
    kind: z.literal('web'),
    title: text.optional(),
    contentType: text.optional(),
    url: text.optional(),
    truncated: z.boolean().optional(),
    characters: count.optional(),
  }),
  z.strictObject({
    kind: z.literal('browser'),
    ...operation,
    url: text.optional(),
    title: text.optional(),
    text: text.optional(),
    sequence: text.optional(),
    state: text.optional(),
    elements: z.array(z.strictObject({ role: text, name: text.optional() })).optional(),
  }),
  z.strictObject({
    kind: z.literal('task'),
    ...operation,
    agentId: text.optional(),
    executionId: text.optional(),
    runId: text.optional(),
    status: text.optional(),
    accepted: z.boolean().optional(),
    delivery: text.optional(),
  }),
  z.strictObject({
    kind: z.literal('plan'),
    ...operation,
    planId: text.optional(),
    version: z.union([text, count]).optional(),
    status: text.optional(),
    text: text.optional(),
    title: text.optional(),
    steps: z.array(z.strictObject({ id: text, title: text, status: text.optional() })).optional(),
  }),
  z.strictObject({
    kind: z.literal('worktree'),
    ...operation,
    path: text.optional(),
    mutation: text.optional(),
    cwdChanged: z.boolean().optional(),
    code: text.optional(),
    replayed: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal('skill'),
    ...operation,
    name: text.optional(),
    version: text.optional(),
    text: text.optional(),
  }),
  z.strictObject({
    kind: z.literal('mcp'),
    isError: z.boolean(),
    text: z.array(text),
    structuredContent: z.json().optional(),
  }),
  z.strictObject({
    kind: z.literal('question'),
    title: text.optional(),
    answers: z.array(z.strictObject({ question: text, answer: text })).optional(),
  }),
]);
export type ToolResultPresentation = z.infer<typeof toolResultPresentationSchema>;

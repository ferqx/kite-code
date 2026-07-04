import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createToolExecutionRequest, normalizeToolArgs } from '../../src/core/execution/request';

describe('execution request normalization', () => {
  test('canonicalizes object key order and freezes normalized args', () => {
    const schema = z.object({
      b: z.number(),
      a: z.string(),
      optional: z.string().optional(),
    });

    const first = normalizeToolArgs(schema, { b: 2, a: 'x', optional: undefined });
    const second = normalizeToolArgs(schema, { optional: undefined, a: 'x', b: 2 });

    expect(first.hash).toBe(second.hash);
    expect(first.normalized).toEqual({ a: 'x', b: 2 });
    expect(Object.isFrozen(first.normalized)).toBe(true);
  });

  test('builds a standard execution request from raw tool args', () => {
    const request = createToolExecutionRequest({
      toolCallId: 'call-1',
      toolName: 'read_file',
      rawArgs: { path: 'README.md' },
      schema: z.object({ path: z.string() }),
      source: 'main_agent',
      signal: new AbortController().signal,
    });

    expect(request.toolCallId).toBe('call-1');
    expect(request.toolName).toBe('read_file');
    expect(request.normalizedArgs).toEqual({ path: 'README.md' });
    expect(request.argsHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

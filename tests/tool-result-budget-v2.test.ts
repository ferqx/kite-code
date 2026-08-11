import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readFileWindowV2 } from '@/core/tools/file';
import { builtinToolSpecs } from '@/core/tools/registry/builtins';
import { readFileSpec } from '@/core/tools/registry/builtins/read-file';
import { dispatchRegisteredTool } from '@/core/tools/registry/dispatch';
import { defineExecutableTool } from '@/core/tools/registry/spec';
import {
  finalizeProjectedToolResultV2,
  freezeRuntimeOutputSchemaV2,
  resolveBuiltinToolResultBudgetV2,
  STREAM_TOOL_RESULT_BUDGET_V2,
  TOOL_RESULT_UTF8_ENVELOPE_MAX_BYTES_V2,
  UTF8_TOOL_RESULT_BUDGET_V2,
  validateFrozenRuntimeOutputSchemaV2,
  validateToolModelResultBudgetV2,
} from '@/core/tools/result-budget-v2';

describe('ToolResultBudgetV2 registry and finalizer', () => {
  test('every production builtin resolves a finite, replayable binding', () => {
    expect(builtinToolSpecs.length).toBeGreaterThan(0);
    for (const spec of builtinToolSpecs) {
      const resolved = resolveBuiltinToolResultBudgetV2({
        toolName: spec.name,
        budget: spec.modelResultBudgetV2,
        governanceRevision: spec.governanceRevision,
      });
      expect(resolved.bindingDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(resolved.policyId).toBe('tool-result-budget:v2');
    }
  });

  test('rejects unknown, unbounded, and cursorless contracts', () => {
    expect(() =>
      validateToolModelResultBudgetV2({
        kind: 'serialized',
        maxUtf8Bytes: Number.POSITIVE_INFINITY,
      }),
    ).toThrow('finite positive');
    expect(() =>
      validateToolModelResultBudgetV2({
        kind: 'line_window',
        maxUtf8Bytes: 100,
        continuation: 'missing' as 'line_byte_cursor_v2',
        decoderContractId: 'decoder:v1',
      }),
    ).toThrow('line_byte_cursor_v2');
    expect(() =>
      validateToolModelResultBudgetV2({
        kind: 'structured',
        maxUtf8Bytes: 100,
        projectorId: 'unknown:v1' as 'structured-receipt:v1',
      }),
    ).toThrow('Unknown structured projector');
    expect(() =>
      validateToolModelResultBudgetV2({
        kind: 'line_window',
        maxUtf8Bytes: 100,
        continuation: 'line_byte_cursor_v2',
        decoderContractId: '',
      }),
    ).toThrow('decoderContractId');
  });

  test('read line-window binding identity includes the decoder contract', () => {
    const first = resolveBuiltinToolResultBudgetV2({
      toolName: 'read_file',
      budget: {
        kind: 'line_window',
        maxUtf8Bytes: 1_024,
        continuation: 'line_byte_cursor_v2',
        decoderContractId: 'decoder:v1',
      },
    });
    const second = resolveBuiltinToolResultBudgetV2({
      toolName: 'read_file',
      budget: {
        kind: 'line_window',
        maxUtf8Bytes: 1_024,
        continuation: 'line_byte_cursor_v2',
        decoderContractId: 'decoder:v2',
      },
    });
    expect(first.bindingDigest).not.toBe(second.bindingDigest);
  });

  test('frozen output schema strips only annotations and deep-freezes real property names', () => {
    const frozen = freezeRuntimeOutputSchemaV2({
      type: 'object',
      title: 'root annotation',
      description: 'root prose',
      default: {},
      properties: {
        title: { type: 'string', description: 'property schema prose' },
        description: { type: 'number' },
        default: { type: 'boolean' },
        nested: {
          type: 'object',
          properties: { title: { type: 'integer' } },
        },
      },
    });
    expect(frozen.status).toBe('frozen');
    if (frozen.status !== 'frozen') throw new Error('expected frozen schema');
    expect(frozen.schema).not.toHaveProperty('title');
    expect(frozen.schema).not.toHaveProperty('description');
    expect(frozen.schema).not.toHaveProperty('default');
    expect(frozen.schema).toMatchObject({
      properties: {
        title: { type: 'string' },
        description: { type: 'number' },
        default: { type: 'boolean' },
        nested: { properties: { title: { type: 'integer' } } },
      },
    });
    expect(JSON.stringify(frozen.schema)).not.toContain('property schema prose');
    const properties = frozen.schema.properties as Record<string, Record<string, unknown>>;
    expect(Object.isFrozen(frozen.schema)).toBe(true);
    expect(Object.isFrozen(properties)).toBe(true);
    expect(Object.isFrozen(properties.nested?.properties)).toBe(true);
    try {
      properties.title!.type = 'number';
    } catch {
      // Strict-mode mutation of the frozen schema is expected to throw.
    }
    expect(properties.title?.type).toBe('string');
    expect(() => validateFrozenRuntimeOutputSchemaV2(frozen)).not.toThrow();

    const tampered = structuredClone(frozen);
    const tamperedProperties = tampered.schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    tamperedProperties.title!.type = 'number';
    expect(() => validateFrozenRuntimeOutputSchemaV2(tampered)).toThrow(
      'canonical digest validation',
    );
  });

  test('compat mode preserves model bytes while budget mode bounds the full UTF-8 envelope', () => {
    const resolved = resolveBuiltinToolResultBudgetV2({
      toolName: 'sample',
      budget: { kind: 'serialized', maxUtf8Bytes: 32 },
    });
    const projected = {
      ok: true,
      modelContent: '🙂'.repeat(40),
      resultMeta: {},
    };
    const compat = finalizeProjectedToolResultV2({
      rawResult: { text: projected.modelContent },
      projected,
      resolvedBudget: resolved,
      projectionMode: 'compat_v1',
    });
    expect(compat.modelContent).toBe(projected.modelContent);
    expect(compat.receipt.projectionMode).toBe('compat_v1');

    const bounded = finalizeProjectedToolResultV2({
      rawResult: { text: projected.modelContent },
      projected,
      resolvedBudget: resolved,
      projectionMode: 'budget_v2',
    });
    expect(Buffer.byteLength(bounded.modelContent, 'utf8')).toBeLessThanOrEqual(32);
    expect(bounded.modelContent).not.toContain('\ufffd');
    expect(bounded.receipt.rawResultDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(bounded.receipt.modelContentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('structured truncation always returns bounded valid JSON', () => {
    const resolved = resolveBuiltinToolResultBudgetV2({
      toolName: 'structured-sample',
      budget: { kind: 'structured', maxUtf8Bytes: 32, projectorId: 'structured-receipt:v1' },
    });
    for (const content of [JSON.stringify({ value: 'x'.repeat(1_000) }), '{invalid-json']) {
      const finalized = finalizeProjectedToolResultV2({
        rawResult: { content },
        projected: { ok: true, modelContent: content, resultMeta: {} },
        resolvedBudget: resolved,
        projectionMode: 'budget_v2',
      });
      expect(() => JSON.parse(finalized.modelContent)).not.toThrow();
      expect(Buffer.byteLength(finalized.modelContent, 'utf8')).toBeLessThanOrEqual(32);
    }
  });

  test('stream head-tail budget is the exact complete-envelope bound at 4000/+1', () => {
    const resolved = resolveBuiltinToolResultBudgetV2({
      toolName: 'stream-sample',
      budget: STREAM_TOOL_RESULT_BUDGET_V2,
    });
    for (const length of [4_000, 4_001]) {
      const stdout = 'x'.repeat(length);
      const finalized = finalizeProjectedToolResultV2({
        rawResult: { stdout, stderr: '' },
        projected: {
          ok: true,
          modelContent: stdout,
          streams: { stdout, stderr: '' },
          resultMeta: {},
        },
        resolvedBudget: resolved,
        projectionMode: 'budget_v2',
      });
      expect(finalized.streams).toBeDefined();
      if (!finalized.streams) throw new Error('expected finalized stream projection');
      expect(finalized.streams?.stdout.length).toBe(Math.min(length, 4_000));
      expect(finalized.modelContent).toBe(finalized.streams.stdout);
      expect(finalized.receipt.streamProjection?.stdoutChars).toBe(Math.min(length, 4_000));
      if (length > 4_000) expect(finalized.streams?.stdout).toContain('stream-head-tail:v1');
    }
  });

  test('projection failure after execute is typed, non-retryable, and retains effect certainty', async () => {
    const spec = defineExecutableTool({
      name: 'projection_failure_fixture',
      kind: 'computer',
      contract: {
        summary: 'Projection failure fixture.',
        useWhen: 'Testing post-execution projection failure handling.',
        returns: { format: 'json', description: 'A bounded failure receipt.' },
      },
      inputSchema: z.object({}),
      declaredEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
      minimumApproval: 'none',
      modelResultBudgetV2: UTF8_TOOL_RESULT_BUDGET_V2,
      effects: () => ({
        effectClass: 'workspace_write',
        sideEffect: true,
        classificationReason: 'fixture',
      }),
      execute: async () => ({ secret: 'executed-secret' }),
      projectResult: () => {
        throw new Error('raw projector secret');
      },
    });
    const result = await dispatchRegisteredTool(spec, {}, { workspace: '/' });
    expect(result.dispatched).toBe(true);
    if (!result.dispatched) throw new Error('expected executed projection result');
    expect(result.projected.resultMeta.projectionFailure).toMatchObject({
      kind: 'projection_failed_after_execution',
      retryable: false,
      executionCertainty: 'executed',
      knownExternalEffects: 'unknown',
    });
    expect(result.projected.modelContent).not.toContain('executed-secret');
    expect(result.projected.modelContent).not.toContain('raw projector secret');
    expect(result.projected.resultMeta.toolResultReceipt).toMatchObject({
      toolIdentity: 'builtin:core-tool-failure:v1',
      projectionMode: 'compat_v1',
    });
  });

  test('registry dispatch selects compat or budget provenance without changing small result bytes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-result-budget-'));
    try {
      writeFileSync(join(workspace, 'small.txt'), 'one\ntwo\n');
      const compat = await dispatchRegisteredTool(
        readFileSpec,
        { path: 'small.txt' },
        { workspace, featureFlags: { toolResultBudgetV2: false } as never },
      );
      const budget = await dispatchRegisteredTool(
        readFileSpec,
        { path: 'small.txt' },
        { workspace, featureFlags: { toolResultBudgetV2: true } as never },
      );
      expect(compat.dispatched && compat.projected.modelContent).toBe('1|one\n2|two\n3|');
      expect(budget.dispatched && budget.projected.modelContent).toBe('1|one\n2|two');
      if (compat.dispatched && budget.dispatched) {
        expect(compat.projected.resultMeta.toolResultReceipt?.projectionMode).toBe('compat_v1');
        expect(budget.projected.resultMeta.toolResultReceipt?.projectionMode).toBe('budget_v2');
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('read_file line_byte_cursor_v2', () => {
  test('rejects a forged cursor whose byte offset starts inside a UTF-8 scalar', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-read-forged-cursor-'));
    try {
      writeFileSync(join(workspace, 'unicode.txt'), '🙂abc\n');
      const first = readFileWindowV2({
        workspace,
        path: 'unicode.txt',
        limit: 1,
        maxUtf8Bytes: 5,
      });
      const identity = first.continuation.cursor!;
      const forged = readFileWindowV2({
        workspace,
        path: 'unicode.txt',
        cursor: { ...identity, utf8ByteOffsetInLine: 1 },
        maxUtf8Bytes: 32,
      });
      expect(forged.ok).toBe(false);
      expect(forged.error).toBe('stale_continuation');
      expect(forged.content).not.toContain('\ufffd');

      for (const forgedCursor of [
        { ...identity, endLineExclusive: identity.endLineExclusive + 1 },
        { ...identity, lineOffset: identity.lineOffset + 1 },
      ]) {
        const rejected = readFileWindowV2({
          workspace,
          path: 'unicode.txt',
          cursor: forgedCursor,
          maxUtf8Bytes: 32,
        });
        expect(rejected.ok).toBe(false);
        expect(rejected.error).toBe('stale_continuation');
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('advances inside a huge Unicode line without splitting UTF-8 and never crosses the window', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-read-cursor-'));
    try {
      writeFileSync(join(workspace, 'huge.txt'), `${'🙂'.repeat(80)}\nsecond\nthird\n`);
      const first = readFileWindowV2({
        workspace,
        path: 'huge.txt',
        offset: 1,
        limit: 1,
        maxUtf8Bytes: 37,
      });
      expect(first.ok).toBe(true);
      expect(Buffer.byteLength(first.content, 'utf8')).toBeLessThanOrEqual(37);
      expect(first.content).not.toContain('\ufffd');
      expect(first.continuation.status).toBe('partial');
      const cursor = first.continuation.cursor;
      expect(cursor?.lineOffset).toBe(1);
      expect(cursor?.utf8ByteOffsetInLine).toBeGreaterThan(0);
      expect(cursor?.endLineExclusive).toBe(2);

      const second = readFileWindowV2({
        workspace,
        path: 'huge.txt',
        cursor: cursor!,
        maxUtf8Bytes: 37,
      });
      expect(second.content).not.toContain('second');
      expect(second.continuation.cursor?.utf8ByteOffsetInLine).toBeGreaterThan(
        cursor!.utf8ByteOffsetInLine,
      );
      expect(second.continuation.cursor?.windowIdentity).toBe(cursor!.windowIdentity);
      expect(second.continuation.cursor?.cursorDigest).not.toBe(cursor!.cursorDigest);
      const deterministic = readFileWindowV2({
        workspace,
        path: 'huge.txt',
        cursor: cursor!,
        maxUtf8Bytes: 37,
      });
      expect(deterministic.continuation.cursor).toEqual(second.continuation.cursor);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('BOM/UTF-16/EOL-only changes keep revision stable, content changes are stale', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-read-revision-'));
    const path = join(workspace, 'revision.txt');
    try {
      const text = `${'alpha'.repeat(20)}\nbeta\n`;
      writeFileSync(path, text, 'utf8');
      const first = readFileWindowV2({
        workspace,
        path: 'revision.txt',
        offset: 1,
        limit: 2,
        maxUtf8Bytes: 24,
      });
      const cursor = first.continuation.cursor!;

      const utf16le = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(text.replace(/\n/g, '\r\n'), 'utf16le'),
      ]);
      writeFileSync(path, utf16le);
      const same = readFileWindowV2({
        workspace,
        path: 'revision.txt',
        cursor,
        maxUtf8Bytes: 24,
      });
      expect(same.continuation.status).not.toBe('stale_continuation');

      const utf16beBody = Buffer.from(text.replace(/\n/g, '\r\n'), 'utf16le');
      for (let index = 0; index + 1 < utf16beBody.length; index += 2) {
        const byte = utf16beBody[index]!;
        utf16beBody[index] = utf16beBody[index + 1]!;
        utf16beBody[index + 1] = byte;
      }
      writeFileSync(path, Buffer.concat([Buffer.from([0xfe, 0xff]), utf16beBody]));
      const sameBe = readFileWindowV2({
        workspace,
        path: 'revision.txt',
        cursor,
        maxUtf8Bytes: 24,
      });
      expect(sameBe.continuation.status).not.toBe('stale_continuation');

      writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]));
      const sameUtf8Bom = readFileWindowV2({
        workspace,
        path: 'revision.txt',
        cursor,
        maxUtf8Bytes: 24,
      });
      expect(sameUtf8Bom.continuation.status).not.toBe('stale_continuation');

      writeFileSync(path, `${text}changed`, 'utf8');
      const stale = readFileWindowV2({
        workspace,
        path: 'revision.txt',
        cursor,
        maxUtf8Bytes: 24,
      });
      expect(stale.ok).toBe(false);
      expect(stale.error).toBe('stale_continuation');
      expect(stale.continuation.status).toBe('stale_continuation');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('limit omission reads to EOF and continuation advances across repeated chunks', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-read-repeat-'));
    try {
      writeFileSync(join(workspace, 'repeat.txt'), `${'🙂'.repeat(30)}\nsecond\nthird\n`);
      let result = readFileWindowV2({
        workspace,
        path: 'repeat.txt',
        offset: 1,
        maxUtf8Bytes: 31,
      });
      const offsets: number[] = [];
      for (let attempt = 0; result.continuation.cursor && attempt < 20; attempt += 1) {
        offsets.push(result.continuation.cursor.utf8ByteOffsetInLine);
        result = readFileWindowV2({
          workspace,
          path: 'repeat.txt',
          cursor: result.continuation.cursor,
          maxUtf8Bytes: 31,
        });
        expect(result.content).not.toContain('\ufffd');
      }
      expect(result.continuation.status).toBe('completed');
      expect(offsets.length).toBeGreaterThan(1);
      expect(
        offsets.every(
          (offset, index) => index === 0 || offset === 0 || offset > offsets[index - 1]!,
        ),
      ).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('invalid UTF-8 is rejected without force and remains bounded when explicitly forced', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-read-invalid-'));
    try {
      writeFileSync(join(workspace, 'invalid.bin'), Buffer.from([0xc3, 0x28, 0xff, 0x61]));
      const rejected = readFileWindowV2({
        workspace,
        path: 'invalid.bin',
        maxUtf8Bytes: 64,
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.error).toContain('not valid UTF-8');
      const forced = readFileWindowV2({
        workspace,
        path: 'invalid.bin',
        maxUtf8Bytes: 64,
        force: true,
      });
      expect(forced.ok).toBe(true);
      expect(forced.content).toContain('\ufffd');
      expect(Buffer.byteLength(forced.content, 'utf8')).toBeLessThanOrEqual(64);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('offset beyond EOF completes empty without a cursor', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-read-empty-'));
    try {
      writeFileSync(join(workspace, 'short.txt'), 'one\n');
      const result = readFileWindowV2({
        workspace,
        path: 'short.txt',
        offset: 2,
        maxUtf8Bytes: TOOL_RESULT_UTF8_ENVELOPE_MAX_BYTES_V2,
      });
      expect(result.content).toBe('');
      expect(result.continuation).toEqual({
        kind: 'line_byte_cursor_v2',
        status: 'completed_empty',
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('the shared default contract is exactly the 128 KiB UTF-8 envelope', () => {
    expect(UTF8_TOOL_RESULT_BUDGET_V2).toEqual({
      kind: 'serialized',
      maxUtf8Bytes: 128 * 1_024,
    });
  });
});

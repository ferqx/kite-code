import { describe, expect, test } from 'bun:test';
import { aiMessage } from '@/core/messages';
import type { ToolCallBlockFrame } from '@/core/model/context-frame';
import {
  oversizedBlockOffloadStubV1,
  tryProjectOversizedToolBlockV1,
} from '@/core/model/oversized-block-offload';
import { projectedModelContentDigest } from '@/core/tools/registry/projection';
import { type ToolResultBudgetReceiptV2, toolResultDigestV2 } from '@/core/tools/result-budget-v2';

const available = new Set(['read_file', 'search_content', 'search_files']);

function receipt(content: string): ToolResultBudgetReceiptV2 {
  const raw = toolResultDigestV2('test-raw:v1', content);
  return {
    version: 2,
    projectionMode: 'budget_v2',
    policyId: 'test-budget:v2',
    toolIdentity: 'builtin:test',
    bindingDigest: 'a'.repeat(64),
    projectorId: 'utf8-envelope:v1',
    projectorRevision: 'test-projector:v1',
    validatorId: 'test-validator:v1',
    rawResultDigest: raw,
    modelContentDigest: projectedModelContentDigest(content),
    modelContentUtf8Bytes: Buffer.byteLength(content, 'utf8'),
  };
}

function block(input?: {
  calls?: Array<{
    id: string;
    name: string;
    content?: string;
    ok?: boolean;
    effectClass?: 'read_only' | 'workspace_write' | 'external_side_effect' | 'unknown';
    args?: Record<string, unknown>;
    resultMeta?: Record<string, unknown>;
  }>;
  mismatchAssistantCall?: boolean;
  mismatchAssistantArgs?: boolean;
}): ToolCallBlockFrame {
  const calls = input?.calls ?? [
    {
      id: 'read-1',
      name: 'read_file',
      content: 'line\n'.repeat(2_000),
      args: { path: 'src/example.ts', offset: 1, limit: 2000 },
    },
  ];
  return {
    kind: 'tool_block',
    assistantMessageId: 'assistant-1',
    turnId: 'turn-1',
    assistantContent: '',
    assistantMessage: aiMessage({
      id: 'assistant-1',
      content: '',
      tool_calls: calls.map((call) => ({
        id: input?.mismatchAssistantCall ? `${call.id}-wrong` : call.id,
        name: call.name,
        args: input?.mismatchAssistantArgs
          ? { path: 'src/other.ts' }
          : (call.args ?? { path: 'src/example.ts' }),
      })),
    }),
    calls: calls.map((call) => {
      const content = call.content ?? 'large result\n'.repeat(2_000);
      const resultReceipt = receipt(content);
      const requestedPath = call.args?.path;
      return {
        toolCallId: call.id,
        name: call.name,
        content,
        ok: call.ok ?? true,
        effectClass: call.effectClass ?? 'read_only',
        args: call.args ?? { path: 'src/example.ts' },
        resultMeta: {
          path: typeof requestedPath === 'string' ? requestedPath : 'src/example.ts',
          rawResultDigest: resultReceipt.rawResultDigest,
          modelContentDigest: resultReceipt.modelContentDigest,
          digestScope: 'raw' as const,
          toolResultReceipt: resultReceipt,
          ...call.resultMeta,
        },
      };
    }),
  };
}

describe('oversized atomic block offload', () => {
  test('replaces every verified available read-only result with deterministic replay stubs', () => {
    const original = block({
      calls: [
        {
          id: 'read-1',
          name: 'read_file',
          content: 'alpha\n'.repeat(2_000),
          args: { path: 'src/a.ts', offset: 1, limit: 2000 },
        },
        {
          id: 'find-1',
          name: 'search_files',
          content: 'src/a.ts\n'.repeat(2_000),
          args: { path: 'src', pattern: '*.ts' },
        },
      ],
    });
    const before = JSON.stringify(original);
    const result = tryProjectOversizedToolBlockV1({
      frame: original,
      availableToolNames: available,
    });

    expect(result.status).toBe('offloaded');
    if (result.status !== 'offloaded') throw new Error('expected offload');
    expect(result.offloadedToolResultCount).toBe(2);
    expect(result.savedTokens).toBeGreaterThan(0);
    expect(result.projectedTokens).toBeLessThan(result.originalTokens);
    expect(result.projectedBytes).toBeLessThan(result.originalBytes);
    const firstStub = JSON.parse(result.frame.calls[0]!.content) as Record<string, unknown>;
    const firstStubTokens = firstStub.originalTokens;
    expect(firstStub).toMatchObject({
      version: 1,
      tool: 'read_file',
      originalTokens: firstStubTokens,
      originalBytes: Buffer.byteLength(original.calls[0]!.content, 'utf8'),
      digest: {
        raw: original.calls[0]!.resultMeta!.rawResultDigest,
        projected: original.calls[0]!.resultMeta!.modelContentDigest,
      },
      replay: 'replay_tool_call_with_original_arguments',
    });
    expect(result.frame.calls[0]!.content).toBe(
      oversizedBlockOffloadStubV1({
        toolCallId: original.calls[0]!.toolCallId,
        tool: 'read_file',
        originalTokens: firstStubTokens as number,
        originalBytes: Buffer.byteLength(original.calls[0]!.content, 'utf8'),
        rawResultDigest: original.calls[0]!.resultMeta!.rawResultDigest!,
        modelContentDigest: original.calls[0]!.resultMeta!.modelContentDigest!,
      }),
    );
    expect(result.frame.calls[0]!.content).toContain(
      '"replay":"replay_tool_call_with_original_arguments"',
    );
    expect(result.frame.calls[0]!.content).not.toContain('alpha');
    expect(result.frame.calls[0]!.resultMeta).toEqual(original.calls[0]!.resultMeta);
    expect(JSON.stringify(original)).toBe(before);
  });

  test.each([
    ['invalid_pairing', block({ mismatchAssistantCall: true }), available],
    ['invalid_pairing', block({ mismatchAssistantArgs: true }), available],
    [
      'unsupported_or_mixed_tool',
      block({ calls: [{ id: 'write', name: 'write_file' }] }),
      available,
    ],
    ['tool_unavailable', block(), new Set(['search_content'])],
    [
      'unsuccessful_result',
      block({ calls: [{ id: 'read', name: 'read_file', ok: false }] }),
      available,
    ],
    [
      'not_read_only',
      block({ calls: [{ id: 'read', name: 'read_file', effectClass: 'workspace_write' }] }),
      available,
    ],
    [
      'legacy_provenance',
      block({
        calls: [
          {
            id: 'read',
            name: 'read_file',
            resultMeta: {
              terminalMigration: {
                kind: 'legacy_unverified',
                migratedFromSchemaVersion: 21,
                originalEventPosition: 1,
              },
            },
          },
        ],
      }),
      available,
    ],
    [
      'missing_digest',
      block({
        calls: [{ id: 'read', name: 'read_file', resultMeta: { rawResultDigest: undefined } }],
      }),
      available,
    ],
    [
      'digest_mismatch',
      block({
        calls: [
          { id: 'read', name: 'read_file', resultMeta: { modelContentDigest: 'b'.repeat(64) } },
        ],
      }),
      available,
    ],
    [
      'missing_locator',
      block({ calls: [{ id: 'read', name: 'read_file', args: { path: '' } }] }),
      available,
    ],
  ] as const)('rejects %s without partially modifying the block', (reason, frame, availableTools) => {
    const before = JSON.stringify(frame);
    expect(tryProjectOversizedToolBlockV1({ frame, availableToolNames: availableTools })).toEqual({
      status: 'unavailable',
      reason,
    });
    expect(JSON.stringify(frame)).toBe(before);
  });

  test('rejects when deterministic references are not actually smaller', () => {
    const frame = block({ calls: [{ id: 'read', name: 'read_file', content: 'ok' }] });
    expect(tryProjectOversizedToolBlockV1({ frame, availableToolNames: available })).toEqual({
      status: 'unavailable',
      reason: 'no_positive_saving',
    });
  });
});

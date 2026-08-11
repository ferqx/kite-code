import { describe, expect, test } from 'bun:test';
import { aiMessage, humanMessage } from '@/core/messages';
import type { ContextFrame, ToolCallBlockFrame } from '@/core/model/context-frame';
import {
  applyContextReclaimPlan,
  digestRawContextProjection,
  planContextReclaim,
  reclaimStubV1,
} from '@/core/model/context-reclaim';
import { serializeFramesToMessages } from '@/core/model/context-serializer';
import { validateFramePairs, validateMessagePairs } from '@/core/model/context-validator';
import { projectedModelContentDigest } from '@/core/tools/registry/projection';
import type { ToolResultBudgetReceiptV2 } from '@/core/tools/result-budget-v2';

function verifiedReceipt(content: string): ToolResultBudgetReceiptV2 {
  return {
    version: 2,
    projectionMode: 'budget_v2',
    policyId: 'test-budget:v2',
    toolIdentity: 'builtin:test',
    bindingDigest: 'd'.repeat(64),
    projectorId: 'utf8-envelope:v1',
    projectorRevision: 'test-projector:v1',
    validatorId: 'test-validator:v1',
    rawResultDigest: 'a'.repeat(64),
    modelContentDigest: projectedModelContentDigest(content),
    modelContentUtf8Bytes: Buffer.byteLength(content, 'utf8'),
  };
}

function toolBlock(input: {
  frameId: string;
  turnId?: string;
  calls: Array<{
    id: string;
    name: string;
    content?: string;
    ok?: boolean;
    args?: Record<string, unknown>;
    digestScope?: 'raw' | 'projected' | 'legacy_unknown';
    mutation?: string[];
    effectClass?: 'read_only' | 'workspace_write' | 'external_side_effect' | 'unknown';
    migrated?: boolean;
  }>;
}): ToolCallBlockFrame {
  const turnId = input.turnId ?? 'historical-turn';
  return {
    kind: 'tool_block',
    assistantMessageId: input.frameId,
    turnId,
    assistantContent: '',
    assistantMessage: Object.assign(
      aiMessage({
        id: input.frameId,
        content: '',
        tool_calls: input.calls.map((call) => ({
          id: call.id,
          name: call.name,
          args: call.args ?? { path: 'src/example.ts' },
        })),
      }),
      { turnId },
    ),
    calls: input.calls.map((call) => {
      const content = call.content ?? `1|${'historical tool output '.repeat(100)}`;
      return {
        toolCallId: call.id,
        name: call.name,
        content,
        ok: call.ok ?? true,
        args: call.args ?? { path: 'src/example.ts' },
        effectClass: call.effectClass ?? 'read_only',
        resultMeta: {
          path: 'src/example.ts',
          modelContentDigest: projectedModelContentDigest(content),
          rawResultDigest: 'a'.repeat(64),
          digestScope: call.digestScope ?? 'raw',
          toolResultReceipt: verifiedReceipt(content),
          ...(call.migrated
            ? {
                terminalMigration: {
                  kind: 'legacy_unverified' as const,
                  migratedFromSchemaVersion: 21 as const,
                  originalEventPosition: 1,
                },
              }
            : {}),
          ...(call.mutation ? { workspaceMutationScope: call.mutation } : {}),
        },
      };
    }),
  };
}

function plan(frames: ContextFrame[], activeTurnId = 'active-turn') {
  return planContextReclaim({
    frames,
    rawProjectionDigest: 'b'.repeat(64),
    environmentDigest: 'c'.repeat(64),
    pressure: 'warning',
    activeTurnId,
  });
}

function recentSettledFrames(): ContextFrame[] {
  return ['recent-turn-1', 'recent-turn-2'].map((turnId) => ({
    kind: 'user' as const,
    turnId,
    message: Object.assign(humanMessage({ id: `user-${turnId}`, content: turnId }), { turnId }),
  }));
}

describe('context reclaim planner and applier', () => {
  test('selects old successful read/search blocks and emits the unique stable stub', () => {
    const original = toolBlock({
      frameId: 'assistant-read',
      calls: [
        {
          id: 'read-1',
          name: 'read_file',
          args: { path: 'src/example.ts', limit: 20 },
        },
      ],
    });
    const frames: ContextFrame[] = [original, ...recentSettledFrames()];
    const before = JSON.stringify(frames);
    const reclaim = plan(frames);

    expect(reclaim.selectedBlockCount).toBe(1);
    expect(reclaim.selected).toHaveLength(1);
    expect(reclaim.estimatedSavedChars).toBeGreaterThan(0);
    expect(reclaim.estimatedSavedTokens).toBeGreaterThan(0);
    expect(JSON.stringify(reclaim)).not.toContain('src/example.ts');
    expect(JSON.stringify(frames)).toBe(before);

    const applied = applyContextReclaimPlan(frames, reclaim);
    expect(applied.status).toBe('applied');
    const appliedBlock = applied.frames[0] as ToolCallBlockFrame;
    const stub = reclaimStubV1({
      tool: 'read_file',
      originalChars: original.calls[0]!.content.length,
    });
    expect(appliedBlock.calls[0]!.content).toBe(stub);
    expect(stub).toBe(
      `{"version":1,"reclaimed":true,"tool":"read_file","originalChars":${original.calls[0]!.content.length},"replay":"repeat_tool_call_with_original_arguments"}`,
    );
    expect(stub).not.toContain('src/example.ts');
    expect(stub).not.toContain('historical tool output');
    expect(stub).not.toContain('aaaa');
    expect(appliedBlock.calls[0]!.args).toEqual({
      path: 'src/example.ts',
      limit: 20,
    });
    expect(appliedBlock.calls[0]!.resultMeta).toEqual(original.calls[0]!.resultMeta);
    validateFramePairs(applied.frames);
    validateMessagePairs(serializeFramesToMessages(applied.frames));

    const repeated = applyContextReclaimPlan(applied.frames, reclaim);
    expect(repeated.status).toBe('already_applied');
    expect(JSON.stringify(repeated.frames)).toBe(JSON.stringify(applied.frames));
  });

  test('fails closed for current, mixed, unsuccessful, effectful, legacy, mutated and locatorless blocks', () => {
    const locatorless = toolBlock({
      frameId: 'locatorless',
      calls: [
        {
          id: 'locatorless-search',
          name: 'search_content',
          args: { pattern: 'x' },
        },
      ],
    });
    const frames: ContextFrame[] = [
      toolBlock({
        frameId: 'current',
        turnId: 'active-turn',
        calls: [{ id: 'current-read', name: 'read_file' }],
      }),
      toolBlock({
        frameId: 'mixed',
        calls: [
          { id: 'mixed-read', name: 'read_file' },
          {
            id: 'mixed-shell',
            name: 'shell_execute',
            args: { command: 'pwd' },
          },
        ],
      }),
      toolBlock({
        frameId: 'failed',
        calls: [{ id: 'failed-read', name: 'read_file', ok: false }],
      }),
      toolBlock({
        frameId: 'effectful',
        calls: [
          {
            id: 'effect-read',
            name: 'read_file',
            effectClass: 'workspace_write',
          },
        ],
      }),
      toolBlock({
        frameId: 'legacy',
        calls: [
          {
            id: 'legacy-read',
            name: 'read_file',
            digestScope: 'legacy_unknown',
          },
        ],
      }),
      toolBlock({
        frameId: 'migrated',
        calls: [{ id: 'migrated-read', name: 'read_file', migrated: true }],
      }),
      toolBlock({
        frameId: 'mutated',
        calls: [
          {
            id: 'mutated-read',
            name: 'read_file',
            mutation: ['src/example.ts'],
          },
        ],
      }),
      {
        ...locatorless,
        calls: [
          {
            ...locatorless.calls[0]!,
            resultMeta: {
              ...locatorless.calls[0]!.resultMeta,
              path: undefined,
            },
          },
        ],
      },
    ];

    const reclaim = plan(frames);
    expect(reclaim.selected).toEqual([]);
    expect(reclaim.rejectionCounts).toEqual({
      current_turn: 1,
      unsupported_or_mixed_tool: 1,
      unsuccessful_result: 1,
      not_read_only: 1,
      legacy_provenance: 2,
      workspace_mutation: 1,
      missing_locator: 1,
    });
  });

  test('keeps the active, two most recent settled turns, and checkpoint uncovered tail raw', () => {
    const frames: ContextFrame[] = [
      toolBlock({
        frameId: 'old',
        turnId: 'old-turn',
        calls: [{ id: 'old-read', name: 'read_file' }],
      }),
      toolBlock({
        frameId: 'recent-1',
        turnId: 'recent-turn-1',
        calls: [{ id: 'recent-read-1', name: 'read_file' }],
      }),
      toolBlock({
        frameId: 'recent-2',
        turnId: 'recent-turn-2',
        calls: [{ id: 'recent-read-2', name: 'read_file' }],
      }),
      toolBlock({
        frameId: 'active',
        turnId: 'active-turn',
        calls: [{ id: 'active-read', name: 'read_file' }],
      }),
    ];

    const reclaim = plan(frames);
    expect(reclaim.selected.map((entry) => entry.toolCallId)).toEqual(['old-read']);
    expect(reclaim.rejectionCounts).toEqual({ recent_turn: 2, current_turn: 1 });

    const uncoveredTail = planContextReclaim({
      frames,
      rawProjectionDigest: 'b'.repeat(64),
      environmentDigest: 'c'.repeat(64),
      pressure: 'warning',
      activeTurnId: 'active-turn',
      checkpointBoundary: 'checkpoint-boundary',
      preserveUncoveredTail: true,
    });
    expect(uncoveredTail.selected).toEqual([]);
    expect(uncoveredTail.rejectionCounts).toEqual({ uncovered_tail: 3, current_turn: 1 });
  });

  test('keeps a multi-call block atomic and rejects mismatched inputs without mutation', () => {
    const block = toolBlock({
      frameId: 'multi-search',
      calls: [
        {
          id: 'search-1',
          name: 'search_files',
          args: { path: '.', pattern: '*.ts' },
        },
        {
          id: 'search-2',
          name: 'search_content',
          args: { path: '.', pattern: 'needle', glob: '*.ts' },
        },
      ],
    });
    const frames: ContextFrame[] = [block, ...recentSettledFrames()];
    const reclaim = plan(frames);
    expect(reclaim.selectedBlockCount).toBe(1);
    expect(reclaim.selected.map((entry) => entry.toolCallId)).toEqual(['search-1', 'search-2']);

    const changed: ContextFrame[] = [
      {
        ...block,
        calls: [{ ...block.calls[0]!, content: 'changed' }, block.calls[1]!],
      },
      ...recentSettledFrames(),
    ];
    const before = JSON.stringify(changed);
    const rejected = applyContextReclaimPlan(changed, reclaim);
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: 'raw_frames_mismatch',
    });
    expect(JSON.stringify(changed)).toBe(before);

    const partialPlan = {
      ...reclaim,
      selected: reclaim.selected.slice(0, 1),
      selectedBlockCount: 1,
    };
    expect(applyContextReclaimPlan(frames, partialPlan)).toMatchObject({
      status: 'rejected',
      reason: 'plan_structure_mismatch',
    });

    const wrongHeader = {
      ...reclaim,
      policyId: 'context-reclaim:forged',
    } as unknown as typeof reclaim;
    expect(applyContextReclaimPlan(frames, wrongHeader)).toMatchObject({
      status: 'rejected',
      reason: 'plan_header_mismatch',
    });
  });

  test('rejects mismatched model-content identity and non-replayable read locators', () => {
    const wrongDigest = toolBlock({
      frameId: 'wrong-digest',
      calls: [{ id: 'read-wrong-digest', name: 'read_file' }],
    });
    wrongDigest.calls[0]!.resultMeta!.modelContentDigest = 'b'.repeat(64);
    const missingPath = toolBlock({
      frameId: 'missing-path',
      calls: [{ id: 'read-missing-path', name: 'read_file', args: { limit: 20 } }],
    });
    const mismatchedPath = toolBlock({
      frameId: 'mismatched-path',
      calls: [
        {
          id: 'read-mismatched-path',
          name: 'read_file',
          args: { path: 'src/other.ts' },
        },
      ],
    });

    const reclaim = plan([wrongDigest, missingPath, mismatchedPath]);
    expect(reclaim.selected).toEqual([]);
    expect(reclaim.rejectionCounts).toEqual({
      model_content_digest_mismatch: 1,
      missing_locator: 2,
    });
  });

  test('binds stable raw projection, raw frame and applied frame identities', () => {
    const frames: ContextFrame[] = [
      toolBlock({
        frameId: 'stable',
        calls: [{ id: 'read-stable', name: 'read_file' }],
      }),
      ...recentSettledFrames(),
    ];
    const firstProjection = digestRawContextProjection({
      providerMessages: serializeFramesToMessages(frames),
      estimate: {
        systemTokens: 1,
        toolSchemaTokens: 2,
        transcriptTokens: 3,
        summaryTokens: 4,
        dynamicRuntimeTokens: 5,
        framingTokens: 6,
        totalInputTokens: 21,
      },
      environmentDigest: 'e'.repeat(64),
      pressure: {
        status: 'warning',
        utilization: 0.81,
        usableInputTokens: 100,
      },
    });
    const secondProjection = digestRawContextProjection({
      providerMessages: serializeFramesToMessages(structuredClone(frames)),
      estimate: {
        systemTokens: 1,
        toolSchemaTokens: 2,
        transcriptTokens: 3,
        summaryTokens: 4,
        dynamicRuntimeTokens: 5,
        framingTokens: 6,
        totalInputTokens: 21,
      },
      environmentDigest: 'e'.repeat(64),
      pressure: {
        status: 'warning',
        utilization: 0.81,
        usableInputTokens: 100,
      },
    });
    expect(secondProjection).toBe(firstProjection);

    const first = planContextReclaim({
      frames,
      rawProjectionDigest: firstProjection,
      environmentDigest: 'e'.repeat(64),
      pressure: 'warning',
    });
    const second = planContextReclaim({
      frames: structuredClone(frames),
      rawProjectionDigest: secondProjection,
      environmentDigest: 'e'.repeat(64),
      pressure: 'warning',
    });
    expect(second).toEqual(first);
    expect(first.rawFramesDigest).not.toBe(first.appliedFramesDigest);
  });

  test('reports invalid tool pairing instead of constructing a partial plan', () => {
    const broken = toolBlock({
      frameId: 'broken',
      calls: [{ id: 'read-broken', name: 'read_file' }],
    });
    broken.calls = [];
    const reclaim = plan([broken]);
    expect(reclaim.selected).toEqual([]);
    expect(reclaim.rejectionCounts).toEqual({ invalid_pairing: 1 });
    expect(reclaim.rawFramesDigest).toBe(reclaim.appliedFramesDigest);
  });
});

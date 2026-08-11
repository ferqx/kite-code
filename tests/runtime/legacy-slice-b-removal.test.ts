import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { normalizeContextRuntimeState } from '@/core/runtime/context-compaction';
import { AgentKernel } from '@/core/runtime/kernel';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';

const ROOT = process.cwd();

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

describe('superseded Slice B removal', () => {
  test('has no producer, qualification, guard, or evidence package', () => {
    const removed = [
      'src/core/model/compaction-cache-safe-fork.ts',
      'src/core/model/compaction-source-v2.ts',
      'src/core/model/context-compactor-v2.ts',
      'src/core/model/context-compaction-qualification-v2.ts',
      'src/core/model/auto-compaction-guard-v2.ts',
      'src/core/model/context-reduction-contract-v2.ts',
      'src/core/model/context-compaction-decision.ts',
      'src/core/model/context-compaction-rollout.ts',
      'scripts/evals/context-reduction-slice-b-local-gate.ts',
      'scripts/evals/context-reduction-slice-b-real-gate.ts',
    ];
    expect(removed.filter((path) => existsSync(join(ROOT, path)))).toEqual([]);
  });

  test('isolates checkpoint-v2 and guard history from current producer modules', () => {
    const allowLegacyImports = new Set([
      'src/core/runtime/events.ts',
      'src/core/runtime/kernel.ts',
      'src/core/runtime/reducer.ts',
    ]);
    const unexpectedLegacyImports = sourceFiles(join(ROOT, 'src/core'))
      .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
      .filter(({ source }) => source.includes("from './legacy-slice-b-reader'"))
      .map(({ path }) => relative(ROOT, path))
      .filter((path) => !allowLegacyImports.has(path));
    expect(unexpectedLegacyImports).toEqual([]);

    const producerPaths = [
      'src/core/controllers/compaction-controller.ts',
      'src/core/controllers/model-controller.ts',
      'src/core/model/compaction-summary.ts',
      'src/core/model/context-preparation-v2.ts',
      'src/core/runtime/effects.ts',
      'src/core/runtime/executor.ts',
      'src/core/runtime/scheduler.ts',
    ];
    for (const path of producerPaths) {
      const source = readFileSync(join(ROOT, path), 'utf8');
      expect(source).not.toContain('cache_safe_fork:v1');
      expect(source).not.toContain('ContextCompactionCheckpointV2');
      expect(source).not.toContain('AutoCompactionGuardV2');
      expect(source).not.toContain('context.compaction_refill_observed');
      expect(source).not.toContain('context.compaction_guard_carried_forward');
      expect(source).not.toContain('context.compaction_guard_reset');
    }
  });

  test('rejects legacy guard events at the live Kernel admission boundary', () => {
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      interactionMode: 'accept_edits',
      initialState: createInitialRuntimeState({
        threadId: 'legacy-slice-b-live-admission',
        userId: 'u',
        workspace: '/',
      }),
    });
    try {
      for (const type of [
        'context.compaction_refill_observed',
        'context.compaction_guard_carried_forward',
        'context.compaction_guard_reset',
      ] as const) {
        expect(() => kernel.processEvent({ type })).toThrow(
          'Superseded Slice B events are accepted only by read-only restore.',
        );
      }
      expect(() =>
        kernel.processEvent({
          type: 'context.compaction_requested',
          compactionId: 'legacy-auto',
          reason: 'auto',
          requestedAtRevision: 0,
          requestedAtTurnId: kernel.getState().turn.turnId,
          force: false,
          estimate: {
            systemTokens: 0,
            toolSchemaTokens: 0,
            transcriptTokens: 0,
            summaryTokens: 0,
            dynamicRuntimeTokens: 0,
            framingTokens: 0,
            totalInputTokens: 0,
          },
        }),
      ).toThrow('Superseded Slice B events are accepted only by read-only restore.');
      expect(() =>
        kernel.processEvent({
          type: 'context.compaction_completed',
          compactionId: 'legacy-auto',
          sourceRevision: 0,
          checkpoint: {
            compactionId: 'legacy-auto',
            version: 1,
            sourceRevision: 0,
            sourceDigest: 'legacy-auto-source',
            coveredThroughMessageId: 'legacy-message',
            coveredThroughTurnId: kernel.getState().turn.turnId,
            summary: 'Legacy automatic summary.',
            inputTokensBefore: 2_000,
            inputTokensAfter: 500,
            reason: 'auto',
            createdAt: '2026-08-10T00:00:00.000Z',
          },
        }),
      ).toThrow('Superseded Slice B events are accepted only by read-only restore.');
      expect(store.loadEventsStrict('legacy-slice-b-live-admission')).toEqual([]);
    } finally {
      kernel.close();
    }
  });

  test('drops legacy automatic pending and both guard generations from current state', () => {
    const initial = createInitialRuntimeState({
      threadId: 'legacy-auto-state',
      userId: 'u',
      workspace: '/',
    });
    const legacy = {
      ...initial.context,
      pendingCompaction: {
        compactionId: 'legacy-auto',
        reason: 'auto',
        requestedAtRevision: 0,
        requestedAtTurnId: initial.turn.turnId,
        force: false,
        estimate: {
          systemTokens: 0,
          toolSchemaTokens: 0,
          transcriptTokens: 0,
          summaryTokens: 0,
          dynamicRuntimeTokens: 0,
          framingTokens: 0,
          totalInputTokens: 0,
        },
      },
      autoGuard: { disabledUntilManualAction: true },
      autoGuardV2: { version: 2, breaker: 'open' },
    } as unknown as typeof initial.context;
    const normalized = normalizeContextRuntimeState(legacy);
    expect(normalized.pendingCompaction).toBeUndefined();
    expect('autoGuard' in normalized).toBe(false);
    expect('autoGuardV2' in normalized).toBe(false);
  });
});

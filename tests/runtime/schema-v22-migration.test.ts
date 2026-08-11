import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentKernel,
  createAgentKernel,
  restoreAndCommitRuntimeStateV22,
  restoreRuntimeStateFromStore,
} from '@/core/runtime/kernel';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { LIMITED_RESOURCE_BUDGET_V1 } from '@/core/runtime/resource-budget';
import { planRuntimeBudgetAdmissionV1 } from '@/core/runtime/resource-budget-admission';
import {
  createInitialRuntimeState,
  RUNTIME_STATE_SCHEMA_VERSION,
  type RuntimeState,
} from '@/core/runtime/state';
import {
  createRuntimeStore,
  RuntimeRevisionConflictError,
  type RuntimeStore,
} from '@/core/runtime/store';

function temporaryStore(label: string) {
  const directory = mkdtempSync(join(tmpdir(), `openpx-schema-v22-${label}-`));
  return { directory, storePath: join(directory, 'runtime.db') };
}

function serializedLegacyFixture(threadId: string, version: number): Record<string, unknown> {
  const legacy = JSON.parse(
    JSON.stringify(createInitialRuntimeState({ threadId, userId: 'u', workspace: '/' })),
  ) as Record<string, unknown>;
  legacy.schemaVersion = version;
  for (const field of ['revision', 'lastAppliedEventId', 'appliedEventIds', 'recoveryState']) {
    delete legacy[field];
  }
  if (version < 21) delete legacy.terminalOutcome;
  if (version < 18) delete legacy.resourceBudget;
  if (version < 17) delete legacy.context;
  if (version < 13) delete legacy.skills;
  if (version < 12) delete legacy.providerAdmission;
  if (version < 11) delete legacy.verification;
  if (version < 4) {
    delete legacy.activeTaskId;
    delete legacy.tasks;
  }
  return JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>;
}

describe('runtime schema v22 exact-head migration', () => {
  test('schema-v21 pending compaction closes deterministically without replaying Provider', () => {
    for (const branch of ['not-dispatched', 'dispatch-started', 'terminal'] as const) {
      const { directory, storePath } = temporaryStore(`pending-${branch}`);
      const threadId = `pending-${branch}`;
      try {
        let state = createInitialRuntimeState({ threadId, userId: 'u', workspace: '/' });
        state.transcript.messages.push({
          kind: 'user',
          messageId: 'settled-source',
          turnId: 'settled-turn',
          ordinal: 0,
          createdAt: '2026-08-10T00:00:00.000Z',
          content: 'settled source',
        });
        state = reduceRuntimeState(state, {
          type: 'context.compaction_requested',
          compactionId: 'legacy-pending',
          reason: 'manual',
          requestedAtRevision: 0,
          requestedAtTurnId: state.turn.turnId,
          force: false,
          estimate: {
            systemTokens: 0,
            toolSchemaTokens: 0,
            transcriptTokens: 2_000,
            summaryTokens: 0,
            dynamicRuntimeTokens: 0,
            framingTokens: 0,
            totalInputTokens: 2_000,
          },
        });
        if (branch === 'dispatch-started') {
          state = reduceRuntimeState(state, {
            type: 'resource_budget.configured',
            runId: 'pending-run',
            startedAt: '2026-08-10T00:00:00.000Z',
            deadlineAt: '2026-08-10T00:20:00.000Z',
            budget: LIMITED_RESOURCE_BUDGET_V1,
          });
          const plan = planRuntimeBudgetAdmissionV1(
            state,
            { type: 'compact_context', compactionId: 'legacy-pending' },
            new Date('2026-08-10T00:00:01.000Z'),
          );
          expect(plan.status).toBe('admitted');
          state = [...plan.preparationEvents, ...plan.dispatchEvents].reduce(
            reduceRuntimeState,
            state,
          );
        }
        state = { ...state, schemaVersion: 21 };
        const store = createRuntimeStore(storePath);
        store.saveSnapshot(threadId, state);
        if (branch === 'terminal') {
          store.appendEvents(
            threadId,
            [
              {
                type: 'context.compaction_completed',
                compactionId: 'legacy-pending',
                sourceRevision: 0,
                checkpoint: {
                  compactionId: 'legacy-pending',
                  version: 1,
                  sourceRevision: 0,
                  sourceDigest: 'legacy-source',
                  coveredThroughMessageId: 'settled-source',
                  coveredThroughTurnId: 'settled-turn',
                  summary: 'Legacy summary.',
                  inputTokensBefore: 2_000,
                  inputTokensAfter: 500,
                  reason: 'manual',
                  createdAt: '2026-08-10T00:00:02.000Z',
                },
              },
            ],
            [
              {
                eventId: 'legacy-terminal',
                revision: 1,
                occurredAt: '2026-08-10T00:00:02.000Z',
              },
            ],
          );
        }
        store.close();

        const kernel = createAgentKernel({ threadId, userId: 'u', workspace: '/', storePath });
        expect(kernel.getState().recoveryState.kind).toBe('normal');
        expect(kernel.getState().context.pendingCompaction).toBeUndefined();
        if (branch === 'terminal') {
          expect(kernel.getState().context.activeCheckpoint?.version).toBe(1);
        } else {
          expect(kernel.getState().context.lastFailure?.errorKind).toBe(
            branch === 'dispatch-started' ? 'unknown_external_outcome' : 'stale_context',
          );
        }
        kernel.close();
        const verifier = createRuntimeStore(storePath);
        const eventTypes = verifier.loadEventsStrict(threadId).map((entry) => entry.event.type);
        expect(eventTypes).toContain(
          branch === 'not-dispatched'
            ? 'context.compaction_migration_cancelled'
            : branch === 'dispatch-started'
              ? 'context.compaction_unknown_external_outcome'
              : 'context.compaction_completed',
        );
        verifier.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test('migrates representative v2..v21 snapshots through v22 into one pure v23 candidate', () => {
    for (const version of [2, 11, 12, 13, 16, 17, 18, 20, 21]) {
      const { directory, storePath } = temporaryStore(`v${version}`);
      try {
        const threadId = `migration-v${version}`;
        const legacy = serializedLegacyFixture(threadId, version);
        const store = createRuntimeStore(storePath);
        store.saveSnapshot(threadId, legacy);
        store.close();

        const kernel = createAgentKernel({
          threadId,
          userId: 'u',
          workspace: '/',
          storePath,
        });
        expect(kernel.getState().schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);
        expect(kernel.getState().recoveryState.kind).toBe('normal');
        expect(kernel.getState().revision).toBe(0);
        expect(kernel.getState().providerAdmission).toEqual({
          pending: [],
          waivers: {},
        });
        kernel.close();

        const verifier = createRuntimeStore(storePath);
        expect(verifier.loadSnapshotRecord(threadId)?.metadata.schemaVersion).toBe(
          RUNTIME_STATE_SCHEMA_VERSION,
        );
        verifier.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test('rejects fractional and out-of-range schema labels instead of treating them as legacy', () => {
    for (const version of [1, 21.5, 24]) {
      const { directory, storePath } = temporaryStore(`invalid-${version}`);
      try {
        const threadId = `invalid-schema-${version}`;
        const store = createRuntimeStore(storePath);
        const fixture = serializedLegacyFixture(threadId, version);
        if (version >= 22) {
          fixture.revision = 0;
          fixture.appliedEventIds = [];
          fixture.recoveryState = { kind: 'normal' };
        }
        store.saveSnapshot(threadId, fixture);
        store.close();
        const kernel = createAgentKernel({
          threadId,
          userId: 'u',
          workspace: '/',
          storePath,
        });
        expect(kernel.getState().recoveryState).toEqual({
          kind: 'incompatible',
          schemaVersion: version,
        });
        kernel.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test('migrates all v21 terminal variants as durable legacy_unverified provenance', () => {
    const { directory, storePath } = temporaryStore('legacy-terminals');
    const threadId = 'legacy-terminal-matrix';
    try {
      let legacy = createInitialRuntimeState({
        threadId,
        userId: 'u',
        workspace: '/',
      });
      for (const [index, name] of [
        'read_file',
        'shell_execute',
        'write_file',
        'ask_user',
      ].entries()) {
        legacy = reduceRuntimeState(legacy, {
          type: 'tool.queued',
          toolCallId: `call-${index + 1}`,
          name,
          args: {},
          modelMessageId: 'assistant-legacy',
          ordinal: index,
        });
      }
      legacy = { ...legacy, schemaVersion: 21 };
      const terminals = [
        {
          type: 'tool.finished' as const,
          toolCallId: 'call-1',
          name: 'read_file',
          result: {
            ok: true,
            command: 'read',
            exitCode: 0,
            stdout: 'legacy read',
            stderr: '',
          },
        },
        {
          type: 'tool.failed' as const,
          toolCallId: 'call-2',
          error: 'legacy failure',
        },
        {
          type: 'tool.rejected' as const,
          toolCallId: 'call-3',
          reason: 'legacy rejection',
        },
        {
          type: 'tool.cancelled' as const,
          toolCallId: 'call-4',
          reason: 'legacy cancellation',
        },
      ];
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, legacy);
      store.appendEvents(
        threadId,
        terminals,
        terminals.map((_, index) => ({
          eventId: `legacy-terminal-${index + 1}`,
          revision: index + 1,
          occurredAt: new Date(index).toISOString(),
        })),
      );
      store.close();

      const kernel = createAgentKernel({
        threadId,
        userId: 'u',
        workspace: '/',
        storePath,
      });
      const migrated = kernel.getState();
      expect(migrated.schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);
      for (let index = 0; index < terminals.length; index += 1) {
        const message = migrated.transcript.messages.find(
          (entry) => entry.kind === 'tool' && entry.toolCallId === `call-${index + 1}`,
        );
        expect(message?.kind).toBe('tool');
        if (message?.kind === 'tool') {
          expect(message.resultMeta?.digestScope).toBe('legacy_unknown');
          expect(message.resultMeta?.terminalMigration).toEqual({
            kind: 'legacy_unverified',
            migratedFromSchemaVersion: 21,
            originalEventPosition: index + 1,
          });
        }
      }
      kernel.close();

      const verifier = createRuntimeStore(storePath);
      expect(
        verifier
          .loadEventsStrict(threadId)
          .every((entry) => !('modelResult' in entry.event) || !entry.event.modelResult),
      ).toBe(true);
      verifier.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('deduplicates exact legacy replay but quarantines byte or terminal-kind conflicts', () => {
    for (const variant of ['exact', 'bytes', 'kind'] as const) {
      const { directory, storePath } = temporaryStore(`legacy-replay-${variant}`);
      const threadId = `legacy-replay-${variant}`;
      try {
        let legacy = reduceRuntimeState(
          createInitialRuntimeState({ threadId, userId: 'u', workspace: '/' }),
          {
            type: 'tool.queued',
            toolCallId: 'call-1',
            name: 'shell_execute',
            args: { command: 'false' },
            modelMessageId: 'assistant-1',
          },
        );
        const first = {
          type: 'tool.failed' as const,
          toolCallId: 'call-1',
          error: 'same failure',
        };
        legacy = { ...reduceRuntimeState(legacy, first), schemaVersion: 21 };
        const replay =
          variant === 'exact'
            ? first
            : variant === 'bytes'
              ? { ...first, error: 'different failure' }
              : ({
                  type: 'tool.cancelled',
                  toolCallId: 'call-1',
                  reason: 'same failure',
                } as const);
        const store = createRuntimeStore(storePath);
        store.appendEvents(threadId, [first]);
        store.saveSnapshot(threadId, legacy);
        store.appendEvents(
          threadId,
          [replay],
          [
            {
              eventId: `legacy-replay-${variant}`,
              revision: 1,
              occurredAt: new Date(0).toISOString(),
            },
          ],
        );
        store.close();

        const kernel = createAgentKernel({
          threadId,
          userId: 'u',
          workspace: '/',
          storePath,
        });
        expect(kernel.getState().recoveryState.kind).toBe(
          variant === 'exact' ? 'normal' : 'corrupted',
        );
        if (variant === 'exact') {
          const results = kernel
            .getState()
            .transcript.messages.filter(
              (message) => message.kind === 'tool' && message.toolCallId === 'call-1',
            );
          expect(results).toHaveLength(1);
          const result = results[0];
          expect(result?.kind).toBe('tool');
          if (result?.kind === 'tool') {
            expect(result.resultMeta?.terminalMigration?.originalEventPosition).toBe(1);
          }
        }
        kernel.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test('requires a real prefix event for snapshot-contained legacy Tool Results', () => {
    const { directory, storePath } = temporaryStore('legacy-position-proof');
    const threadId = 'legacy-position-proof';
    try {
      let legacy = reduceRuntimeState(
        createInitialRuntimeState({ threadId, userId: 'u', workspace: '/' }),
        {
          type: 'tool.queued',
          toolCallId: 'call-1',
          name: 'read_file',
          args: { path: 'legacy.txt' },
          modelMessageId: 'assistant-1',
        },
      );
      legacy = {
        ...reduceRuntimeState(legacy, {
          type: 'tool.finished',
          toolCallId: 'call-1',
          name: 'read_file',
          result: {
            ok: true,
            command: 'read',
            exitCode: 0,
            stdout: 'legacy',
            stderr: '',
          },
        }),
        schemaVersion: 21,
      };
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, legacy);
      store.close();

      const kernel = createAgentKernel({
        threadId,
        userId: 'u',
        workspace: '/',
        storePath,
      });
      expect(kernel.getState().recoveryState.kind).toBe('corrupted');
      kernel.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('quarantines a schema-v22 event tail terminal that is missing its receipt', () => {
    const { directory, storePath } = temporaryStore('missing-receipt');
    const threadId = 'v22-missing-receipt';
    try {
      const state = reduceRuntimeState(
        createInitialRuntimeState({ threadId, userId: 'u', workspace: '/' }),
        {
          type: 'tool.queued',
          toolCallId: 'call-1',
          name: 'shell_execute',
          args: { command: 'echo ok' },
          modelMessageId: 'assistant-1',
        },
      );
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, state);
      store.appendEvents(
        threadId,
        [
          {
            type: 'tool.failed',
            toolCallId: 'call-1',
            error: 'missing receipt',
          },
        ],
        [
          {
            eventId: 'missing-receipt-1',
            revision: 1,
            occurredAt: new Date(0).toISOString(),
          },
        ],
      );
      store.close();

      const kernel = createAgentKernel({
        threadId,
        userId: 'u',
        workspace: '/',
        storePath,
      });
      const recovery = kernel.getState().recoveryState;
      expect(recovery.kind).toBe('corrupted');
      if (recovery.kind === 'corrupted') {
        expect(recovery.reason).toContain('missing a verified schema-v22 terminal');
      }
      kernel.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects a migration candidate when only the observed event head advances', () => {
    const { directory, storePath } = temporaryStore('head-drift');
    const threadId = 'migration-head-drift';
    try {
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, {
        ...createInitialRuntimeState({ threadId, userId: 'u', workspace: '/' }),
        schemaVersion: 21,
      });
      const before = store.loadSnapshotRecord(threadId)!;
      const restored = restoreRuntimeStateFromStore({
        store,
        threadId,
        userId: 'u',
        workspace: '/',
      });
      expect(restored.migrationCandidate).not.toBeNull();
      store.appendEvents(
        threadId,
        [
          {
            type: 'user.message_appended',
            messageId: 'user-head-1',
            content: 'advanced after candidate',
          },
        ],
        [
          {
            eventId: 'head-advanced-1',
            revision: 1,
            occurredAt: new Date(0).toISOString(),
          },
        ],
      );
      expect(
        store.compareAndSaveMigratedSnapshot(
          threadId,
          restored.migrationCandidate!.identity,
          restored.migrationCandidate!.state,
        ),
      ).toBe('stale');
      const after = store.loadSnapshotRecord(threadId)!;
      expect(after.metadata).toEqual(before.metadata);
      expect(after.state).toEqual(before.state);
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('migration CAS compares event-head position, revision, and eventId independently', () => {
    const { directory, storePath } = temporaryStore('head-components');
    const threadId = 'migration-head-components';
    try {
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, serializedLegacyFixture(threadId, 21));
      store.appendEvents(
        threadId,
        [{ type: 'user.message_appended', messageId: 'head', content: 'head' }],
        [
          {
            eventId: 'head-event',
            revision: 1,
            occurredAt: new Date(0).toISOString(),
          },
        ],
      );
      const candidate = restoreRuntimeStateFromStore({
        store,
        threadId,
        userId: 'u',
        workspace: '/',
      }).migrationCandidate!;
      for (const observedHead of [
        {
          ...candidate.identity.observedHead,
          eventPosition: candidate.identity.observedHead.eventPosition + 1,
        },
        {
          ...candidate.identity.observedHead,
          revision: candidate.identity.observedHead.revision + 1,
        },
        { ...candidate.identity.observedHead, eventId: 'different-head-event' },
      ]) {
        expect(
          store.compareAndSaveMigratedSnapshot(
            threadId,
            { ...candidate.identity, observedHead },
            candidate.state,
          ),
        ).toBe('stale');
        expect(store.loadSnapshotRecord(threadId)?.metadata.schemaVersion).toBe(21);
      }
      expect(
        store.compareAndSaveMigratedSnapshot(threadId, candidate.identity, candidate.state),
      ).toBe('saved');
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('migration CAS also rejects an ABA source recreated under a newer generation', () => {
    const { directory, storePath } = temporaryStore('migration-generation');
    const threadId = 'migration-generation';
    try {
      const legacy = serializedLegacyFixture(threadId, 21);
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, legacy);
      const candidate = restoreRuntimeStateFromStore({
        store,
        threadId,
        userId: 'u',
        workspace: '/',
      }).migrationCandidate!;
      store.deleteSession(threadId);
      store.saveSnapshot(threadId, legacy);
      expect(
        store.compareAndSaveMigratedSnapshot(threadId, candidate.identity, candidate.state),
      ).toBe('stale');
      expect(store.loadSnapshotRecord(threadId)?.metadata.schemaVersion).toBe(21);
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('two slow migration writers cannot overwrite the winning exact-head snapshot', () => {
    const { directory, storePath } = temporaryStore('two-writers');
    const threadId = 'migration-two-writers';
    try {
      const seed = createRuntimeStore(storePath);
      seed.saveSnapshot(threadId, {
        ...createInitialRuntimeState({ threadId, userId: 'u', workspace: '/' }),
        schemaVersion: 21,
      });
      seed.close();

      const firstStore = createRuntimeStore(storePath);
      const secondStore = createRuntimeStore(storePath);
      const first = restoreRuntimeStateFromStore({
        store: firstStore,
        threadId,
        userId: 'u',
        workspace: '/',
      }).migrationCandidate!;
      const second = restoreRuntimeStateFromStore({
        store: secondStore,
        threadId,
        userId: 'u',
        workspace: '/',
      }).migrationCandidate!;
      expect(firstStore.compareAndSaveMigratedSnapshot(threadId, first.identity, first.state)).toBe(
        'saved',
      );
      expect(
        secondStore.compareAndSaveMigratedSnapshot(threadId, second.identity, second.state),
      ).toBe('stale');
      expect(secondStore.loadSnapshotRecord(threadId)?.metadata.schemaVersion).toBe(
        RUNTIME_STATE_SCHEMA_VERSION,
      );
      expect(
        restoreRuntimeStateFromStore({
          store: secondStore,
          threadId,
          userId: 'u',
          workspace: '/',
        }).migrationCandidate,
      ).toBeNull();
      firstStore.close();
      secondStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('ordinary schema-v22 writes bind the full observed base so a post-restore writer wins alone', () => {
    const { directory, storePath } = temporaryStore('ordinary-two-writers');
    const threadId = 'ordinary-two-writers';
    try {
      const firstStore = createRuntimeStore(storePath);
      const secondStore = createRuntimeStore(storePath);
      const first = new AgentKernel({
        store: firstStore,
        initialState: createInitialRuntimeState({
          threadId,
          userId: 'u',
          workspace: '/',
        }),
        interactionMode: 'accept_edits',
      });
      const second = new AgentKernel({
        store: secondStore,
        initialState: createInitialRuntimeState({
          threadId,
          userId: 'u',
          workspace: '/',
        }),
        interactionMode: 'accept_edits',
      });
      first.processEvent({
        type: 'user.message_appended',
        messageId: 'winner',
        content: 'winner',
      });
      expect(() =>
        second.processEvent({
          type: 'user.message_appended',
          messageId: 'stale',
          content: 'stale',
        }),
      ).toThrow(RuntimeRevisionConflictError);
      expect(firstStore.loadEventsStrict(threadId).map((entry) => entry.event)).toHaveLength(1);
      expect(second.getState().revision).toBe(0);
      first.close();
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('schema-v22 saveSnapshot cannot overwrite a rolling head without identity', () => {
    const { directory, storePath } = temporaryStore('snapshot-identity');
    const threadId = 'snapshot-identity';
    try {
      const store = createRuntimeStore(storePath);
      const kernel = new AgentKernel({
        store,
        initialState: createInitialRuntimeState({
          threadId,
          userId: 'u',
          workspace: '/',
        }),
        interactionMode: 'accept_edits',
      });
      kernel.processEvent({
        type: 'user.message_appended',
        messageId: 'first',
        content: 'first',
      });
      const stale = structuredClone(kernel.getState());
      kernel.processEvent({
        type: 'user.message_appended',
        messageId: 'second',
        content: 'second',
      });
      expect(() => store.saveSnapshot(threadId, stale)).toThrow(
        'require an exact persistence identity',
      );
      expect(store.loadEventsStrict(threadId)).toHaveLength(2);
      expect(store.loadSnapshotRecord(threadId)?.metadata.stateRevision).toBe(2);
      kernel.close();

      const seedStore = createRuntimeStore(storePath);
      const seedThread = 'empty-v22-seed';
      const seed = createInitialRuntimeState({
        threadId: seedThread,
        userId: 'u',
        workspace: '/',
      });
      expect(() => seedStore.saveSnapshot(seedThread, seed)).not.toThrow();
      expect(() => seedStore.saveSnapshot(seedThread, seed)).toThrow(
        'require an exact persistence identity',
      );
      seedStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('restore cross-checks every schema-v22 snapshot and prefix identity component', () => {
    for (const variant of [
      'metadata_revision',
      'metadata_schema',
      'cut',
      'prefix_revision',
      'prefix_event_id',
      'applied_event_ids',
    ] as const) {
      const { directory, storePath } = temporaryStore(`prefix-${variant}`);
      const threadId = `prefix-${variant}`;
      try {
        const writerStore = createRuntimeStore(storePath);
        const writer = new AgentKernel({
          store: writerStore,
          initialState: createInitialRuntimeState({
            threadId,
            userId: 'u',
            workspace: '/',
          }),
          interactionMode: 'accept_edits',
        });
        writer.processEvent({
          type: 'user.message_appended',
          messageId: 'first',
          content: 'first',
        });
        writer.processEvent({
          type: 'user.message_appended',
          messageId: 'second',
          content: 'second',
        });
        writer.close();

        if (variant === 'applied_event_ids') {
          const tamperStore = createRuntimeStore(storePath);
          const snapshot = tamperStore.loadSnapshot<RuntimeState>(threadId);
          if (!snapshot) throw new Error('Expected a persisted snapshot.');
          snapshot.appliedEventIds = snapshot.appliedEventIds.slice(1);
          tamperStore.appendEventsAndSnapshot(
            threadId,
            [],
            snapshot,
            [],
            undefined,
            tamperStore.loadPersistenceIdentity(threadId),
          );
          tamperStore.close();
        } else {
          const database = new Database(storePath);
          if (variant === 'metadata_revision') {
            database
              .query('UPDATE runtime_snapshots SET state_revision = 99 WHERE thread_id = ?')
              .run(threadId);
          } else if (variant === 'metadata_schema') {
            database
              .query('UPDATE runtime_snapshots SET schema_version = 21 WHERE thread_id = ?')
              .run(threadId);
          } else if (variant === 'cut') {
            const firstPosition = database
              .query<{ id: number }, [string]>(
                'SELECT id FROM runtime_events WHERE thread_id = ? ORDER BY id ASC LIMIT 1',
              )
              .get(threadId)!.id;
            database
              .query('UPDATE runtime_snapshots SET event_position = ? WHERE thread_id = ?')
              .run(firstPosition, threadId);
          } else if (variant === 'prefix_revision') {
            database
              .query(
                'UPDATE runtime_events SET revision = 99 WHERE id = (SELECT MAX(id) FROM runtime_events WHERE thread_id = ?)',
              )
              .run(threadId);
          } else {
            database
              .query(
                "UPDATE runtime_events SET event_id = 'tampered-prefix-id' WHERE id = (SELECT MAX(id) FROM runtime_events WHERE thread_id = ?)",
              )
              .run(threadId);
          }
          database.close();
        }

        const restored = createAgentKernel({
          threadId,
          userId: 'u',
          workspace: '/',
          storePath,
        });
        expect(restored.getState().recoveryState.kind).toBe('corrupted');
        restored.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test('monotonic generations fence stale kernels after rewind, delete, and fork replacement', () => {
    const { directory, storePath } = temporaryStore('generation-fences');
    try {
      const rewindThread = 'generation-rewind';
      const rewindStore = createRuntimeStore(storePath);
      const rewindKernel = new AgentKernel({
        store: rewindStore,
        initialState: createInitialRuntimeState({
          threadId: rewindThread,
          userId: 'u',
          workspace: '/',
        }),
        interactionMode: 'accept_edits',
      });
      rewindKernel.processEvent({
        type: 'user.message_appended',
        messageId: 'before-rewind',
        content: 'before',
      });
      rewindKernel.saveNamedSnapshot('same-head');
      const rewindGeneration = rewindStore.loadPersistenceIdentity(rewindThread).generation;
      const rewindAdmin = createRuntimeStore(storePath);
      expect(rewindAdmin.restoreNamedSnapshot(rewindThread, 'same-head')).toBe(true);
      expect(rewindAdmin.loadPersistenceIdentity(rewindThread).generation).toBeGreaterThan(
        rewindGeneration,
      );
      expect(() =>
        rewindKernel.processEvent({
          type: 'user.message_appended',
          messageId: 'stale-after-rewind',
          content: 'stale',
        }),
      ).toThrow(RuntimeRevisionConflictError);
      rewindKernel.close();
      rewindAdmin.close();

      const deletedThread = 'generation-delete';
      const deletedStore = createRuntimeStore(storePath);
      const deletedKernel = new AgentKernel({
        store: deletedStore,
        initialState: createInitialRuntimeState({
          threadId: deletedThread,
          userId: 'u',
          workspace: '/',
        }),
        interactionMode: 'accept_edits',
      });
      const deletedGeneration = deletedStore.loadPersistenceIdentity(deletedThread).generation;
      const deleteAdmin = createRuntimeStore(storePath);
      deleteAdmin.deleteSession(deletedThread);
      const replacementStore = createRuntimeStore(storePath);
      const replacement = new AgentKernel({
        store: replacementStore,
        initialState: createInitialRuntimeState({
          threadId: deletedThread,
          userId: 'u',
          workspace: '/',
        }),
        interactionMode: 'accept_edits',
      });
      expect(replacementStore.loadPersistenceIdentity(deletedThread).generation).toBeGreaterThan(
        deletedGeneration,
      );
      expect(() =>
        deletedKernel.processEvent({
          type: 'user.message_appended',
          messageId: 'stale-after-delete',
          content: 'stale',
        }),
      ).toThrow(RuntimeRevisionConflictError);
      deletedKernel.close();
      deleteAdmin.close();
      replacement.close();

      const sourceThread = 'generation-fork-source';
      const targetThread = 'generation-fork-target';
      const sourceStore = createRuntimeStore(storePath);
      sourceStore.saveSnapshot(
        sourceThread,
        createInitialRuntimeState({
          threadId: sourceThread,
          userId: 'u',
          workspace: '/',
        }),
      );
      const staleTargetStore = createRuntimeStore(storePath);
      const staleTarget = new AgentKernel({
        store: staleTargetStore,
        initialState: createInitialRuntimeState({
          threadId: targetThread,
          userId: 'u',
          workspace: '/',
        }),
        interactionMode: 'accept_edits',
      });
      const targetGeneration = staleTargetStore.loadPersistenceIdentity(targetThread).generation;
      expect(sourceStore.forkCurrentSession(sourceThread, targetThread)).toBe(true);
      expect(sourceStore.loadPersistenceIdentity(targetThread).generation).toBeGreaterThan(
        targetGeneration,
      );
      expect(() =>
        staleTarget.processEvent({
          type: 'user.message_appended',
          messageId: 'stale-after-fork',
          content: 'stale',
        }),
      ).toThrow(RuntimeRevisionConflictError);
      staleTarget.close();
      sourceStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('schema-v22 Store rejects duplicate ids and non-contiguous revisions atomically', () => {
    for (const variant of ['duplicate_id', 'revision_gap', 'state_revision'] as const) {
      const { directory, storePath } = temporaryStore(`metadata-${variant}`);
      const threadId = `metadata-${variant}`;
      try {
        const store = createRuntimeStore(storePath);
        const identity = store.loadPersistenceIdentity(threadId);
        const events = [
          {
            type: 'user.message_appended' as const,
            messageId: 'one',
            content: 'one',
          },
          {
            type: 'user.message_appended' as const,
            messageId: 'two',
            content: 'two',
          },
        ];
        const metadata = [
          { eventId: 'event-1', revision: variant === 'revision_gap' ? 2 : 1 },
          {
            eventId: variant === 'duplicate_id' ? 'event-1' : 'event-2',
            revision: 2,
          },
        ];
        const nextState = {
          ...createInitialRuntimeState({
            threadId,
            userId: 'u',
            workspace: '/',
          }),
          revision: variant === 'state_revision' ? 1 : 2,
        };
        expect(() =>
          store.appendEventsAndSnapshot(threadId, events, nextState, metadata, undefined, identity),
        ).toThrow();
        expect(store.loadEventsStrict(threadId)).toHaveLength(0);
        expect(store.loadSnapshotRecord(threadId)).toBeNull();
        store.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test('reload after a successful migration CAS observes a deterministic concurrent post-CAS append', () => {
    const { directory, storePath } = temporaryStore('post-cas-append');
    const threadId = 'post-cas-append';
    try {
      const durable = createRuntimeStore(storePath);
      durable.saveSnapshot(threadId, serializedLegacyFixture(threadId, 21));
      let injected = false;
      const injectingStore: RuntimeStore = {
        ...durable,
        compareAndSaveMigratedSnapshot(thread, identity, candidate) {
          const outcome = durable.compareAndSaveMigratedSnapshot(thread, identity, candidate);
          if (outcome === 'saved' && !injected) {
            injected = true;
            const concurrentStore = createRuntimeStore(storePath);
            const concurrentRestore = restoreRuntimeStateFromStore({
              store: concurrentStore,
              threadId,
              userId: 'u',
              workspace: '/',
            });
            const concurrent = new AgentKernel({
              store: concurrentStore,
              initialState: concurrentRestore.state,
              persistenceIdentity: concurrentRestore.persistenceIdentity,
              interactionMode: 'accept_edits',
            });
            concurrent.processEvent({
              type: 'user.message_appended',
              messageId: 'post-cas-user',
              content: 'committed after migration CAS',
            });
            concurrent.close();
          }
          return outcome;
        },
      };
      const restored = restoreAndCommitRuntimeStateV22({
        store: injectingStore,
        threadId,
        userId: 'u',
        workspace: '/',
      });
      expect(injected).toBe(true);
      expect(restored.state.revision).toBe(1);
      expect(restored.persistenceIdentity.observedHead.revision).toBe(1);
      expect(restored.state.transcript.messages).toContainEqual(
        expect.objectContaining({ kind: 'user', messageId: 'post-cas-user' }),
      );
      durable.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('bounded migration retry exhaustion performs no fallback snapshot write', () => {
    const { directory, storePath } = temporaryStore('retry-exhaustion');
    const threadId = 'retry-exhaustion';
    try {
      const durable = createRuntimeStore(storePath);
      durable.saveSnapshot(threadId, serializedLegacyFixture(threadId, 21));
      let attempts = 0;
      const staleStore: RuntimeStore = {
        ...durable,
        compareAndSaveMigratedSnapshot() {
          attempts += 1;
          return 'stale';
        },
      };
      expect(() =>
        restoreAndCommitRuntimeStateV22(
          { store: staleStore, threadId, userId: 'u', workspace: '/' },
          3,
        ),
      ).toThrow('source changed repeatedly');
      expect(attempts).toBe(3);
      expect(durable.loadSnapshotRecord(threadId)?.metadata.schemaVersion).toBe(21);
      durable.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('read-only restore returns a candidate without artifact or snapshot writes', () => {
    const { directory, storePath } = temporaryStore('readonly');
    const threadId = 'readonly';
    try {
      const durable = createRuntimeStore(storePath);
      durable.saveSnapshot(threadId, serializedLegacyFixture(threadId, 20));
      let writes = 0;
      const readonlyStore: RuntimeStore = {
        ...durable,
        saveSnapshot(...args) {
          writes += 1;
          durable.saveSnapshot(...args);
        },
        appendEventsAndSnapshot(...args) {
          writes += 1;
          return durable.appendEventsAndSnapshot(...args);
        },
        compareAndSaveMigratedSnapshot(...args) {
          writes += 1;
          return durable.compareAndSaveMigratedSnapshot(...args);
        },
      };
      const before = durable.loadSnapshotRecord(threadId);
      const restored = restoreRuntimeStateFromStore({
        store: readonlyStore,
        threadId,
        userId: 'u',
        workspace: '/',
      });
      expect(restored.migrationCandidate).not.toBeNull();
      expect(writes).toBe(0);
      expect(durable.loadSnapshotRecord(threadId)).toEqual(before);
      durable.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('fork remaps legacy source positions and rewind emits no superseded guard event', () => {
    const { directory, storePath } = temporaryStore('fork-rewind');
    const sourceThread = 'legacy-source';
    const targetThread = 'legacy-fork';
    try {
      let legacy = reduceRuntimeState(
        createInitialRuntimeState({
          threadId: sourceThread,
          userId: 'u',
          workspace: '/',
        }),
        {
          type: 'tool.queued',
          toolCallId: 'call-1',
          name: 'read_file',
          args: { path: 'legacy.txt' },
          modelMessageId: 'assistant-1',
        },
      );
      const terminal = {
        type: 'tool.finished' as const,
        toolCallId: 'call-1',
        name: 'read_file',
        result: {
          ok: true,
          command: 'read',
          exitCode: 0,
          stdout: 'legacy',
          stderr: '',
        },
      };
      legacy = { ...reduceRuntimeState(legacy, terminal), schemaVersion: 21 };
      const seed = createRuntimeStore(storePath);
      seed.appendEvents(sourceThread, [terminal]);
      seed.saveSnapshot(sourceThread, legacy);
      seed.close();

      const migrated = createAgentKernel({
        threadId: sourceThread,
        userId: 'u',
        workspace: '/',
        storePath,
      });
      migrated.saveNamedSnapshot('legacy-point');
      migrated.processEvent({
        type: 'user.message_appended',
        messageId: 'later-user',
        content: 'later',
      });
      migrated.close();

      const store = createRuntimeStore(storePath);
      store.appendEvents('padding', [
        {
          type: 'user.message_appended',
          messageId: 'padding',
          content: 'padding',
        },
      ]);
      expect(store.forkCurrentSession(sourceThread, targetThread)).toBe(true);
      const targetEventPosition = store.loadEventsStrict(targetThread)[0]!.id;
      const targetSnapshot = store.loadSnapshot<RuntimeState>(targetThread);
      if (!targetSnapshot) throw new Error('Expected the fork target snapshot.');
      const targetMessage = targetSnapshot.transcript.messages.find(
        (message) => message.kind === 'tool' && message.toolCallId === 'call-1',
      );
      if (targetMessage?.kind !== 'tool' || !targetMessage.resultMeta?.terminalMigration) {
        throw new Error('Forked legacy terminal marker is missing.');
      }
      const targetMarker = targetMessage.resultMeta.terminalMigration.originalEventPosition;
      expect(targetMarker).toBe(targetEventPosition);
      expect(targetMarker).not.toBe(1);
      expect(store.restoreNamedSnapshot(sourceThread, 'legacy-point')).toBe(true);
      store.close();

      const forked = createAgentKernel({
        threadId: targetThread,
        userId: 'u',
        workspace: '/',
        storePath,
      });
      expect(forked.getState().recoveryState.kind).toBe('normal');
      forked.close();
      const rewound = createAgentKernel({
        threadId: sourceThread,
        userId: 'u',
        workspace: '/',
        storePath,
      });
      expect(rewound.getState().recoveryState.kind).toBe('normal');
      expect(rewound.getState().revision).toBe(0);
      const carryVerifier = createRuntimeStore(storePath);
      expect(
        carryVerifier
          .loadEventsStrict(sourceThread)
          .some((entry) => entry.event.type === 'context.compaction_guard_carried_forward'),
      ).toBe(false);
      carryVerifier.close();
      rewound.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

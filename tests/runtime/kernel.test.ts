import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite/agent-kernel';
import { createToolRecoveryJournal } from '@kite/agent-kernel';
import { createCapabilityBinding } from '@kite/builtin-runtime';
import { McpConnectionManager, McpProviderError } from '@kite/builtin-runtime/mcp';
import { buildContextProjection } from '@kite/builtin-runtime/model';
import { computePlanStructuralDigest } from '@kite/builtin-runtime/planning';
import type {
  BuiltinPreparedShellExecutionInput,
  ShellExecutor,
} from '@kite/builtin-runtime/sandbox';
import { SandboxPreparationArtifactStore } from '@kite/builtin-runtime/sandbox';
import { descriptorRevision } from '@kite/builtin-runtime/skills';
import { createDeterministicRuntimeIdSource } from '@kite/runtime-host';
import {
  createRuntimeHostStateInitialState as createRuntimeHostStateInitialStateRaw,
  getActivePlanning,
  runtimeHostStateNormalizeToolOutcomeEvent as normalizeCurrentToolOutcomeEvent,
  RUNTIME_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION,
  type RuntimeState,
} from '@kite/runtime-host/kernel-adapter';
import { classifyFailure } from '#app/bootstrap/runtime/failures';
import { projectRuntimeSchedulerFacts } from '#app/bootstrap/runtime/scheduler-facts';
import { eventsForRunCancellation } from '#app/bootstrap/runtime/state-actions';
import { runStateRuntimeLoop } from '#app/bootstrap/runtime/state-runner';
import { normalizeTerminalRuntimeEvent } from '#app/bootstrap/runtime/terminal-outcome';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import {
  APP_PREPARED_SHELL_EXECUTION_,
  projectAppHostShellResult,
} from '../../apps/kite/src/sandbox/prepared-tool-pipeline';
import {
  StateHostSessionHarness as AgentKernel,
  restoreStateHostSessionHarness as restoreStateKernelCoordinatorRaw,
} from '../../scripts/support/runtime-host-state';
import {
  openStateStoreForTest,
  type TestRuntimeStore,
} from '../../scripts/support/runtime-storage';
import { decideNextEffect } from '../helpers/agent-kernel-scheduler';
import { currentPlanDocument } from '../helpers/current-plan';
import { createTestRuntimeEffectExecutor, testBuiltinToolCatalog } from '../helpers/runtime-model';

function createRuntimeHostStateInitialState(
  input: Parameters<typeof createRuntimeHostStateInitialStateRaw>[0],
) {
  return createRuntimeHostStateInitialStateRaw({
    projectId: 'project_kernel_test',
    canonicalWorkspaceDigest: `sha256:${'9'.repeat(64)}`,
    ...input,
  });
}

function restoreStateKernelCoordinator(
  input: Parameters<typeof restoreStateKernelCoordinatorRaw>[0],
) {
  return restoreStateKernelCoordinatorRaw({
    projectId: 'project_kernel_test',
    canonicalWorkspaceDigest: `sha256:${'9'.repeat(64)}`,
    ...input,
  });
}

function insertRawStateEvent(input: {
  storePath: string;
  threadId: string;
  eventId: string;
  event: Readonly<Record<string, unknown>>;
  occurredAt: string;
}): void {
  const database = new Database(input.storePath);
  try {
    const eventJson = JSON.stringify(input.event);
    database
      .query(
        'INSERT INTO runtime_events (session_id, event_id, sequence, schema_version, event_json, causation_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())',
      )
      .run(
        input.threadId,
        input.eventId,
        1,
        RUNTIME_STATE_SCHEMA_VERSION,
        eventJson,
        null,
        input.occurredAt,
      );
  } finally {
    database.close();
  }
}

function openPreflightedStore(
  storePath: string,
  threadId: string,
): TestRuntimeStore<RuntimeEvent, RuntimeState> {
  return openStateStoreForTest(storePath, { sessionId: threadId });
}

function mutateStoredStateForKernelFixture(
  storePath: string,
  threadId: string,
  mutate: (state: RuntimeState) => void,
): void {
  const database = new Database(storePath);
  try {
    const row = database
      .query('SELECT state_json, revision FROM runtime_snapshots WHERE session_id = ?')
      .get(threadId) as { state_json: string; revision: number } | null;
    if (!row) throw new Error(`Missing State snapshot for ${threadId}.`);
    const state = JSON.parse(row.state_json) as RuntimeState;
    mutate(state);
    const stateJson = JSON.stringify(state);
    let checksum = 2166136261;
    for (let index = 0; index < stateJson.length; index++) {
      checksum ^= stateJson.charCodeAt(index);
      checksum = Math.imul(checksum, 16777619);
    }
    database
      .query('UPDATE runtime_snapshots SET state_json = ?, state_checksum = ? WHERE session_id = ?')
      .run(stateJson, (checksum >>> 0).toString(16).padStart(8, '0'), threadId);
  } finally {
    database.close();
  }
}

/**
 * Keep malformed-snapshot recovery tests below the strict Host codec: the
 * fixture reads the already-corrupted bytes after the one Store 4 adapter is
 * closed for mutation, then overlays only Core's test compatibility read.
 */
function canonicalShellInvocationFacts(command: string) {
  const entry = testBuiltinToolCatalog().entries.find(
    (candidate) => candidate.visibility === 'model' && candidate.name === 'shell_execute',
  );
  if (!entry) throw new Error('Builtin shell catalog entry is unavailable.');
  const parsed = entry.parse({ command }, { workspace: '/', phase: 'building' });
  if (!parsed.success) throw new Error('Builtin shell fixture is invalid.');
  const effects = entry.classifyEffects(parsed.data, { workspace: '/', phase: 'building' });
  return {
    effectClass: effects.effectClass,
    sideEffect: effects.sideEffect,
    classificationReason: effects.classificationReason,
  };
}

function testSandboxPreparationArtifacts(label: string) {
  return new SandboxPreparationArtifactStore({
    root: join(mkdtempSync(join('/tmp', `kite-kernel-${label}-`)), 'sandbox-preparations'),
  });
}

function preparedShellExecutor(executor: ShellExecutor): ShellExecutor {
  const wrapped = ((input) => executor(input)) as ShellExecutor &
    Partial<Record<typeof APP_PREPARED_SHELL_EXECUTION_, unknown>>;
  Object.defineProperty(wrapped, APP_PREPARED_SHELL_EXECUTION_, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      execute: async (input: BuiltinPreparedShellExecutionInput) =>
        projectAppHostShellResult(
          await executor({
            workspace: input.workspace,
            command: input.command,
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
            ...(input.onProgress ? { onProgress: input.onProgress } : {}),
            ...(input.networkMode ? { networkMode: input.networkMode } : {}),
            ...(input.filesystemMode ? { filesystemMode: input.filesystemMode } : {}),
            ...(input.executionTrust ? { executionTrust: input.executionTrust } : {}),
            sandboxInvocationIdentity: input.identity,
          }),
        ),
    }),
  });
  return Object.freeze(wrapped);
}

function reduceKernelTestEvents(
  state: RuntimeState,
  events: readonly RuntimeEvent[],
): RuntimeState {
  const beforeRevision = state.revision;
  let next = state;
  for (const event of events) {
    next = reduceRuntimeState(
      next,
      normalizeCurrentToolOutcomeEvent(
        normalizeTerminalRuntimeEvent(event),
        next,
        new Date().toISOString(),
      ),
    );
  }
  return next.revision === beforeRevision
    ? { ...next, revision: beforeRevision + events.length }
    : next;
}

describe('AgentKernel durability', () => {
  test('fails closed when a restored State recovery identity disagrees with Host storage', () => {
    const store = openStateStoreForTest(':memory:');
    const state = createRuntimeHostStateInitialState({
      threadId: 'recovery-identity-mismatch',
      userId: 'user',
      workspace: '/workspace',
      recoveryIdentityKey: 'a'.repeat(64),
    });
    store.saveSnapshot(state.session.threadId, state);

    const restored = restoreStateKernelCoordinator({
      threadId: state.session.threadId,
      userId: 'user',
      workspace: '/workspace',
      store,
      recoveryIdentityKey: 'b'.repeat(64),
    });
    expect(restored.getState().toolRecovery.identityKey).toBe('b'.repeat(64));
    expect(restored.getState().recoveryState).toMatchObject({
      kind: 'corrupted',
      reason: expect.stringContaining('does not match Host storage authority'),
    });
    expect(decideNextEffect(restored.getState())).toMatchObject({ type: 'recovery_blocked' });
    restored.close();
  });

  test('rejects the pre-cutover v24 epoch marker without rewriting the store', () => {
    const dir = mkdtempSync(join(process.cwd(), '.kite-runtime-pre-cutover-epoch-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'pre-cutover-v24';
    try {
      const state = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      const store = openStateStoreForTest(storePath);
      store.saveSnapshot(threadId, state);
      store.close();

      const database = new Database(storePath);
      database.run("UPDATE runtime_store_meta SET value = ? WHERE key = 'runtime_format_epoch'", [
        'kite-runtime-2026-08-15',
      ]);
      database.close();

      const digest = () => createHash('sha256').update(readFileSync(storePath)).digest('hex');
      const before = digest();
      expect(() =>
        restoreStateKernelCoordinator({
          recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
          threadId,
          userId: 'user',
          workspace: '/workspace',
          store: openPreflightedStore(storePath, threadId),
        }),
      ).toThrow('Runtime format is incompatible');
      expect(digest()).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ['missing', null],
    ['wrong', `${RUNTIME_STATE_FORMAT_EPOCH}-wrong`],
  ] as const)('rejects a current-schema snapshot with %s format epoch without rewriting the store', (_label, formatEpoch) => {
    const dir = mkdtempSync(join(process.cwd(), '.kite-runtime-format-epoch-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = `format-${formatEpoch ?? 'missing'}`;
    try {
      const state = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      const store = openStateStoreForTest(storePath);
      store.saveSnapshot(threadId, state);
      store.close();

      const database = new Database(storePath);
      if (formatEpoch === null) {
        database.run("DELETE FROM runtime_store_meta WHERE key = 'runtime_format_epoch'");
      } else {
        database.run("UPDATE runtime_store_meta SET value = ? WHERE key = 'runtime_format_epoch'", [
          formatEpoch,
        ]);
      }
      database.close();

      const digest = () => createHash('sha256').update(readFileSync(storePath)).digest('hex');
      const before = digest();
      expect(() =>
        restoreStateKernelCoordinator({
          recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
          threadId,
          userId: 'user',
          workspace: '/workspace',
          store: openPreflightedStore(storePath, threadId),
        }),
      ).toThrow('Runtime format is incompatible');
      expect(digest()).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a retired event in a current-format tail before scheduling', () => {
    const dir = mkdtempSync(join(process.cwd(), '.kite-runtime-retired-tail-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'retired-tail';
    try {
      const state = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      const store = openStateStoreForTest(storePath);
      store.saveSnapshot(threadId, state);
      store.close();

      insertRawStateEvent({
        storePath,
        threadId,
        eventId: 'retired-event',
        event: { type: 'tool.execution_ready', toolCallId: 'shell-unapproved' },
        occurredAt: '2026-08-15T00:00:00.000Z',
      });

      expect(() => openStateStoreForTest(storePath)).toThrow('Runtime format is incompatible');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a current event whose required payload fields are missing', () => {
    const dir = mkdtempSync(join(process.cwd(), '.kite-runtime-malformed-tail-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'malformed-current-tail';
    try {
      const state = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      const store = openStateStoreForTest(storePath);
      store.saveSnapshot(threadId, state);
      store.close();

      insertRawStateEvent({
        storePath,
        threadId,
        eventId: 'malformed-event',
        event: { type: 'tool.queued', toolCallId: 'malformed', args: {} },
        occurredAt: '2026-08-15T00:00:00.000Z',
      });

      expect(() => openStateStoreForTest(storePath)).toThrow('Runtime format is incompatible');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a user-message tail whose Host-allocated Task identity is absent from the snapshot', () => {
    const dir = mkdtempSync(join(process.cwd(), '.kite-runtime-task-identity-tail-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'task-identity-tail';
    try {
      const state = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      const store = openStateStoreForTest(storePath);
      store.saveSnapshot(threadId, state);
      store.appendEvents(
        threadId,
        [
          {
            type: 'user.message_appended',
            messageId: 'message-1',
            content: 'resume without an identity snapshot',
          },
        ],
        [
          {
            eventId: 'user-message-1',
            revision: 1,
            occurredAt: '2026-08-20T00:00:00.000Z',
          },
        ],
      );
      store.close();

      const restored = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
        store: openStateStoreForTest(storePath),
      });
      expect(restored.getState().recoveryState).toMatchObject({
        kind: 'corrupted',
        reason: expect.stringContaining('Host-allocated Task identity'),
      });
      expect(restored.getState().activeTaskId).toBeNull();
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails closed when a current snapshot omits the recovery journal', () => {
    const dir = mkdtempSync(join(process.cwd(), '.kite-runtime-current-missing-recovery-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'v23-missing-recovery';
    try {
      const current = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      const store = openStateStoreForTest(storePath);
      store.saveSnapshot(threadId, current);
      store.close();
      mutateStoredStateForKernelFixture(storePath, threadId, (state) => {
        Reflect.deleteProperty(state, 'toolRecovery');
      });

      expect(() => openStateStoreForTest(storePath)).toThrow('Runtime format is incompatible');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails closed when a cutover snapshot omits the Model invocation index', () => {
    const dir = mkdtempSync(join(process.cwd(), '.kite-runtime-current-missing-model-evidence-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'v25-missing-model-evidence';
    try {
      const current = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      const store = openStateStoreForTest(storePath);
      store.saveSnapshot(threadId, current);
      store.close();
      mutateStoredStateForKernelFixture(storePath, threadId, (state) => {
        Reflect.deleteProperty(state, 'modelInvocations');
      });

      expect(() => openStateStoreForTest(storePath)).toThrow('Runtime format is incompatible');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [label, mutate, _reason] of [
    [
      'Provider readiness ledger',
      (state: RuntimeState) => {
        Reflect.deleteProperty(state, 'providerReadiness');
      },
      'provider readiness state is required',
    ],
    [
      'CompletionGuard state',
      (state: RuntimeState) => {
        Reflect.deleteProperty(state, 'completionGuard');
      },
      'completion guard state is required',
    ],
    [
      'transcript identity',
      (state: RuntimeState) => {
        state.transcript.messages = [
          ...state.transcript.messages,
          {
            kind: 'user',
            content: 'current message',
            messageId: 'current-message',
            turnId: state.turn.turnId,
            ordinal: 0,
            createdAt: '2026-08-18T00:00:00.000Z',
          },
        ];
        Reflect.deleteProperty(state.transcript.messages[0]!, 'messageId');
      },
      'transcript message identity is required',
    ],
  ] as const) {
    test(`fails closed when a cutover snapshot omits ${label}`, () => {
      const dir = mkdtempSync(join(process.cwd(), '.kite-runtime-current-missing-required-state-'));
      const storePath = join(dir, 'runtime.db');
      const threadId = `v25-missing-${label.replaceAll(' ', '-').toLowerCase()}`;
      try {
        const current = createRuntimeHostStateInitialState({
          recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
          threadId,
          userId: 'user',
          workspace: '/workspace',
        });
        const store = openStateStoreForTest(storePath);
        store.saveSnapshot(threadId, current);
        store.close();
        mutateStoredStateForKernelFixture(storePath, threadId, mutate);

        expect(() => openStateStoreForTest(storePath)).toThrow('Runtime format is incompatible');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('fails closed before scheduling when a suspended child omits its recovery journal', () => {
    const dir = mkdtempSync(join(process.cwd(), '.kite-runtime-child-journal-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'current-child-missing-recovery';
    try {
      const state = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      const store = openStateStoreForTest(storePath);
      store.saveSnapshot(threadId, state);
      store.close();
      mutateStoredStateForKernelFixture(storePath, threadId, (storedState) => {
        storedState.suspendedSubagents.task = {
          storage: 'private_artifact_v1',
          subagentId: 'child',
          role: 'code',
          continuationId: `continuation-${'a'.repeat(64)}`,
          modelInvocationOrdinal: 0,
          parentInvocationId: 'parent-child',
          parentAttempt: 1,
          blockedTool: {
            reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
            toolCallId: 'child-shell',
            toolName: 'shell_execute',
          },
        } as unknown as (typeof storedState.suspendedSubagents)[string];
      });

      expect(() => openStateStoreForTest(storePath)).toThrow('Runtime format is incompatible');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('restores a healthy completed child merge without rotating its recovery identity', () => {
    const dir = mkdtempSync(join(process.cwd(), '.kite-runtime-child-merge-restart-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'child-merge-restart';
    try {
      const initial = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      initial.tools.calls['task-1'] = {
        toolCallId: 'task-1',
        modelMessageId: 'model-1',
        name: 'task',
        args: { subagent_type: 'explore', task: 'Inspect the workspace.' },
        status: 'running',
        createdAtTurnId: initial.turn.turnId,
      };
      const parentIdentity = initial.toolRecovery.identityKey;
      const store = openStateStoreForTest(storePath);
      const kernel = new AgentKernel({
        store,
        initialState: initial,
        interactionMode: 'accept_edits',
      });
      kernel.processEvent({
        type: 'subagent.recovery_journal_merged',
        toolCallId: 'task-1',
        journal: createToolRecoveryJournal(parentIdentity),
      });
      kernel.close();

      const restored = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
        store: openStateStoreForTest(storePath),
      });
      expect(restored.getState().toolRecovery.identityKey).toBe(parentIdentity);
      expect(restored.getState().toolRecovery.qualityGuard).toEqual({
        blocked: false,
        observedFailures: 0,
      });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('replays the context compaction crash matrix from snapshot plus event tail', () => {
    const dir = mkdtempSync(join(process.cwd(), '.kite-runtime-compaction-crash-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'compaction-crash-matrix';
    try {
      const base = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      base.transcript.messages = [
        {
          kind: 'user',
          messageId: 'message-1',
          turnId: base.turn.turnId,
          ordinal: 0,
          createdAt: '2026-07-22T00:00:00.000Z',
          content: 'preserve this transcript',
        },
      ];
      const request: RuntimeEvent = {
        type: 'context.compaction_requested',
        compactionId: 'compact-crash',
        reason: 'manual',
        requestedAtRevision: 0,
        requestedAtTurnId: base.turn.turnId,
        force: false,
        estimate: {
          systemTokens: 10,
          toolSchemaTokens: 0,
          transcriptTokens: 3_000,
          summaryTokens: 0,
          dynamicRuntimeTokens: 0,
          framingTokens: 10,
          totalInputTokens: 3_020,
        },
      };
      const checkpoint = {
        compactionId: 'compact-crash',
        version: 1 as const,
        sourceRevision: 1,
        sourceDigest: 'sha256:crash',
        coveredThroughMessageId: 'message-1',
        coveredThroughTurnId: base.turn.turnId,
        summary: '# Restored\n\nContinue safely.',
        inputTokensBefore: 3_020,
        inputTokensAfter: 900,
        reason: 'manual' as const,
        createdAt: '2026-07-22T00:00:01.000Z',
      };
      const completed: RuntimeEvent = {
        type: 'context.compaction_completed',
        compactionId: checkpoint.compactionId,
        sourceRevision: 1,
        checkpoint,
      };
      const store = openStateStoreForTest(storePath);
      store.saveSnapshot(threadId, base);
      store.appendEvents(
        threadId,
        [request],
        [{ eventId: 'request-1', revision: 1, occurredAt: '2026-07-22T00:00:01.000Z' }],
      );
      store.close();

      const afterRequest = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
        store: openStateStoreForTest(storePath),
      });
      expect(afterRequest.getState().context.pendingCompaction?.compactionId).toBe('compact-crash');
      expect(afterRequest.getState().transcript.messages).toEqual(base.transcript.messages);
      afterRequest.close();

      const tailStore = openStateStoreForTest(storePath);
      tailStore.appendEvents(
        threadId,
        [completed],
        [{ eventId: 'completed-1', revision: 2, occurredAt: '2026-07-22T00:00:02.000Z' }],
      );
      tailStore.close();
      const afterCompletedTail = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
        store: openStateStoreForTest(storePath),
      });
      expect(afterCompletedTail.getState().context.pendingCompaction).toBeUndefined();
      expect(afterCompletedTail.getState().context.activeCheckpoint).toEqual(checkpoint);
      expect(afterCompletedTail.getState().context.history).toHaveLength(1);
      afterCompletedTail.runtimeStore.saveSnapshot(threadId, afterCompletedTail.getState());
      afterCompletedTail.close();

      const afterCompletedSnapshot = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
        store: openStateStoreForTest(storePath),
      });
      expect(afterCompletedSnapshot.getState().context.activeCheckpoint).toEqual(checkpoint);
      expect(afterCompletedSnapshot.getState().context.history).toHaveLength(1);
      expect(afterCompletedSnapshot.getState().transcript.messages).toEqual(
        base.transcript.messages,
      );
      const restoredProjection = buildContextProjection({
        role: 'agent',
        state: afterCompletedSnapshot.getState(),
        serializedTools: [],
      });
      const serializedProjection = JSON.stringify(restoredProjection.providerMessages);
      expect(
        restoredProjection.providerMessages.filter(
          (message) =>
            typeof message.content === 'string' &&
            message.content.startsWith('<compacted_history>\n'),
        ),
      ).toHaveLength(1);
      expect(serializedProjection).toContain('Continue safely.');
      afterCompletedSnapshot.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('restores a non-empty session-loaded capability set after restart', () => {
    const dir = mkdtempSync(join(process.cwd(), '.kite-runtime-loaded-capability-restart-'));
    const storePath = join(dir, 'runtime.db');
    try {
      const state = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'loaded-capability-restart',
        userId: 'user',
        workspace: '/workspace',
      });
      const loaded = {
        capabilityId: 'mcp:github/publish',
        capabilityRevision: 'revision-1',
        firstLoadedAtTurnId: state.turn.turnId,
      };
      const store = openStateStoreForTest(storePath);
      const kernel = new AgentKernel({
        store,
        initialState: state,
        interactionMode: 'accept_edits',
      });
      kernel.processEvent({
        type: 'capability.bindings_issued',
        catalogRevision: 'catalog-r1',
        bindings: [
          {
            bindingId: 'binding-r1',
            capabilityId: loaded.capabilityId,
            capabilityRevision: loaded.capabilityRevision,
            exposedToolName: 'mcp__github__publish',
            schemaDigest: 'schema-r1',
            issuedForTurnId: state.turn.turnId,
          },
        ],
        disclosures: [
          {
            capabilityId: loaded.capabilityId,
            capabilityRevision: loaded.capabilityRevision,
            issuedForTurnId: state.turn.turnId,
          },
        ],
        loadedCapabilities: [loaded],
        searchId: 'search-r1',
      });
      expect(kernel.getState().capabilities.loadedCapabilities).toEqual({
        [loaded.capabilityId]: loaded,
      });
      kernel.close();

      const restored = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: state.session.threadId,
        userId: 'user',
        workspace: '/workspace',
        store: openStateStoreForTest(storePath),
      });
      expect(restored.getState().capabilities.loadedCapabilities).toEqual({
        [loaded.capabilityId]: loaded,
      });
      expect(restored.getState().capabilities.bindings['binding-r1']).toMatchObject({
        capabilityId: loaded.capabilityId,
        capabilityRevision: loaded.capabilityRevision,
      });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('persists a snapshot with each processed event', () => {
    const store = openStateStoreForTest(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'kernel-durability',
        userId: 'user',
        workspace: '/workspace',
      }),
      interactionMode: 'accept_edits',
    });

    kernel.processEvent({
      type: 'tool.queued',
      toolCallId: 'call-1',
      name: 'read_file',
      args: { path: 'README.md' },
    });

    const snapshot =
      store.loadSnapshot<ReturnType<typeof createRuntimeHostStateInitialState>>(
        'kernel-durability',
      );
    expect(snapshot?.tools.queue).toEqual(['call-1']);
    kernel.close();
  });

  test('marks a persisted invocation without a terminal result as unknown after restart', () => {
    const dir = mkdtempSync(join(process.cwd(), '.kite-runtime-invocation-'));
    const storePath = join(dir, 'runtime.db');
    try {
      const first = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'invocation-recovery',
        userId: 'user',
        workspace: '/workspace',
        store: openStateStoreForTest(storePath),
      });
      first.processEvent({
        type: 'capability.invocation_recorded',
        invocationId: 'invocation-1',
        toolCallId: 'tool-1',
        capabilityId: 'mcp:fixture/write',
        capabilityRevision: 'revision-1',
        argumentsDigest: 'arguments',
        authorizationDigest: 'authorization',
        effectiveEffectsDigest: 'effects',
        effectiveEffects: { filesystem: 'none', network: 'write', externalState: 'write' },
        recordedAt: '2026-07-14T00:00:00.000Z',
      });
      first.close();

      const restored = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'invocation-recovery',
        userId: 'user',
        workspace: '/workspace',
        store: openStateStoreForTest(storePath),
      });
      expect(restored.getState().capabilities.invocations['invocation-1']).toMatchObject({
        status: 'unknown',
        error: expect.stringContaining('without a terminal result'),
      });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('marks a blocked Subagent lifecycle without a persisted suspension unknown after restart', () => {
    const dir = mkdtempSync(join(process.cwd(), '.kite-runtime-subagent-blocked-window-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'subagent-blocked-without-suspension';
    const at = '2026-08-17T00:00:00.000Z';
    const invocationId = 'subagent-blocked-invocation';
    const intent = `sha256:${'1'.repeat(64)}`;
    try {
      const first = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
        store: openStateStoreForTest(storePath),
      });
      first.processEvents([
        {
          type: 'capability.invocation_recorded',
          invocationId,
          toolCallId: 'task-call',
          capabilityId: 'builtin:task',
          capabilityRevision: '2'.repeat(64),
          argumentsDigest: '3'.repeat(64),
          authorizationDigest: '4'.repeat(64),
          admissionDigest: '5'.repeat(64),
          effectiveEffectsDigest: '6'.repeat(64),
          effectiveEffects: { filesystem: 'unknown', network: 'unknown', externalState: 'none' },
          receiptRequirement: 'control_receipt',
          recordedAt: at,
        },
        {
          type: 'capability.execution_started',
          invocationId,
          startedAt: at,
          attempt: 1,
        },
        {
          type: 'capability.subagent_dispatch_intent_recorded',
          invocationId,
          attempt: 1,
          purpose: 'start',
          childInvocationId: 'child-blocked',
          taskArtifact: {
            artifactId: `pa_${'7'.repeat(64)}`,
            kind: 'subagent_task',
            integrityIdentifier: `sha256:${'8'.repeat(64)}`,
            byteLength: 128,
          },
          dispatchIntentDigest: intent,
          recordedAt: at,
        },
        {
          type: 'capability.subagent_handle_recorded',
          invocationId,
          attempt: 1,
          dispatchIntentDigest: intent,
          handleArtifact: {
            artifactId: `pa_${'9'.repeat(64)}`,
            kind: 'subagent_handle',
            integrityIdentifier: `sha256:${'a'.repeat(64)}`,
            byteLength: 256,
          },
          handleIntegrityIdentifier: `sha256:${'b'.repeat(64)}`,
          recordedAt: at,
        },
        {
          type: 'capability.subagent_observation_recorded',
          invocationId,
          attempt: 1,
          dispatchIntentDigest: intent,
          status: 'blocked',
          observedAt: at,
        },
        {
          type: 'capability.subagent_cleanup_started',
          invocationId,
          attempt: 1,
          dispatchIntentDigest: intent,
          cleanupAttempt: 1,
          cleanupKind: 'handle_reconcile',
          startedAt: at,
        },
        {
          type: 'capability.subagent_cleanup_completed',
          invocationId,
          attempt: 1,
          dispatchIntentDigest: intent,
          cleanupAttempt: 1,
          cleanupKind: 'handle_reconcile',
          cleanupConfirmed: true,
          completedAt: at,
        },
      ]);
      expect(first.getState().suspendedSubagents['task-call']).toBeUndefined();
      expect(first.getState().capabilities.invocations[invocationId]).toMatchObject({
        status: 'running',
        subagentProviderLifecycle: {
          status: 'cleanup_completed',
          observationStatus: 'blocked',
          cleanupConfirmed: true,
        },
      });
      first.close();

      const restored = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
        store: openStateStoreForTest(storePath),
      });
      expect(restored.getState().capabilities.invocations[invocationId]).toMatchObject({
        status: 'unknown',
        error: expect.stringContaining('without a terminal result'),
        subagentProviderLifecycle: { status: 'cleanup_completed', cleanupConfirmed: true },
      });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('persists reconciliation across a second restart without replaying the invocation', () => {
    const dir = mkdtempSync(join(process.cwd(), '.kite-runtime-reconcile-'));
    const storePath = join(dir, 'runtime.db');
    try {
      const first = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'reconcile-recovery',
        userId: 'user',
        workspace: '/workspace',
        store: openStateStoreForTest(storePath),
      });
      first.processEvent({
        type: 'capability.invocation_recorded',
        invocationId: 'invocation-reconcile',
        toolCallId: 'tool-1',
        capabilityId: 'mcp:fixture/write',
        capabilityRevision: 'revision-1',
        argumentsDigest: 'arguments',
        authorizationDigest: 'authorization',
        effectiveEffectsDigest: 'effects',
        effectiveEffects: { filesystem: 'none', network: 'write', externalState: 'write' },
        recordedAt: '2026-07-14T00:00:00.000Z',
      });
      first.close();

      const recovered = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'reconcile-recovery',
        userId: 'user',
        workspace: '/workspace',
        store: openStateStoreForTest(storePath),
      });
      const action = recovered.applyAction({
        type: 'reconcile_invocation',
        invocationId: 'invocation-reconcile',
        decision: 'confirmed_success',
      });
      expect(action.status).toBe('applied');
      recovered.close();

      const restored = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'reconcile-recovery',
        userId: 'user',
        workspace: '/workspace',
        store: openStateStoreForTest(storePath),
      });
      expect(restored.getState().capabilities.invocations['invocation-reconcile']).toMatchObject({
        status: 'succeeded',
        reconciliation: 'confirmed_success',
      });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('persists and reopens the exact Host-allocated Task identity without changing event bytes', () => {
    const dir = mkdtempSync(join(process.cwd(), '.kite-runtime-task-identity-reopen-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'task-identity-reopen';
    try {
      const idSource = createDeterministicRuntimeIdSource({
        seed: 'identity',
        epochMs: Date.parse('2026-08-20T00:00:00.000Z'),
      });
      const initial = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
        runtimeIdSource: idSource,
      });
      const store = openStateStoreForTest(storePath);
      const kernel = new AgentKernel({
        store,
        initialState: initial,
        interactionMode: 'accept_edits',
        runtimeIdSource: idSource,
      });
      kernel.processEvent({
        type: 'user.message_appended',
        messageId: 'message-1',
        content: 'preserve this Task identity',
      });
      expect(kernel.getState().activeTaskId).toBe('identity-task-0001');
      expect(kernel.getState().tasks['identity-task-0001']?.userGoal).toBe(
        'preserve this Task identity',
      );
      const persistedEvent = store.loadEventsStrict(threadId)[0]?.event;
      expect(persistedEvent?.type).toBe('user.message_appended');
      expect(Object.hasOwn(persistedEvent ?? {}, 'taskId')).toBe(false);
      kernel.close();

      const reopened = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'user',
        workspace: '/workspace',
        store: openStateStoreForTest(storePath),
      });
      expect(reopened.getState().activeTaskId).toBe('identity-task-0001');
      expect(Object.keys(reopened.getState().tasks)).toEqual(['identity-task-0001']);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('Kernel replay cannot complete a V2 plan while an external read awaits approval', () => {
  const store = openStateStoreForTest(':memory:');
  const initial = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'kernel-plan-approval-block',
    userId: 'u',
    workspace: '/workspace',
  });
  const document: import('@kite/runtime-contract').PlanDocument = {
    planSchemaVersion: 2,
    planId: 'approval-plan',
    version: 2,
    title: 'Approval gated plan',
    bodyMarkdown: 'Finish the plan only after every pending approval has resolved.',
    steps: [{ id: 'finish', title: 'Finish after approval', status: 'pending' }],
    structuralDigest: '',
    createdAtTurnId: initial.turn.turnId,
    updatedAtTurnId: initial.turn.turnId,
    completionEvidence: {
      schemaVersion: 1,
      verification: [],
      execution: [],
      skipped: [],
      unresolved: [],
    },
  };
  document.structuralDigest = computePlanStructuralDigest(document);
  const planning = {
    kind: 'executing' as const,
    document,
    executionMode: 'auto' as const,
    approvedAtTurnId: initial.turn.turnId,
  };
  initial.activeTaskId = 'kernel-task';
  initial.tasks['kernel-task'] = {
    taskId: 'kernel-task',
    userGoal: 'Verify approval blocks Plan completion.',
    status: 'active',
    startedAtTurnId: initial.turn.turnId,
    sideEffectsStarted: false,
    planning,
    executionMode: 'auto',
    planHistory: [],
  };
  initial.tools.calls['external-read'] = {
    toolCallId: 'external-read',
    modelMessageId: 'external-read-model',
    name: 'read_file',
    args: { path: '/outside/workspace.txt' },
    status: 'awaiting_approval',
    sideEffect: false,
    createdAtTurnId: initial.turn.turnId,
  };
  initial.tools.queue = [...initial.tools.queue, 'external-read'];
  initial.interactions = {
    kind: 'awaiting_tool_approval',
    interactionId: 'external-read-approval',
    toolCallId: 'external-read',
    approval: {} as never,
  };
  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });

  kernel.processEvent({
    type: 'plan.completed',
    toolCallId: 'forged-completion',
    taskId: 'kernel-task',
    planId: document.planId,
    version: document.version,
    structuralDigest: document.structuralDigest,
    plan: {
      name: document.title,
      description: document.bodyMarkdown,
      status: 'completed',
      steps: [{ id: 'finish', step: 'Finish after approval', status: 'completed' }],
    },
    completionEvidence: document.completionEvidence,
  });

  expect(getActivePlanning(kernel.getState()).kind).toBe('executing');
  expect(kernel.getState().interactions.kind).toBe('awaiting_tool_approval');
  kernel.close();
});

test('runStateRuntimeLoop resumes a matching input action and persists its facts', async () => {
  const store = openStateStoreForTest(':memory:');
  const kernel = new AgentKernel({
    store,
    initialState: createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'loop',
      userId: 'u',
      workspace: '/',
    }),
    interactionMode: 'accept_edits',
  });
  kernel.processEvents([
    { type: 'tool.queued', toolCallId: 'accept_edits', name: 'ask_user', args: {} },
    {
      type: 'user_input.requested',
      interactionId: 'input-1',
      toolCallId: 'accept_edits',
      request: { question: 'q', options: [], allow_free_text: true },
    },
  ]);
  const events = [] as string[];
  for await (const event of runStateRuntimeLoop(kernel, async () => [], {
    requestAction: async () => ({ type: 'input', interactionId: 'input-1', text: 'answer' }),
  }))
    events.push(event.type);
  expect(events).toEqual(['user_input.answered', 'tool.finished']);
  expect(kernel.getState().interactions.kind).toBe('idle');
  kernel.close();
});

test('runStateRuntimeLoop completes provider recovery on a fresh turn without replaying the tool', async () => {
  const store = openStateStoreForTest(':memory:');
  const initial = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'provider-recovery-loop',
    userId: 'u',
    workspace: '/',
  });
  const previousTurnId = initial.turn.turnId;
  const kernel = new AgentKernel({
    store,
    initialState: initial,
    interactionMode: 'accept_edits',
  });
  kernel.processEvents([
    {
      type: 'tool.queued',
      toolCallId: 'mcp-call',
      name: 'mcp__github__publish',
      args: { private: 'not-copied-to-provider-events' },
    },
    {
      type: 'tool.failed',
      toolCallId: 'mcp-call',
      failure: {
        kind: 'provider_auth_required',
        message: 'MCP provider authentication is required.',
        retryable: false,
        modelFixable: false,
        needsUserIntervention: true,
        terminatesTurn: false,
        journal: true,
      },
    },
    {
      type: 'provider.action_required',
      interactionId: 'provider-action',
      providerId: 'github',
      action: 'login',
      originatingToolCallId: 'mcp-call',
    },
  ]);

  const events: RuntimeEvent[] = [];
  for await (const event of runStateRuntimeLoop(kernel, async () => [], {
    requestAction: async () => ({
      type: 'provider_action_result',
      interactionId: 'provider-action',
      outcome: 'completed',
      providerDirectoryRevision: 'directory-r2',
    }),
  })) {
    events.push(event);
  }

  expect(events.map((event) => event.type)).toEqual([
    'provider.action_started',
    'provider.action_completed',
    'turn.started',
  ]);
  expect(kernel.getState().turn.turnId).not.toBe(previousTurnId);
  expect(kernel.getState().tools.calls['mcp-call']?.status).toBe('failed');
  expect(kernel.getState().tools.queue).toEqual([]);
  expect(kernel.getState().tools.active).toEqual([]);
  expect(JSON.stringify(events)).not.toContain('not-copied-to-provider-events');
  kernel.close();
});

test.each([
  ['awaiting_user_input', 'generic'],
  ['awaiting_tool_approval', 'generic'],
  ['awaiting_review', 'generic'],
  ['awaiting_review', 'structured'],
] as const)('runStateRuntimeLoop consumes %s cancellation via %s action without throwing', async (interactionKind, actionKind) => {
  const store = openStateStoreForTest(':memory:');
  const toolCallId =
    interactionKind === 'awaiting_user_input'
      ? 'ask-1'
      : interactionKind === 'awaiting_tool_approval'
        ? 'approval-1'
        : 'plan-1';
  const initial = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: `cancel-${interactionKind}`,
    userId: 'u',
    workspace: '/',
    phase: interactionKind === 'awaiting_review' ? 'planning' : 'building',
  });
  initial.tools.calls[toolCallId] = {
    toolCallId,
    modelMessageId: 'model-1',
    name:
      interactionKind === 'awaiting_user_input'
        ? 'ask_user'
        : interactionKind === 'awaiting_tool_approval'
          ? 'shell_execute'
          : 'write_plan',
    args: {},
    status:
      interactionKind === 'awaiting_user_input'
        ? 'awaiting_user_input'
        : interactionKind === 'awaiting_tool_approval'
          ? 'awaiting_approval'
          : 'awaiting_review',
    createdAtTurnId: initial.turn.turnId,
  };
  if (interactionKind === 'awaiting_user_input') {
    initial.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'interaction-1',
      toolCallId,
      request: { question: 'q', options: [], allow_free_text: true },
    };
  } else if (interactionKind === 'awaiting_tool_approval') {
    initial.interactions = {
      kind: 'awaiting_tool_approval',
      interactionId: 'interaction-1',
      toolCallId,
      approval: {
        scope: 'once',
        cwd: '/',
        threadId: initial.session.threadId,
        tool: 'shell_execute',
        command: 'pwd',
        risk: 'execute_code',
        approvalHash: 'approval-hash',
        summary: 'Run pwd',
        reason: 'Test approval cancellation.',
        expectedEffects: [],
        grantOptions: ['approve_once'],
        recommendedGrant: 'approve_once',
      },
    };
  } else {
    const document = currentPlanDocument({
      planId: 'plan-1',
      version: 1,
      title: 'Plan',
      bodyMarkdown: 'A plan to verify cancellation behavior.',
      steps: [{ id: 'step-1', title: 'Verify cancellation', status: 'pending' as const }],
      structuralDigest: 'digest-1',
      createdAtTurnId: initial.turn.turnId,
      updatedAtTurnId: initial.turn.turnId,
    });
    initial.activeTaskId = 'plan-review-task';
    initial.tasks['plan-review-task'] = {
      taskId: 'plan-review-task',
      userGoal: 'Review the current Plan.',
      status: 'active',
      startedAtTurnId: initial.turn.turnId,
      sideEffectsStarted: false,
      planning: {
        kind: 'awaiting_review',
        document,
        interactionId: 'interaction-1',
        exitToolCallId: toolCallId,
      },
      planHistory: [],
    };
    initial.interactions = {
      kind: 'awaiting_review',
      interactionId: 'interaction-1',
      toolCallId,
      planId: document.planId,
      version: document.version,
      structuralDigest: document.structuralDigest,
      plan: {
        name: document.title,
        description: document.bodyMarkdown,
        status: 'pending',
        steps: [],
      },
      planSummary: document.title,
    };
  }

  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });
  const events: string[] = [];
  const executedEffects: string[] = [];
  for await (const event of runStateRuntimeLoop(
    kernel,
    async (effect) => {
      executedEffects.push(effect.type);
      return [];
    },
    {
      requestAction: async () =>
        actionKind === 'structured' && initial.interactions.kind === 'awaiting_review'
          ? {
              type: 'plan_review_decision',
              interactionId: 'interaction-1',
              planId: initial.interactions.planId,
              version: initial.interactions.version,
              structuralDigest: initial.interactions.structuralDigest,
              decision: { kind: 'cancel' },
            }
          : { type: 'cancel', interactionId: 'interaction-1' },
    },
  )) {
    events.push(event.type);
  }

  if (interactionKind === 'awaiting_tool_approval') {
    expect(events).toEqual(['approval.rejected', 'turn.aborted']);
    expect(executedEffects).toEqual([]);
  } else if (interactionKind === 'awaiting_review') {
    expect(events).toEqual(['plan.review_cancelled', 'tool.cancelled', 'turn.aborted']);
    expect(executedEffects).toEqual([]);
  } else {
    expect(events).toContain('tool.finished');
    expect(executedEffects).toEqual(['call_model']);
  }
  expect(kernel.getState().interactions.kind).toBe('idle');
  kernel.close();
});

test('runStateRuntimeLoop closes a suspended subagent when its approval is cancelled', async () => {
  const store = openStateStoreForTest(':memory:');
  const initial = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'cancel-subagent-approval',
    userId: 'u',
    workspace: '/',
  });
  initial.tools.calls['task-1'] = {
    toolCallId: 'task-1',
    modelMessageId: 'model-1',
    name: 'task',
    args: { task: 'Run a nested command.' },
    status: 'awaiting_approval',
    createdAtTurnId: initial.turn.turnId,
  };
  initial.interactions = {
    kind: 'awaiting_tool_approval',
    interactionId: 'approval-1',
    toolCallId: 'task-1',
    approval: {
      scope: 'once',
      cwd: '/',
      threadId: initial.session.threadId,
      tool: 'shell_execute',
      command: 'pwd',
      risk: 'execute_code',
      approvalHash: 'approval-hash',
      summary: 'Run pwd',
      reason: 'Nested command needs approval.',
      expectedEffects: [],
      grantOptions: ['approve_once'],
      recommendedGrant: 'approve_once',
      subagentId: 'subagent-1',
    },
  };
  initial.suspendedSubagents['task-1'] = {
    storage: 'private_artifact_v1',
    subagentId: 'subagent-1',
    role: 'code',
    continuationId: `continuation-${'a'.repeat(64)}`,
    modelInvocationOrdinal: 0,
    continuationArtifact: {
      artifactId: `pa_${'b'.repeat(64)}`,
      kind: 'subagent_continuation',
      integrityIdentifier: `sha256:${'c'.repeat(64)}`,
      byteLength: 1,
    },
    parentInvocationId: 'parent-task-1',
    parentAttempt: 1,
    blockedTool: {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
      toolCallId: 'nested-1',
      toolName: 'shell_execute',
    },
  };

  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });
  const events: string[] = [];
  for await (const event of runStateRuntimeLoop(kernel, async () => [], {
    requestAction: async () => ({ type: 'cancel', interactionId: 'approval-1' }),
  })) {
    events.push(event.type);
  }

  expect(events).toEqual(['approval.rejected', 'turn.aborted']);
  expect(kernel.getState().interactions.kind).toBe('idle');
  expect(kernel.getState().suspendedSubagents).toEqual({});
  expect(kernel.getState().tools.calls['task-1']?.status).toBe('rejected');
  kernel.close();
});

test('runStateRuntimeLoop persists and yields a durable terminal output event', async () => {
  const store = openStateStoreForTest(':memory:');
  const kernel = new AgentKernel({
    store,
    initialState: createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'final',
      userId: 'u',
      workspace: '/',
    }),
    interactionMode: 'accept_edits',
  });
  const events = [] as string[];
  for await (const event of runStateRuntimeLoop(
    kernel,
    async () => [
      {
        type: 'model.responded' as const,
        messageId: 'answer',
        text: 'finished answer',
      },
    ],
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
  )) {
    events.push(event.type);
  }

  expect(events).toEqual(['model.responded', 'run.completed', 'turn.completed']);
  expect(store.loadEventsStrict('final').at(-1)?.event).toEqual({
    type: 'turn.completed',
    turnId: kernel.getState().turn.turnId,
  });
  const recoveryPoints = store.listNamedSnapshots('final');
  expect(recoveryPoints).toHaveLength(1);
  expect(recoveryPoints[0]?.eventPosition).toBe(store.getLastEventPosition('final'));
  expect(
    store.loadNamedSnapshot<RuntimeState>('final', recoveryPoints[0]!.snapshotId)?.turn.status,
  ).toBe('completed');
  kernel.close();
});

test('runStateRuntimeLoop applies streamed tool events before the effect completes', async () => {
  const store = openStateStoreForTest(':memory:');
  const kernel = new AgentKernel({
    store,
    initialState: createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'streamed-tool',
      userId: 'u',
      workspace: '/',
    }),
    interactionMode: 'accept_edits',
  });
  kernel.processEvent({
    type: 'tool.queued',
    toolCallId: 'shell-1',
    name: 'shell_execute',
    args: { command: 'printf live' },
  });

  const events: RuntimeEvent[] = [];
  for await (const event of runStateRuntimeLoop(
    kernel,
    async (effect, _state, emit) => {
      if (effect.type !== 'run_tools') return [];
      emit?.({ type: 'tool.started', toolCallId: 'shell-1' });
      emit?.({
        type: 'tool.progress',
        toolCallId: 'shell-1',
        chunk: 'live 1',
        stream: 'stdout',
      });
      emit?.({
        type: 'tool.progress',
        toolCallId: 'shell-1',
        chunk: 'live 2',
        stream: 'stdout',
      });
      return [
        {
          type: 'tool.finished',
          toolCallId: 'shell-1',
          name: 'shell_execute',
          result: {
            ok: true,
            command: 'printf live',
            exitCode: 0,
            stdout: 'live',
            stderr: '',
          },
        },
      ];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
  )) {
    events.push(event);
    if (event.type === 'tool.progress') {
      expect(kernel.getState().tools.calls['shell-1']?.status).toBe('running');
    }
  }

  expect(events.slice(0, 3).map((event) => event.type)).toEqual([
    'tool.started',
    'tool.progress',
    'tool.finished',
  ]);
  expect(events.find((event) => event.type === 'tool.progress')).toEqual({
    type: 'tool.progress',
    toolCallId: 'shell-1',
    chunk: 'live 1\nlive 2',
    stream: 'stdout',
    lineCount: 2,
  });
  expect(
    store.loadEventsStrict('streamed-tool').some(({ event }) => event.type === 'tool.progress'),
  ).toBe(false);
  expect(
    store.loadEventsStrict('streamed-tool').some(({ event }) => event.type === 'tool.finished'),
  ).toBe(true);
  expect(kernel.getState().tools.calls['shell-1']?.status).toBe('succeeded');
  expect(kernel.getState().tools.queue).not.toContain('shell-1');
  expect(kernel.getState().tools.active).not.toContain('shell-1');
  kernel.close();
});

test('runStateRuntimeLoop rejects persistEvent when durable persistence throws instead of hanging', async () => {
  const durableStore = openStateStoreForTest(':memory:');
  const persistenceError = new Error('fixture persistence failure');
  const store: TestRuntimeStore<RuntimeEvent, RuntimeState> = {
    ...durableStore,
    appendEventsAndSnapshot(threadId, events, nextState, metadata, snapshotMetadata) {
      if (events.some((event) => event.type === 'network.admission_decided')) {
        throw persistenceError;
      }
      durableStore.appendEventsAndSnapshot(threadId, events, nextState, metadata, snapshotMetadata);
    },
  };
  const initialState = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'streamed-persistence-rejection',
    userId: 'u',
    workspace: '/',
  });
  initialState.tools.queue = [...initialState.tools.queue, 'shell-1'];
  initialState.tools.calls['shell-1'] = {
    toolCallId: 'shell-1',
    modelMessageId: 'model-1',
    name: 'shell_execute',
    args: { command: 'printf safe' },
    status: 'queued',
    createdAtTurnId: initialState.turn.turnId,
  };
  const kernel = new AgentKernel({ store, initialState, interactionMode: 'accept_edits' });
  const decision = {
    version: 1 as const,
    outcome: 'denied' as const,
    toolCallId: 'shell-1',
    invocationId: 'invocation-1',
    hop: 0,
    policyRevision: 'fixture',
    canonicalOrigin: 'https://example.test',
    host: 'example.test',
    failureCode: 'network_off' as const,
    receiptDigest: `sha256:${'1'.repeat(64)}`,
  };
  let persistenceRejected = false;
  const stream = runStateRuntimeLoop(
    kernel,
    async (effect, _state, _emit, context) => {
      if (effect.type !== 'run_tools') return [];
      try {
        await context?.persistEvent({
          type: 'network.admission_decided',
          toolCallId: 'shell-1',
          decision,
        });
      } catch (error) {
        persistenceRejected = error === persistenceError;
      }
      return [
        {
          type: 'tool.failed',
          toolCallId: 'shell-1',
          failure: classifyFailure('persistence_unavailable', 'fixture persistence failure'),
        },
      ];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([
    stream.next(),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), 1_000);
    }),
  ]);
  if (timer) clearTimeout(timer);

  expect(first).not.toBe('timeout');
  expect(persistenceRejected).toBe(true);
  if (first !== 'timeout') expect(first.value).toMatchObject({ type: 'tool.failed' });
  await stream.return(undefined);
  kernel.close();
});

test('runStateRuntimeLoop starts each approved shell while later sibling approval is pending', async () => {
  const store = openStateStoreForTest(':memory:');
  const initial = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'incremental-shell-approval',
    userId: 'u',
    workspace: '/',
  });
  for (const [ordinal, toolCallId] of ['shell-1', 'shell-2'].entries()) {
    const command = `node task-${ordinal + 1}.js`;
    initial.tools.queue = [...initial.tools.queue, toolCallId];
    initial.tools.calls[toolCallId] = {
      toolCallId,
      modelMessageId: 'parallel-shell-message',
      ordinal,
      name: 'shell_execute',
      args: { command },
      status: 'queued',
      ...canonicalShellInvocationFacts(command),
      createdAtTurnId: initial.turn.turnId,
    };
  }
  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });

  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reportBothStarted!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    reportBothStarted = resolve;
  });
  const started: string[] = [];
  const approvalOrder: string[] = [];
  const events: RuntimeEvent[] = [];
  const run = (async () => {
    for await (const event of runStateRuntimeLoop(
      kernel,
      async (effect, state, emit) => {
        if (effect.type === 'call_model') {
          return [{ type: 'model.responded', messageId: 'done', text: 'done' }];
        }
        if (effect.type !== 'run_tools') return [];
        const toolCallId = effect.toolCallIds[0]!;
        const call = state.tools.calls[toolCallId]!;
        if (call.status === 'queued') {
          emit?.({
            type: 'approval.requested',
            interactionId: `approval-${toolCallId}`,
            toolCallId,
            approval: {
              scope: 'once',
              cwd: '/',
              threadId: state.session.threadId,
              tool: 'shell_execute',
              command: String((call.args as { command: string }).command),
              risk: 'execute_code',
              approvalHash: `hash-${toolCallId}`,
              summary: `Run ${toolCallId}`,
              reason: 'Test incremental approval.',
              expectedEffects: [],
              grantOptions: ['approve_once'],
              recommendedGrant: 'approve_once',
            },
          });
          return [];
        }
        emit?.({ type: 'tool.started', toolCallId });
        started.push(toolCallId);
        if (started.length === 2) reportBothStarted();
        await released;
        return [
          {
            type: 'tool.finished',
            toolCallId,
            name: 'shell_execute',
            result: {
              ok: true,
              command: String((call.args as { command: string }).command),
              exitCode: 0,
              stdout: toolCallId,
              stderr: '',
            },
          },
        ];
      },
      {
        requestAction: async (effect) => {
          if (effect.type !== 'request_tool_approval') {
            throw new Error(`Unexpected interaction: ${effect.type}`);
          }
          approvalOrder.push(effect.toolCallId);
          if (effect.toolCallId === 'shell-2') {
            expect(kernel.getState().tools.calls['shell-1']?.status).toBe('running');
          }
          return {
            type: 'approve',
            interactionId: effect.interactionId,
            grant: 'approve_once',
          };
        },
      },
      10_000,
      undefined,
      undefined,
      (state) => projectRuntimeSchedulerFacts(state, testBuiltinToolCatalog()),
    )) {
      events.push(event);
    }
  })();

  const overlapped = await Promise.race([
    bothStarted.then(() => true),
    Bun.sleep(250).then(() => false),
  ]);
  expect(overlapped).toBe(true);
  expect(approvalOrder).toEqual(['shell-1', 'shell-2']);
  expect(started).toEqual(['shell-1', 'shell-2']);

  release();
  await run;
  expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(2);
  expect(kernel.getState().tools.calls['shell-1']?.status).toBe('succeeded');
  expect(kernel.getState().tools.calls['shell-2']?.status).toBe('succeeded');
  kernel.close();
});

test('cancelling a later shell approval aborts the turn and cancels a running sibling', async () => {
  const store = openStateStoreForTest(':memory:');
  const initial = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'cancel-incremental-shell-approval',
    userId: 'u',
    workspace: '/',
  });
  for (const [ordinal, toolCallId] of ['shell-1', 'shell-2'].entries()) {
    const command = `node task-${ordinal + 1}.js`;
    initial.tools.queue = [...initial.tools.queue, toolCallId];
    initial.tools.calls[toolCallId] = {
      toolCallId,
      modelMessageId: 'parallel-shell-message',
      ordinal,
      name: 'shell_execute',
      args: { command },
      status: 'queued',
      ...canonicalShellInvocationFacts(command),
      createdAtTurnId: initial.turn.turnId,
    };
  }
  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });

  let releaseRunningShell!: () => void;
  const runningShellReleased = new Promise<void>((resolve) => {
    releaseRunningShell = resolve;
  });
  let reportRunningShellSettled!: () => void;
  const runningShellSettled = new Promise<void>((resolve) => {
    reportRunningShellSettled = resolve;
  });
  let modelCalls = 0;
  const events: RuntimeEvent[] = [];

  for await (const event of runStateRuntimeLoop(
    kernel,
    async (effect, state, emit) => {
      if (effect.type === 'call_model') {
        modelCalls += 1;
        return [{ type: 'model.responded', messageId: 'unexpected', text: 'unexpected' }];
      }
      if (effect.type !== 'run_tools') return [];
      const toolCallId = effect.toolCallIds[0]!;
      const call = state.tools.calls[toolCallId]!;
      if (call.status === 'queued') {
        emit?.({
          type: 'approval.requested',
          interactionId: `approval-${toolCallId}`,
          toolCallId,
          approval: {
            scope: 'once',
            cwd: '/',
            threadId: state.session.threadId,
            tool: 'shell_execute',
            command: String((call.args as { command: string }).command),
            risk: 'execute_code',
            approvalHash: `hash-${toolCallId}`,
            summary: `Run ${toolCallId}`,
            reason: 'Test whole-turn approval cancellation.',
            expectedEffects: [],
            grantOptions: ['approve_once'],
            recommendedGrant: 'approve_once',
          },
        });
        return [];
      }
      emit?.({ type: 'tool.started', toolCallId });
      try {
        await runningShellReleased;
        return [
          {
            type: 'tool.finished',
            toolCallId,
            name: 'shell_execute',
            result: {
              ok: true,
              command: String((call.args as { command: string }).command),
              exitCode: 0,
              stdout: toolCallId,
              stderr: '',
            },
          },
        ];
      } finally {
        reportRunningShellSettled();
      }
    },
    {
      requestAction: async (effect) => {
        if (effect.type !== 'request_tool_approval') {
          throw new Error(`Unexpected interaction: ${effect.type}`);
        }
        return effect.toolCallId === 'shell-1'
          ? {
              type: 'approve',
              interactionId: effect.interactionId,
              grant: 'approve_once',
            }
          : {
              type: 'cancel',
              interactionId: effect.interactionId,
              reason: 'Cancelled second approval.',
            };
      },
    },
    10_000,
    undefined,
    undefined,
    (state) => projectRuntimeSchedulerFacts(state, testBuiltinToolCatalog()),
  )) {
    events.push(event);
  }

  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining(['approval.rejected', 'tool.cancelled', 'turn.aborted']),
  );
  expect(modelCalls).toBe(0);
  expect(kernel.getState().tools.calls['shell-1']?.status).toBe('cancelled');
  expect(kernel.getState().tools.calls['shell-2']?.status).toBe('rejected');
  expect(kernel.getState().interactions.kind).toBe('idle');

  releaseRunningShell();
  await runningShellSettled;
  kernel.close();
});

test('a cancelled concurrent shell rejects its late terminal event', () => {
  const store = openStateStoreForTest(':memory:');
  const initial = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'cancel-concurrent-shell',
    userId: 'u',
    workspace: '/',
  });
  initial.tools.queue = [...initial.tools.queue, 'shell-1'];
  initial.tools.calls['shell-1'] = {
    toolCallId: 'shell-1',
    modelMessageId: 'parallel-shell-message',
    name: 'shell_execute',
    args: { command: 'node long-running.js' },
    status: 'approved',
    approvalGrant: 'approve_once',
    createdAtTurnId: initial.turn.turnId,
  };
  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });
  const lease = kernel.beginEffect({ type: 'run_tools', toolCallIds: ['shell-1'] });

  expect(kernel.applyEffectEvent(lease, { type: 'tool.started', toolCallId: 'shell-1' })).toBe(
    true,
  );
  kernel.processEvent({
    type: 'tool.cancelled',
    toolCallId: 'shell-1',
    reason: 'Cancelled by user.',
  });
  expect(
    kernel.applyEffectEvent(lease, {
      type: 'tool.finished',
      toolCallId: 'shell-1',
      name: 'shell_execute',
      result: {
        ok: true,
        command: 'node long-running.js',
        exitCode: 0,
        stdout: 'late success',
        stderr: '',
      },
    }),
  ).toBe(false);
  expect(kernel.getState().tools.calls['shell-1']?.status).toBe('cancelled');
  kernel.close();
});

test('a stale concurrent shell lease accepts one ordered started-to-finished result batch', () => {
  const store = openStateStoreForTest(':memory:');
  const initial = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'concurrent-shell-result-batch',
    userId: 'u',
    workspace: '/',
  });
  initial.tools.queue = [...initial.tools.queue, 'shell-1'];
  initial.tools.calls['shell-1'] = {
    toolCallId: 'shell-1',
    modelMessageId: 'parallel-shell-message',
    name: 'shell_execute',
    args: { command: 'node task.js' },
    status: 'approved',
    approvalGrant: 'approve_once',
    createdAtTurnId: initial.turn.turnId,
  };
  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });
  const lease = kernel.beginEffect({ type: 'run_tools', toolCallIds: ['shell-1'] });
  kernel.processEvent({
    type: 'run.error',
    message: 'Unrelated diagnostic advanced the revision.',
    recoverable: true,
  });

  expect(
    kernel.applyEffectResult(lease, [
      { type: 'tool.started', toolCallId: 'shell-1' },
      {
        type: 'tool.finished',
        toolCallId: 'shell-1',
        name: 'shell_execute',
        result: {
          ok: true,
          command: 'node task.js',
          exitCode: 0,
          stdout: 'done',
          stderr: '',
        },
      },
    ]),
  ).toBe(true);
  expect(kernel.getState().tools.calls['shell-1']?.status).toBe('succeeded');
  kernel.close();
});

test('a stale concurrent shell lease forwards ephemeral progress without advancing revision', () => {
  const store = openStateStoreForTest(':memory:');
  const initial = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'concurrent-shell-progress',
    userId: 'u',
    workspace: '/',
  });
  initial.tools.queue = [...initial.tools.queue, 'shell-1'];
  initial.tools.calls['shell-1'] = {
    toolCallId: 'shell-1',
    modelMessageId: 'parallel-shell-message',
    name: 'shell_execute',
    args: { command: 'node task.js' },
    status: 'approved',
    approvalGrant: 'approve_once',
    createdAtTurnId: initial.turn.turnId,
  };
  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });
  const lease = kernel.beginEffect({ type: 'run_tools', toolCallIds: ['shell-1'] });
  expect(kernel.applyEffectEvent(lease, { type: 'tool.started', toolCallId: 'shell-1' })).toBe(
    true,
  );
  kernel.processEvent({
    type: 'run.error',
    message: 'A sibling advanced the revision.',
    recoverable: true,
  });
  const revisionBeforeProgress = kernel.getState().revision;
  const progress: RuntimeEvent = {
    type: 'tool.progress',
    toolCallId: 'shell-1',
    chunk: 'still running',
    stream: 'stdout',
  };

  expect(kernel.isEffectEventCurrent(lease, progress)).toBe(true);
  expect(kernel.getState().revision).toBe(revisionBeforeProgress);
  expect(store.loadEventsStrict('concurrent-shell-progress').at(-1)?.event.type).toBe('run.error');
  expect(
    kernel.applyEffectEvent(lease, {
      type: 'tool.finished',
      toolCallId: 'shell-1',
      name: 'shell_execute',
      result: {
        ok: true,
        command: 'node task.js',
        exitCode: 0,
        stdout: 'still running',
        stderr: '',
      },
    }),
  ).toBe(true);
  expect(kernel.getState().tools.calls['shell-1']?.status).toBe('succeeded');
  kernel.close();
});

test('production executor overlaps tools from a scheduler read batch', async () => {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'parallel-read-executor',
    userId: 'u',
    workspace: '/workspace',
  });
  for (const [toolCallId, command] of [
    ['read-a', 'pwd'],
    ['read-b', 'ls -la'],
  ] as const) {
    state.tools.queue = [...state.tools.queue, toolCallId];
    state.tools.calls[toolCallId] = {
      toolCallId,
      modelMessageId: 'model',
      name: 'shell_execute',
      args: { command },
      status: 'queued',
      effectClass: 'read_only',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
  }

  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reportBothStarted!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    reportBothStarted = resolve;
  });
  const entered: string[] = [];
  const executor = createTestRuntimeEffectExecutor({
    config: {
      providerName: 'test',
      providerType: 'openai-compatible',
      apiKey: 'test',
      baseURL: 'http://localhost:1',
      modelName: 'test',
      sandbox: { enabled: true },
    },
    model: {} as never,
    sandboxBackend: 'seatbelt',
    sandboxPreparationArtifacts: testSandboxPreparationArtifacts('parallel-read'),
    shellExecutor: preparedShellExecutor(async ({ command }) => {
      entered.push(command);
      if (entered.length === 2) reportBothStarted();
      await released;
      return { ok: true, command, exitCode: 0, stdout: command, stderr: '' };
    }),
  });

  const emitted: RuntimeEvent[] = [];
  const persistedEvents: RuntimeEvent[] = [];
  let runtimeState = state;
  const execution = executor(
    { type: 'run_tools', toolCallIds: ['read-a', 'read-b'] },
    state,
    (event) => emitted.push(event),
    {
      reservationIds: [],
      getState: () => runtimeState,
      persistEvent: async (event) => {
        persistedEvents.push(event);
        runtimeState = reduceKernelTestEvents(runtimeState, [event]);
        return true;
      },
      persistEvents: async (events) => {
        persistedEvents.push(...events);
        runtimeState = reduceKernelTestEvents(runtimeState, events);
        return true;
      },
      persistAttemptStartEvents: async (events) => {
        persistedEvents.push(...events);
        runtimeState = reduceKernelTestEvents(runtimeState, events);
        return true;
      },
      persistTerminalRecoveryEvents: async (events) => {
        persistedEvents.push(...events);
        runtimeState = reduceKernelTestEvents(runtimeState, events);
        return true;
      },
    },
  );
  const overlapped = await Promise.race([
    bothStarted.then(() => true),
    Bun.sleep(250).then(() => false),
  ]);
  release();
  const terminalEvents = await execution;

  expect(overlapped).toBe(true);
  expect(entered).toEqual(['pwd', 'ls -la']);
  expect(persistedEvents.filter((event) => event.type === 'tool.started')).toHaveLength(2);
  expect(persistedEvents.filter((event) => event.type === 'tool.finished')).toHaveLength(2);
  expect(runtimeState.tools.calls['read-a']?.status).toBe('succeeded');
  expect(runtimeState.tools.calls['read-b']?.status).toBe('succeeded');
  expect(terminalEvents).toHaveLength(0);
});

test('production executor all-settled waits for a sibling when another adapter throws', async () => {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'all-settled-production-executor',
    userId: 'u',
    workspace: '/workspace',
  });
  for (const [toolCallId, command] of [
    ['throwing', 'pwd'],
    ['slow', 'ls'],
  ] as const) {
    state.tools.queue = [...state.tools.queue, toolCallId];
    state.tools.calls[toolCallId] = {
      toolCallId,
      modelMessageId: 'model',
      name: 'shell_execute',
      args: { command },
      status: 'queued',
      effectClass: 'read_only',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
  }
  let slowFinished = false;
  const persistedEvents: RuntimeEvent[] = [];
  const executor = createTestRuntimeEffectExecutor({
    config: {
      providerName: 'test',
      providerType: 'openai-compatible',
      apiKey: 'test',
      baseURL: 'http://localhost:1',
      modelName: 'test',
      sandbox: { enabled: true },
    },
    model: {} as never,
    sandboxBackend: 'seatbelt',
    sandboxPreparationArtifacts: testSandboxPreparationArtifacts('all-settled'),
    shellExecutor: preparedShellExecutor(async ({ command }) => {
      if (command === 'pwd') throw new Error('private adapter failure');
      await Bun.sleep(20);
      slowFinished = true;
      return { ok: true, command, exitCode: 0, stdout: '', stderr: '' };
    }),
  });
  let runtimeState = state;
  const terminal = await executor(
    { type: 'run_tools', toolCallIds: ['throwing', 'slow'] },
    state,
    undefined,
    {
      reservationIds: [],
      getState: () => runtimeState,
      persistEvent: async (event) => {
        persistedEvents.push(event);
        runtimeState = reduceKernelTestEvents(runtimeState, [event]);
        return true;
      },
      persistEvents: async (events) => {
        persistedEvents.push(...events);
        runtimeState = reduceKernelTestEvents(runtimeState, events);
        return true;
      },
      persistAttemptStartEvents: async (events) => {
        persistedEvents.push(...events);
        runtimeState = reduceKernelTestEvents(runtimeState, events);
        return true;
      },
      persistTerminalRecoveryEvents: async (events) => {
        persistedEvents.push(...events);
        runtimeState = reduceKernelTestEvents(runtimeState, events);
        return true;
      },
    },
  );
  expect(slowFinished).toBe(true);
  expect(persistedEvents.filter((event) => event.type === 'tool.finished')).toHaveLength(2);
  expect(runtimeState.tools.calls.throwing?.status).toBe('failed');
  expect(runtimeState.tools.calls.slow?.status).toBe('succeeded');
  expect(JSON.stringify(persistedEvents)).not.toContain('private adapter failure');
  expect(terminal).toHaveLength(0);
});

test('production executor commits provider recovery after the originating tool failure', async () => {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'provider-action-order',
    userId: 'u',
    workspace: '/workspace',
  });
  const descriptorWithoutRevision = {
    capabilityId: 'mcp:github/publish',
    kind: 'mcp_tool' as const,
    displayName: 'publish',
    description: 'Publish a fixture.',
    provider: { type: 'mcp' as const, id: 'github', provenance: 'user' as const },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    declaredEffects: {
      filesystem: 'none' as const,
      network: 'read' as const,
      externalState: 'read' as const,
    },
    effectiveEffects: {
      filesystem: 'none' as const,
      network: 'read' as const,
      externalState: 'read' as const,
    },
    policy: { workspaceTrustRequired: false, minimumApproval: 'none' as const },
    availability: 'available' as const,
    diagnostics: [],
  };
  const descriptor = {
    ...descriptorWithoutRevision,
    revision: descriptorRevision(descriptorWithoutRevision),
  };
  const binding = createCapabilityBinding({
    capabilityId: descriptor.capabilityId,
    capabilityRevision: descriptor.revision,
    exposedToolName: 'mcp__github__publish',
    inputSchema: descriptor.inputSchema ?? {},
    turnId: state.turn.turnId,
  });
  state.capabilities.bindings[binding.bindingId] = binding;
  state.tools.calls.mcp = {
    toolCallId: 'mcp',
    modelMessageId: 'model',
    name: 'mcp__github__publish',
    args: {},
    status: 'queued',
    bindingId: binding.bindingId,
    capabilityId: descriptor.capabilityId,
    capabilityRevision: descriptor.revision,
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue = [...state.tools.queue, 'mcp'];
  const manager = new McpConnectionManager();
  manager.findCapability = () => descriptor;
  manager.getProviderDirectorySnapshot = () => ({
    revision: 'directory',
    entries: [
      {
        providerId: 'github',
        status: 'login_required',
        required: false,
        source: 'user',
        lastKnownCapabilityNames: ['publish'],
        diagnosticCode: 'auth_required',
        retryable: false,
      },
    ],
  });
  const runtimeManager = manager as McpConnectionManager & {
    ensureProviderReady(providerId: string, timeoutMs?: number): Promise<void>;
  };
  runtimeManager.ensureProviderReady = async () => {
    throw new McpProviderError({
      providerId: 'github',
      kind: 'provider_auth_required',
      message: 'redacted fixture authorization required',
      recoveryAction: 'login',
      retryable: false,
    });
  };
  const executor = createTestRuntimeEffectExecutor({
    config: {
      providerName: 'test',
      providerType: 'openai-compatible',
      apiKey: 'test',
      baseURL: 'http://localhost:1',
      modelName: 'test',
      sandbox: { enabled: false },
      features: {
        capabilityCatalog: true,
        mcpRuntimeBinding: true,
        mcpProviderAction: true,
      },
    },
    model: {} as never,
    mcpManager: runtimeManager,
  });
  const emitted: RuntimeEvent[] = [];
  let runtimeState = state;

  const terminalEvents = await executor(
    { type: 'run_tools', toolCallIds: ['mcp'] },
    state,
    (event) => emitted.push(event),
    {
      reservationIds: [],
      getState: () => runtimeState,
      persistEvent: async (event) => {
        runtimeState = reduceKernelTestEvents(runtimeState, [event]);
        return true;
      },
      persistEvents: async (events) => {
        runtimeState = reduceKernelTestEvents(runtimeState, events);
        return true;
      },
      persistAttemptStartEvents: async (events) => {
        runtimeState = reduceKernelTestEvents(runtimeState, events);
        return true;
      },
      persistTerminalRecoveryEvents: async (events) => {
        runtimeState = reduceKernelTestEvents(runtimeState, events);
        return true;
      },
    },
  );

  expect(emitted.some((event) => event.type === 'provider.action_required')).toBe(false);
  expect(terminalEvents.map((event) => event.type)).toEqual(['tool.failed']);
  expect(terminalEvents[0]).toMatchObject({
    type: 'tool.failed',
    failure: { kind: 'provider_auth_required' },
  });
});

test('batch run completion persists a named rewind recovery point', () => {
  const store = openStateStoreForTest(':memory:');
  const initialState = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'batch-completion-rewind',
    userId: 'u',
    workspace: '/workspace',
  });
  const kernel = new AgentKernel({
    store,
    initialState,
    interactionMode: 'accept_edits',
  });

  kernel.processEventBatch([
    {
      type: 'run.completed',
      turnId: initialState.turn.turnId,
      output: 'done',
    },
    {
      type: 'turn.completed',
      turnId: initialState.turn.turnId,
    },
  ]);

  expect(store.listNamedSnapshots(initialState.session.threadId)).toEqual([
    expect.objectContaining({
      snapshotId: expect.stringContaining(`turn-${initialState.turn.turnId}-`),
      eventPosition: 2,
    }),
  ]);
  kernel.close();
});

test('runStateRuntimeLoop yields model deltas without persisting or reducing them', async () => {
  const store = openStateStoreForTest(':memory:');
  const kernel = new AgentKernel({
    store,
    initialState: createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'ephemeral-model-deltas',
      userId: 'u',
      workspace: '/',
    }),
    interactionMode: 'accept_edits',
  });
  const revisionBeforeDelta = kernel.getState().revision;
  const events: RuntimeEvent[] = [];

  for await (const event of runStateRuntimeLoop(
    kernel,
    async (effect, _state, emit) => {
      if (effect.type !== 'call_model') return [];
      emit?.({ type: 'model.reasoning_delta', text: 'thinking' });
      emit?.({ type: 'model.text_delta', text: 'partial' });
      expect(kernel.getState().revision).toBe(revisionBeforeDelta);
      return [{ type: 'model.responded', messageId: 'answer', text: 'complete' }];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
  )) {
    events.push(event);
  }

  expect(events.slice(0, 3).map((event) => event.type)).toEqual([
    'model.reasoning_delta',
    'model.text_delta',
    'model.responded',
  ]);
  expect(
    store
      .loadEventsStrict('ephemeral-model-deltas')
      .map(({ event }) => event.type)
      .filter((type) => type.endsWith('_delta')),
  ).toEqual([]);
  expect(kernel.getState().transcript.final).toBe('complete');
  kernel.close();
});

test('runStateRuntimeLoop drops ephemeral model deltas from a stale effect lease', async () => {
  const store = openStateStoreForTest(':memory:');
  const kernel = new AgentKernel({
    store,
    initialState: createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'stale-ephemeral-model-delta',
      userId: 'u',
      workspace: '/',
    }),
    interactionMode: 'accept_edits',
  });
  const events: RuntimeEvent[] = [];
  let calls = 0;

  for await (const event of runStateRuntimeLoop(
    kernel,
    async (effect, _state, emit) => {
      if (effect.type !== 'call_model') return [];
      calls += 1;
      if (calls === 1) {
        kernel.processEvent({
          type: 'model.retry',
          attempt: 1,
          maxAttempts: 5,
          error: 'external revision change',
          delayMs: 0,
        });
        emit?.({ type: 'model.text_delta', text: 'stale text' });
        return [{ type: 'model.responded', messageId: 'stale', text: 'stale text' }];
      }
      return [{ type: 'model.responded', messageId: 'fresh', text: 'fresh text' }];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    4,
  )) {
    events.push(event);
  }

  expect(events.some((event) => event.type === 'model.text_delta')).toBe(false);
  expect(kernel.getState().transcript.final).toBe('fresh text');
  kernel.close();
});

test('run cancellation atomically settles running and queued tools while keeping the task resumable', () => {
  const store = openStateStoreForTest(':memory:');
  const initial = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'cancel-run',
    userId: 'u',
    workspace: '/workspace',
  });
  const kernel = new AgentKernel({
    store,
    initialState: initial,
    interactionMode: 'accept_edits',
  });
  kernel.processEvents([
    {
      type: 'user.message_appended',
      messageId: 'user-1',
      content: 'inspect the runtime',
    },
    {
      type: 'model.responded',
      messageId: 'model-1',
      toolCalls: [
        { id: 'shell-1', name: 'shell_execute', args: { command: 'bun test' } },
        { id: 'read-1', name: 'read_file', args: { path: 'src/core/runtime/agent.ts' } },
      ],
    },
    {
      type: 'tool.queued',
      toolCallId: 'shell-1',
      modelMessageId: 'model-1',
      ordinal: 0,
      name: 'shell_execute',
      args: { command: 'bun test' },
    },
    {
      type: 'tool.queued',
      toolCallId: 'read-1',
      modelMessageId: 'model-1',
      ordinal: 1,
      name: 'read_file',
      args: { path: 'src/core/runtime/agent.ts' },
    },
    { type: 'tool.started', toolCallId: 'shell-1' },
  ]);
  const activeTaskId = kernel.getState().activeTaskId;

  const events = eventsForRunCancellation(kernel.getState());
  kernel.processEventBatch(events);

  expect(events.map((event) => event.type)).toEqual([
    'tool.cancelled',
    'tool.cancelled',
    'turn.aborted',
  ]);
  expect(kernel.getState().tools.queue).toEqual([]);
  expect(kernel.getState().tools.active).toEqual([]);
  expect(kernel.getState().tools.calls['shell-1']!.status).toBe('cancelled');
  expect(kernel.getState().tools.calls['read-1']!.status).toBe('cancelled');
  expect(kernel.getState().activeTaskId).toBe(activeTaskId);
  expect(
    kernel
      .getState()
      .transcript.messages.filter((message) => message.kind === 'tool')
      .map((message) => message.toolCallId),
  ).toEqual(['shell-1', 'read-1']);
  expect(
    kernel.runtimeStore
      .loadEventsStrict('cancel-run')
      .slice(-3)
      .map(({ event }) => event),
  ).toMatchObject([
    { type: 'tool.cancelled', toolCallId: 'shell-1' },
    { type: 'tool.cancelled', toolCallId: 'read-1' },
    { type: 'turn.aborted', cause: 'user' },
  ]);
  kernel.close();
});

test('Kernel atomically terminalizes a suspended Tool with its prepared capability receipt', () => {
  const store = openStateStoreForTest(':memory:');
  const initial = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'suspended-capability-receipt',
    userId: 'u',
    workspace: '/workspace',
  });
  const kernel = new AgentKernel({
    store,
    initialState: initial,
    interactionMode: 'accept_edits',
  });
  const invocationId = 'capability-suspended-fixture';
  kernel.processEventBatch([
    {
      type: 'tool.queued',
      toolCallId: 'control-1',
      name: 'write_plan',
      args: { action: 'submit' },
    },
    { type: 'tool.started', toolCallId: 'control-1' },
    {
      type: 'capability.invocation_recorded',
      invocationId,
      toolCallId: 'control-1',
      capabilityId: 'builtin:write_plan',
      capabilityRevision: 'fixture-revision',
      argumentsDigest: 'args-digest',
      authorizationDigest: 'authorization-digest',
      admissionDigest: 'admission-digest',
      effectiveEffectsDigest: 'effects-digest',
      effectiveEffects: { filesystem: 'none', network: 'none', externalState: 'write' },
      receiptRequirement: 'control_receipt',
      retryEligibility: 'none',
      recordedAt: '2026-08-16T00:00:00.000Z',
    },
    {
      type: 'capability.execution_started',
      invocationId,
      attempt: 1,
      startedAt: '2026-08-16T00:00:01.000Z',
    },
    {
      type: 'capability.execution_result_recorded',
      invocationId,
      resultDigest: 'result-digest',
      evidenceDigest: 'evidence-digest',
      recordedAt: '2026-08-16T00:00:02.000Z',
      artifact: {
        artifactId: `pa_${'a'.repeat(64)}`,
        kind: 'capability_result',
        integrityIdentifier: `sha256:${'b'.repeat(64)}`,
        byteLength: 42,
      },
    },
  ]);

  const terminal = kernel.processEventBatch([
    {
      type: 'tool.finished',
      toolCallId: 'control-1',
      name: 'write_plan',
      result: { ok: true, command: '', exitCode: 0, stdout: 'approved', stderr: '' },
    },
  ]);

  expect(terminal.map((event) => event.type)).toEqual([
    'capability.execution_succeeded',
    'tool.finished',
  ]);
  expect(kernel.getState().capabilities.invocations[invocationId]).toMatchObject({
    status: 'succeeded',
    artifact: { kind: 'capability_result' },
  });
  expect(kernel.getState().tools.calls['control-1']?.status).toBe('succeeded');
  kernel.close();
});

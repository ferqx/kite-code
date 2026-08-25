import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import { assertAgentStateInvariants, assertCurrentRuntimeEvent } from '@kite-ai/agent-kernel';
import { capabilityResultDigest, capabilityResultEvidenceDigest } from '@kite-ai/builtin-runtime';
import { digestCapabilityValue } from '@kite-ai/builtin-runtime/capability';
import {
  workspaceFilesystemIntentDigest,
  workspaceFilesystemMutationReadyDigest,
} from '@kite-ai/builtin-runtime/filesystem';
import type {
  WorkspaceFilesystemIntentRecord,
  WorkspaceFilesystemMutationReadyRecord,
} from '@kite-ai/runtime-contract';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { restoreStateStateFromStore as restoreRuntimeStateFromStore } from '../../scripts/support/runtime-host-state';
import { openStateStoreForTest } from '../../scripts/support/runtime-storage';

const BARE_A = 'a'.repeat(64);
const BARE_B = 'b'.repeat(64);
const SHA_A = `sha256:${BARE_A}`;
const SHA_B = `sha256:${BARE_B}`;
const AT = '2026-08-17T00:00:00.000Z';
const WRITE_EFFECTS_DIGEST = digestCapabilityValue({
  filesystem: 'write',
  network: 'none',
  externalState: 'none',
});

describe('Runtime filesystem evidence', () => {
  test('rejects malformed and digest-tampered intent/ready events at the current codec boundary', () => {
    const intent = intentRecord();
    const intentEvent: RuntimeEvent = {
      type: 'capability.filesystem_intent_recorded',
      invocationId: 'invocation-1',
      ...intent,
    };
    expect(() => assertCurrentRuntimeEvent(intentEvent)).not.toThrow();
    expect(() => assertCurrentRuntimeEvent({ ...intentEvent, operationDigest: SHA_B })).toThrow(
      'digest mismatch',
    );
    expect(() => assertCurrentRuntimeEvent({ ...intentEvent, extra: true })).toThrow(
      'invalid shape',
    );

    const ready = readyRecord(intent);
    const readyEvent: RuntimeEvent = {
      type: 'capability.filesystem_mutation_ready',
      invocationId: 'invocation-1',
      ...ready,
    };
    expect(() => assertCurrentRuntimeEvent(readyEvent)).not.toThrow();
    expect(() =>
      assertCurrentRuntimeEvent({
        ...readyEvent,
        preimageArtifact: { ...ready.preimageArtifact, byteLength: -1 },
      }),
    ).toThrow('Artifact byteLength');
    expect(() => assertCurrentRuntimeEvent({ ...readyEvent, readyAt: 'not-a-date' })).toThrow(
      'readyAt',
    );
  });

  test('rejects tampered filesystem evidence already present in a current-format snapshot', () => {
    const state = runningFilesystemInvocation();
    state.capabilities.invocations['invocation-1']!.filesystemIntent = {
      ...intentRecord(),
      operationDigest: SHA_B,
    };
    expect(() => assertAgentStateInvariants(state)).toThrow('intent evidence is invalid');
  });

  test('clears prior-attempt filesystem authority before acknowledging a retry attempt', () => {
    let state = runningFilesystemInvocation();
    const intent = intentRecord();
    state = reduceRuntimeState(state, {
      type: 'capability.filesystem_intent_recorded',
      invocationId: 'invocation-1',
      ...intent,
    });
    state = reduceRuntimeState(state, {
      type: 'capability.filesystem_mutation_ready',
      invocationId: 'invocation-1',
      ...readyRecord(intent),
    });
    assertAgentStateInvariants(state);

    state = reduceRuntimeState(state, {
      type: 'capability.execution_started',
      invocationId: 'invocation-1',
      attempt: 2,
      startedAt: '2026-08-17T00:00:01.000Z',
    });

    expect(state.capabilities.invocations['invocation-1']).toMatchObject({
      attemptsStarted: 2,
      filesystemIntent: undefined,
      filesystemMutationReady: undefined,
    });
    expect(() => assertAgentStateInvariants(state)).not.toThrow();
  });

  test('marks a parseable current-tail intent with a forged digest as corrupted on restore', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-filesystem-evidence-'));
    const databasePath = join(root, 'runtime.db');
    try {
      const store = openStateStoreForTest(databasePath);
      const snapshot = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'filesystem-restore-tamper',
        userId: 'test',
        workspace: '/workspace',
      });
      store.saveSnapshot('filesystem-restore-tamper', snapshot);
      store.close();

      // The State codec correctly refuses this forged event on normal writes.
      // Seed it only as a persisted-corruption fixture after the sole adapter is
      // closed, so restore still exercises the fail-closed tail path.
      const forged = {
        type: 'capability.filesystem_intent_recorded',
        invocationId: 'invocation-1',
        ...intentRecord(),
        operationDigest: SHA_B,
      } as RuntimeEvent;
      const database = new Database(databasePath);
      database.run(
        'INSERT INTO runtime_events (session_id, event_id, sequence, schema_version, event_json, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch())',
        ['filesystem-restore-tamper', 'event-1', 1, 26, JSON.stringify(forged), AT],
      );
      database.close();

      expect(() =>
        openStateStoreForTest(databasePath, { sessionId: 'filesystem-restore-tamper' }),
      ).toThrow('Runtime format is incompatible');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('marks restored filesystem observation evidence with the wrong Artifact owner as corrupted', () => {
    const store = openStateStoreForTest(':memory:');
    const observation = {
      actorIdentityDigest: BARE_A,
      lexicalTargetDigest: SHA_A,
      canonicalTargetDigest: SHA_A,
      targetIdentityDigest: SHA_A,
      contentDigest: SHA_A,
    };
    const result = {
      status: 'success' as const,
      content: [],
      structuredContent: { filesystemObservation: observation },
    };
    let state = runningFilesystemInvocation();
    const intent = intentRecord();
    state = reduceRuntimeState(state, {
      type: 'capability.filesystem_intent_recorded',
      invocationId: 'invocation-1',
      ...intent,
    });
    state = reduceRuntimeState(state, {
      type: 'capability.filesystem_mutation_ready',
      invocationId: 'invocation-1',
      ...readyRecord(intent),
    });
    state = reduceRuntimeState(state, {
      type: 'capability.execution_succeeded',
      invocationId: 'invocation-1',
      resultDigest: capabilityResultDigest(result),
      evidenceDigest: capabilityResultEvidenceDigest(result),
      finishedAt: AT,
      artifact: {
        artifactId: `pa_${BARE_A}`,
        kind: 'capability_result',
        integrityIdentifier: `sha256:${BARE_B}`,
        byteLength: 1,
      },
      filesystemObservation: observation,
    });
    assertAgentStateInvariants(state);
    store.saveSnapshot('filesystem-evidence', state);

    const restored = restoreRuntimeStateFromStore({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      store,
      threadId: 'filesystem-evidence',
      userId: 'test',
      workspace: '/workspace',
      capabilityArtifactEvidence: {
        read: () => result,
        readEnvelope: () => ({
          artifactFormatVersion: 2,
          invocationId: 'different-invocation',
          result,
        }),
      },
    });
    expect(restored.state.recoveryState.kind).toBe('corrupted');
    store.close();
  });

  test('rejects observation authority for a different lexical target than its intent', () => {
    let state = runningFilesystemInvocation();
    const intent = intentRecord();
    state = reduceRuntimeState(state, {
      type: 'capability.filesystem_intent_recorded',
      invocationId: 'invocation-1',
      ...intent,
    });
    state = reduceRuntimeState(state, {
      type: 'capability.filesystem_mutation_ready',
      invocationId: 'invocation-1',
      ...readyRecord(intent),
    });
    state = reduceRuntimeState(state, {
      type: 'capability.execution_succeeded',
      invocationId: 'invocation-1',
      resultDigest: BARE_A,
      evidenceDigest: BARE_A,
      finishedAt: AT,
      artifact: {
        artifactId: `pa_${BARE_A}`,
        kind: 'capability_result',
        integrityIdentifier: `sha256:${BARE_B}`,
        byteLength: 1,
      },
      filesystemObservation: {
        actorIdentityDigest: BARE_A,
        lexicalTargetDigest: SHA_B,
        canonicalTargetDigest: SHA_A,
        targetIdentityDigest: SHA_A,
        contentDigest: SHA_A,
      },
    });

    expect(() => assertAgentStateInvariants(state)).toThrow('observation target is inconsistent');
  });

  test('rejects write observation authority without same-attempt mutation-ready evidence', () => {
    let state = runningFilesystemInvocation();
    const intent = intentRecord();
    state = reduceRuntimeState(state, {
      type: 'capability.filesystem_intent_recorded',
      invocationId: 'invocation-1',
      ...intent,
    });
    state = reduceRuntimeState(state, {
      type: 'capability.execution_succeeded',
      invocationId: 'invocation-1',
      resultDigest: BARE_A,
      evidenceDigest: BARE_A,
      finishedAt: AT,
      artifact: {
        artifactId: `pa_${BARE_A}`,
        kind: 'capability_result',
        integrityIdentifier: `sha256:${BARE_B}`,
        byteLength: 1,
      },
      filesystemObservation: {
        actorIdentityDigest: BARE_A,
        lexicalTargetDigest: SHA_A,
        canonicalTargetDigest: SHA_A,
        targetIdentityDigest: SHA_A,
        contentDigest: SHA_A,
      },
    });

    expect(() => assertAgentStateInvariants(state)).toThrow(
      'observation lacks mutation-ready authority',
    );
  });

  test('rejects observation authority attached to a non-filesystem capability family', () => {
    let state = runningFilesystemInvocation();
    const intent = intentRecord();
    state = reduceRuntimeState(state, {
      type: 'capability.filesystem_intent_recorded',
      invocationId: 'invocation-1',
      ...intent,
    });
    state.capabilities.invocations['invocation-1']!.capabilityId = 'mcp-invocation';
    state = reduceRuntimeState(state, {
      type: 'capability.execution_succeeded',
      invocationId: 'invocation-1',
      resultDigest: BARE_A,
      evidenceDigest: BARE_A,
      finishedAt: AT,
      artifact: {
        artifactId: `pa_${BARE_A}`,
        kind: 'capability_result',
        integrityIdentifier: `sha256:${BARE_B}`,
        byteLength: 1,
      },
      filesystemObservation: {
        actorIdentityDigest: BARE_A,
        lexicalTargetDigest: SHA_A,
        canonicalTargetDigest: SHA_A,
        targetIdentityDigest: SHA_A,
        contentDigest: SHA_A,
      },
    });

    expect(() => assertAgentStateInvariants(state)).toThrow('unsupported observation capability');
  });
});

function runningFilesystemInvocation() {
  let state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'filesystem-evidence',
    userId: 'test',
    workspace: '/workspace',
  });
  state = reduceRuntimeState(state, {
    type: 'capability.invocation_recorded',
    invocationId: 'invocation-1',
    toolCallId: 'tool-1',
    capabilityId: 'builtin:write_file',
    capabilityRevision: BARE_A,
    argumentsDigest: BARE_A,
    authorizationDigest: BARE_A,
    admissionDigest: BARE_A,
    effectiveEffectsDigest: WRITE_EFFECTS_DIGEST,
    effectiveEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
    receiptRequirement: 'effect_receipt',
    recordedAt: AT,
  });
  return reduceRuntimeState(state, {
    type: 'capability.execution_started',
    invocationId: 'invocation-1',
    attempt: 1,
    startedAt: AT,
  });
}

function intentRecord(): WorkspaceFilesystemIntentRecord {
  const unsigned = {
    attempt: 1,
    capabilityRevision: BARE_A,
    argumentsDigest: BARE_A,
    admissionDigest: BARE_A,
    operationDigest: SHA_A,
    searchBoundaryDigest: null,
    lexicalTargetDigest: SHA_A,
    canonicalWorkspaceDigest: SHA_A,
    protectedPathRevision: 'protected-path-unconfigured-v1',
    approvalSummaryDigest: SHA_A,
    effectiveEffectsDigest: WRITE_EFFECTS_DIGEST,
    recordedAt: AT,
  };
  return { ...unsigned, intentDigest: workspaceFilesystemIntentDigest(unsigned) };
}

function readyRecord(
  intent: WorkspaceFilesystemIntentRecord,
): WorkspaceFilesystemMutationReadyRecord {
  const unsigned = {
    attempt: intent.attempt,
    intentDigest: intent.intentDigest,
    operationDigest: intent.operationDigest,
    targetIdentityDigest: SHA_A,
    preimageDigest: SHA_A,
    preimageArtifact: {
      artifactId: `pa_${BARE_A}`,
      kind: 'filesystem_preimage' as const,
      integrityIdentifier: `sha256:${BARE_B}`,
      byteLength: 42,
    },
    readyAt: AT,
  };
  return { ...unsigned, readyDigest: workspaceFilesystemMutationReadyDigest(unsigned) };
}

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCompactionSummary } from '@/core/model/compaction-summary-frame';
import { findSafeCompactionBoundary } from '@/core/model/compaction-v2';
import {
  CONTEXT_ESTIMATOR_ID_V2,
  CONTEXT_PROJECTION_CONTRACT_V2,
  canonicalContextDigestV2,
} from '@/core/model/context-preparation-v2';
import { AgentKernel, createAgentKernel } from '@/core/runtime/kernel';
import {
  type LegacyContextCompactionCheckpointV2,
  type LegacyContextCompactionSourceManifestV1,
  readLegacyCheckpointV2ReadOnly,
} from '@/core/runtime/legacy-slice-b-reader';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';

function legacyFixture(options: { threadId?: string; settledContent?: string } = {}) {
  const state = createInitialRuntimeState({
    threadId: options.threadId ?? 'legacy-checkpoint-v2',
    userId: 'fixture',
    workspace: '/',
  });
  state.transcript.messages = [
    {
      kind: 'user',
      messageId: 'settled-user',
      turnId: 'settled-turn',
      ordinal: 0,
      createdAt: '2026-08-10T00:00:00.000Z',
      content: options.settledContent ?? `settled history ${'x'.repeat(24_000)}`,
    },
    {
      kind: 'assistant',
      messageId: 'settled-assistant',
      turnId: 'settled-turn',
      ordinal: 1,
      createdAt: '2026-08-10T00:00:01.000Z',
      content: 'settled answer',
      toolCalls: [],
    },
  ];
  const boundary = findSafeCompactionBoundary(state);
  if (
    !boundary.eligible ||
    !boundary.firstMessageId ||
    !boundary.lastMessageId ||
    !boundary.coveredThroughTurnId
  )
    throw new Error('invalid fixture boundary');
  const transcriptProof = state.transcript.messages.map(
    ({ createdAt: _createdAt, ...message }) => message,
  );
  const base = { kind: 'none' as const };
  const rawTranscriptDigest = canonicalContextDigestV2(
    'context-compaction-raw-transcript:v2',
    transcriptProof,
  );
  const rawSourceDigest = canonicalContextDigestV2('context-compaction-raw-source:v2', {
    base,
    rawTranscriptDigest,
    sourceStartMessageId: boundary.firstMessageId,
    coveredThroughMessageId: boundary.lastMessageId,
    coveredThroughTurnId: boundary.coveredThroughTurnId,
  });
  const summary = normalizeCompactionSummary(
    'The settled history is represented by one bounded narrative.',
  );
  if (!summary) throw new Error('invalid fixture summary');
  const manifest: LegacyContextCompactionSourceManifestV1 = {
    version: 1,
    sourceRevision: state.revision,
    sourceStartMessageId: boundary.firstMessageId,
    coveredThroughMessageId: boundary.lastMessageId,
    coveredThroughTurnId: boundary.coveredThroughTurnId,
    rawSourceDigest,
    rawTranscriptDigest,
    rawFramesDigest: '1'.repeat(64),
    summaryProjectionDigest: '2'.repeat(64),
    appliedFramesDigest: '3'.repeat(64),
    toolResultBudgetPolicyId: 'tool-result-budget-registry:v2',
    reclaimPolicyId: 'context-reclaim-live:v2',
    summaryPolicyId: 'context-compaction-summary:v2',
    estimatorId: CONTEXT_ESTIMATOR_ID_V2,
    projectionEnvironmentDigest: '4'.repeat(64),
    cacheAffectingEnvironmentDigest: '5'.repeat(64),
    projectionContractId: CONTEXT_PROJECTION_CONTRACT_V2,
    routeIdentityDigest: '6'.repeat(64),
    requestShape: 'isolated_minimal_no_tools:v1',
    sourceIdentity: 'verified_v2',
    base,
    reclaimApplication: { kind: 'off', rawFramesDigest: '1'.repeat(64) },
  };
  const checkpoint: LegacyContextCompactionCheckpointV2 = {
    compactionId: 'legacy-v2',
    version: 2,
    sourceRevision: state.revision,
    sourceDigest: rawSourceDigest,
    rawSourceDigest,
    sourceIdentity: 'verified_v2',
    coveredThroughMessageId: boundary.lastMessageId,
    coveredThroughTurnId: boundary.coveredThroughTurnId,
    summary,
    inputTokensBefore: 8_000,
    inputTokensAfter: 100,
    reason: 'manual',
    createdAt: '2026-08-10T00:00:02.000Z',
    base,
    rawTranscriptDigest,
    rawFramesDigest: manifest.rawFramesDigest,
    summaryProjectionDigest: manifest.summaryProjectionDigest,
    appliedFramesDigest: manifest.appliedFramesDigest,
    normalizedSummaryDigest: canonicalContextDigestV2('normalized-compaction-summary:v2', summary),
    candidateAfterFramesDigest: '7'.repeat(64),
    candidateAfterProjectionDigest: '8'.repeat(64),
    toolResultBudgetPolicyId: manifest.toolResultBudgetPolicyId,
    reclaimPolicyId: manifest.reclaimPolicyId,
    summaryPolicyId: manifest.summaryPolicyId,
    estimatorId: manifest.estimatorId,
    projectionEnvironmentDigest: manifest.projectionEnvironmentDigest,
    cacheAffectingEnvironmentDigest: manifest.cacheAffectingEnvironmentDigest,
    projectionContractId: manifest.projectionContractId,
    routeIdentityDigest: manifest.routeIdentityDigest,
    requestShape: manifest.requestShape,
    manifestIdentity: canonicalContextDigestV2('context-compaction-source-manifest:v1', manifest),
    sourceManifest: manifest,
    reclaimApplication: manifest.reclaimApplication,
  };
  return { state, checkpoint };
}

function temporaryStore(label: string) {
  const directory = mkdtempSync(join(tmpdir(), `openpx-checkpoint-v2-${label}-`));
  return { directory, storePath: join(directory, 'runtime.db') };
}

describe('legacy checkpoint-v2 read-only compatibility', () => {
  test('accepts a bounded historical checkpoint without exposing any writer', () => {
    const value = legacyFixture();
    expect(readLegacyCheckpointV2ReadOnly(value)).toMatchObject({
      version: 1,
      compactionId: 'legacy-v2',
      sourceDigest: value.checkpoint.rawSourceDigest,
    });
  });

  test('rejects transcript and manifest tampering', () => {
    const transcriptTamper = legacyFixture();
    const first = transcriptTamper.state.transcript.messages[0];
    if (first?.kind !== 'user') throw new Error('invalid fixture');
    first.content = 'tampered';
    expect(() => readLegacyCheckpointV2ReadOnly(transcriptTamper)).toThrow(
      'legacy_checkpoint_v2_source_mismatch',
    );

    const manifestTamper = legacyFixture();
    manifestTamper.checkpoint.sourceManifest = {
      ...manifestTamper.checkpoint.sourceManifest,
      rawFramesDigest: '9'.repeat(64),
    };
    expect(() => readLegacyCheckpointV2ReadOnly(manifestTamper)).toThrow(
      'legacy_checkpoint_v2_manifest_mismatch',
    );

    const coveredIdentityTamper = legacyFixture();
    coveredIdentityTamper.checkpoint.sourceManifest = {
      ...coveredIdentityTamper.checkpoint.sourceManifest,
      coveredThroughMessageId: 'forged-covered-message',
    };
    coveredIdentityTamper.checkpoint.manifestIdentity = canonicalContextDigestV2(
      'context-compaction-source-manifest:v1',
      coveredIdentityTamper.checkpoint.sourceManifest,
    );
    expect(() => readLegacyCheckpointV2ReadOnly(coveredIdentityTamper)).toThrow(
      'legacy_checkpoint_v2_manifest_mismatch',
    );
  });

  test('fails closed on unbounded or malformed legacy envelopes', () => {
    const unknownKey = legacyFixture();
    (
      unknownKey.checkpoint as LegacyContextCompactionCheckpointV2 & { writerHint?: string }
    ).writerHint = 'revive-v2';
    expect(() => readLegacyCheckpointV2ReadOnly(unknownKey)).toThrow(
      'legacy_checkpoint_v2_envelope_invalid',
    );

    const invalidDate = legacyFixture();
    invalidDate.checkpoint.createdAt = 'August 10, 2026';
    expect(() => readLegacyCheckpointV2ReadOnly(invalidDate)).toThrow(
      'legacy_checkpoint_v2_envelope_invalid',
    );

    const invalidTokens = legacyFixture();
    invalidTokens.checkpoint.inputTokensBefore = -1;
    expect(() => readLegacyCheckpointV2ReadOnly(invalidTokens)).toThrow(
      'legacy_checkpoint_v2_envelope_invalid',
    );

    const oversizedSummary = legacyFixture();
    oversizedSummary.checkpoint.summary = `summary ${'x'.repeat(128 * 1_024)}`;
    expect(() => readLegacyCheckpointV2ReadOnly(oversizedSummary)).toThrow(
      'legacy_checkpoint_v2_envelope_invalid',
    );

    const oversizedSource = legacyFixture({ settledContent: 'x'.repeat(16 * 1_024 * 1_024) });
    expect(() => readLegacyCheckpointV2ReadOnly(oversizedSource)).toThrow(
      'legacy_checkpoint_v2_source_too_large',
    );
  });

  test('rejects oversized and unknown data before traversing later getters', () => {
    const oversizedSummary = legacyFixture();
    let summaryReachedManifest = false;
    oversizedSummary.checkpoint.summary = 'x'.repeat(128 * 1_024 + 1);
    Object.defineProperty(oversizedSummary.checkpoint, 'sourceManifest', {
      enumerable: true,
      get() {
        summaryReachedManifest = true;
        throw new Error('source manifest must not be reached');
      },
    });
    expect(() => readLegacyCheckpointV2ReadOnly(oversizedSummary)).toThrow(
      'legacy_checkpoint_v2_envelope_invalid',
    );
    expect(summaryReachedManifest).toBe(false);

    const unknownNested = legacyFixture();
    let unknownReachedBase = false;
    const maliciousManifest = {
      ...unknownNested.checkpoint.sourceManifest,
      unknownNestedField: 'reject-before-known-getters',
    } as LegacyContextCompactionSourceManifestV1 & { unknownNestedField: string };
    Object.defineProperty(maliciousManifest, 'base', {
      enumerable: true,
      get() {
        unknownReachedBase = true;
        throw new Error('base must not be reached');
      },
    });
    unknownNested.checkpoint.sourceManifest = maliciousManifest;
    expect(() => readLegacyCheckpointV2ReadOnly(unknownNested)).toThrow(
      'legacy_checkpoint_v2_manifest_invalid',
    );
    expect(unknownReachedBase).toBe(false);

    const oversizedManifestField = legacyFixture();
    let oversizedReachedBase = false;
    const largeIdManifest = {
      ...oversizedManifestField.checkpoint.sourceManifest,
      sourceStartMessageId: 'x'.repeat(513),
    };
    Object.defineProperty(largeIdManifest, 'base', {
      enumerable: true,
      get() {
        oversizedReachedBase = true;
        throw new Error('base must not be reached');
      },
    });
    oversizedManifestField.checkpoint.sourceManifest = largeIdManifest;
    expect(() => readLegacyCheckpointV2ReadOnly(oversizedManifestField)).toThrow(
      'legacy_checkpoint_v2_manifest_invalid',
    );
    expect(oversizedReachedBase).toBe(false);

    const oversizedArray = legacyFixture();
    let oversizedArrayElementRead = false;
    const messages = new Array(20_001) as typeof oversizedArray.state.transcript.messages;
    Object.defineProperty(messages, 0, {
      enumerable: true,
      get() {
        oversizedArrayElementRead = true;
        throw new Error('oversized source array must not be traversed');
      },
    });
    oversizedArray.state.transcript.messages = messages;
    expect(() => readLegacyCheckpointV2ReadOnly(oversizedArray)).toThrow(
      'legacy_checkpoint_v2_source_too_large',
    );
    expect(oversizedArrayElementRead).toBe(false);

    const oversizedProof = legacyFixture({ settledContent: 'x'.repeat(16 * 1_024 * 1_024) });
    let laterProofContentRead = false;
    const laterMessage = oversizedProof.state.transcript.messages[1];
    if (!laterMessage) throw new Error('missing later proof message');
    Object.defineProperty(laterMessage, 'content', {
      enumerable: true,
      get() {
        laterProofContentRead = true;
        throw new Error('later proof content must not be reached');
      },
    });
    expect(() => readLegacyCheckpointV2ReadOnly(oversizedProof)).toThrow(
      'legacy_checkpoint_v2_source_too_large',
    );
    expect(laterProofContentRead).toBe(false);

    const escapedProof = legacyFixture();
    const escapedFirst = escapedProof.state.transcript.messages[0];
    const escapedLater = escapedProof.state.transcript.messages[1];
    if (escapedFirst?.kind !== 'user' || !escapedLater) {
      throw new Error('invalid escaped proof fixture');
    }
    escapedFirst.content = '\0'.repeat(3 * 1_024 * 1_024);
    let escapedLaterContentRead = false;
    Object.defineProperty(escapedLater, 'content', {
      enumerable: true,
      get() {
        escapedLaterContentRead = true;
        throw new Error('later escaped proof content must not be reached');
      },
    });
    expect(() => readLegacyCheckpointV2ReadOnly(escapedProof)).toThrow(
      'legacy_checkpoint_v2_source_too_large',
    );
    expect(escapedLaterContentRead).toBe(false);
  });

  test('rejects checkpoint-v2 completion at the live Kernel boundary', () => {
    const fixture = legacyFixture({ threadId: 'legacy-v2-live-rejection' });
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      interactionMode: 'accept_edits',
      initialState: fixture.state,
    });
    try {
      expect(() =>
        kernel.processEvent({
          type: 'context.compaction_completed',
          compactionId: fixture.checkpoint.compactionId,
          sourceRevision: fixture.checkpoint.sourceRevision,
          checkpoint: fixture.checkpoint,
        }),
      ).toThrow('Superseded Slice B events are accepted only by read-only restore.');
      expect(store.loadEventsStrict('legacy-v2-live-rejection')).toEqual([]);
    } finally {
      kernel.close();
    }
  });

  test('restores a schema-v23 snapshot read-only and never re-saves checkpoint-v2', () => {
    const { directory, storePath } = temporaryStore('restore');
    const threadId = 'legacy-v2-restore';
    try {
      const fixture = legacyFixture({ threadId });
      fixture.state.context = {
        ...fixture.state.context,
        activeCheckpoint: fixture.checkpoint,
        autoGuard: { version: 1, lastCompactionRevision: 0 },
        autoGuardV2: { version: 2, lastCompactionRevision: 0 },
      } as unknown as typeof fixture.state.context;
      const writer = createRuntimeStore(storePath);
      writer.saveSnapshot(threadId, fixture.state);
      writer.close();

      const kernel = createAgentKernel({ threadId, userId: 'fixture', workspace: '/', storePath });
      expect(kernel.getState().context.activeCheckpoint).toMatchObject({
        version: 1,
        compactionId: fixture.checkpoint.compactionId,
      });
      expect(kernel.getState().context).not.toHaveProperty('autoGuard');
      expect(kernel.getState().context).not.toHaveProperty('autoGuardV2');
      kernel.saveSnapshot();
      kernel.close();

      const verifier = createRuntimeStore(storePath);
      const persisted = verifier.loadSnapshot<typeof fixture.state>(threadId);
      expect(persisted?.context.activeCheckpoint?.version).toBe(1);
      expect(persisted?.context).not.toHaveProperty('autoGuard');
      expect(persisted?.context).not.toHaveProperty('autoGuardV2');
      verifier.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('downgrades legacy checkpoint-v2 across replay, fork, and rewind boundaries', () => {
    const { directory, storePath } = temporaryStore('boundaries');
    const sourceThreadId = 'legacy-v2-source';
    const forkThreadId = 'legacy-v2-fork';
    try {
      const fixture = legacyFixture({ threadId: sourceThreadId });
      const pendingState = {
        ...fixture.state,
        context: {
          ...fixture.state.context,
          pendingCompaction: {
            compactionId: fixture.checkpoint.compactionId,
            reason: 'manual' as const,
            requestedAtRevision: fixture.state.revision,
            requestedAtTurnId: fixture.state.turn.turnId,
            force: false,
            estimate: {
              systemTokens: 0,
              toolSchemaTokens: 0,
              transcriptTokens: 8_000,
              summaryTokens: 0,
              dynamicRuntimeTokens: 0,
              framingTokens: 0,
              totalInputTokens: 8_000,
            },
          },
        },
      };
      const writer = createRuntimeStore(storePath);
      writer.saveSnapshot(sourceThreadId, pendingState);
      writer.saveNamedSnapshot(sourceThreadId, 'legacy-v2-rewind', {
        ...fixture.state,
        context: { ...fixture.state.context, activeCheckpoint: fixture.checkpoint },
      });
      writer.appendEvents(
        sourceThreadId,
        [
          {
            type: 'context.compaction_completed',
            compactionId: fixture.checkpoint.compactionId,
            sourceRevision: fixture.checkpoint.sourceRevision,
            checkpoint: fixture.checkpoint,
          },
        ],
        [
          {
            eventId: 'legacy-v2-completed',
            revision: 1,
            occurredAt: '2026-08-10T00:00:03.000Z',
          },
        ],
      );
      writer.close();

      const replayed = createAgentKernel({
        threadId: sourceThreadId,
        userId: 'fixture',
        workspace: '/',
        storePath,
      });
      expect(replayed.getState().context.activeCheckpoint?.version).toBe(1);
      replayed.saveSnapshot();
      replayed.close();

      const boundaryStore = createRuntimeStore(storePath);
      expect(boundaryStore.forkSession(sourceThreadId, 'legacy-v2-rewind', forkThreadId)).toBe(
        true,
      );
      expect(boundaryStore.restoreNamedSnapshot(sourceThreadId, 'legacy-v2-rewind')).toBe(true);
      boundaryStore.close();

      for (const threadId of [sourceThreadId, forkThreadId]) {
        const kernel = createAgentKernel({
          threadId,
          userId: 'fixture',
          workspace: '/',
          storePath,
        });
        expect(kernel.getState().context.activeCheckpoint?.version).toBe(1);
        kernel.saveSnapshot();
        kernel.close();

        const verifier = createRuntimeStore(storePath);
        expect(
          verifier.loadSnapshot<typeof fixture.state>(threadId)?.context.activeCheckpoint,
        ).toMatchObject({ version: 1, compactionId: fixture.checkpoint.compactionId });
        verifier.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

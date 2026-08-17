import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatModel } from '@/core/model/factory';
import { loadOrCreateModelArtifactIntegrityKeyV1 } from '@/core/model/model-artifact-key';
import { ModelArtifactStoreV1 } from '@/core/model/model-artifacts';
import { createRecordModelResponseSourceV1 } from '@/core/model/response-source';
import { PrivateArtifactStorageError } from '@/core/persistence/private-immutable-artifacts';
import { SubagentGrantAuthorityV1 } from '@/core/subagent/grant-authority';
import type {
  CanonicalModelTextPartV1,
  CanonicalModelToolCallPartV1,
  ModelAttemptOutcomeV1,
} from '@/protocol/model-surface';
import { sanitizeModelReplayRecordOutcomeV1 } from '../../../scripts/evals/model-replay-record';
import {
  createPs03LocalSubagentCandidateCatalogV1,
  createPs03ModelArtifactStoreV1,
  PS03_LOCAL_SUBAGENT_CANDIDATE_SUITE_ID_V1,
  resolvePs03GitWorktreeRootV1,
  runFreshPs03LocalSubagentReplayV1,
  runPs03LocalSubagentJourneyV1,
} from '../../../scripts/evals/model-replay-subagent-journey';

const CONFIG = {
  providerName: 'ps03-record-test',
  providerType: 'openai-compatible' as const,
  apiKey: '',
  baseURL: 'https://ps03-record-test.invalid/v1',
  modelName: 'ps03-record-test',
  sandbox: { enabled: false },
  features: { providerDataPolicyV1: false },
};

const negativeRoots: string[] = [];

afterEach(() => {
  for (const root of negativeRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PS-03 candidate Local start → blocked → resume replay contract', () => {
  test('records through Gateway ack and fresh-replays through Strict catalog exactly once', async () => {
    const model = createChatModel(CONFIG);
    const recordArtifactRoot = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'kite-ps03-replay-record-')),
    );
    const replayArtifactRoot = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'kite-ps03-replay-fresh-')),
    );
    negativeRoots.push(recordArtifactRoot, replayArtifactRoot);
    const records: import('@/protocol/model-surface').ModelReplayAttemptRecordV1[] = [];
    let liveAttempts = 0;
    const live: import('@/core/model/response-source').ModelResponseSourceV1 = {
      mode: 'live',
      attempt: async () => {
        liveAttempts += 1;
        return liveAttempts === 1
          ? successOutcome({
              type: 'tool_call',
              toolCallId: 'raw-approval-call',
              toolName: 'shell_execute',
              input: { command: 'bun run typecheck' },
            })
          : successOutcome({ type: 'text', text: 'Approved local continuation completed.' });
      },
    };
    const recordSource = createRecordModelResponseSourceV1({
      live,
      recorder: {
        append: (record) => {
          records.push(record);
        },
      },
      encodeForCassette: ({ outcome, context, attemptOrdinal }) => {
        if (!context.replayBinding) throw new Error('missing candidate replay binding');
        return sanitizeModelReplayRecordOutcomeV1({
          outcome,
          purpose: context.purpose,
          actor: context.replayBinding.actor,
          logicalInvocationOrdinal: context.replayBinding.logicalInvocationOrdinal,
          attemptOrdinal,
        });
      },
    });
    const recorded = await runPs03LocalSubagentJourneyV1({
      config: CONFIG,
      model,
      source: recordSource,
      suiteRevision: 2,
      artifactRoot: recordArtifactRoot,
    });
    expect(recorded).toMatchObject({
      mode: 'record',
      status: 'candidate_preflight_passed',
      lifecycle: { started: true, blocked: true, resumed: true },
      modelAttemptCount: 2,
      providerSourceAttempts: 2,
      providerTransportAttempts: 2,
      liveFallback: false,
      artifactReadback: { modelSurfaces: 2, modelResponses: 2, capabilityReceipt: true },
    });
    for (const ref of recorded.artifactReadback.refs) {
      expect(ref.surface.artifactId).toMatch(/^pa_[0-9a-f]{64}$/u);
      expect(ref.response.artifactId).toMatch(/^pa_[0-9a-f]{64}$/u);
    }
    expect(liveAttempts).toBe(2);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.actor.kind)).toEqual(['subagent', 'subagent']);
    expect(records[0]?.actor).toMatchObject({
      parentToolCallId: 'ps03-parent-task',
      continuationId: null,
    });
    expect(records[1]?.actor).toMatchObject({
      parentToolCallId: 'ps03-parent-task',
    });
    expect(records[1]?.actor.kind === 'subagent' ? records[1].actor.continuationId : null).toMatch(
      /^continuation-/,
    );

    const catalog = createPs03LocalSubagentCandidateCatalogV1({ records, suiteRevision: 2 });
    expect(catalog.suite.suiteId).toBe(PS03_LOCAL_SUBAGENT_CANDIDATE_SUITE_ID_V1);
    const replayed = await runFreshPs03LocalSubagentReplayV1({
      config: { ...CONFIG, apiKey: '' },
      catalog,
      artifactRoot: replayArtifactRoot,
    });
    expect(replayed).toMatchObject({
      mode: 'replay',
      status: 'fresh_replay_passed',
      lifecycle: { started: true, blocked: true, resumed: true },
      providerSourceAttempts: 2,
      providerTransportAttempts: 0,
      keyless: true,
      liveFallback: false,
      artifactReadback: { modelSurfaces: 2, modelResponses: 2, capabilityReceipt: true },
      allRecordsConsumed: true,
    });
    const recordKey = readFileSync(join(recordArtifactRoot, 'model-artifacts.key'));
    const replayKey = readFileSync(join(replayArtifactRoot, 'model-artifacts.key'));
    expect(Buffer.from(recordKey)).not.toEqual(Buffer.from(replayKey));
    expect(recorded.artifactReadback.refs[0]?.surface.integrityIdentifier).not.toBe(
      replayed.artifactReadback.refs[0]?.surface.integrityIdentifier,
    );
    expect(records[0]?.actor.kind === 'subagent' ? records[0].actor.subagentId : null).toBe(
      new SubagentGrantAuthorityV1({ key: new Uint8Array(32).fill(7) }).issueChildInvocationId({
        parentModelInvocationId: 'ps03-parent-invocation',
        parentToolCallId: 'ps03-parent-task',
        parentAttempt: 1,
        role: 'code',
      }),
    );
  });

  test('keeps the actor stable when capability Artifact refs and keys change', () => {
    const authority = new SubagentGrantAuthorityV1({ key: new Uint8Array(32).fill(7) });
    const stable = {
      parentModelInvocationId: 'ps03-parent-invocation',
      parentToolCallId: 'ps03-parent-task',
      parentAttempt: 1,
      role: 'code' as const,
    };
    const capabilityArtifacts = [
      {
        invocationId: 'capability-invocation-a',
        artifactRef: `pa_${'a'.repeat(64)}`,
        artifactKey: `hmac-sha256:${'b'.repeat(64)}`,
      },
      {
        invocationId: 'capability-invocation-b',
        artifactRef: `pa_${'c'.repeat(64)}`,
        artifactKey: `hmac-sha256:${'d'.repeat(64)}`,
      },
    ];
    const actors = capabilityArtifacts.map((capabilityArtifact) => {
      void capabilityArtifact;
      return authority.issueChildInvocationId(stable);
    });
    expect(actors[0]).toBe(actors[1]);
  });

  test('rejects a replay invocation that presents credential material', async () => {
    await expect(
      runFreshPs03LocalSubagentReplayV1({
        config: { ...CONFIG, apiKey: 'credential-must-not-enter-replay' },
        catalog: {} as never,
      }),
    ).rejects.toThrow('PS03_LOCAL_SUBAGENT_REPLAY_CREDENTIAL_FORBIDDEN');
  });

  test('resolves a subdirectory to the Git worktree and rejects an explicit worktree root', () => {
    const worktreeRoot = realpathSync.native(process.cwd());
    const subdirectory = join(worktreeRoot, 'tests');
    expect(resolvePs03GitWorktreeRootV1(subdirectory)).toBe(worktreeRoot);
    expect(() => createPs03ModelArtifactStoreV1(worktreeRoot)).toThrow(
      'PS03_LOCAL_SUBAGENT_ARTIFACT_ROOT_WORKTREE_INVALID',
    );
  });

  test('fails closed on wrong-key, tamper, missing and cross-owner Model Artifact readback', async () => {
    const artifactRoot = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'kite-ps03-artifact-negative-')),
    );
    negativeRoots.push(artifactRoot);
    const model = createChatModel(CONFIG);
    let attempt = 0;
    const report = await runPs03LocalSubagentJourneyV1({
      config: CONFIG,
      model,
      artifactRoot,
      source: {
        mode: 'live',
        attempt: async () => {
          attempt += 1;
          return successOutcome(
            attempt === 1
              ? {
                  type: 'tool_call',
                  toolCallId: 'negative-approval-call',
                  toolName: 'shell_execute',
                  input: { command: 'bun run typecheck' },
                }
              : { type: 'text', text: 'Approved local continuation completed.' },
          );
        },
      },
    });
    expect(report.artifactReadback).toMatchObject({
      exactOwner: true,
      exactSchema: true,
      exactContent: true,
    });
    expect(report.artifactReadback.refs).toHaveLength(2);
    const first = report.artifactReadback.refs[0]!;
    const modelRoot = join(artifactRoot, 'model-artifacts');
    const ownerKey = loadOrCreateModelArtifactIntegrityKeyV1({
      keyPath: join(artifactRoot, 'model-artifacts.key'),
      artifactRoot: modelRoot,
    });
    const reloadedOwnerKey = loadOrCreateModelArtifactIntegrityKeyV1({
      keyPath: join(artifactRoot, 'model-artifacts.key'),
      artifactRoot: modelRoot,
    });
    expect(ownerKey.byteLength).toBe(32);
    expect(Buffer.from(reloadedOwnerKey)).toEqual(Buffer.from(ownerKey));
    const wrongKeyStore = new ModelArtifactStoreV1({
      root: modelRoot,
      integrityKey: randomBytes(32),
    });
    expectStorageError(() => wrongKeyStore.readSurface(first.surface), 'artifact_corrupt');

    const surfacePath = join(modelRoot, 'surfaces', `${first.surface.artifactId}.json`);
    const originalSurface = readFileSync(surfacePath);
    writeFileSync(surfacePath, Buffer.from('{}'));
    chmodSync(surfacePath, 0o600);
    const ownerStore = new ModelArtifactStoreV1({
      root: modelRoot,
      integrityKey: ownerKey,
    });
    expectStorageError(() => ownerStore.readSurface(first.surface), 'artifact_corrupt');
    writeFileSync(surfacePath, originalSurface);
    chmodSync(surfacePath, 0o600);

    const otherRoot = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'kite-ps03-artifact-cross-owner-')),
    );
    negativeRoots.push(otherRoot);
    const otherModelRoot = join(otherRoot, 'model-artifacts');
    const otherKey = loadOrCreateModelArtifactIntegrityKeyV1({
      keyPath: join(otherRoot, 'model-artifacts.key'),
      artifactRoot: otherModelRoot,
    });
    const otherStore = new ModelArtifactStoreV1({
      root: otherModelRoot,
      integrityKey: otherKey,
    });
    const otherSurfaceRoot = join(otherModelRoot, 'surfaces');
    mkdirSync(otherSurfaceRoot, { recursive: true, mode: 0o700 });
    copyFileSync(surfacePath, join(otherSurfaceRoot, `${first.surface.artifactId}.json`));
    expectStorageError(() => otherStore.readSurface(first.surface), 'artifact_corrupt');

    const responsePath = join(modelRoot, 'responses', `${first.response.artifactId}.json`);
    unlinkSync(responsePath);
    expectStorageError(() => ownerStore.readResponse(first.response), 'artifact_missing');
  });
});

function expectStorageError(read: () => unknown, code: PrivateArtifactStorageError['code']): void {
  let observed: unknown;
  try {
    read();
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(PrivateArtifactStorageError);
  expect((observed as PrivateArtifactStorageError).code).toBe(code);
}

function successOutcome(
  content: CanonicalModelTextPartV1 | CanonicalModelToolCallPartV1,
): ModelAttemptOutcomeV1 {
  return {
    schema: {
      name: 'kite.model-attempt-outcome',
      version: 1,
      canonicalizerVersion: 'kite.model-surface.canonical-json.v1',
    },
    kind: 'success',
    nativeReplayState: null,
    response: {
      message: { role: 'assistant', content: [content] },
      finishReason: content.type === 'tool_call' ? 'tool_calls' : 'stop',
      usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12, cacheReadTokens: 0 },
      providerMetadata: { responseId: 'raw-provider-response', rawFinishReason: null },
    },
  };
}

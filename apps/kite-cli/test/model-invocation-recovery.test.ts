import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  compileModelSurface,
  createLiveModelResponseSource,
  humanMessage,
  ModelArtifactStore,
  ModelInvocationGateway,
  PrivateArtifactStorageError,
} from '@kite-ai/builtin-runtime/model';
import type { AgentConfig } from '#kite-cli/config';
import { restoreStateHostSessionHarness as restoreStateKernelCoordinator } from '../../../scripts/support/runtime-host-state';
import { openStateStoreForTest } from '../../../scripts/support/runtime-storage';
import { createMockModel } from '../../../tests/helpers/mock-model';
import { testBuiltinModelOperationExecutionPort } from '../../../tests/helpers/model-invocation';

const CONFIG: AgentConfig = {
  apiKey: 'synthetic-unused-key',
  baseURL: 'https://model-recovery.invalid/v1',
  modelName: 'recovery-fixture',
  providerName: 'fixture',
  providerType: 'openai-compatible',
  sandbox: { enabled: false },
};

const RESPONSE = Object.freeze({
  message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'restored' }] },
  finishReason: 'stop' as const,
  usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, cacheReadTokens: null },
  providerMetadata: { responseId: 'response-recovery', rawFinishReason: 'stop' },
});

function createFixture(threadId: string) {
  const directory = mkdtempSync(join(process.cwd(), '.kite-model-recovery-'));
  const storePath = join(directory, 'runtime.db');
  const workspace = join(directory, 'workspace');
  const projectIdentity = {
    projectId: `project_${threadId}`,
    canonicalWorkspaceDigest: `sha256:${createHash('sha256').update(workspace).digest('hex')}`,
  } as const;
  const artifacts = new ModelArtifactStore({
    root: join(directory, 'model-artifacts'),
  });
  const model = createMockModel([]);
  const compiled = compileModelSurface({
    purpose: 'primary_agent',
    config: CONFIG,
    model,
    messages: [humanMessage('restore this request')],
    tools: {},
    transport: 'generate',
  });
  const gateway = new ModelInvocationGateway({
    artifacts,
    source: createLiveModelResponseSource(async () => RESPONSE),
    operationExecution: testBuiltinModelOperationExecutionPort(),
    sleep: async () => {},
  });
  const kernel = restoreStateKernelCoordinator({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId,
    userId: 'test',
    workspace,
    ...projectIdentity,
    store: openStateStoreForTest(storePath),
  });
  return {
    directory,
    storePath,
    workspace,
    projectIdentity,
    artifacts,
    model,
    compiled,
    gateway,
    kernel,
  };
}

function invokeInput(fixture: ReturnType<typeof createFixture>) {
  return {
    model: fixture.model,
    compiled: fixture.compiled,
    persistence: {
      getState: () => fixture.kernel.getState(),
      persistEvents: async (events: Parameters<typeof fixture.kernel.processEventBatch>[0]) =>
        fixture.kernel.processEventBatch(events).length === events.length,
    },
    provenance: {
      promptContractVersion: 'recovery-fixture-v1',
      projectionEnvironmentDigest: `sha256:${'1'.repeat(64)}` as const,
      capabilityBindingDigest: `sha256:${'2'.repeat(64)}` as const,
    },
    resourceKind: 'model' as const,
  };
}

describe('model invocation evidence recovery', () => {
  test('strictly verifies completed evidence across restore and a Runtime fork', async () => {
    const fixture = createFixture('model-evidence-source');
    try {
      const pending = await fixture.gateway.invoke(invokeInput(fixture));
      const invocationId = pending.invocationId;
      await pending.commitWith((response) => ({
        events: [
          {
            type: 'model.responded',
            messageId: 'assistant-restored',
            invocationId: response.invocationId,
            text: 'restored',
          },
        ],
        value: undefined,
      }));
      expect(
        fixture.kernel.runtimeStore.forkCurrentSession(
          'model-evidence-source',
          'model-evidence-fork',
          'f'.repeat(64),
        ),
      ).toBe(true);
      fixture.kernel.close();

      const restored = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'model-evidence-source',
        userId: 'test',
        workspace: fixture.workspace,
        ...fixture.projectIdentity,
        store: openStateStoreForTest(fixture.storePath),
        modelArtifactEvidence: { status: 'available', reader: fixture.artifacts },
      });
      expect(restored.getState().transcript.final).toBe('restored');
      expect(restored.getState().modelInvocations[invocationId]).toMatchObject({
        status: 'completed',
      });
      expect(
        restored.getState().modelInvocations[invocationId]?.modelEvidenceUnavailable,
      ).toBeUndefined();
      restored.close();

      const fork = restoreStateKernelCoordinator({
        recoveryIdentityKey: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        threadId: 'model-evidence-fork',
        userId: 'test',
        workspace: fixture.workspace,
        ...fixture.projectIdentity,
        store: openStateStoreForTest(fixture.storePath),
        modelArtifactEvidence: { status: 'available', reader: fixture.artifacts },
      });
      expect(fork.getState().transcript.final).toBe('restored');
      expect(fork.getState().modelInvocations[invocationId]).toMatchObject({ status: 'completed' });
      expect(
        fork.getState().modelInvocations[invocationId]?.modelEvidenceUnavailable,
      ).toBeUndefined();
      fork.close();
    } finally {
      fixture.kernel.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  test('preserves completed transcript while marking missing evidence replay-ineligible', async () => {
    const fixture = createFixture('model-evidence-missing');
    try {
      const pending = await fixture.gateway.invoke(invokeInput(fixture));
      const invocationId = pending.invocationId;
      await pending.commitWith((response) => ({
        events: [
          {
            type: 'model.responded',
            messageId: 'assistant-missing-evidence',
            invocationId: response.invocationId,
            text: 'restored',
          },
        ],
        value: undefined,
      }));
      fixture.kernel.close();

      const missing = () => {
        throw new PrivateArtifactStorageError('artifact_missing', 'fixture artifact missing');
      };
      const restored = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'model-evidence-missing',
        userId: 'test',
        workspace: fixture.workspace,
        ...fixture.projectIdentity,
        store: openStateStoreForTest(fixture.storePath),
        modelArtifactEvidence: {
          status: 'available',
          reader: { readSurface: missing, readResponse: missing },
        },
      });
      expect(restored.getState().transcript.final).toBe('restored');
      expect(restored.getState().modelInvocations[invocationId]).toMatchObject({
        status: 'completed',
        modelEvidenceUnavailable: 'artifact_missing',
      });
      restored.close();
    } finally {
      fixture.kernel.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  test('recovers prepared and dispatched crashes with exact dispatch certainty', async () => {
    const preparedFixture = createFixture('model-evidence-prepared');
    try {
      const preparedPersistence = {
        getState: () => preparedFixture.kernel.getState(),
        persistEvents: async (
          events: Parameters<typeof preparedFixture.kernel.processEventBatch>[0],
        ) => {
          if (events.some((event) => event.type === 'model.invocation_attempt_started')) {
            return false;
          }
          return preparedFixture.kernel.processEventBatch(events).length === events.length;
        },
      };
      await expect(
        preparedFixture.gateway.invoke({
          ...invokeInput(preparedFixture),
          persistence: preparedPersistence,
        }),
      ).rejects.toThrow('acknowledgement was rejected');
      const preparedId = Object.keys(preparedFixture.kernel.getState().modelInvocations)[0]!;
      expect(preparedFixture.kernel.getState().modelInvocations[preparedId]?.status).toBe(
        'prepared',
      );
      preparedFixture.kernel.close();

      const preparedRestore = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'model-evidence-prepared',
        userId: 'test',
        workspace: preparedFixture.workspace,
        ...preparedFixture.projectIdentity,
        store: openStateStoreForTest(preparedFixture.storePath),
        modelArtifactEvidence: { status: 'available', reader: preparedFixture.artifacts },
      });
      expect(preparedRestore.getState().modelInvocations[preparedId]).toMatchObject({
        status: 'interrupted',
        dispatchCertainty: 'none',
        interruptionReason: 'runtime_restored',
      });
      preparedRestore.close();
    } finally {
      preparedFixture.kernel.close();
      rmSync(preparedFixture.directory, { recursive: true, force: true });
    }

    const dispatchedFixture = createFixture('model-evidence-dispatched');
    try {
      const pending = await dispatchedFixture.gateway.invoke(invokeInput(dispatchedFixture));
      const invocationId = pending.invocationId;
      expect(dispatchedFixture.kernel.getState().modelInvocations[invocationId]?.status).toBe(
        'dispatching',
      );
      dispatchedFixture.kernel.close();

      const dispatchedRestore = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'model-evidence-dispatched',
        userId: 'test',
        workspace: dispatchedFixture.workspace,
        ...dispatchedFixture.projectIdentity,
        store: openStateStoreForTest(dispatchedFixture.storePath),
        modelArtifactEvidence: { status: 'available', reader: dispatchedFixture.artifacts },
      });
      expect(dispatchedRestore.getState().modelInvocations[invocationId]).toMatchObject({
        status: 'interrupted',
        dispatchCertainty: 'unknown',
        interruptionReason: 'runtime_restored',
      });
      dispatchedRestore.close();
    } finally {
      dispatchedFixture.kernel.close();
      rmSync(dispatchedFixture.directory, { recursive: true, force: true });
    }
  });
});

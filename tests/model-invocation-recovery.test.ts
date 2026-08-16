import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '@/core/config';
import { humanMessage } from '@/core/messages';
import { ModelInvocationGatewayV1 } from '@/core/model/invocation-gateway';
import { ModelArtifactStoreV1 } from '@/core/model/model-artifacts';
import { compileModelSurfaceV1 } from '@/core/model/surface-compiler';
import { PrivateArtifactStorageError } from '@/core/persistence/private-immutable-artifacts';
import { createAgentKernel } from '@/core/runtime/kernel';
import { createMockModel } from './mock-model';

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
  const directory = mkdtempSync(join(tmpdir(), 'kite-model-recovery-'));
  const storePath = join(directory, 'runtime.db');
  const workspace = join(directory, 'workspace');
  const artifacts = new ModelArtifactStoreV1({
    root: join(directory, 'model-artifacts'),
    integrityKey: new Uint8Array(32).fill(7),
  });
  const model = createMockModel([]);
  const compiled = compileModelSurfaceV1({
    purpose: 'primary_agent',
    config: CONFIG,
    model,
    messages: [humanMessage('restore this request')],
    tools: {},
    transport: 'generate',
  });
  const gateway = new ModelInvocationGatewayV1({
    artifacts,
    transport: async () => RESPONSE,
    sleep: async () => {},
  });
  const kernel = createAgentKernel({
    threadId,
    userId: 'test',
    workspace,
    storePath,
  });
  return { directory, storePath, workspace, artifacts, model, compiled, gateway, kernel };
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
    providerDataPolicyRequired: false,
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
        ),
      ).toBe(true);
      fixture.kernel.close();

      const restored = createAgentKernel({
        threadId: 'model-evidence-source',
        userId: 'test',
        workspace: fixture.workspace,
        storePath: fixture.storePath,
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

      const fork = createAgentKernel({
        threadId: 'model-evidence-fork',
        userId: 'test',
        workspace: fixture.workspace,
        storePath: fixture.storePath,
        modelArtifactEvidence: { status: 'available', reader: fixture.artifacts },
      });
      expect(fork.getState().transcript.final).toBe('restored');
      expect(fork.getState().modelInvocations[invocationId]).toMatchObject({
        status: 'completed',
      });
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
      const restored = createAgentKernel({
        threadId: 'model-evidence-missing',
        userId: 'test',
        workspace: fixture.workspace,
        storePath: fixture.storePath,
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

      const preparedRestore = createAgentKernel({
        threadId: 'model-evidence-prepared',
        userId: 'test',
        workspace: preparedFixture.workspace,
        storePath: preparedFixture.storePath,
        modelArtifactEvidence: { status: 'unavailable', reason: 'key_unavailable' },
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

      const dispatchedRestore = createAgentKernel({
        threadId: 'model-evidence-dispatched',
        userId: 'test',
        workspace: dispatchedFixture.workspace,
        storePath: dispatchedFixture.storePath,
        modelArtifactEvidence: { status: 'unavailable', reason: 'key_unavailable' },
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

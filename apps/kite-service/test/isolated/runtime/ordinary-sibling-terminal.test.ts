import { expect, test } from 'bun:test';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import { StateHostSessionHarness } from '../../../../../scripts/support/runtime-host-state';
import { openStateStoreForTest } from '../../../../../scripts/support/runtime-storage';

test('Host accepts exact shell_stop receipt on a stale lease after its sibling rejects', () => {
  const initial = createRuntimeHostStateInitialState({
    recoveryIdentityKey: 'a'.repeat(64),
    threadId: 'stop-host-fence',
    userId: 'user',
    workspace: process.cwd(),
  });
  const state = {
    ...initial,
    tools: {
      ...initial.tools,
      calls: {
        stop: {
          toolCallId: 'stop',
          modelMessageId: 'message',
          name: 'shell_stop',
          args: { shell_id: 'shell' },
          status: 'running' as const,
          createdAtTurnId: initial.turn.turnId,
          sideEffect: true,
        },
        denied: {
          toolCallId: 'denied',
          modelMessageId: 'message',
          name: 'shell_execute',
          args: { command: 'rm -rf .kite-tool-test' },
          status: 'queued' as const,
          createdAtTurnId: initial.turn.turnId,
          sideEffect: true,
        },
      },
      queue: ['denied'],
      active: ['stop'],
    },
    capabilities: {
      ...initial.capabilities,
      invocations: {
        invocation: {
          invocationId: 'invocation',
          toolCallId: 'stop',
          capabilityId: 'builtin:shell_stop',
          capabilityRevision: 'revision',
          argumentsDigest: 'arguments',
          authorizationDigest: 'authorization',
          effectiveEffectsDigest: 'effects',
          status: 'running' as const,
          recordedAt: '2026-09-30T10:45:04.856Z',
          startedAt: '2026-09-30T10:45:04.856Z',
          receiptRequirement: 'effect_receipt' as const,
          attemptsStarted: 1,
          admissionDigest: 'admission',
          retryEligibility: 'none' as const,
        },
      },
    },
  };
  const kernel = new StateHostSessionHarness({
    store: openStateStoreForTest(':memory:'),
    initialState: state,
    interactionMode: 'accept_edits',
  });
  try {
    const lease = kernel.beginEffect({ type: 'run_tools', toolCallIds: ['stop'] });
    kernel.processEvent({ type: 'tool.rejected', toolCallId: 'denied', reason: 'policy denied' });
    expect(kernel.getState().revision).toBeGreaterThan(lease.expectedRevision);
    const terminal: RuntimeEvent[] = [
      {
        type: 'capability.execution_succeeded',
        invocationId: 'invocation',
        resultDigest: 'result',
        evidenceDigest: 'evidence',
        artifact: {
          artifactId: `pa_${'b'.repeat(64)}`,
          kind: 'capability_result',
          integrityIdentifier: `sha256:${'c'.repeat(64)}`,
          byteLength: 1,
        },
        finishedAt: '2026-09-30T10:45:04.940Z',
      },
      {
        type: 'tool.finished',
        toolCallId: 'stop',
        name: 'shell_stop',
        result: { ok: true, command: 'shell_stop', exitCode: 0, stdout: '{}', stderr: '' },
      },
    ];
    expect(kernel.applyEffectEvents(lease, terminal, 'receipt_evidence')).toBe(true);
    expect(kernel.getState().tools.calls.stop?.status).toBe('succeeded');
    expect(kernel.getState().capabilities.invocations.invocation?.artifact).toBeDefined();
    // Force a fresh stale revision after settlement: late duplicate receipts remain rejected.
    kernel.processEvent({
      type: 'interaction_mode.changed',
      mode: 'auto',
      source: 'user',
      changedAt: '2026-09-30T10:45:05.000Z',
    });
    expect(kernel.applyEffectEvents(lease, terminal, 'receipt_evidence')).toBe(false);
  } finally {
    kernel.runtimeStore.close();
  }
});

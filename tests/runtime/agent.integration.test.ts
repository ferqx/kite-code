import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite/agent-kernel';
import { McpConnectionManager } from '@kite/builtin-runtime/mcp';
import type { SupportedChatModel } from '@kite/builtin-runtime/model';
import { aiMessage, BuiltinModelEffectCoordinator } from '@kite/builtin-runtime/model';
import {
  createRuntimeHostStateInitialState,
  getActivePlanning,
  type RuntimeState,
} from '@kite/runtime-host';
import { MODEL_ATTEMPT_OUTCOME_SCHEMA_ } from '@kite/runtime-spi';
import { requiredProviderAdmissionEvents } from '#app/bootstrap/runtime/turn-coordinator';
import { restoreStateHostSessionHarness as restoreStateKernelCoordinator } from '../../scripts/support/runtime-host-state';
import { openStateStoreForTest } from '../../scripts/support/runtime-storage';
import { createTestModelInvocationHarness } from '../helpers/model-invocation';
import {
  runTestRuntimeAgent,
  testBuiltinToolCatalog,
  testModelInvocationRuntime,
} from '../helpers/runtime-model';
import { createMockModel } from '../mock-model';

test('classifies an exhausted model timeout from its structured attempt outcome', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.kite-agent-model-retry-exhausted-'));
  try {
    const gatewayHarness = createTestModelInvocationHarness({
      workspace,
      sleep: async () => {},
      source: {
        attempt: async () => ({
          schema: MODEL_ATTEMPT_OUTCOME_SCHEMA_,
          kind: 'retryable_failure',
          classification: 'attempt_timeout',
          retryObservation: { providerStatusCode: null, timedOut: true },
        }),
        failureError: () => new Error('Model attempt timed out.'),
      },
    });
    const baseRuntime = testModelInvocationRuntime(workspace);
    const events: RuntimeEvent[] = [];
    for await (const event of runTestRuntimeAgent(
      {
        task: 'Exercise the bounded model retry terminal.',
        threadId: 'model-retry-exhausted',
        userId: 'test',
        workspace,
        openStateSessionStorage: () => openStateStoreForTest(join(workspace, 'runtime.db')),
        model: createMockModel([]),
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: false },
        },
        modelInvocationRuntime: {
          ...baseRuntime,
          gateway: gatewayHarness.gateway,
          modelEffects: new BuiltinModelEffectCoordinator(gatewayHarness.gateway),
        },
      },
      {
        requestAction: async () => {
          throw new Error('model retry failure must not request user action');
        },
      },
    )) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === 'model.retry')).toHaveLength(4);
    expect(events.find((event) => event.type === 'model.invocation_interrupted')).toMatchObject({
      type: 'model.invocation_interrupted',
      reasonCode: 'attempts_exhausted',
    });
    expect(events.find((event) => event.type === 'run.error')).toMatchObject({
      type: 'run.error',
      recoverable: false,
      failure: { kind: 'model_retry_exhausted' },
      outcome: { reasonCode: 'model_retry_exhausted' },
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('startup reconciles a pending Subagent handle before any model or Driver dispatch', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.kite-agent-subagent-startup-recovery-'));
  const storePath = join(workspace, 'runtime.db');
  const threadId = 'agent-subagent-startup-recovery';
  const invocationId = 'pending-subagent-invocation';
  const intent = `sha256:${'1'.repeat(64)}`;
  try {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId,
      userId: 'test',
      workspace,
    });
    state.capabilities.invocations[invocationId] = {
      invocationId,
      toolCallId: 'pending-task',
      capabilityId: 'builtin:task',
      capabilityRevision: '2'.repeat(64),
      argumentsDigest: '3'.repeat(64),
      authorizationDigest: '4'.repeat(64),
      admissionDigest: '5'.repeat(64),
      effectiveEffectsDigest: '6'.repeat(64),
      receiptRequirement: 'control_receipt',
      status: 'running',
      recordedAt: '2026-08-17T00:00:00.000Z',
      startedAt: '2026-08-17T00:00:00.000Z',
      attemptsStarted: 1,
      subagentProviderLifecycle: {
        attempt: 1,
        purpose: 'start',
        childInvocationId: 'pending-child',
        taskArtifact: {
          artifactId: `pa_${'7'.repeat(64)}`,
          kind: 'subagent_task',
          integrityIdentifier: `sha256:${'8'.repeat(64)}`,
          byteLength: 128,
        },
        dispatchIntentDigest: intent,
        status: 'handle_recorded',
        recordedAt: '2026-08-17T00:00:00.000Z',
        handleArtifact: {
          artifactId: `pa_${'9'.repeat(64)}`,
          kind: 'subagent_handle',
          integrityIdentifier: `sha256:${'a'.repeat(64)}`,
          byteLength: 256,
        },
        handleIntegrityIdentifier: `sha256:${'b'.repeat(64)}`,
        handleRecordedAt: '2026-08-17T00:00:00.000Z',
      },
    };
    const store = openStateStoreForTest(storePath);
    store.saveSnapshot(threadId, state);
    store.close();
    const model = createMockModel([{ message: aiMessage({ content: 'must not dispatch' }) }]);
    let runtimeFactories = 0;
    let reconciles = 0;
    const events: RuntimeEvent[] = [];
    for await (const event of runTestRuntimeAgent(
      {
        task: 'Do not start until pending Subagent recovery is terminal.',
        threadId,
        userId: 'test',
        workspace,
        openStateSessionStorage: () => openStateStoreForTest(storePath),
        model,
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: false },
        },
        modelInvocationRuntime: {
          builtinToolCatalog: testBuiltinToolCatalog(),
          subagentRuntimeFactory: () => {
            runtimeFactories += 1;
            throw new Error('must not dispatch a new child');
          },
          reconcilePendingSubagents: async (persistence) => {
            reconciles += 1;
            const before = persistence.getState().capabilities.invocations[invocationId];
            expect(before?.subagentProviderLifecycle?.status).toBe('handle_recorded');
            const at = '2026-08-17T00:00:01.000Z';
            return persistence.persistEvents([
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
              {
                type: 'capability.execution_unknown',
                invocationId,
                reason: 'Startup Subagent handle was reconciled without redispatch.',
                finishedAt: at,
              },
            ]);
          },
        },
      },
      {
        requestAction: async () => {
          throw new Error('startup recovery must not request user action');
        },
      },
    )) {
      events.push(event);
    }
    expect(reconciles).toBe(1);
    expect(runtimeFactories).toBe(0);
    expect(model.callCount.count).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      'capability.subagent_cleanup_started',
      'capability.subagent_cleanup_completed',
      'capability.execution_unknown',
      'provider.admission_status',
      'user.message_appended',
      'turn.started',
      'turn.aborted',
      'run.error',
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'run.error',
      message: expect.stringContaining('recovery'),
    });
    const restored = restoreStateKernelCoordinator({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId,
      userId: 'test',
      workspace,
      store: openStateStoreForTest(storePath),
    });
    expect(restored.getState().capabilities.invocations[invocationId]).toMatchObject({
      status: 'unknown',
      subagentProviderLifecycle: { status: 'cleanup_completed', cleanupConfirmed: true },
    });
    restored.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('cancelling any shell approval aborts the current turn and its running sibling', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.kite-runtime-approval-cancel-'));
  const mockModel = createMockModel([
    {
      message: aiMessage({
        content: '',
        tool_calls: [
          {
            id: 'shell-1',
            name: 'shell_execute',
            args: { command: 'node task-1.js' },
          },
          {
            id: 'shell-2',
            name: 'shell_execute',
            args: { command: 'node task-2.js' },
          },
        ],
      }),
    },
  ]);
  let reportShellAborted!: () => void;
  const shellAborted = new Promise<void>((resolve) => {
    reportShellAborted = resolve;
  });
  let approvals = 0;

  try {
    const events: RuntimeEvent[] = [];
    for await (const event of runTestRuntimeAgent(
      {
        task: 'Run two commands',
        threadId: 'approval-cancels-turn',
        userId: 'test',
        workspace,
        openStateSessionStorage: () => openStateStoreForTest(join(workspace, 'runtime.db')),
        model: mockModel as SupportedChatModel,
        sandboxBackend: 'seatbelt',
        shellExecutor: async (input) => {
          if (input.command !== 'node task-1.js') {
            throw new Error(`Unexpected shell execution: ${input.command}`);
          }
          return await new Promise((resolve) => {
            const finish = () => {
              reportShellAborted();
              resolve({
                ok: false,
                command: input.command,
                exitCode: 130,
                stdout: '',
                stderr: 'Command cancelled by user.',
                processCleanup: {
                  confirmedExited: true,
                  gracefulRequested: true,
                  forced: false,
                  unconfirmedDescendantCount: 0,
                },
              });
            };
            if (input.signal?.aborted) finish();
            else input.signal?.addEventListener('abort', finish, { once: true });
          });
        },
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
        },
      },
      {
        requestAction: async (effect) => {
          if (effect.type !== 'request_tool_approval') {
            throw new Error(`Unexpected interaction: ${effect.type}`);
          }
          approvals += 1;
          return approvals === 1
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
    )) {
      events.push(event);
    }

    await shellAborted;
    expect(approvals).toBe(2);
    expect(mockModel.callCount.count).toBe(1);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['approval.rejected', 'tool.cancelled', 'turn.aborted']),
    );

    const store = openStateStoreForTest(join(workspace, 'runtime.db'));
    const snapshot = store.loadSnapshot<RuntimeState>('approval-cancels-turn');
    if (!snapshot) throw new Error('Expected a persisted Runtime snapshot');
    expect(snapshot.tools.calls['shell-1']?.status).toBe('cancelled');
    expect(snapshot.tools.calls['shell-2']?.status).toBe('rejected');
    store.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Runtime gates an unavailable required MCP provider before the model and persists waiver', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.kite-runtime-required-provider-'));
  const storePath = join(workspace, 'runtime.db');
  const mockModel = createMockModel([
    { message: aiMessage({ content: 'Continued without MCP.' }) },
  ]);
  const manager = new McpConnectionManager();
  manager.getProviderDirectorySnapshot = () => ({
    revision: 'directory-r1',
    entries: [
      {
        providerId: 'github',
        status: 'login_required',
        required: true,
        source: 'project',
        lastKnownCapabilityNames: ['publish'],
        diagnosticCode: 'auth_required',
        retryable: false,
      },
    ],
  });

  try {
    const events: RuntimeEvent[] = [];
    for await (const event of runTestRuntimeAgent(
      {
        task: 'Continue without GitHub',
        threadId: 'required-provider-waiver',
        userId: 'test',
        workspace,
        openStateSessionStorage: () => openStateStoreForTest(storePath),
        model: mockModel as SupportedChatModel,
        mcpManager: manager,
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
          features: { mcpProviderAction: true },
        },
      },
      {
        requestAction: async (effect) => {
          if (effect.type !== 'request_provider_admission') {
            return { type: 'cancel', interactionId: effect.interactionId };
          }
          return {
            type: 'provider_admission_decision',
            interactionId: effect.interactionId,
            decision: { kind: 'waive' },
          };
        },
      },
    )) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toContain('provider.admission_required');
    expect(events.findIndex((event) => event.type === 'user.message_appended')).toBeLessThan(
      events.findIndex((event) => event.type === 'provider.admission_required'),
    );
    expect(events.map((event) => event.type)).toContain('provider.admission_waived');
    expect(events.findIndex((event) => event.type === 'provider.admission_waived')).toBeLessThan(
      events.findIndex((event) => event.type === 'model.requested'),
    );
    const store = openStateStoreForTest(storePath);
    const snapshot = store.loadSnapshot<RuntimeState>('required-provider-waiver');
    if (!snapshot) throw new Error('Expected a persisted Runtime snapshot');
    expect(snapshot.providerAdmission.waivers.github).toMatchObject({
      source: 'project',
      reason: 'user_session_waiver',
    });
    expect(snapshot.capabilities.bindings).toEqual({});
    store.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('successor recovery settles a stale Tool before opening required Provider admission', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.kite-runtime-provider-after-recovery-'));
  const storePath = join(workspace, 'runtime.db');
  const threadId = 'provider-after-recovery';
  const manager = new McpConnectionManager();
  manager.getProviderDirectorySnapshot = () => ({
    revision: 'directory-r1',
    entries: [
      {
        providerId: 'github',
        status: 'login_required',
        required: true,
        source: 'project',
        lastKnownCapabilityNames: ['publish'],
        retryable: false,
      },
    ],
  });

  try {
    const stale = restoreStateKernelCoordinator({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId,
      userId: 'test',
      workspace,
      store: openStateStoreForTest(storePath),
      interactionMode: 'accept_edits',
    });
    stale.processEventBatch([
      { type: 'user.message_appended', messageId: 'old-user', content: 'old turn' },
      { type: 'turn.started', turnId: 'old-turn' },
      {
        type: 'model.responded',
        messageId: 'old-model',
        toolCalls: [{ id: 'stale-task', name: 'task', args: { task: 'old child' } }],
      },
      {
        type: 'tool.queued',
        toolCallId: 'stale-task',
        modelMessageId: 'old-model',
        name: 'task',
        args: { task: 'old child' },
      },
      { type: 'tool.started', toolCallId: 'stale-task' },
    ]);
    stale.close();

    const events: RuntimeEvent[] = [];
    for await (const event of runTestRuntimeAgent(
      {
        task: 'new message',
        threadId,
        userId: 'test',
        workspace,
        openStateSessionStorage: () => openStateStoreForTest(storePath),
        model: createMockModel([
          { message: aiMessage({ content: 'completed after admission' }) },
        ]) as SupportedChatModel,
        mcpManager: manager,
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
          features: { mcpProviderAction: true },
        },
      },
      {
        requestAction: async (effect) => ({
          type: 'provider_admission_decision',
          interactionId: effect.interactionId,
          decision: { kind: 'waive' },
        }),
      },
    )) {
      events.push(event);
    }

    const cancelled = events.findIndex(
      (event) => event.type === 'tool.cancelled' && event.toolCallId === 'stale-task',
    );
    const message = events.findIndex(
      (event) => event.type === 'user.message_appended' && event.content === 'new message',
    );
    const admission = events.findIndex((event) => event.type === 'provider.admission_required');
    expect(cancelled).toBeGreaterThanOrEqual(0);
    expect(message).toBeGreaterThan(cancelled);
    expect(admission).toBeGreaterThan(message);
    expect(events.some((event) => event.type === 'completion.blocked')).toBe(false);
    expect(events.at(-1)?.type).toBe('turn.completed');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('required provider admission failure is recorded as an error, not a user cancellation', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.kite-runtime-provider-admission-error-'));
  const storePath = join(workspace, 'runtime.db');
  const manager = new McpConnectionManager();
  manager.getProviderDirectorySnapshot = () => ({
    revision: 'directory-r1',
    entries: [
      {
        providerId: 'github',
        status: 'login_required',
        required: true,
        source: 'project',
        lastKnownCapabilityNames: ['publish'],
        retryable: true,
      },
    ],
  });

  try {
    const events: RuntimeEvent[] = [];
    for await (const event of runTestRuntimeAgent(
      {
        task: 'recover GitHub admission',
        threadId: 'required-provider-admission-error',
        userId: 'test',
        workspace,
        openStateSessionStorage: () => openStateStoreForTest(storePath),
        model: createMockModel([]) as SupportedChatModel,
        mcpManager: manager,
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
          features: { mcpProviderAction: true },
        },
      },
      {
        requestAction: async () => {
          throw new Error('admission UI disconnected');
        },
      },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'run.error', message: 'admission UI disconnected' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'turn.aborted', cause: 'error' }),
    );
    expect(events.map((event) => event.type)).not.toContain('provider.admission_cancelled');
    expect(events.map((event) => event.type)).not.toContain('task.cancelled');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('required provider admission accepts ready/degraded and queues every other required entry', () => {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'required-provider-projection',
    userId: 'test',
    workspace: '/',
  });
  const manager = new McpConnectionManager();
  manager.getProviderDirectorySnapshot = () => ({
    revision: 'directory',
    entries: [
      {
        providerId: 'ready',
        status: 'ready',
        required: true,
        source: 'user',
        lastKnownCapabilityNames: [],
        retryable: false,
      },
      {
        providerId: 'degraded',
        status: 'degraded',
        required: true,
        source: 'user',
        lastKnownCapabilityNames: [],
        retryable: true,
      },
      {
        providerId: 'failed',
        status: 'failed',
        required: true,
        source: 'user',
        lastKnownCapabilityNames: [],
        retryable: true,
      },
      {
        providerId: 'optional',
        status: 'failed',
        required: false,
        source: 'user',
        lastKnownCapabilityNames: [],
        retryable: true,
      },
      {
        providerId: 'login',
        status: 'login_required',
        required: true,
        source: 'project',
        lastKnownCapabilityNames: [],
        diagnosticCode: 'auth_required',
        retryable: false,
      },
    ],
  });

  expect(
    requiredProviderAdmissionEvents(state, manager, true).map((event) =>
      event.type === 'provider.admission_required' ? event.providerId : '',
    ),
  ).toEqual(['failed', 'login']);
  expect(requiredProviderAdmissionEvents(state, manager, false)).toEqual([]);
});

test('Runtime Kernel persists a direct model answer as a completed turn', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.kite-runtime-integration-'));
  const storePath = join(workspace, 'runtime.db');
  const mockModel = createMockModel([{ message: aiMessage({ content: 'Kernel answer' }) }]);

  try {
    const events: RuntimeEvent['type'][] = [];
    for await (const event of runTestRuntimeAgent(
      {
        task: 'Say hello',
        threadId: 'kernel-integration',
        userId: 'test',
        workspace,
        openStateSessionStorage: () => openStateStoreForTest(storePath),
        model: mockModel as SupportedChatModel,
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
        },
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      events.push(event.type);
    }

    // Cache/context telemetry may appear; attempt evidence is part of the durable lifecycle.
    const coreEvents = events.filter(
      (event) => event !== 'model.cache_metrics' && event !== 'model.context_metrics',
    );
    expect(coreEvents).toEqual([
      'provider.admission_status',
      'user.message_appended',
      'turn.started',
      'model.invocation_prepared',
      'model.invocation_attempt_started',
      'model.requested',
      'model.invocation_completed',
      'model.responded',
      'run.completed',
      'turn.completed',
    ]);
    const store = openStateStoreForTest(storePath);
    expect(store.loadEventsStrict('kernel-integration').map((entry) => entry.event.type)).toEqual(
      events,
    );
    store.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Runtime Kernel executes a read tool before completing the answer', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.kite-runtime-integration-'));
  const storePath = join(workspace, 'runtime.db');
  writeFileSync(join(workspace, 'note.txt'), 'runtime kernel');
  const mockModel = createMockModel([
    {
      message: aiMessage({
        content: '',
        tool_calls: [{ id: 'read-note', name: 'read_file', args: { path: 'note.txt' } }],
      }),
    },
    { message: aiMessage({ content: 'Read the note.' }) },
  ]);

  try {
    const events: RuntimeEvent['type'][] = [];
    for await (const event of runTestRuntimeAgent(
      {
        task: 'Read note.txt',
        threadId: 'kernel-tool-integration',
        userId: 'test',
        workspace,
        openStateSessionStorage: () => openStateStoreForTest(storePath),
        model: mockModel as SupportedChatModel,
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
        },
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      events.push(event.type);
    }

    expect(events).toContain('tool.queued');
    expect(events).toContain('tool.started');
    expect(events).toContain('tool.finished');
    expect(events.at(-2)).toBe('run.completed');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Runtime isolates an MCP adapter exception and continues the same conversation', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.kite-runtime-mcp-failure-'));
  const storePath = join(workspace, 'runtime.db');
  const manager = new McpConnectionManager();
  const descriptor = {
    capabilityId: 'mcp:fixture/broken_tool',
    revision: 'revision-1',
    kind: 'mcp_tool' as const,
    displayName: 'broken_tool',
    description: 'A deliberately broken MCP fixture.',
    provider: { type: 'mcp' as const, id: 'fixture', provenance: 'remote' as const },
    inputSchema: { type: 'object', properties: {} },
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
  manager.getCapabilitySnapshot = () => ({ revision: 'snapshot-1', descriptors: [descriptor] });
  manager.findCapability = () => {
    throw new Error('deliberate local adapter defect');
  };
  const mockModel = createMockModel([
    {
      message: aiMessage({
        content: '',
        tool_calls: [
          {
            id: 'search-mcp',
            name: 'tool_search',
            args: { query: 'broken tool' },
          },
        ],
      }),
    },
    {
      message: aiMessage({
        content: '',
        tool_calls: [
          {
            id: 'call-broken-mcp',
            name: 'mcp__fixture__broken_tool',
            args: {},
          },
        ],
      }),
    },
    {
      message: aiMessage({
        content: 'The MCP tool failed, but this conversation is still active.',
      }),
    },
  ]);

  try {
    const events: RuntimeEvent[] = [];
    for await (const event of runTestRuntimeAgent(
      {
        task: 'Use the broken MCP fixture and explain any failure.',
        threadId: 'kernel-mcp-failure-continuation',
        userId: 'test',
        workspace,
        openStateSessionStorage: () => openStateStoreForTest(storePath),
        model: mockModel as SupportedChatModel,
        mcpManager: manager,
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
        },
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toContain('tool.failed');
    expect(events.filter((event) => event.type === 'model.responded')).toHaveLength(3);
    const store = openStateStoreForTest(storePath);
    const snapshot = store.loadSnapshot<RuntimeState>('kernel-mcp-failure-continuation');
    expect(snapshot?.transcript.final).toBe(
      'The MCP tool failed, but this conversation is still active.',
    );
    expect(snapshot?.transcript.messages).toContainEqual(
      expect.objectContaining({
        kind: 'tool',
        toolCallId: 'call-broken-mcp',
        ok: false,
      }),
    );
    store.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Runtime Kernel feeds a V2 planning phase write rejection back for one correction', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.kite-runtime-integration-'));
  const storePath = join(workspace, 'runtime.db');
  const mockModel = createMockModel([
    {
      message: aiMessage({
        content: '',
        tool_calls: [
          { id: 'write-note', name: 'write_file', args: { path: 'note.txt', content: 'approved' } },
        ],
      }),
    },
    { message: aiMessage({ content: 'Wrote the note.' }) },
    { message: aiMessage({ content: 'The note still cannot be completed from planning mode.' }) },
  ]);

  try {
    const events: RuntimeEvent[] = [];
    for await (const event of runTestRuntimeAgent(
      {
        task: 'Write note.txt',
        threadId: 'kernel-approval-integration',
        userId: 'test',
        workspace,
        openStateSessionStorage: () => openStateStoreForTest(storePath),
        model: mockModel as SupportedChatModel,
        phase: 'planning',
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
        },
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      events.push(event);
    }

    expect(mockModel.callCount.count).toBe(3);
    expect(events.map((event) => event.type)).toContain('tool.rejected');
    expect(existsSync(join(workspace, 'note.txt'))).toBe(false);
    assertCompletionGuardErrorTerminal(events, 'planning_empty');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Runtime replaces the planning intent placeholder with the submitted Task', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.kite-runtime-planning-intent-'));
  const storePath = join(workspace, 'runtime.db');
  const threadId = 'planning-intent';
  const mockModel = createMockModel([
    { message: aiMessage({ content: 'Planning conversation completed.' }) },
    { message: aiMessage({ content: 'Second planning conversation completed.' }) },
    { message: aiMessage({ content: 'Continue planning in the same TUI mode.' }) },
    { message: aiMessage({ content: 'Planning still needs a submitted plan.' }) },
  ]);

  try {
    const kernel = restoreStateKernelCoordinator({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId,
      userId: 'test',
      workspace,
      store: openStateStoreForTest(storePath),
      phase: 'building',
    });
    const placeholderTaskId = 'planning-placeholder';
    kernel.processEventBatch([
      {
        type: 'task.started',
        taskId: placeholderTaskId,
        userGoal: '',
        turnId: kernel.getState().turn.turnId,
      },
      {
        type: 'planning.entered',
        taskId: placeholderTaskId,
        source: 'user_command',
      },
    ]);
    kernel.close();

    const initialStore = openStateStoreForTest(storePath);
    const persistedBeforeFirstRun = initialStore.loadEventsStrict(threadId).length;
    initialStore.close();

    const events: RuntimeEvent[] = [];
    for await (const event of runTestRuntimeAgent(
      {
        task: 'Inspect the repository and make a plan',
        threadId,
        userId: 'test',
        workspace,
        openStateSessionStorage: () => openStateStoreForTest(storePath),
        phase: 'planning',
        model: mockModel as SupportedChatModel,
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
        },
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      events.push(event);
    }

    expect(mockModel.callCount.count).toBe(2);
    assertCompletionGuardCorrectionTerminal(events);
    const firstPersisted = openStateStoreForTest(storePath);
    const firstReplay = firstPersisted
      .loadEventsStrict(threadId)
      .slice(persistedBeforeFirstRun)
      .map((record) => record.event);
    firstPersisted.close();
    assertCompletionGuardCorrectionTerminal(firstReplay);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'task.cancelled',
        taskId: placeholderTaskId,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'task.started',
        userGoal: 'Inspect the repository and make a plan',
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'run.error',
        message: expect.stringContaining('active task'),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'model.responded',
        text: 'Planning conversation completed.',
      }),
    );

    const secondEvents: RuntimeEvent[] = [];
    for await (const event of runTestRuntimeAgent(
      {
        task: 'Continue planning in the same TUI mode',
        threadId,
        userId: 'test',
        workspace,
        openStateSessionStorage: () => openStateStoreForTest(storePath),
        phase: 'planning',
        model: mockModel as SupportedChatModel,
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
        },
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      secondEvents.push(event);
    }
    expect(mockModel.callCount.count).toBe(4);
    assertCompletionGuardCorrectionTerminal(secondEvents);
    const secondPersisted = openStateStoreForTest(storePath);
    const replayed = secondPersisted.loadEventsStrict(threadId).map((record) => record.event);
    secondPersisted.close();
    const secondReplay = replayed.slice(persistedBeforeFirstRun + firstReplay.length);
    assertCompletionGuardCorrectionTerminal(secondReplay);
    expect(replayed.filter((event) => event.type === 'completion.blocked')).toHaveLength(4);
    expect(secondEvents).toContainEqual(
      expect.objectContaining({
        type: 'model.responded',
        text: 'Continue planning in the same TUI mode.',
      }),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function assertCompletionGuardCorrectionTerminal(events: RuntimeEvent[]): void {
  const blocked = events.filter(
    (event): event is Extract<RuntimeEvent, { type: 'completion.blocked' }> =>
      event.type === 'completion.blocked',
  );
  expect(blocked).toHaveLength(2);
  expect(blocked.map((event) => [event.code, event.correctionAttempt])).toEqual([
    ['planning_empty', 1],
    ['planning_empty', 2],
  ]);
  const firstBlocked = events.indexOf(blocked[0]!);
  const secondRequest = events.findIndex(
    (event, index) => index > firstBlocked && event.type === 'model.requested',
  );
  const terminalBlock = events.indexOf(blocked[1]!);
  const aborted = events.findIndex(
    (event, index) => index > terminalBlock && event.type === 'turn.aborted',
  );
  const error = events.findIndex((event, index) => index > aborted && event.type === 'run.error');
  expect(firstBlocked).toBeGreaterThanOrEqual(0);
  expect(secondRequest).toBeGreaterThan(firstBlocked);
  expect(terminalBlock).toBeGreaterThan(secondRequest);
  expect(aborted).toBeGreaterThan(terminalBlock);
  expect(error).toBeGreaterThan(aborted);
}

function assertCompletionGuardErrorTerminal(events: RuntimeEvent[], code: 'planning_empty'): void {
  const blocked = events.filter(
    (event): event is Extract<RuntimeEvent, { type: 'completion.blocked' }> =>
      event.type === 'completion.blocked',
  );
  expect(blocked.map((event) => [event.code, event.correctionAttempt])).toEqual([
    [code, 1],
    [code, 2],
  ]);
  const correctionRequest = events.findIndex(
    (event, index) => index > events.indexOf(blocked[0]!) && event.type === 'model.requested',
  );
  const terminalBlock = events.indexOf(blocked[1]!);
  const aborted = events.findIndex(
    (event, index) => index > terminalBlock && event.type === 'turn.aborted',
  );
  const error = events.findIndex((event, index) => index > aborted && event.type === 'run.error');
  expect(correctionRequest).toBeGreaterThan(events.indexOf(blocked[0]!));
  expect(terminalBlock).toBeGreaterThan(correctionRequest);
  expect(aborted).toBeGreaterThan(terminalBlock);
  expect(error).toBeGreaterThan(aborted);
  expect(events[error]).toMatchObject({
    type: 'run.error',
    message: expect.stringContaining(`Completion blocked by ${code};`),
  });
  expect(events[error]).not.toMatchObject({
    message: expect.stringContaining('tool-pair validation failed'),
  });
}

test('Runtime Kernel resumes ask_user with the supplied RuntimeAction answer', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.kite-runtime-integration-'));
  const mockModel = createMockModel([
    {
      message: aiMessage({
        content: '',
        tool_calls: [
          {
            id: 'ask-name',
            name: 'ask_user',
            args: {
              questions: [
                {
                  question: 'What is your name?',
                  options: [
                    {
                      label: 'Ada',
                      description: 'Use Ada as the display name.',
                      recommended: true,
                    },
                    {
                      label: 'Grace',
                      description: 'Use Grace as the display name.',
                      recommended: false,
                    },
                  ],
                },
              ],
            },
          },
        ],
      }),
    },
    { message: aiMessage({ content: 'Thanks for the answer.' }) },
  ]);

  try {
    const events: RuntimeEvent['type'][] = [];
    for await (const event of runTestRuntimeAgent(
      {
        task: 'Ask for a name',
        threadId: 'kernel-input-integration',
        userId: 'test',
        workspace,
        openStateSessionStorage: () => openStateStoreForTest(join(workspace, 'runtime.db')),
        model: mockModel as SupportedChatModel,
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
        },
      },
      {
        requestAction: async (effect) => ({
          type: 'input',
          interactionId: effect.interactionId,
          text: 'Ada',
        }),
      },
    ))
      events.push(event.type);

    expect(events).toContain('user_input.requested');
    expect(events).toContain('user_input.answered');
    expect(events).toContain('tool.finished');
    expect(events.at(-1)).toBe('turn.completed');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Runtime Kernel continues the same turn after ask_user is cancelled', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.kite-runtime-input-cancel-'));
  const storePath = join(workspace, 'runtime.db');
  const mockModel = createMockModel([
    {
      message: aiMessage({
        content: '',
        tool_calls: [
          {
            id: 'ask-name',
            name: 'ask_user',
            args: {
              questions: [
                {
                  question: 'What is your name?',
                  options: [
                    {
                      label: 'Ada',
                      description: 'Use Ada as the display name.',
                      recommended: true,
                    },
                    {
                      label: 'Grace',
                      description: 'Use Grace as the display name.',
                      recommended: false,
                    },
                  ],
                },
              ],
            },
          },
        ],
      }),
    },
    { message: aiMessage({ content: 'Continued without an answer.' }) },
  ]);

  try {
    const events: RuntimeEvent[] = [];
    for await (const event of runTestRuntimeAgent(
      {
        task: 'Ask for a name, but continue if I decline',
        threadId: 'kernel-input-cancel-integration',
        userId: 'test',
        workspace,
        openStateSessionStorage: () => openStateStoreForTest(storePath),
        model: mockModel as SupportedChatModel,
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
        },
      },
      {
        requestAction: async (effect) => ({
          type: 'cancel',
          interactionId: effect.interactionId,
          reason: 'User declined to answer.',
        }),
      },
    )) {
      events.push(event);
    }

    expect(mockModel.callCount.count).toBe(2);
    expect(events.some((event) => event.type === 'turn.aborted')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.finished',
        toolCallId: 'ask-name',
        name: 'ask_user',
        result: expect.objectContaining({ ok: false, stdout: 'Cancelled' }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'model.responded',
        text: 'Continued without an answer.',
      }),
    );
    expect(events.at(-1)?.type).toBe('turn.completed');

    const store = openStateStoreForTest(storePath);
    const snapshot = store.loadSnapshot<RuntimeState>('kernel-input-cancel-integration');
    if (!snapshot) throw new Error('Expected a persisted Runtime snapshot');
    expect(snapshot.tools.calls['ask-name']?.status).toBe('failed');
    expect(snapshot.transcript.final).toBe('Continued without an answer.');
    store.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Runtime Kernel bounds a draft-only plan after one correction', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.kite-runtime-integration-'));
  const previousKiteCodeHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = workspace;
  const mockModel = createMockModel([
    {
      message: aiMessage({
        content: '',
        tool_calls: [
          {
            id: 'wp-1',
            name: 'write_plan',
            args: {
              title: 'Write note',
              body_markdown: 'Create a note file with planned content for testing.',
              steps: [{ id: 'write-note', title: 'Write note.txt' }],
            },
          },
        ],
      }),
    },
    { message: aiMessage({ content: 'Plan draft saved.' }) },
    { message: aiMessage({ content: 'The plan still awaits review before it can complete.' }) },
  ]);
  try {
    const events: RuntimeEvent[] = [];
    for await (const event of runTestRuntimeAgent(
      {
        task: 'Create note.txt',
        threadId: 'kernel-plan-draft',
        userId: 'test',
        workspace,
        openStateSessionStorage: () => openStateStoreForTest(join(workspace, 'runtime.db')),
        phase: 'planning',
        model: mockModel as SupportedChatModel,
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
        },
      },
      {
        requestAction: async () => ({
          type: 'approve',
          interactionId: 'any',
          grant: 'approve_once',
        }),
      },
    ))
      events.push(event);

    // The initial write_plan call succeeds and produces the draft lifecycle fact.
    const eventTypes = events.map((event) => event.type);
    if (!eventTypes.includes('plan.drafted')) {
      throw new Error(
        `write_plan did not draft a plan: ${JSON.stringify(
          events.filter(
            (event) => event.type.startsWith('tool.') || event.type.startsWith('capability.'),
          ),
        )}`,
      );
    }
    expect(eventTypes).toContain('plan.drafted');
    expect(mockModel.callCount.count).toBe(3);
    const blocked = events.filter(
      (event): event is Extract<RuntimeEvent, { type: 'completion.blocked' }> =>
        event.type === 'completion.blocked',
    );
    expect(blocked.map((event) => [event.code, event.correctionAttempt])).toEqual([
      ['plan_draft_pending', 1],
      ['plan_draft_pending', 2],
    ]);
    expect(eventTypes).not.toContain('run.completed');
    expect(eventTypes).not.toContain('run.error');
    expect(eventTypes).not.toContain('turn.aborted');
    expect(events.at(-1)?.type).toBe('turn.completed');

    const store = openStateStoreForTest(join(workspace, 'runtime.db'));
    const snapshot = store.loadSnapshot<RuntimeState>('kernel-plan-draft');
    store.close();
    expect(snapshot?.turn.status).toBe('completed');
    expect(snapshot?.activeTaskId).not.toBeNull();
    expect(snapshot && getActivePlanning(snapshot).kind).toBe('planning_draft');
  } finally {
    if (previousKiteCodeHome == null) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousKiteCodeHome;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Runtime Kernel restores a persisted snapshot when reopening the same thread', () => {
  const workspace = mkdtempSync(join(process.cwd(), '.kite-runtime-integration-'));
  const storePath = join(workspace, 'runtime.db');
  try {
    const first = restoreStateKernelCoordinator({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'kernel-recovery',
      userId: 'test',
      workspace,
      store: openStateStoreForTest(storePath),
    });
    first.processEvent({
      type: 'tool.queued',
      toolCallId: 'persisted-read',
      name: 'read_file',
      args: { path: 'note.txt' },
    });
    first.close();

    const restored = restoreStateKernelCoordinator({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'kernel-recovery',
      userId: 'test',
      workspace,
      store: openStateStoreForTest(storePath),
    });
    expect(restored.getState().tools.queue).toEqual(['persisted-read']);
    expect(restored.getState().tools.calls['persisted-read']?.status).toBe('queued');
    restored.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

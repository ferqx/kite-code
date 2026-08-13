import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpConnectionManager } from '@/core/mcp/manager';
import type { SupportedChatModel } from '@/core/model/factory';
import { requiredProviderAdmissionEvents, runRuntimeAgent } from '@/core/runtime/agent';
import type { RuntimeEvent } from '@/core/runtime/events';
import { createAgentKernel } from '@/core/runtime/kernel';
import { createInitialRuntimeState, type RuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';
import { aiMessage } from '../../src/core/messages';
import { createMockModel } from '../mock-model';

test('cancelling any shell approval aborts the current turn and its running sibling', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-approval-cancel-'));
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
    for await (const event of runRuntimeAgent(
      {
        task: 'Run two commands',
        threadId: 'approval-cancels-turn',
        userId: 'test',
        workspace,
        runtimeStorePath: join(workspace, 'runtime.db'),
        model: mockModel as SupportedChatModel,
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

    const store = createRuntimeStore(join(workspace, 'runtime.db'));
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
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-required-provider-'));
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
    for await (const event of runRuntimeAgent(
      {
        task: 'Continue without GitHub',
        threadId: 'required-provider-waiver',
        userId: 'test',
        workspace,
        runtimeStorePath: storePath,
        model: mockModel as SupportedChatModel,
        mcpManager: manager,
        config: {
          providerName: 'test',
          providerType: 'openai-compatible',
          apiKey: 'test',
          baseURL: 'http://localhost:1',
          modelName: 'test',
          sandbox: { enabled: true },
          features: { mcpProviderActionV1: true },
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

    expect(events[0]?.type).toBe('provider.admission_required');
    expect(events.map((event) => event.type)).toContain('provider.admission_waived');
    expect(events.findIndex((event) => event.type === 'provider.admission_waived')).toBeLessThan(
      events.findIndex((event) => event.type === 'model.requested'),
    );
    const store = createRuntimeStore(storePath);
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

test('required provider admission accepts ready/degraded and queues every other required entry', () => {
  const state = createInitialRuntimeState({
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
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-integration-'));
  const storePath = join(workspace, 'runtime.db');
  const mockModel = createMockModel([{ message: aiMessage({ content: 'Kernel answer' }) }]);

  try {
    const events: RuntimeEvent['type'][] = [];
    for await (const event of runRuntimeAgent(
      {
        task: 'Say hello',
        threadId: 'kernel-integration',
        userId: 'test',
        workspace,
        runtimeStorePath: storePath,
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

    // Model telemetry may appear; filter to expected lifecycle events.
    const coreEvents = events.filter(
      (event) => event !== 'model.cache_metrics' && event !== 'model.context_metrics',
    );
    expect(coreEvents).toEqual([
      'user.message_appended',
      'turn.started',
      'model.requested',
      'model.responded',
      'run.completed',
      'turn.completed',
    ]);
    const store = createRuntimeStore(storePath);
    expect(store.loadEvents('kernel-integration').map((entry) => entry.event.type)).toEqual(events);
    store.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Runtime Kernel executes a read tool before completing the answer', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-integration-'));
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
    for await (const event of runRuntimeAgent(
      {
        task: 'Read note.txt',
        threadId: 'kernel-tool-integration',
        userId: 'test',
        workspace,
        runtimeStorePath: storePath,
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
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-mcp-failure-'));
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
    for await (const event of runRuntimeAgent(
      {
        task: 'Use the broken MCP fixture and explain any failure.',
        threadId: 'kernel-mcp-failure-continuation',
        userId: 'test',
        workspace,
        runtimeStorePath: storePath,
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
    const store = createRuntimeStore(storePath);
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
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-integration-'));
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
    for await (const event of runRuntimeAgent(
      {
        task: 'Write note.txt',
        threadId: 'kernel-approval-integration',
        userId: 'test',
        workspace,
        runtimeStorePath: storePath,
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
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-planning-intent-'));
  const storePath = join(workspace, 'runtime.db');
  const threadId = 'planning-intent';
  const mockModel = createMockModel([
    { message: aiMessage({ content: 'Planning conversation completed.' }) },
    { message: aiMessage({ content: 'Second planning conversation completed.' }) },
    { message: aiMessage({ content: 'Continue planning in the same TUI mode.' }) },
    { message: aiMessage({ content: 'Planning still needs a submitted plan.' }) },
  ]);

  try {
    const kernel = createAgentKernel({
      threadId,
      userId: 'test',
      workspace,
      storePath,
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

    const initialStore = createRuntimeStore(storePath);
    const persistedBeforeFirstRun = initialStore.loadEvents(threadId).length;
    initialStore.close();

    const events: RuntimeEvent[] = [];
    for await (const event of runRuntimeAgent(
      {
        task: 'Inspect the repository and make a plan',
        threadId,
        userId: 'test',
        workspace,
        runtimeStorePath: storePath,
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
    const firstPersisted = createRuntimeStore(storePath);
    const firstReplay = firstPersisted
      .loadEvents(threadId)
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
    for await (const event of runRuntimeAgent(
      {
        task: 'Continue planning in the same TUI mode',
        threadId,
        userId: 'test',
        workspace,
        runtimeStorePath: storePath,
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
    const secondPersisted = createRuntimeStore(storePath);
    const replayed = secondPersisted.loadEvents(threadId).map((record) => record.event);
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

function assertCompletionGuardErrorTerminal(
  events: RuntimeEvent[],
  code: 'planning_empty' | 'plan_draft_pending',
): void {
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
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-integration-'));
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
    for await (const event of runRuntimeAgent(
      {
        task: 'Ask for a name',
        threadId: 'kernel-input-integration',
        userId: 'test',
        workspace,
        runtimeStorePath: join(workspace, 'runtime.db'),
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
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-input-cancel-'));
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
    for await (const event of runRuntimeAgent(
      {
        task: 'Ask for a name, but continue if I decline',
        threadId: 'kernel-input-cancel-integration',
        userId: 'test',
        workspace,
        runtimeStorePath: storePath,
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

    const store = createRuntimeStore(storePath);
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
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-integration-'));
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
    for await (const event of runRuntimeAgent(
      {
        task: 'Create note.txt',
        threadId: 'kernel-plan-draft',
        userId: 'test',
        workspace,
        runtimeStorePath: join(workspace, 'runtime.db'),
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
          events.filter((event) => event.type === 'tool.rejected'),
        )}`,
      );
    }
    expect(eventTypes).toContain('plan.drafted');
    expect(mockModel.callCount.count).toBe(3);
    assertCompletionGuardErrorTerminal(events, 'plan_draft_pending');
  } finally {
    if (previousKiteCodeHome == null) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousKiteCodeHome;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Runtime Kernel restores a persisted snapshot when reopening the same thread', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-integration-'));
  const storePath = join(workspace, 'runtime.db');
  try {
    const first = createAgentKernel({
      threadId: 'kernel-recovery',
      userId: 'test',
      workspace,
      storePath,
    });
    first.processEvent({
      type: 'tool.queued',
      toolCallId: 'persisted-read',
      name: 'read_file',
      args: { path: 'note.txt' },
    });
    first.close();

    const restored = createAgentKernel({
      threadId: 'kernel-recovery',
      userId: 'test',
      workspace,
      storePath,
    });
    expect(restored.getState().tools.queue).toEqual(['persisted-read']);
    expect(restored.getState().tools.calls['persisted-read']?.status).toBe('queued');
    restored.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

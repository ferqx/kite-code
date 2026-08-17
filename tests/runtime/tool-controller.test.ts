import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBinding,
  createSnapshot,
  descriptorRevision,
  digestCapability,
} from '@/core/capabilities/catalog';
import type { AgentConfig } from '@/core/config/index';
import {
  blockedSubagentReviewEvent,
  buildBlockedToolRequest,
  serializeConcurrentSubagentApprovalEvents,
  toRuntimeSubagentEvent,
} from '@/core/controllers/tool-controller';
import { exposedMcpToolName } from '@/core/mcp';
import { McpConnectionManager } from '@/core/mcp/manager';
import { McpProviderError } from '@/core/mcp/provider-errors';
import { aiMessage } from '@/core/messages';
import { CapabilityArtifactStore } from '@/core/persistence/capability-artifacts';
import type { RuntimeEvent } from '@/core/runtime/events';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import {
  createInitialRuntimeState,
  getActivePlanning,
  setActivePlanning,
} from '@/core/runtime/state';
import { normalizeCurrentToolOutcomeEventV1 } from '@/core/runtime/tool-outcome-events';
import { createToolRecoveryJournalV1 } from '@/core/runtime/tool-recovery-journal';
import { serializeSubagentContinuation } from '@/core/subagent/continuation-codec';
import { getRoleConfig } from '@/core/subagent/roles';
import { toolAvailabilityContext } from '@/core/tools/definitions';
import type { CapabilityDescriptor } from '@/protocol/capabilities';
import { currentPlanDocument } from '../helpers/current-plan';
import {
  createTestRuntimeEffectExecutorV1 as createRuntimeEffectExecutor,
  executeTestRuntimeToolsV1 as executeRuntimeTools,
  testCapabilityArtifactWriterV1,
} from '../helpers/runtime-model';
import { createMockModel } from '../mock-model';

function canonicalMcpDescriptor(
  input: Omit<CapabilityDescriptor, 'revision'> & { revision?: string },
): CapabilityDescriptor {
  const { revision: _ignored, ...withoutRevision } = input;
  return { ...withoutRevision, revision: descriptorRevision(withoutRevision) };
}

function issueMcpBinding(
  state: ReturnType<typeof createInitialRuntimeState>,
  descriptor: CapabilityDescriptor,
  exposedToolName: string,
) {
  const binding = createBinding({
    descriptor,
    exposedToolName,
    turnId: state.turn.turnId,
  });
  state.capabilities.bindings[binding.bindingId] = binding;
  return binding;
}

function v2ExecutingPlanState() {
  let state = startCurrentTask(
    createInitialRuntimeState({
      threadId: 'runtime-plan-evidence',
      userId: 'user',
      workspace: process.cwd(),
    }),
    'plan-task',
  );
  state = setActivePlanning(state, {
    kind: 'executing',
    document: currentPlanDocument({
      taskId: 'plan-task',
      planId: 'plan-evidence',
      version: 2,
      title: 'Evidence-backed execution plan',
      bodyMarkdown: 'Execute the approved change and verify its observable behavior.',
      steps: [{ id: 'implement', title: 'Implement the approved change', status: 'pending' }],
      structuralDigest: 'digest-evidence',
      createdAtTurnId: state.turn.turnId,
      updatedAtTurnId: state.turn.turnId,
    }),
    executionMode: 'auto',
    approvedAtTurnId: state.turn.turnId,
  });
  return state;
}

function startCurrentTask(
  state: ReturnType<typeof createInitialRuntimeState>,
  taskId = 'test-task',
) {
  return reduceRuntimeState(state, {
    type: 'task.started',
    taskId,
    userGoal: 'Exercise the current Runtime tool contract.',
    turnId: state.turn.turnId,
  });
}

function setTestPlanning(
  state: ReturnType<typeof createInitialRuntimeState>,
  planning: ReturnType<typeof getActivePlanning>,
): void {
  const taskId = state.activeTaskId ?? 'test-task';
  state.activeTaskId = taskId;
  state.tasks[taskId] ??= {
    taskId,
    userGoal: 'Exercise test planning.',
    status: 'active',
    startedAtTurnId: state.turn.turnId,
    sideEffectsStarted: false,
    planning: { kind: 'building_without_plan' },
    planHistory: [],
  };
  state.tasks[taskId]!.planning = planning;
}

function reduceCurrentEvent(
  state: ReturnType<typeof createInitialRuntimeState>,
  event: RuntimeEvent,
) {
  return reduceRuntimeState(
    state,
    normalizeCurrentToolOutcomeEventV1(event, state, '2026-08-15T00:00:00.000Z'),
  );
}

function childRuntimeToolId(input: {
  parentToolCallId: string;
  subagentId: string;
  modelInvocationId: string;
  modelToolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}) {
  return `subagent-tool:${digestCapability({
    schema: 'kite.subagent-runtime-tool-identity.v1',
    parentToolCallId: input.parentToolCallId,
    subagentId: input.subagentId,
    modelInvocationId: input.modelInvocationId,
    modelToolCallId: input.modelToolCallId,
    toolName: input.toolName,
    arguments: input.args,
  })}`;
}

async function executeUpdatePlan(
  state: ReturnType<typeof v2ExecutingPlanState>,
  args: Record<string, unknown>,
) {
  state.tools.calls.update = {
    toolCallId: 'update',
    modelMessageId: 'model-update',
    name: 'update_plan',
    args,
    status: 'queued',
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue.push('update');
  return executeRuntimeTools({ state, toolCallIds: ['update'] });
}

describe('executeRuntimeTools', () => {
  test('dispatches a review child for the mixed-language multi-agent user request', async () => {
    const state = reduceRuntimeState(
      createInitialRuntimeState({
        threadId: 'autonomous-review-delegation',
        userId: 'user',
        workspace: process.cwd(),
      }),
      {
        type: 'user.message_appended',
        messageId: 'user-review',
        content: '调用多agent审核这些问题，确认策略无误。',
      },
    );
    state.tools.calls.review = {
      toolCallId: 'review',
      modelMessageId: 'model-review',
      name: 'task',
      args: {
        subagent_type: 'review',
        task: 'Review the reported policy issues and return concrete file evidence.',
      },
      status: 'queued',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('review');
    const model = createMockModel([{ message: aiMessage({ content: 'Review complete.' }) }]);

    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['review'],
      taskConfig: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'fixture',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
      },
      taskModel: model,
    });

    expect(model.callCount.count).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'subagent.started' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'subagent.completed' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.finished',
        toolCallId: 'review',
        result: expect.objectContaining({ ok: true }),
      }),
    );
  });

  test('routes child read then edit through namespaced Runtime calls and durable receipts', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-child-runtime-filesystem-'));
    writeFileSync(join(workspace, 'child.txt'), 'child evidence\n', 'utf8');
    try {
      const state = createInitialRuntimeState({
        threadId: 'child-runtime-filesystem',
        userId: 'user',
        workspace,
      });
      state.tools.calls.task = {
        toolCallId: 'task',
        modelMessageId: 'parent-model',
        name: 'task',
        args: {
          subagent_type: 'code',
          task: 'Read child.txt, replace child with updated, then report.',
        },
        status: 'queued',
        sideEffect: true,
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push('task');
      const model = createMockModel([
        {
          message: aiMessage({
            content: 'Reading evidence.',
            tool_calls: [
              { id: 'model-child-read', name: 'read_file', args: { path: 'child.txt' } },
            ],
          }),
        },
        {
          message: aiMessage({
            content: 'Editing after the durable read.',
            tool_calls: [
              {
                id: 'model-child-edit',
                name: 'edit_file',
                args: {
                  path: 'child.txt',
                  old_string: 'child evidence',
                  new_string: 'updated evidence',
                },
              },
            ],
          }),
        },
        { message: aiMessage({ content: 'Read and edit complete.' }) },
      ]);

      const events = await executeRuntimeTools({
        state,
        toolCallIds: ['task'],
        taskConfig: {
          apiKey: 'unused',
          baseURL: 'https://example.invalid',
          modelName: 'fixture',
          providerName: 'fixture',
          providerType: 'openai-compatible',
          sandbox: { enabled: false },
        },
        taskModel: model,
      });

      const childStarted = events.find(
        (event): event is Extract<RuntimeEvent, { type: 'subagent.started' }> =>
          event.type === 'subagent.started',
      );
      const childQueued = events.find(
        (event): event is Extract<RuntimeEvent, { type: 'tool.queued' }> =>
          event.type === 'tool.queued' && event.name === 'read_file',
      );
      expect(childQueued?.toolCallId.startsWith('subagent-tool:')).toBe(true);
      const invocationRecordedIndex = events.findIndex(
        (event) =>
          event.type === 'capability.invocation_recorded' &&
          event.toolCallId === childQueued?.toolCallId,
      );
      const attemptIndex = events.findIndex(
        (event, index) =>
          index > invocationRecordedIndex && event.type === 'capability.execution_started',
      );
      const childTerminalIndex = events.findIndex(
        (event) => event.type === 'tool.finished' && event.toolCallId === childQueued?.toolCallId,
      );
      expect(invocationRecordedIndex).toBeGreaterThan(events.indexOf(childQueued!));
      expect(attemptIndex).toBeGreaterThan(invocationRecordedIndex);
      expect(childTerminalIndex).toBeGreaterThan(attemptIndex);
      const filesystemReceipt = events.find(
        (event): event is Extract<RuntimeEvent, { type: 'capability.execution_succeeded' }> =>
          event.type === 'capability.execution_succeeded' && Boolean(event.filesystemObservation),
      );
      expect(filesystemReceipt).toBeDefined();
      expect(filesystemReceipt?.filesystemObservation?.actorIdentityDigest).toBe(
        digestCapability({
          schema: 'kite.workspace-filesystem-actor.v1',
          threadId: state.session.threadId,
          actorIdentity: childStarted?.subagent.id,
        }),
      );
      expect(
        events.some(
          (event) =>
            event.type === 'capability.filesystem_mutation_ready' &&
            event.invocationId !== filesystemReceipt?.invocationId,
        ),
      ).toBe(true);
      expect(readFileSync(join(workspace, 'child.txt'), 'utf8')).toBe('updated evidence\n');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.finished',
          toolCallId: 'task',
          result: expect.objectContaining({ ok: true }),
        }),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('executes independent task calls concurrently', async () => {
    const state = createInitialRuntimeState({
      threadId: 'parallel-task-execution',
      userId: 'user',
      workspace: process.cwd(),
    });
    for (const [ordinal, toolCallId] of ['review-a', 'review-b'].entries()) {
      state.tools.calls[toolCallId] = {
        toolCallId,
        modelMessageId: 'parallel-task-model',
        ordinal,
        name: 'task',
        args: {
          subagent_type: 'review',
          task: `Review independent runtime concern ${ordinal + 1} and report evidence.`,
        },
        status: 'queued',
        effectClass: 'read_only',
        sideEffect: false,
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push(toolCallId);
    }
    const model = createMockModel([
      { message: aiMessage({ content: 'First review complete.' }), delay: 25 },
      { message: aiMessage({ content: 'Second review complete.' }), delay: 25 },
    ]);
    const languageModel = model.model as typeof model.model & {
      doGenerate: (...args: unknown[]) => Promise<unknown>;
    };
    const generate = languageModel.doGenerate.bind(languageModel);
    let running = 0;
    let maximumRunning = 0;
    languageModel.doGenerate = async (...args: unknown[]) => {
      running += 1;
      maximumRunning = Math.max(maximumRunning, running);
      try {
        return await generate(...args);
      } finally {
        running -= 1;
      }
    };

    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['review-a', 'review-b'],
      taskConfig: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'fixture',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
      },
      taskModel: model,
    });

    expect(maximumRunning).toBe(2);
    expect(events.filter((event) => event.type === 'subagent.completed')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'tool.finished')).toHaveLength(2);
  });

  test('serializes concurrent child approvals without dropping suspended siblings', () => {
    const approval = {
      type: 'approval.requested' as const,
      interactionId: 'approval-a',
      toolCallId: 'task-a',
      approval: {} as never,
    };
    const serialized = serializeConcurrentSubagentApprovalEvents([
      [{ type: 'subagent.suspended', toolCallId: 'task-a', snapshot: {} as never }, approval],
      [
        { type: 'subagent.suspended', toolCallId: 'task-b', snapshot: {} as never },
        { ...approval, interactionId: 'approval-b', toolCallId: 'task-b' },
      ],
    ]);

    expect(serialized.filter((event) => event.type === 'subagent.suspended')).toHaveLength(2);
    expect(serialized.filter((event) => event.type === 'approval.requested')).toHaveLength(1);
    expect(serialized).toContainEqual({
      type: 'subagent.approval_deferred',
      toolCallId: 'task-b',
    });
  });

  test('surfaces a deferred child approval without restarting the child model', async () => {
    const state = createInitialRuntimeState({
      threadId: 'deferred-child-approval',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'auto';
    state.tools.calls.task = {
      toolCallId: 'task',
      modelMessageId: 'parallel-task-model',
      name: 'task',
      args: { subagent_type: 'review', task: 'Read the external fixture and report evidence.' },
      status: 'queued',
      effectClass: 'read_only',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('task');
    state.suspendedSubagents.task = serializeSubagentContinuation(
      {
        id: 'deferred-child',
        role: getRoleConfig('review'),
        task: 'Read the external fixture and report evidence.',
        messages: [],
        toolCallCount: 1,
        steps: [],
        toolRecovery: createToolRecoveryJournalV1(state.toolRecovery.identityKey),
      },
      {
        reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
        toolCallId: 'child-read',
        toolName: 'read_file',
        args: { path: '/outside/fixture.txt' },
        command: '/outside/fixture.txt',
      },
    );
    const model = createMockModel([{ message: aiMessage({ content: 'must not run' }) }]);

    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['task'],
      taskConfig: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'fixture',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
      },
      taskModel: model,
    });

    expect(model.callCount.count).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'approval.requested', toolCallId: 'task' }),
    );
    expect(events.some((event) => event.type === 'auto_review.requested')).toBe(false);
    expect(events.some((event) => event.type === 'tool.started')).toBe(false);
  });

  test('production executor queues simultaneous child approvals after concurrent dispatch', async () => {
    const state = createInitialRuntimeState({
      threadId: 'parallel-child-approvals',
      userId: 'user',
      workspace: process.cwd(),
    });
    for (const [ordinal, toolCallId] of ['task-a', 'task-b'].entries()) {
      state.tools.calls[toolCallId] = {
        toolCallId,
        modelMessageId: 'parallel-child-approval-model',
        ordinal,
        name: 'task',
        args: {
          subagent_type: 'review',
          task: `Read external fixture ${ordinal + 1} and report the independent evidence.`,
        },
        status: 'queued',
        effectClass: 'read_only',
        sideEffect: false,
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push(toolCallId);
    }
    const model = createMockModel([
      {
        message: aiMessage({
          content: 'Inspecting the first fixture.',
          tool_calls: [{ id: 'child-read-a', name: 'read_file', args: { path: '/outside/a.txt' } }],
        }),
      },
      {
        message: aiMessage({
          content: 'Inspecting the second fixture.',
          tool_calls: [{ id: 'child-read-b', name: 'read_file', args: { path: '/outside/b.txt' } }],
        }),
      },
    ]);
    const config: AgentConfig = {
      apiKey: 'unused',
      baseURL: 'https://example.invalid',
      modelName: 'fixture',
      providerName: 'fixture',
      providerType: 'openai-compatible',
      sandbox: { enabled: false },
    };
    const terminal = await executeRuntimeTools({
      state,
      toolCallIds: ['task-a', 'task-b'],
      taskConfig: config,
      taskModel: model,
      subagentEventSink: () => {},
    });

    expect(model.callCount.count).toBe(2);
    const starts = terminal.filter((event) => event.type === 'subagent.started');
    expect(starts).toHaveLength(2);
    expect(starts.map((event) => event.subagent.concurrencyGroupId)).toEqual([
      'subagent-batch:task-a',
      'subagent-batch:task-a',
    ]);
    expect(terminal.filter((event) => event.type === 'subagent.suspended')).toHaveLength(2);
    expect(terminal.filter((event) => event.type === 'approval.requested')).toHaveLength(1);
    expect(terminal.filter((event) => event.type === 'subagent.approval_deferred')).toHaveLength(1);
  });

  test.each([
    'missing',
    'mismatched',
  ] as const)('fails closed when a child auto-review continuation is %s', async (snapshotState) => {
    const state = createInitialRuntimeState({
      threadId: `child-auto-review-${snapshotState}`,
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.task = {
      toolCallId: 'task',
      modelMessageId: 'model',
      name: 'task',
      args: { subagent_type: 'code', task: 'Modify the fixture.' },
      status: 'awaiting_auto_review',
      createdAtTurnId: state.turn.turnId,
    };
    state.interactions = {
      kind: 'awaiting_auto_review',
      interactionId: 'review-child',
      toolCallId: 'task',
      toolName: 'shell_execute',
      reason: 'review child command',
      approval: {
        scope: 'once',
        cwd: state.session.workspace,
        threadId: state.session.threadId,
        tool: 'shell_execute',
        command: 'git add fixture.txt',
        risk: 'vcs_mutation',
        approvalHash: 'hash',
        summary: 'Stage fixture.',
        reason: 'Requires automatic review.',
        expectedEffects: ['Mutates version control state'],
        grantOptions: ['approve_once'],
        recommendedGrant: 'approve_once',
        subagentId: 'expected-child',
      },
    };
    if (snapshotState === 'mismatched') {
      state.suspendedSubagents.task = serializeSubagentContinuation(
        {
          id: 'different-child',
          role: getRoleConfig('code'),
          task: 'Modify the fixture.',
          messages: [],
          toolCallCount: 1,
          steps: [],
          toolRecovery: createToolRecoveryJournalV1(state.toolRecovery.identityKey),
        },
        {
          reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
          toolCallId: 'child-shell',
          toolName: 'shell_execute',
          args: { command: 'git add fixture.txt' },
          command: 'git add fixture.txt',
        },
      );
    }
    const model = createMockModel([]);
    const executor = createRuntimeEffectExecutor({
      config: { providerName: 'fixture', modelName: 'fixture' } as AgentConfig,
      model,
    });

    const events = await executor(
      { type: 'run_auto_review', reviewId: 'review-child', toolCallId: 'task' },
      state,
    );

    expect(model.callCount.count).toBe(0);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'auto_review.completed',
        result: expect.objectContaining({
          ok: true,
          approved: false,
          reason: expect.stringContaining('continuation'),
        }),
      }),
    ]);
  });

  test.each([
    ['accept_edits', false, 'approval.requested'],
    ['auto', false, 'auto_review.requested'],
    ['auto', true, 'approval.requested'],
  ] as const)('routes a blocked child in %s mode with breaker=%s through %s', (mode, circuitBreakerTripped, expectedType) => {
    const state = createInitialRuntimeState({
      threadId: `child-review-${mode}-${circuitBreakerTripped}`,
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = mode;
    state.autoReview.circuitBreakerTripped = circuitBreakerTripped;
    const event = blockedSubagentReviewEvent({
      state,
      parentToolCallId: 'task-call',
      blocked: {
        reasonCode: 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW',
        toolCallId: 'child-shell',
        toolName: 'shell_execute',
        command: 'git add fixture.txt',
        args: { command: 'git add fixture.txt' },
        message: 'blocked',
        continuation: {
          id: 'child',
          role: getRoleConfig('code'),
          task: 'Modify the fixture in a code subagent.',
          messages: [],
          toolCallCount: 1,
          steps: [],
          toolRecovery: createToolRecoveryJournalV1(),
        },
      },
      availCtx: toolAvailabilityContext({
        workspace: state.session.workspace,
        threadId: state.session.threadId,
      }),
    });

    expect(event.type).toBe(expectedType);
    if (event.type === 'approval.requested') {
      expect(event.toolCallId).toBe('task-call');
      expect(event.approval.callId).toBe('child-shell');
      expect(event.approval.grantOptions).toContain('same_command');
    }
  });

  test('reserves and reconciles the actual child tool when a suspended Sub-agent resumes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-subagent-resume-budget-'));
    try {
      const state = createInitialRuntimeState({
        threadId: 'subagent-resume-budget',
        userId: 'user',
        workspace,
      });
      state.tools.calls.task = {
        toolCallId: 'task',
        modelMessageId: 'model',
        name: 'task',
        args: { subagent_type: 'code', task: 'Run pwd and finish.' },
        status: 'approved',
        approvalGrant: 'approve_once',
        sideEffect: true,
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.active.push('task');
      const runtimeChildToolId = childRuntimeToolId({
        parentToolCallId: 'task',
        subagentId: 'child',
        modelInvocationId: 'child-model-invocation',
        modelToolCallId: 'child-shell',
        toolName: 'shell_execute',
        args: { command: 'pwd' },
      });
      state.tools.calls[runtimeChildToolId] = {
        toolCallId: runtimeChildToolId,
        modelInvocationId: 'child-model-invocation',
        modelMessageId: 'child-model-invocation',
        name: 'shell_execute',
        args: { command: 'pwd' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push(runtimeChildToolId);
      state.suspendedSubagents.task = serializeSubagentContinuation(
        {
          id: 'child',
          role: getRoleConfig('code'),
          task: 'Run pwd and finish.',
          messages: [
            aiMessage({
              content: 'I need to inspect the directory.',
              tool_calls: [{ id: 'child-shell', name: 'shell_execute', args: { command: 'pwd' } }],
            }),
          ],
          toolCallCount: 1,
          steps: [
            {
              toolName: 'shell_execute',
              toolArgs: { command: 'pwd' },
              status: 'awaiting_approval',
            },
          ],
          toolRecovery: createToolRecoveryJournalV1(state.toolRecovery.identityKey),
        },
        {
          reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
          toolCallId: 'child-shell',
          runtimeToolCallId: runtimeChildToolId,
          toolName: 'shell_execute',
          args: { command: 'pwd' },
          command: 'pwd',
        },
      );

      const order: string[] = [];
      const model = createMockModel([{ message: aiMessage({ content: 'Done.' }) }]);
      const mockModel = model.model as typeof model.model & {
        doGenerate: (...args: unknown[]) => Promise<unknown>;
      };
      const generate = mockModel.doGenerate.bind(mockModel);
      mockModel.doGenerate = async (...args: unknown[]) => {
        order.push('model-dispatch');
        return generate(...args);
      };
      const config: AgentConfig = {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'fixture',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        features: { resourceBudgetV1: true, boundedCancellationV1: true },
        sandbox: { enabled: false },
      };

      const events = await executeRuntimeTools({
        state,
        toolCallIds: ['task'],
        taskConfig: config,
        taskModel: model,
        capabilityArtifactStore: new CapabilityArtifactStore({
          integrityKey: Buffer.alloc(32, 9),
          root: join(workspace, 'capability-artifacts'),
        }),
        subagentEventSink: () => {},
        shellExecutor: async ({ command }) => {
          order.push('tool-dispatch');
          return { ok: true, command, exitCode: 0, stdout: workspace, stderr: '' };
        },
        descendantResourceAdmission: {
          reserveTool: async () => {
            order.push('reserve-tool');
            return { reservationId: 'child-tool' };
          },
          reconcileTool: async ({ reservationId }) => {
            expect(reservationId).toBe('child-tool');
            order.push('reconcile-tool');
          },
          reserveModel: async () => {
            order.push('reserve-model');
            return { reservationId: 'child-model', maxOutputTokens: 64 };
          },
          reconcileModel: async ({ reservationId }) => {
            expect(reservationId).toBe('child-model');
            order.push('reconcile-model');
          },
          markUnknown: async () => {
            order.push('unknown');
          },
          markLocalProviderAdmissionDenied: async () => {
            order.push('released');
          },
        },
      });

      expect(order).toEqual(['reserve-tool', 'tool-dispatch', 'reconcile-tool', 'model-dispatch']);
      expect(events).toContainEqual(expect.objectContaining({ type: 'subagent.completed' }));
      const terminal = events.find(
        (event): event is Extract<RuntimeEvent, { type: 'tool.finished' }> =>
          event.type === 'tool.finished' && event.toolCallId === 'task',
      );
      expect(terminal?.result.resultMeta).toEqual(
        expect.objectContaining({
          digestScope: 'raw',
          contentDigest: expect.any(String),
          modelContentDigest: expect.any(String),
          rawResultDigest: expect.any(String),
        }),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('terminalizes a suspended task when its approved child tool throws during resume', async () => {
    const state = createInitialRuntimeState({
      threadId: 'subagent-resume-tool-throws',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.task = {
      toolCallId: 'task',
      modelMessageId: 'model',
      name: 'task',
      args: { subagent_type: 'code', task: 'Run the approved command and finish.' },
      status: 'approved',
      approvalGrant: 'approve_once',
      sideEffect: true,
      startedAt: '2026-08-14T00:00:00.000Z',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.active.push('task');
    const runtimeChildToolId = childRuntimeToolId({
      parentToolCallId: 'task',
      subagentId: 'child',
      modelInvocationId: 'child-model-invocation',
      modelToolCallId: 'child-shell',
      toolName: 'shell_execute',
      args: { command: 'fixture-command' },
    });
    state.tools.calls[runtimeChildToolId] = {
      toolCallId: runtimeChildToolId,
      modelInvocationId: 'child-model-invocation',
      modelMessageId: 'child-model-invocation',
      name: 'shell_execute',
      args: { command: 'fixture-command' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push(runtimeChildToolId);
    state.suspendedSubagents.task = serializeSubagentContinuation(
      {
        id: 'child',
        role: getRoleConfig('code'),
        task: 'Run the approved command and finish.',
        messages: [],
        toolCallCount: 1,
        steps: [],
        toolRecovery: createToolRecoveryJournalV1(state.toolRecovery.identityKey),
      },
      {
        reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
        toolCallId: 'child-shell',
        runtimeToolCallId: runtimeChildToolId,
        toolName: 'shell_execute',
        args: { command: 'fixture-command' },
        command: 'fixture-command',
      },
    );

    let dispatches = 0;
    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['task'],
      taskConfig: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'fixture',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
      },
      taskModel: createMockModel([]),
      subagentEventSink: () => {},
      shellExecutor: async ({ command }) => {
        dispatches += 1;
        return { ok: true, command, exitCode: 0, stdout: '', stderr: '' };
      },
      descendantResourceAdmission: {
        reserveTool: async () => ({ reservationId: 'child-tool' }),
        reconcileTool: async () => {
          throw new Error('fixture reconciliation failed after dispatch');
        },
        reserveModel: async () => ({ reservationId: 'child-model', maxOutputTokens: 64 }),
        reconcileModel: async () => {},
        markUnknown: async () => {},
        markLocalProviderAdmissionDenied: async () => {},
      },
    });

    expect(dispatches).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.failed',
        toolCallId: 'task',
        failure: expect.objectContaining({ kind: 'tool_runtime_error' }),
      }),
    );
  });

  test('rejects a mismatched child continuation before approval replay or dispatch', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-child-resume-identity-mismatch-'));
    try {
      const state = createInitialRuntimeState({
        threadId: 'child-resume-identity-mismatch',
        userId: 'user',
        workspace,
      });
      state.tools.calls.task = {
        toolCallId: 'task',
        modelMessageId: 'parent-model',
        name: 'task',
        args: { subagent_type: 'code', task: 'Run the approved child operation and finish.' },
        status: 'approved',
        approvalGrant: 'approve_once',
        createdAtTurnId: state.turn.turnId,
      };
      const runtimeChildToolId = childRuntimeToolId({
        parentToolCallId: 'task',
        subagentId: 'child',
        modelInvocationId: 'child-model-invocation',
        modelToolCallId: 'child-shell',
        toolName: 'shell_execute',
        args: { command: 'pwd' },
      });
      state.tools.calls[runtimeChildToolId] = {
        toolCallId: runtimeChildToolId,
        modelInvocationId: 'child-model-invocation',
        modelMessageId: 'child-model-invocation',
        name: 'shell_execute',
        args: { command: 'pwd' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push(runtimeChildToolId);
      state.suspendedSubagents.task = serializeSubagentContinuation(
        {
          id: 'child',
          role: getRoleConfig('code'),
          task: 'Run the approved child operation and finish.',
          messages: [],
          toolCallCount: 1,
          steps: [],
          toolRecovery: createToolRecoveryJournalV1(state.toolRecovery.identityKey),
        },
        {
          reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
          toolCallId: 'child-write',
          runtimeToolCallId: runtimeChildToolId,
          toolName: 'write_file',
          args: { path: 'must-not-exist.txt', content: 'unauthorized' },
          command: 'write_file must-not-exist.txt',
        },
      );
      const model = createMockModel([]);

      const events = await executeRuntimeTools({
        state,
        toolCallIds: ['task'],
        taskConfig: {
          apiKey: 'unused',
          baseURL: 'https://example.invalid',
          modelName: 'fixture',
          providerName: 'fixture',
          providerType: 'openai-compatible',
          sandbox: { enabled: false },
        },
        taskModel: model,
        subagentEventSink: () => {},
      });

      expect(model.callCount.count).toBe(0);
      expect(existsSync(join(workspace, 'must-not-exist.txt'))).toBe(false);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.rejected',
          toolCallId: 'task',
          reason: expect.stringContaining('identity'),
        }),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('releases the exact child reservation without dispatch when attempt acknowledgement fails', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-child-attempt-ack-rejected-'));
    try {
      const state = createInitialRuntimeState({
        threadId: 'child-attempt-ack-rejected',
        userId: 'user',
        workspace,
      });
      state.tools.calls.task = {
        toolCallId: 'task',
        modelMessageId: 'parent-model',
        name: 'task',
        args: { subagent_type: 'code', task: 'Write child.txt and then report the result.' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push('task');
      const model = createMockModel([
        {
          message: aiMessage({
            content: 'Writing.',
            tool_calls: [
              {
                id: 'child-write',
                name: 'write_file',
                args: { path: 'child.txt', content: 'must not be written' },
              },
            ],
          }),
        },
        { message: aiMessage({ content: 'The write was rejected.' }) },
      ]);
      let toolReservations = 0;
      let releasedReservations = 0;

      const events = await executeRuntimeTools({
        state,
        toolCallIds: ['task'],
        taskConfig: {
          apiKey: 'unused',
          baseURL: 'https://example.invalid',
          modelName: 'fixture',
          providerName: 'fixture',
          providerType: 'openai-compatible',
          sandbox: { enabled: false },
        },
        taskModel: model,
        subagentEventSink: () => {},
        descendantResourceAdmission: {
          reserveModel: async () => ({ reservationId: 'model' }),
          reconcileModel: async () => {},
          reserveTool: async () => {
            toolReservations += 1;
            return { reservationId: 'child-pre-ack-reservation' };
          },
          reconcileTool: async () => {},
          markUnknown: async () => {},
          markLocalProviderAdmissionDenied: async (reservationId) => {
            expect(reservationId).toBe('child-pre-ack-reservation');
            releasedReservations += 1;
          },
        },
        persistRuntimeEvents: async (batch) =>
          !batch.some(
            (event) =>
              event.type === 'capability.invocation_recorded' &&
              event.toolCallId.startsWith('subagent-tool:'),
          ),
      });

      expect(existsSync(join(workspace, 'child.txt'))).toBe(false);
      expect(toolReservations).toBe(1);
      expect(releasedReservations).toBe(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.failed',
          toolCallId: expect.stringMatching(/^subagent-tool:/),
          failure: expect.objectContaining({ kind: 'persistence_unavailable' }),
        }),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('records unknown and does not retry when a child receipt artifact fails', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-child-receipt-failure-'));
    try {
      const state = createInitialRuntimeState({
        threadId: 'child-receipt-failure',
        userId: 'user',
        workspace,
      });
      state.tools.calls.task = {
        toolCallId: 'task',
        modelMessageId: 'parent-model',
        name: 'task',
        args: { subagent_type: 'code', task: 'Write child.txt once and then report the result.' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push('task');
      const model = createMockModel([
        {
          message: aiMessage({
            content: 'Writing once.',
            tool_calls: [
              {
                id: 'child-write',
                name: 'write_file',
                args: { path: 'child.txt', content: 'written once' },
              },
            ],
          }),
        },
        { message: aiMessage({ content: 'Receipt was unavailable; stopping.' }) },
      ]);
      const childInvocations = new Set<string>();
      const artifacts = testCapabilityArtifactWriterV1();
      let rejectedArtifacts = 0;

      const events = await executeRuntimeTools({
        state,
        toolCallIds: ['task'],
        taskConfig: {
          apiKey: 'unused',
          baseURL: 'https://example.invalid',
          modelName: 'fixture',
          providerName: 'fixture',
          providerType: 'openai-compatible',
          sandbox: { enabled: false },
        },
        taskModel: model,
        subagentEventSink: () => {},
        persistRuntimeEvents: async (batch) => {
          for (const event of batch) {
            if (
              event.type === 'capability.invocation_recorded' &&
              event.toolCallId.startsWith('subagent-tool:')
            ) {
              childInvocations.add(event.invocationId);
            }
          }
          return true;
        },
        capabilityArtifactStore: {
          write: (invocationId, result) => {
            if (childInvocations.has(invocationId)) {
              rejectedArtifacts += 1;
              throw new Error('fixture child artifact failure');
            }
            return artifacts.write(invocationId, result);
          },
        },
      });

      expect(readFileSync(join(workspace, 'child.txt'), 'utf8')).toBe('written once');
      expect(rejectedArtifacts).toBe(1);
      expect(
        events.filter(
          (event) =>
            event.type === 'capability.execution_unknown' &&
            childInvocations.has(event.invocationId),
        ),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === 'capability.filesystem_mutation_ready'),
      ).toHaveLength(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('Skill fork keeps its durable MCP binding across an acknowledged safe-read retry', async () => {
    const state = startCurrentTask(
      createInitialRuntimeState({
        threadId: 'skill-fork-mcp-retry',
        userId: 'user',
        workspace: process.cwd(),
      }),
    );
    state.authorization = { mode: 'full_access', commandGrants: {} };
    const mcpDescriptor = canonicalMcpDescriptor({
      capabilityId: 'mcp:fixture/read',
      kind: 'mcp_tool',
      displayName: 'read',
      description: 'Read fixture data.',
      provider: { type: 'mcp', id: 'fixture', provenance: 'remote' },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      declaredEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
      execution: { retry: 'safe_read' },
      availability: 'available',
      diagnostics: [],
    });
    const skillDescriptor = canonicalMcpDescriptor({
      capabilityId: 'skill:fixture-read',
      kind: 'skill',
      displayName: 'fixture-read',
      description: 'Read fixture data in a governed fork.',
      provider: {
        type: 'skill',
        id: 'fixture-read',
        provenance: 'project',
        version: '1.0.0',
      },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: { outcome: { type: 'string' } },
        required: ['outcome'],
        additionalProperties: false,
      },
      declaredEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
      execution: { retry: 'never' },
      availability: 'available',
      diagnostics: [],
    });
    const skillCatalog: import('@/core/skills/catalog').SkillCatalogSnapshot = {
      revision: 'skill-catalog-retry',
      capabilities: createSnapshot([skillDescriptor]),
      entries: [
        {
          sourcePath: '/workspace/.kite-code/skills/fixture-read',
          source: 'project',
          origin: '.kite-code',
          diagnostics: [],
          descriptor: skillDescriptor,
          contract: {
            schemaVersion: 1,
            name: 'fixture-read',
            version: '1.0.0',
            description: 'Read fixture data in a governed fork.',
            instructions: 'Call the fixture read capability once.',
            invocation: { allowImplicit: true, allowManual: true },
            context: { mode: 'fork', agent: 'code' },
            inputSchema: skillDescriptor.inputSchema!,
            outputSchema: skillDescriptor.outputSchema!,
            capabilityCeiling: [mcpDescriptor.capabilityId],
            deniedCapabilities: [],
            effectiveCapabilityCeiling: [mcpDescriptor.capabilityId],
            effects: { filesystem: 'none', network: 'read', externalState: 'read' },
            effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
            minimumApproval: 'none',
            effectiveMinimumApproval: 'none',
            execution: { timeoutMs: 1_000, maxAttempts: 1 },
            verification: { mode: 'not_required' },
            recovery: { retry: 'never' },
            files: ['SKILL.md'],
            dependencyRevisions: { [mcpDescriptor.capabilityId]: mcpDescriptor.revision },
          },
        },
      ],
    };
    state.capabilities.disclosures[skillDescriptor.capabilityId] = {
      capabilityId: skillDescriptor.capabilityId,
      capabilityRevision: skillDescriptor.revision,
      issuedForTurnId: state.turn.turnId,
    };
    state.tools.calls.activate = {
      toolCallId: 'activate',
      modelMessageId: 'parent-model',
      name: 'activate_skill',
      args: { skill_id: skillDescriptor.capabilityId, input: {} },
      status: 'approved',
      approvalGrant: 'approve_once',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('activate');

    const manager = new McpConnectionManager();
    const runtimeManager = manager as McpConnectionManager & {
      ensureProviderReady(
        providerId: string,
        timeoutMs?: number,
        signal?: AbortSignal,
      ): Promise<void>;
    };
    runtimeManager.ensureProviderReady = async () => {};
    manager.getCapabilitySnapshot = () => createSnapshot([mcpDescriptor]);
    manager.findCapability = (capabilityId) =>
      capabilityId === mcpDescriptor.capabilityId ? mcpDescriptor : undefined;
    manager.getCapabilityRoute = () => ({
      transport: 'stdio',
      serverIdentity: 'fixture',
      endpointRevision: 'stdio-fixture-v1',
      toolRevision: mcpDescriptor.revision,
    });
    let providerCalls = 0;
    manager.callCapability = async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        throw new McpProviderError({
          providerId: 'fixture',
          kind: 'provider_unavailable',
          message: 'transient fixture outage',
          recoveryAction: 'retry',
          retryable: true,
        });
      }
      return { content: [{ type: 'text', text: 'fixture data' }] };
    };
    const settlementOrder: string[] = [];
    let reservation = 0;
    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['activate'],
      mcpManager: runtimeManager,
      skillCatalog,
      taskConfig: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'fixture',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
        features: {
          capabilityCatalogV1: true,
          mcpRuntimeBindingV1: true,
          mcpExecutionRecordV1: true,
          toolSearchV1: true,
          skillWorkflowV1: true,
          skillActivationV2: true,
        },
      },
      taskModel: createMockModel([
        {
          message: aiMessage({
            content: 'Read the fixture.',
            tool_calls: [{ id: 'skill-mcp-read', name: 'mcp__fixture__read', args: {} }],
          }),
        },
        { message: aiMessage({ content: '{"outcome":"done"}' }) },
      ]),
      descendantResourceAdmission: {
        reserveModel: async () => ({ reservationId: 'model' }),
        reconcileModel: async () => {},
        reserveTool: async () => {
          reservation += 1;
          settlementOrder.push(`reserve-${reservation}`);
          return { reservationId: `tool-${reservation}` };
        },
        reconcileTool: async ({ reservationId }) => {
          settlementOrder.push(`reconcile-${reservationId}`);
        },
        markUnknown: async (reservationId) => {
          settlementOrder.push(`unknown-${reservationId}`);
        },
        markLocalProviderAdmissionDenied: async () => {},
      },
    });

    expect(providerCalls).toBe(2);
    expect(settlementOrder).toEqual([
      'reserve-1',
      'unknown-tool-1',
      'reserve-2',
      'reconcile-tool-2',
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'capability.bindings_issued',
        bindings: [expect.objectContaining({ capabilityId: mcpDescriptor.capabilityId })],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'skill.frame_closed', status: 'closed' }),
    );

    const rejectedBindingEvents = await executeRuntimeTools({
      state: structuredClone(state),
      toolCallIds: ['activate'],
      mcpManager: runtimeManager,
      skillCatalog,
      taskConfig: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'fixture',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
        features: {
          capabilityCatalogV1: true,
          mcpRuntimeBindingV1: true,
          mcpExecutionRecordV1: true,
          toolSearchV1: true,
          skillWorkflowV1: true,
          skillActivationV2: true,
        },
      },
      taskModel: createMockModel([
        {
          message: aiMessage({
            content: 'Must not dispatch.',
            tool_calls: [{ id: 'unacknowledged-skill-mcp', name: 'mcp__fixture__read', args: {} }],
          }),
        },
      ]),
      persistRuntimeEvents: async (batch) =>
        !batch.some((event) => event.type === 'capability.bindings_issued'),
    });

    expect(providerCalls).toBe(2);
    expect(rejectedBindingEvents).not.toContainEqual(
      expect.objectContaining({ type: 'subagent.started' }),
    );
    expect(rejectedBindingEvents).toContainEqual(
      expect.objectContaining({
        type: 'tool.rejected',
        toolCallId: 'activate',
        reason: expect.stringContaining('resolvable capability bindings'),
      }),
    );
  });

  test('does not dispatch an approved child continuation after its live recovery identity changes', async () => {
    const state = createInitialRuntimeState({
      threadId: 'stale-subagent-resume-identity',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.task = {
      toolCallId: 'task',
      modelMessageId: 'model',
      name: 'task',
      args: { subagent_type: 'code', task: 'Run pwd.' },
      status: 'approved',
      approvalGrant: 'approve_once',
      createdAtTurnId: state.turn.turnId,
    };
    state.suspendedSubagents.task = serializeSubagentContinuation(
      {
        id: 'child',
        role: getRoleConfig('code'),
        task: 'Run pwd.',
        messages: [],
        toolCallCount: 1,
        steps: [],
        toolRecovery: createToolRecoveryJournalV1(state.toolRecovery.identityKey),
      },
      {
        reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
        toolCallId: 'child-shell',
        toolName: 'shell_execute',
        args: { command: 'pwd' },
        command: 'pwd',
      },
    );
    const live = structuredClone(state);
    live.toolRecovery = createToolRecoveryJournalV1('b'.repeat(64));
    let dispatched = false;

    const events = await executeRuntimeTools({
      state,
      getRuntimeState: () => live,
      toolCallIds: ['task'],
      taskConfig: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'fixture',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
      },
      taskModel: createMockModel([]),
      shellExecutor: async ({ command }) => {
        dispatched = true;
        return { ok: true, command, exitCode: 0, stdout: '', stderr: '' };
      },
      subagentEventSink: () => {},
    });

    expect(dispatched).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.rejected',
        reason: expect.stringContaining('no longer matches the live runtime'),
      }),
    );
  });

  test('keeps a read-only child shell ceiling after an approved continuation resumes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-read-only-subagent-resume-'));
    try {
      const state = createInitialRuntimeState({
        threadId: 'read-only-subagent-resume',
        userId: 'user',
        workspace,
      });
      state.tools.calls.task = {
        toolCallId: 'task',
        modelMessageId: 'model',
        name: 'task',
        args: { subagent_type: 'review', task: 'Review the project without making changes.' },
        status: 'approved',
        approvalGrant: 'approve_once',
        sideEffect: false,
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.active.push('task');
      state.suspendedSubagents.task = serializeSubagentContinuation(
        {
          id: 'review-child',
          role: getRoleConfig('review'),
          task: 'Review the project without making changes.',
          messages: [
            aiMessage({
              content: 'I will run the project tests.',
              tool_calls: [
                {
                  id: 'child-shell',
                  name: 'shell_execute',
                  args: { command: 'bun run typecheck' },
                },
              ],
            }),
          ],
          toolCallCount: 1,
          steps: [
            {
              toolName: 'shell_execute',
              toolArgs: { command: 'bun run typecheck' },
              status: 'awaiting_approval',
            },
          ],
          toolRecovery: createToolRecoveryJournalV1(state.toolRecovery.identityKey),
        },
        {
          reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
          toolCallId: 'child-shell',
          toolName: 'shell_execute',
          args: { command: 'bun run typecheck' },
          command: 'bun run typecheck',
        },
      );

      let shellExecutions = 0;
      const events = await executeRuntimeTools({
        state,
        toolCallIds: ['task'],
        taskConfig: {
          apiKey: 'unused',
          baseURL: 'https://example.invalid',
          modelName: 'fixture',
          providerName: 'fixture',
          providerType: 'openai-compatible',
          sandbox: { enabled: false },
        },
        taskModel: createMockModel([
          { message: aiMessage({ content: 'The command was rejected by the read-only ceiling.' }) },
        ]),
        subagentEventSink: () => {},
        shellExecutor: async ({ command }) => {
          shellExecutions += 1;
          return { ok: true, command, exitCode: 0, stdout: 'unexpected', stderr: '' };
        },
      });

      expect(shellExecutions).toBe(0);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'subagent.tool_result',
          subagent: expect.objectContaining({
            ok: false,
            summary: expect.stringContaining('read-only command'),
          }),
        }),
      );
      expect(events).toContainEqual(expect.objectContaining({ type: 'subagent.completed' }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'subagent.failed' }));
      const journalEvent = events.find(
        (event) => event.type === 'subagent.recovery_journal_merged',
      );
      expect(journalEvent?.type).toBe('subagent.recovery_journal_merged');
      if (journalEvent?.type === 'subagent.recovery_journal_merged') {
        expect(Object.values(journalEvent.journal.failures)[0]?.outcome).toMatchObject({
          status: 'rejected',
          failure: { kind: 'policy_denied' },
          dispatchState: 'not_started',
          externalEffects: 'none',
        });
      }
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'tool.finished', toolCallId: 'task' }),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('executes a normalized model tool name against the original remote MCP name', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-normalized-mcp-name',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.authorization = { mode: 'full_access', commandGrants: {} };
    const remoteToolName = '搜索 docs / latest';
    const exposedName = exposedMcpToolName('docs.provider', remoteToolName);
    const descriptor = canonicalMcpDescriptor({
      capabilityId: `mcp:docs.provider/${remoteToolName}`,
      revision: 'revision-1',
      kind: 'mcp_tool' as const,
      displayName: remoteToolName,
      description: 'search fixture',
      provider: { type: 'mcp' as const, id: 'docs.provider', provenance: 'remote' as const },
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
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
    });
    const binding = issueMcpBinding(state, descriptor, exposedName);
    state.tools.calls.mcp = {
      toolCallId: 'mcp',
      modelMessageId: 'model',
      name: exposedName,
      args: { query: 'runtime' },
      status: 'queued',
      bindingId: binding.bindingId,
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('mcp');
    const manager = new McpConnectionManager();
    const runtimeManager = manager as McpConnectionManager & {
      ensureProviderReady(
        providerId: string,
        timeoutMs?: number,
        signal?: AbortSignal,
      ): Promise<void>;
    };
    let calledWith: { server: string; tool: string } | undefined;
    runtimeManager.ensureProviderReady = async () => {};
    runtimeManager.getCapabilityRoute = () => ({
      transport: 'stdio',
      serverIdentity: descriptor.provider.id,
      endpointRevision: 'stdio-v1',
      toolRevision: descriptor.revision,
    });
    manager.findCapability = () => descriptor;
    manager.callCapability = async () => {
      calledWith = { server: descriptor.provider.id, tool: descriptor.displayName };
      return { content: [{ type: 'text', text: 'ok' }] };
    };

    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['mcp'],
      mcpManager: runtimeManager,
      taskConfig: {
        apiKey: 'test',
        baseURL: 'http://localhost',
        modelName: 'mock',
        providerName: 'mock',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
        features: { capabilityCatalogV1: true, mcpRuntimeBindingV1: true },
      },
    });

    expect(calledWith).toEqual({ server: 'docs.provider', tool: remoteToolName });
    expect(events.some((event) => event.type === 'tool.finished')).toBe(true);
  });

  test('sealed network boundary rejects every MCP provider path before readiness or search', async () => {
    const state = createInitialRuntimeState({
      threadId: 'sealed-mcp-network',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.authorization = { mode: 'full_access', commandGrants: {} };
    const descriptor = canonicalMcpDescriptor({
      capabilityId: 'mcp:docs/search',
      revision: 'revision-1',
      kind: 'mcp_tool' as const,
      displayName: 'search',
      description: 'search fixture',
      provider: { type: 'mcp' as const, id: 'docs', provenance: 'remote' as const },
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
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
    });
    const dynamicName = exposedMcpToolName('docs', 'search');
    const binding = issueMcpBinding(state, descriptor, dynamicName);
    state.tools.calls.resource = {
      toolCallId: 'resource',
      modelMessageId: 'model',
      name: 'read_mcp_resource',
      args: { server: 'docs', uri: 'docs://one' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls.dynamic = {
      toolCallId: 'dynamic',
      modelMessageId: 'model',
      name: dynamicName,
      args: { query: 'runtime' },
      status: 'queued',
      bindingId: binding.bindingId,
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls.search = {
      toolCallId: 'search',
      modelMessageId: 'model',
      name: 'tool_search',
      args: { query: 'docs search' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('resource', 'dynamic', 'search');

    const manager = new McpConnectionManager();
    const runtimeManager = manager as McpConnectionManager & {
      ensureProviderReady(providerId: string, timeoutMs?: number): Promise<void>;
    };
    let providerCalls = 0;
    runtimeManager.ensureProviderReady = async () => {
      providerCalls += 1;
    };
    manager.findCapability = () => {
      providerCalls += 1;
      return descriptor;
    };
    manager.callCapability = async () => {
      providerCalls += 1;
      return { content: [] };
    };

    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['resource', 'dynamic', 'search'],
      mcpManager: runtimeManager,
      taskConfig: {
        apiKey: 'test',
        baseURL: 'http://localhost',
        modelName: 'mock',
        providerName: 'mock',
        providerType: 'openai-compatible',
        sandbox: { enabled: true },
        features: {
          capabilityCatalogV1: true,
          mcpRuntimeBindingV1: true,
          toolSearchV1: true,
          networkBoundaryV1: true,
        },
        executionBoundary: {
          filesystemScope: 'workspace_write',
          workspaceRoot: process.cwd(),
          networkMode: 'allowlist',
          networkAllowlist: ['docs.example'],
          allowLocalAndPrivateNetwork: false,
          protectedPathPolicy: 'deny',
          maxProcessTreeSizePerShellInvocation: 8,
          sandboxRequired: true,
          sandboxUnavailable: 'fail',
        },
      },
    });

    expect(providerCalls).toBe(0);
    expect(events).toHaveLength(3);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool.rejected', toolCallId: 'resource' }),
        expect.objectContaining({ type: 'tool.rejected', toolCallId: 'dynamic' }),
        expect.objectContaining({ type: 'tool.rejected', toolCallId: 'search' }),
      ]),
    );
    for (const event of events) {
      expect(event).toMatchObject({
        type: 'tool.rejected',
        failure: { kind: 'mandatory_policy_unavailable' },
      });
    }
  });

  test('ask_user emits user_input.requested with the interrupt spec payload', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-ask-user-interrupt',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.ask = {
      toolCallId: 'ask',
      modelMessageId: 'model',
      name: 'ask_user',
      args: {
        questions: [
          {
            question: 'Continue with the migration?',
            options: [
              {
                label: 'Continue',
                description: 'Proceed with the migration now.',
                recommended: true,
              },
              {
                label: 'Pause',
                description: 'Keep the current state and stop here.',
                recommended: false,
              },
            ],
          },
        ],
      },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('ask');

    const events = await executeRuntimeTools({ state, toolCallIds: ['ask'] });

    const requested = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'user_input.requested' }> =>
        event.type === 'user_input.requested',
    );
    expect(requested).toBeDefined();
    // 载荷是 Schema 规范化的中断内容：question 从 questions[0] 派生，
    // options/allow_free_text 补齐默认值——模型原始 args 不直通事件。
    expect(requested?.request).toEqual({
      question: 'Continue with the migration?',
      options: [
        {
          id: 'q1-o1',
          label: 'Continue',
          description: 'Proceed with the migration now.',
        },
        {
          id: 'q1-o2',
          label: 'Pause',
          description: 'Keep the current state and stop here.',
        },
      ],
      allow_free_text: true,
      recommended: 'q1-o1',
      questions: [
        {
          id: 'q1',
          question: 'Continue with the migration?',
          options: [
            {
              id: 'q1-o1',
              label: 'Continue',
              description: 'Proceed with the migration now.',
            },
            {
              id: 'q1-o2',
              label: 'Pause',
              description: 'Keep the current state and stop here.',
            },
          ],
          recommended: 'q1-o1',
          allow_free_text: true,
        },
      ],
    });
  });

  test('full mode allows ask_user to open a user-input interaction', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-full-mode-ask-user',
      userId: 'user',
      workspace: process.cwd(),
      interactionMode: 'full',
    });
    state.tools.calls.ask = {
      toolCallId: 'ask',
      modelMessageId: 'model',
      name: 'ask_user',
      args: {
        questions: [
          {
            question: 'Choose a path?',
            options: [
              { label: 'A', description: 'Choose A.', recommended: true },
              { label: 'B', description: 'Choose B.', recommended: false },
            ],
          },
        ],
      },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('ask');

    const events = await executeRuntimeTools({ state, toolCallIds: ['ask'] });

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'user_input.requested', toolCallId: 'ask' }),
    );
    expect(events.some((event) => event.type === 'tool.rejected')).toBe(false);
  });

  test('controller routes the ask_user payload through askUserSpec.createInterrupt', () => {
    const source = readFileSync(
      new URL('../../src/core/controllers/tool-controller.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('askUserSpec.createInterrupt(');
  });

  test('fails closed when a provider reconnect changes the bound descriptor revision', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-provider-revision-drift',
      userId: 'user',
      workspace: process.cwd(),
    });
    const descriptor = canonicalMcpDescriptor({
      capabilityId: 'mcp:github/read',
      revision: 'revision-1',
      kind: 'mcp_tool' as const,
      displayName: 'read',
      description: 'read fixture',
      provider: { type: 'mcp' as const, id: 'github', provenance: 'remote' as const },
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
    });
    const binding = issueMcpBinding(state, descriptor, 'mcp__github__read');
    state.tools.calls.mcp = {
      toolCallId: 'mcp',
      modelMessageId: 'model',
      name: 'mcp__github__read',
      args: {},
      status: 'queued',
      bindingId: binding.bindingId,
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('mcp');
    const manager = new McpConnectionManager();
    const runtimeManager = manager as McpConnectionManager & {
      ensureProviderReady(providerId: string, timeoutMs?: number): Promise<void>;
    };
    let reconnected = false;
    let called = false;
    manager.findCapability = () =>
      reconnected ? { ...descriptor, revision: 'revision-2' } : descriptor;
    runtimeManager.ensureProviderReady = async () => {
      reconnected = true;
    };
    manager.callCapability = async () => {
      called = true;
      return { content: [] };
    };

    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['mcp'],
      mcpManager: runtimeManager,
      taskConfig: {
        apiKey: '',
        baseURL: 'http://localhost',
        modelName: 'test',
        providerName: 'test',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
        features: { capabilityCatalogV1: true, mcpRuntimeBindingV1: true },
      },
    });

    expect(called).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.failed',
        failure: expect.objectContaining({
          kind: 'provider_capability_changed',
          retryable: false,
        }),
      }),
    );
  });

  test('classifies an unavailable bound MCP provider without string matching', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-provider-auth',
      userId: 'user',
      workspace: process.cwd(),
    });
    const unavailableDescriptor = canonicalMcpDescriptor({
      capabilityId: 'mcp:github/publish',
      kind: 'mcp_tool',
      displayName: 'publish',
      description: 'Publish a fixture release.',
      provider: { type: 'mcp', id: 'github', provenance: 'remote' },
      inputSchema: { type: 'object', properties: {} },
      declaredEffects: { filesystem: 'none', network: 'write', externalState: 'write' },
      effectiveEffects: { filesystem: 'none', network: 'write', externalState: 'write' },
      policy: { workspaceTrustRequired: false, minimumApproval: 'user' },
      availability: 'available',
      diagnostics: [],
    });
    const binding = issueMcpBinding(state, unavailableDescriptor, 'mcp__github__publish');
    state.tools.calls.mcp = {
      toolCallId: 'mcp',
      modelMessageId: 'model',
      name: 'mcp__github__publish',
      args: {},
      status: 'queued',
      bindingId: binding.bindingId,
      capabilityId: binding.capabilityId,
      capabilityRevision: binding.capabilityRevision,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('mcp');
    const manager = new McpConnectionManager();
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

    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['mcp'],
      mcpManager: manager,
      taskConfig: {
        apiKey: '',
        baseURL: 'http://localhost',
        modelName: 'test',
        providerName: 'test',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
        features: { capabilityCatalogV1: true, mcpRuntimeBindingV1: true },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.failed',
        failure: expect.objectContaining({
          kind: 'provider_auth_required',
          needsUserIntervention: true,
          retryable: false,
        }),
      }),
    ]);

    const actionEvents = await executeRuntimeTools({
      state,
      toolCallIds: ['mcp'],
      mcpManager: manager,
      taskConfig: {
        apiKey: '',
        baseURL: 'http://localhost',
        modelName: 'test',
        providerName: 'test',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
        features: {
          capabilityCatalogV1: true,
          mcpRuntimeBindingV1: true,
          mcpProviderActionV1: true,
        },
      },
    });
    expect(actionEvents.map((event) => event.type)).toEqual([
      'tool.failed',
      'provider.action_required',
    ]);
    expect(actionEvents[1]).toMatchObject({
      providerId: 'github',
      action: 'login',
      originatingToolCallId: 'mcp',
    });
    expect(JSON.stringify(actionEvents[1])).not.toContain('old-revision');
  });

  test('rejects an empty ask_user request instead of opening a blank prompt', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-empty-ask',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.ask = {
      toolCallId: 'ask',
      modelMessageId: 'model',
      name: 'ask_user',
      args: {},
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('ask');

    const events = await executeRuntimeTools({ state, toolCallIds: ['ask'] });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.failed',
        toolCallId: 'ask',
        failure: expect.objectContaining({ kind: 'tool_invalid_args' }),
      }),
    ]);
  });

  test('rejects the removed top-level ask_user shape', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-legacy-ask-shape',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.ask = {
      toolCallId: 'ask',
      modelMessageId: 'model',
      name: 'ask_user',
      args: {
        question: 'Continue?',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('ask');

    const events = await executeRuntimeTools({ state, toolCallIds: ['ask'] });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.failed',
        toolCallId: 'ask',
        failure: expect.objectContaining({
          kind: 'tool_invalid_args',
          message: expect.stringContaining('questions'),
        }),
      }),
    ]);
  });

  test('fails closed when a dynamic MCP call has no Runtime-issued binding', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-unbound-mcp',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.mcp = {
      toolCallId: 'mcp',
      modelMessageId: 'model',
      name: 'mcp__fixture__read',
      args: { id: '1' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('mcp');
    const events = await executeRuntimeTools({ state, toolCallIds: ['mcp'] });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.failed',
        failure: expect.objectContaining({ kind: 'tool_invalid_args' }),
      }),
    ]);
  });

  test('enforces an active Skill frame capability ceiling before executing a builtin', async () => {
    let state = createInitialRuntimeState({
      threadId: 'runtime-skill-ceiling',
      userId: 'user',
      workspace: process.cwd(),
    });
    state = {
      ...state,
      activeTaskId: 'task',
      tasks: {
        task: {
          taskId: 'task',
          userGoal: 'skill task',
          status: 'active',
          startedAtTurnId: state.turn.turnId,
          sideEffectsStarted: false,
          planning: { kind: 'building_without_plan' },
          planHistory: [],
        },
      },
      skills: {
        catalogRevision: 'skills-r1',
        frames: {
          activation: {
            activationId: 'activation',
            skillId: 'skill:read-only',
            skillRevision: 'skill-r1',
            taskId: 'task',
            input: {},
            contextMode: 'inline',
            agent: 'code',
            capabilityCeiling: ['builtin:read_file'],
            verificationMode: 'not_required',
            requestedBy: 'user',
            activatedAt: '2026-07-15T00:00:00.000Z',
            status: 'active',
          },
        },
      },
    };
    state.tools.calls.write = {
      toolCallId: 'write',
      modelMessageId: 'model',
      name: 'write_file',
      args: { path: 'blocked.txt', content: 'blocked' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('write');

    const events = await executeRuntimeTools({ state, toolCallIds: ['write'] });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.rejected',
        toolCallId: 'write',
        reason: expect.stringContaining('capability ceiling'),
      }),
    ]);
  });

  test('records a side-effecting MCP invocation before execution and persists only digests', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-recorded-mcp',
      userId: 'user',
      workspace: process.cwd(),
    });
    const descriptor = canonicalMcpDescriptor({
      capabilityId: 'mcp:fixture/write',
      revision: 'write-revision',
      kind: 'mcp_tool' as const,
      displayName: 'write',
      description: 'write fixture',
      provider: { type: 'mcp' as const, id: 'fixture', provenance: 'remote' as const },
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      declaredEffects: {
        filesystem: 'none' as const,
        network: 'write' as const,
        externalState: 'write' as const,
      },
      effectiveEffects: {
        filesystem: 'none' as const,
        network: 'write' as const,
        externalState: 'write' as const,
      },
      policy: { workspaceTrustRequired: false, minimumApproval: 'user' as const },
      execution: { retry: 'idempotency_key' as const, idempotencyKeyArgument: 'idempotency_key' },
      availability: 'available' as const,
      diagnostics: [],
    });
    const binding = issueMcpBinding(state, descriptor, 'mcp__fixture__write');
    state.tools.calls.mcp = {
      toolCallId: 'mcp',
      modelMessageId: 'model',
      name: 'mcp__fixture__write',
      args: { id: 'secret-argument' },
      status: 'approved',
      approvalGrant: 'approve_once',
      bindingId: binding.bindingId,
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.active.push('mcp');
    const manager = new McpConnectionManager();
    const runtimeManager = manager as McpConnectionManager & {
      ensureProviderReady(): Promise<void>;
    };
    runtimeManager.ensureProviderReady = async () => {};
    manager.findCapability = (capabilityId) =>
      capabilityId === descriptor.capabilityId ? descriptor : undefined;
    manager.getCapabilityRoute = () => ({
      transport: 'stdio',
      serverIdentity: descriptor.provider.id,
      endpointRevision: 'stdio-v1',
      toolRevision: descriptor.revision,
    });
    let providerDispatches = 0;
    manager.callCapability = async ({ arguments: args }) => {
      providerDispatches += 1;
      return {
        content: [
          { type: 'resource_link', uri: 'resource://fixture/secret-argument', name: 'fixture' },
        ],
        structuredContent: { ok: true },
        ...(typeof args.idempotency_key === 'string' ? {} : { isError: true }),
      } as never;
    };
    const config: AgentConfig = {
      apiKey: '',
      baseURL: 'http://localhost',
      modelName: 'test',
      providerName: 'test',
      providerType: 'openai-compatible',
      sandbox: { enabled: false },
      features: {
        capabilityCatalogV1: true,
        mcpRuntimeBindingV1: true,
        mcpExecutionRecordV1: true,
        verificationV1: true,
      },
    };

    const artifactStore = new CapabilityArtifactStore();
    artifactStore.write = () => ({
      artifactId: `pa_${'a'.repeat(64)}`,
      kind: 'capability_result',
      integrityIdentifier: `hmac-sha256:${'b'.repeat(64)}`,
      byteLength: 42,
    });
    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['mcp'],
      mcpManager: runtimeManager,
      taskConfig: config,
      capabilityArtifactStore: artifactStore,
    });

    const recorded = events.find((event) => event.type === 'capability.invocation_recorded');
    expect(recorded).toMatchObject({
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
    });
    expect(JSON.stringify(recorded)).not.toContain('secret-argument');
    expect(events.find((event) => event.type === 'capability.execution_succeeded')).toMatchObject({
      artifact: { kind: 'capability_result' },
    });
    const verification = events.find((event) => event.type === 'verification.requested');
    expect(verification).toMatchObject({ mode: 'required' });
    expect(JSON.stringify(verification)).not.toContain('secret-argument');
    expect(events.map((event) => event.type)).toEqual([
      'provider.readiness_intent_recorded',
      'provider.readiness_waiter_registered',
      'provider.readiness_attempt_started',
      'provider.readiness_succeeded',
      'tool.started',
      'capability.invocation_recorded',
      'capability.execution_started',
      'capability.execution_succeeded',
      'verification.requested',
      'tool.finished',
    ]);

    const flagOffEvents = await executeRuntimeTools({
      state,
      toolCallIds: ['mcp'],
      mcpManager: manager,
      taskConfig: {
        ...config,
        features: { ...config.features, verificationV1: false },
      },
      capabilityArtifactStore: artifactStore,
    });
    expect(flagOffEvents.some((event) => event.type === 'verification.requested')).toBe(false);

    const dispatchesBeforeReceiptFailure = providerDispatches;
    const receiptFailureEvents = await executeRuntimeTools({
      state,
      toolCallIds: ['mcp'],
      mcpManager: manager,
      taskConfig: config,
      capabilityArtifactStore: {
        write: () => {
          throw new Error('fixture artifact failure');
        },
      },
    });
    expect(providerDispatches).toBe(dispatchesBeforeReceiptFailure + 1);
    expect(receiptFailureEvents.some((event) => event.type === 'tool.finished')).toBe(false);
    expect(receiptFailureEvents.some((event) => event.type === 'verification.requested')).toBe(
      false,
    );
    expect(receiptFailureEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'capability.execution_unknown' }),
        expect.objectContaining({
          type: 'tool.failed',
          failure: expect.objectContaining({ kind: 'persistence_unavailable' }),
        }),
      ]),
    );
  });

  test('derives the internal summary question from the first canonical item', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-batch-ask',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.ask = {
      toolCallId: 'ask',
      modelMessageId: 'model',
      name: 'ask_user',
      args: {
        questions: [
          {
            question: 'What scope should be covered?',
            options: [
              {
                label: 'Focused',
                description: 'Cover only the critical path.',
                recommended: true,
              },
              {
                label: 'Complete',
                description: 'Cover the full production rollout.',
                recommended: false,
              },
            ],
          },
        ],
      },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('ask');

    const events = await executeRuntimeTools({ state, toolCallIds: ['ask'] });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'user_input.requested',
        request: expect.objectContaining({ question: 'What scope should be covered?' }),
      }),
    ]);
  });

  test('converts delegated lifecycle facts to the public RuntimeEvent protocol', () => {
    expect(
      toRuntimeSubagentEvent({
        type: 'start',
        data: { id: 'sub-1', role: 'explore', task: 'find callers' },
      }),
    ).toEqual({
      type: 'subagent.started',
      subagent: { id: 'sub-1', role: 'explore', task: 'find callers' },
    });
  });

  test('emits a rejection without executing a policy-denied tool', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-tool-policy',
      userId: 'user',
      workspace: process.cwd(),
    });
    setTestPlanning(state, { kind: 'planning_empty' });
    state.tools.calls.denied = {
      toolCallId: 'denied',
      modelMessageId: 'model',
      name: 'shell_execute',
      args: { command: 'bun run typecheck' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('denied');
    let executed = false;

    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['denied'],
      shellExecutor: async () => {
        executed = true;
        return { ok: true, command: '', exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(executed).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.rejected',
        toolCallId: 'denied',
        reason: 'Deferred shell_execute until building phase.',
        failure: expect.objectContaining({ kind: 'phase_deferred' }),
      }),
    ]);
  });

  test('keeps planning write calls as hard policy denials', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-write-policy',
      userId: 'user',
      workspace: process.cwd(),
    });
    setTestPlanning(state, { kind: 'planning_empty' });
    state.tools.calls.denied = {
      toolCallId: 'denied',
      modelMessageId: 'model',
      name: 'write_file',
      args: { path: 'blocked.txt', content: 'blocked' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('denied');

    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['denied'],
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.rejected',
        toolCallId: 'denied',
        reason:
          'Plan mode is read-only. No file was written. Describe the intended change in the plan and apply it after plan approval.',
        failure: expect.objectContaining({ kind: 'phase_denied' }),
      }),
    ]);
  });

  test('finishes write_plan once and returns the persisted plan identity', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-plan-artifact-'));
    const previousKiteCodeHome = process.env.KITE_CODE_HOME;
    process.env.KITE_CODE_HOME = workspace;
    try {
      let state = startCurrentTask(
        createInitialRuntimeState({
          threadId: 'runtime-plan-write',
          userId: 'user',
          workspace,
        }),
        'plan-write-task',
      );
      state = reduceRuntimeState(state, {
        type: 'planning.entered',
        taskId: 'plan-write-task',
        source: 'user_command',
      });
      state.tools.calls.write = {
        toolCallId: 'write',
        modelMessageId: 'model',
        name: 'write_plan',
        args: {
          title: 'Inspect runtime',
          body_markdown: 'Inspect the runtime lifecycle and verify every transition.',
          steps: [{ id: 'inspect-runtime', title: 'Inspect runtime lifecycle' }],
        },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push('write');

      const events = await executeRuntimeTools({ state, toolCallIds: ['write'] });

      const finished = events.find((event) => event.type === 'tool.finished');
      expect(finished).toBeDefined();
      if (finished?.type === 'tool.finished') {
        expect(finished.name).toBe('write_plan');
        expect(finished.result.status).toBe('success');
        expect(JSON.parse(finished.result.stdout)).toMatchObject({
          ok: true,
          status: 'draft_saved',
          version: 1,
        });
      }
    } finally {
      if (previousKiteCodeHome == null) delete process.env.KITE_CODE_HOME;
      else process.env.KITE_CODE_HOME = previousKiteCodeHome;
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('update_plan requires exact V2 plan identity and rejects repeated updates', async () => {
    const missing = await executeUpdatePlan(v2ExecutingPlanState(), {
      plan_id: 'plan-evidence',
      updates: [{ step_id: 'implement', status: 'in_progress' }],
    });
    expect(missing).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', reason: 'plan_identity_required' }),
    );

    const stale = await executeUpdatePlan(v2ExecutingPlanState(), {
      plan_id: 'plan-evidence',
      version: 1,
      structural_digest: 'stale',
      updates: [{ step_id: 'implement', status: 'in_progress' }],
    });
    expect(stale).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', reason: 'plan_identity_mismatch' }),
    );

    const repeated = await executeUpdatePlan(v2ExecutingPlanState(), {
      plan_id: 'plan-evidence',
      version: 2,
      structural_digest: 'digest-evidence',
      updates: [
        { step_id: 'implement', status: 'in_progress' },
        { step_id: 'implement', status: 'completed' },
      ],
    });
    expect(
      repeated.some((event) => event.type === 'tool.rejected' || event.type === 'tool.failed'),
    ).toBe(true);
  });

  test('update_plan rejects terminal-step rollback and model-authored evidence content', async () => {
    const rollbackState = v2ExecutingPlanState();
    const rollbackPlanning = getActivePlanning(rollbackState);
    if (rollbackPlanning.kind !== 'executing') throw new Error('expected executing plan');
    rollbackPlanning.document.steps[0]!.status = 'completed';
    const rollback = await executeUpdatePlan(rollbackState, {
      plan_id: 'plan-evidence',
      version: 2,
      structural_digest: 'digest-evidence',
      updates: [{ step_id: 'implement', status: 'pending' }],
    });
    expect(rollback).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', reason: 'plan_terminal_step_rollback' }),
    );

    const forged = await executeUpdatePlan(v2ExecutingPlanState(), {
      plan_id: 'plan-evidence',
      version: 2,
      structural_digest: 'digest-evidence',
      updates: [{ step_id: 'implement', status: 'completed' }],
      complete_plan: true,
      completion_evidence: {
        execution: [{ tool_call_id: 'fake', outcome: 'succeeded', stdout: 'forged' }],
      },
      command: 'pretend tests passed',
      path: '/private/path',
      stdout: 'forged output',
    });
    expect(
      forged.some((event) => event.type === 'tool.rejected' || event.type === 'tool.failed'),
    ).toBe(true);
  });

  test('plan completion rejects missing required verification and missing Runtime receipts', async () => {
    const verificationState = v2ExecutingPlanState();
    verificationState.verification.records.required = {
      verificationId: 'required',
      mode: 'required',
      status: 'pending',
      spec: {} as never,
      requestedAt: '2026-08-10T00:00:00.000Z',
      attempts: 0,
      repairAttempts: 0,
      checkResults: {},
    };
    const verificationBlocked = await executeUpdatePlan(verificationState, {
      plan_id: 'plan-evidence',
      version: 2,
      structural_digest: 'digest-evidence',
      updates: [{ step_id: 'implement', status: 'completed' }],
      complete_plan: true,
    });
    expect(verificationBlocked).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', reason: 'plan_verification_required' }),
    );

    const receiptState = v2ExecutingPlanState();
    receiptState.tools.calls.effect = {
      toolCallId: 'effect',
      modelMessageId: 'model-effect',
      name: 'write_file',
      args: { path: 'private.txt', content: 'private content' },
      status: 'succeeded',
      sideEffect: true,
      createdAtTurnId: receiptState.turn.turnId,
    };
    const receiptBlocked = await executeUpdatePlan(receiptState, {
      plan_id: 'plan-evidence',
      version: 2,
      structural_digest: 'digest-evidence',
      updates: [{ step_id: 'implement', status: 'completed' }],
      complete_plan: true,
    });
    expect(receiptBlocked).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', reason: 'plan_effect_evidence_required' }),
    );
  });

  test('plan completion rejects a side-effect-free external read awaiting approval', async () => {
    const state = v2ExecutingPlanState();
    state.tools.calls['external-read'] = {
      toolCallId: 'external-read',
      modelMessageId: 'external-read-model',
      name: 'read_file',
      args: { path: '/outside/workspace.txt' },
      status: 'awaiting_approval',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('external-read');
    state.interactions = {
      kind: 'awaiting_tool_approval',
      interactionId: 'external-read-approval',
      toolCallId: 'external-read',
      approval: {} as never,
    };

    const events = await executeUpdatePlan(state, {
      plan_id: 'plan-evidence',
      version: 2,
      structural_digest: 'digest-evidence',
      updates: [{ step_id: 'implement', status: 'completed' }],
      complete_plan: true,
    });

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', reason: 'plan_unresolved_blocker' }),
    );
    expect(events.some((event) => event.type === 'plan.completed')).toBe(false);
  });

  test('plan completion rejects an all-skipped plan', async () => {
    const events = await executeUpdatePlan(v2ExecutingPlanState(), {
      plan_id: 'plan-evidence',
      version: 2,
      structural_digest: 'digest-evidence',
      updates: [{ step_id: 'implement', status: 'skipped', reason_code: 'not_needed' }],
      complete_plan: true,
    });

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', reason: 'plan_all_steps_skipped' }),
    );
    expect(events.some((event) => event.type === 'plan.completed')).toBe(false);
  });

  test('projects only Runtime receipt and verification metadata into V2 completion evidence', async () => {
    const state = v2ExecutingPlanState();
    state.tools.calls.effect = {
      toolCallId: 'effect',
      modelMessageId: 'model-effect',
      name: 'write_file',
      args: { path: 'private.txt', content: 'private content' },
      status: 'succeeded',
      sideEffect: true,
      result: { ok: true, summary: 'private command and output' },
      createdAtTurnId: state.turn.turnId,
    };
    state.verification.records.required = {
      verificationId: 'required',
      mode: 'required',
      status: 'passed',
      spec: {} as never,
      requestedAt: '2026-08-10T00:00:00.000Z',
      attempts: 1,
      repairAttempts: 0,
      checkResults: {},
      completedAt: '2026-08-10T00:01:00.000Z',
    };
    const events = await executeUpdatePlan(state, {
      plan_id: 'plan-evidence',
      version: 2,
      structural_digest: 'digest-evidence',
      updates: [{ step_id: 'implement', status: 'completed' }],
      complete_plan: true,
    });
    const completed = events.find((event) => event.type === 'plan.completed');

    expect(completed).toMatchObject({
      type: 'plan.completed',
      planId: 'plan-evidence',
      version: 2,
      structuralDigest: 'digest-evidence',
      completionEvidence: {
        schemaVersion: 1,
        verification: [{ verificationId: 'required', outcome: 'passed' }],
        execution: [{ toolCallId: 'effect', outcome: 'succeeded' }],
        skipped: [],
        unresolved: [],
      },
    });
    expect(JSON.stringify(completed)).not.toContain('private');
  });

  test('cancels later sibling calls when write_plan action=submit opens review', async () => {
    const artifactHome = mkdtempSync(join(tmpdir(), 'openpx-plan-barrier-'));
    const previousKiteCodeHome = process.env.KITE_CODE_HOME;
    process.env.KITE_CODE_HOME = artifactHome;
    try {
      let state = startCurrentTask(
        createInitialRuntimeState({
          threadId: 'runtime-plan-barrier',
          userId: 'user',
          workspace: process.cwd(),
        }),
        'plan-barrier-task',
      );
      state = reduceRuntimeState(state, {
        type: 'planning.entered',
        taskId: 'plan-barrier-task',
        source: 'user_command',
      });
      state.tools.calls.save = {
        toolCallId: 'save',
        modelMessageId: 'message-0',
        ordinal: 0,
        name: 'write_plan',
        args: {
          title: 'Inspect',
          body_markdown: 'Inspect runtime state transitions in detail.',
          steps: [{ id: 'inspect', title: 'Inspect runtime' }],
          action: 'save',
        },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push('save');
      const saveEvents = await executeRuntimeTools({ state, toolCallIds: ['save'] });
      for (const event of saveEvents) state = reduceCurrentEvent(state, event);
      const saved = getActivePlanning(state);
      if (saved.kind !== 'planning_draft') throw new Error('saved plan missing');
      state.tools.calls.submit = {
        toolCallId: 'submit',
        modelMessageId: 'message-1',
        ordinal: 0,
        name: 'write_plan',
        args: {
          plan_id: saved.document.planId,
          version: saved.document.version,
          structural_digest: saved.document.structuralDigest,
          action: 'submit',
        },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.calls.write = {
        toolCallId: 'write',
        modelMessageId: 'message-1',
        ordinal: 1,
        name: 'write_file',
        args: { path: 'unsafe.txt', content: 'unsafe' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push('submit', 'write');

      const events = await executeRuntimeTools({ state, toolCallIds: ['submit'] });

      expect(events).toContainEqual({
        type: 'tool.cancelled',
        toolCallId: 'write',
        reason: 'Cancelled because an earlier tool call opened an interaction.',
      });
    } finally {
      if (previousKiteCodeHome == null) delete process.env.KITE_CODE_HOME;
      else process.env.KITE_CODE_HOME = previousKiteCodeHome;
      rmSync(artifactHome, { recursive: true, force: true });
    }
  });

  test('write_file in accept_edits mode bypasses approval and executes directly', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-accept-edits-write-'));
    try {
      const state = createInitialRuntimeState({
        threadId: 'runtime-accept-edits',
        userId: 'user',
        workspace,
      });
      state.mode = 'accept_edits';
      setTestPlanning(state, {
        kind: 'executing',
        document: {
          planSchemaVersion: 2,
          planId: 'plan-approved',
          version: 1,
          title: 'Test',
          bodyMarkdown: 'Test plan.',
          steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
          structuralDigest: 'abc',
          createdAtTurnId: state.turn.turnId,
          updatedAtTurnId: state.turn.turnId,
          completionEvidence: {
            schemaVersion: 1,
            verification: [],
            execution: [],
            skipped: [],
            unresolved: [],
          },
        },
        executionMode: 'accept_edits',
        approvedAtTurnId: state.turn.turnId,
      });
      state.tools.calls.wf = {
        toolCallId: 'wf',
        modelMessageId: 'model',
        ordinal: 0,
        name: 'write_file',
        args: { path: 'test.txt', content: 'hello' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push('wf');

      const events = await executeRuntimeTools({
        state,
        toolCallIds: ['wf'],
        shellExecutor: {
          execute: async (_command: string, _opts?: Record<string, unknown>) => {
            return {
              ok: true,
              command: 'write_file test.txt',
              exitCode: 0,
              stdout: '',
              stderr: '',
            };
          },
        } as never,
      });

      // Should NOT be rejected — accept_edits mode allows file edits without approval
      const rejected = events.find((e) => e.type === 'tool.rejected');
      expect(rejected).toBeUndefined();

      // Should complete successfully
      const finished = events.find((e) => e.type === 'tool.finished');
      expect(finished).toBeDefined();
      if (finished?.type === 'tool.finished') {
        expect(finished.result.ok).toBe(true);
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('edit_file in accept_edits mode bypasses approval and executes directly', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-accept-edits-edit-'));
    try {
      writeFileSync(join(workspace, 'test.txt'), 'old');
      const state = createInitialRuntimeState({
        threadId: 'runtime-accept-edits-edit',
        userId: 'user',
        workspace,
      });
      state.mode = 'accept_edits';
      setTestPlanning(state, {
        kind: 'executing',
        document: {
          planSchemaVersion: 2,
          planId: 'plan-approved',
          version: 1,
          title: 'Test',
          bodyMarkdown: 'Test plan.',
          steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
          structuralDigest: 'abc',
          createdAtTurnId: state.turn.turnId,
          updatedAtTurnId: state.turn.turnId,
          completionEvidence: {
            schemaVersion: 1,
            verification: [],
            execution: [],
            skipped: [],
            unresolved: [],
          },
        },
        executionMode: 'accept_edits',
        approvedAtTurnId: state.turn.turnId,
      });
      // ADR-0042 §1：先读取目标文件，使后续 edit_file 通过先读后改校验。
      state.tools.calls.rf = {
        toolCallId: 'rf',
        modelMessageId: 'model',
        ordinal: 0,
        name: 'read_file',
        args: { path: 'test.txt' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push('rf');
      await executeRuntimeTools({
        state,
        toolCallIds: ['rf'],
        shellExecutor: {
          execute: async (_command: string, _opts?: Record<string, unknown>) => {
            return { ok: true, command: 'read_file test.txt', exitCode: 0, stdout: '', stderr: '' };
          },
        } as never,
      });

      state.tools.calls.ef = {
        toolCallId: 'ef',
        modelMessageId: 'model',
        ordinal: 0,
        name: 'edit_file',
        args: { path: 'test.txt', old_string: 'old', new_string: 'new' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push('ef');

      const events = await executeRuntimeTools({
        state,
        toolCallIds: ['ef'],
        shellExecutor: {
          execute: async (_command: string, _opts?: Record<string, unknown>) => {
            return { ok: true, command: 'edit_file test.txt', exitCode: 0, stdout: '', stderr: '' };
          },
        } as never,
      });

      // edit_file should NOT be rejected by defense-in-depth — accept_edits mode bypasses approval
      const rejected = events.find((e) => e.type === 'tool.rejected');
      expect(rejected).toBeUndefined();

      // Tool should have been started (not blocked at defense-in-depth)
      const started = events.find((e) => e.type === 'tool.started');
      expect(started).toBeDefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('shell_execute in accept_edits mode still requires approval', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-accept-edits-shell',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'accept_edits';
    setTestPlanning(state, {
      kind: 'executing',
      document: {
        planSchemaVersion: 2,
        planId: 'plan-approved',
        version: 1,
        title: 'Test',
        bodyMarkdown: 'Test plan.',
        steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
        completionEvidence: {
          schemaVersion: 1,
          verification: [],
          execution: [],
          skipped: [],
          unresolved: [],
        },
      },
      executionMode: 'accept_edits',
      approvedAtTurnId: state.turn.turnId,
    });
    state.tools.calls.sh = {
      toolCallId: 'sh',
      modelMessageId: 'model',
      ordinal: 0,
      name: 'shell_execute',
      args: { command: 'npm test' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('sh');

    const events = await executeRuntimeTools({ state, toolCallIds: ['sh'] });

    // shell_execute is NOT a file edit — should create an approval interaction
    const approvalRequested = events.find((e) => e.type === 'approval.requested');
    expect(approvalRequested).toBeDefined();

    // Should NOT have executed directly
    const finished = events.find((e) => e.type === 'tool.finished');
    expect(finished).toBeUndefined();
  });

  test('full_access authorization skips approval for later shell calls', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-full-access-follow-up',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.authorization.mode = 'full_access';
    state.tools.calls.followUp = {
      toolCallId: 'followUp',
      modelMessageId: 'model',
      name: 'shell_execute',
      args: { command: 'node -e "console.log(84)"' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('followUp');

    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['followUp'],
      shellExecutor: {
        execute: async () => ({
          ok: true,
          command: 'node -e "console.log(84)"',
          exitCode: 0,
          stdout: '84\n',
          stderr: '',
        }),
      } as never,
    });

    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
    expect(events.some((event) => event.type === 'tool.finished')).toBe(true);
  });

  test('starts an allowed shell without waiting for sibling preflight', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-parallel-shell-preflight',
      userId: 'user',
      workspace: process.cwd(),
    });
    for (const [ordinal, toolCallId] of ['first', 'second'].entries()) {
      state.tools.calls[toolCallId] = {
        toolCallId,
        modelMessageId: 'parallel-shell-model',
        ordinal,
        name: 'shell_execute',
        args: { command: ordinal === 0 ? 'pwd' : 'ls -la' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push(toolCallId);
    }
    let executionCount = 0;

    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['first'],
      shellExecutor: async () => {
        executionCount += 1;
        return { ok: true, command: 'pwd', exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(executionCount).toBe(1);
    expect(events.some((event) => event.type === 'tool.started')).toBe(true);
    expect(events.some((event) => event.type === 'tool.finished')).toBe(true);
  });

  test('does not preflight shell calls across a non-shell sibling', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-shell-interaction-barrier',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.authorization.mode = 'full_access';
    const modelMessageId = 'mixed-tool-model';
    state.tools.queue.push('shell-before', 'question', 'shell-after');
    state.tools.calls['shell-before'] = {
      toolCallId: 'shell-before',
      modelMessageId,
      ordinal: 0,
      name: 'shell_execute',
      args: { command: 'pwd' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls.question = {
      toolCallId: 'question',
      modelMessageId,
      ordinal: 1,
      name: 'ask_user',
      args: { question: 'Continue?' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls['shell-after'] = {
      toolCallId: 'shell-after',
      modelMessageId,
      ordinal: 2,
      name: 'shell_execute',
      args: { command: 'git status' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    let executionCount = 0;

    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['shell-before'],
      shellExecutor: async ({ command }) => {
        executionCount += 1;
        return { ok: true, command, exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(executionCount).toBe(1);
    expect(events.some((event) => event.type === 'tool.finished')).toBe(true);
  });

  test('starts every approved shell sibling concurrently', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-parallel-shell-execution',
      userId: 'user',
      workspace: process.cwd(),
    });
    for (const [ordinal, toolCallId] of ['first', 'second'].entries()) {
      state.tools.calls[toolCallId] = {
        toolCallId,
        modelMessageId: 'parallel-shell-model',
        ordinal,
        name: 'shell_execute',
        args: { command: `node task-${ordinal + 1}.js` },
        status: 'approved',
        approvalGrant: 'approve_once',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push(toolCallId);
    }
    let running = 0;
    let maximumRunning = 0;

    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['first', 'second'],
      shellExecutor: async ({ command }) => {
        running += 1;
        maximumRunning = Math.max(maximumRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        return { ok: true, command, exitCode: 0, stdout: command, stderr: '' };
      },
    });

    expect(maximumRunning).toBe(2);
    expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'tool.finished')).toHaveLength(2);
  });

  test('streams shell lifecycle and progress events while the command is running', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-shell-stream',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.authorization.mode = 'full_access';
    state.tools.calls.stream = {
      toolCallId: 'stream',
      modelMessageId: 'model',
      name: 'shell_execute',
      args: { command: 'bun --version' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('stream');

    const streamed: RuntimeEvent[] = [];
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let observeProgress!: () => void;
    const progressObserved = new Promise<void>((resolve) => {
      observeProgress = resolve;
    });
    const execution = executeRuntimeTools({
      state,
      toolCallIds: ['stream'],
      shellExecutor: async (input) => {
        input.onProgress?.('live output', 'stdout');
        await executionGate;
        return {
          ok: true,
          command: input.command,
          exitCode: 0,
          stdout: 'live output\n',
          stderr: '',
        };
      },
      emitRuntimeEvent: (event) => {
        streamed.push(event);
        if (event.type === 'tool.progress') observeProgress();
      },
    });

    const progressArrivedWhileRunning = await Promise.race([
      progressObserved.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    const eventTypesWhileRunning = streamed.map((event) => event.type);
    releaseExecution();
    const returned = await execution;

    expect(progressArrivedWhileRunning).toBe(true);
    expect(eventTypesWhileRunning).toEqual(['tool.started', 'tool.progress']);
    expect(returned).toEqual([]);
    expect(streamed.map((event) => event.type)).toEqual([
      'tool.started',
      'tool.progress',
      'capability.execution_succeeded',
      'tool.finished',
    ]);
  });

  test('does not retain high-volume shell progress in the returned event array', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-shell-high-volume-stream',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.authorization.mode = 'full_access';
    state.tools.calls.stream = {
      toolCallId: 'stream',
      modelMessageId: 'model',
      name: 'shell_execute',
      args: { command: 'high-volume-output' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('stream');
    let progressEvents = 0;

    const returned = await executeRuntimeTools({
      state,
      toolCallIds: ['stream'],
      shellExecutor: async (input) => {
        for (let index = 0; index < 10_000; index += 1) {
          input.onProgress?.(`line-${index}`, 'stdout');
        }
        return {
          ok: true,
          command: input.command,
          exitCode: 0,
          stdout: 'bounded terminal result',
          stderr: '',
        };
      },
      emitRuntimeEvent: (event) => {
        if (event.type === 'tool.progress') progressEvents += 1;
      },
    });

    expect(progressEvents).toBe(10_000);
    expect(returned).toEqual([]);
  });

  test('requires approval for a network read in accept_edits mode', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-accept-edits-network',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'accept_edits';
    state.tools.calls.fetch = {
      toolCallId: 'fetch',
      modelMessageId: 'model',
      ordinal: 0,
      name: 'web_fetch',
      args: { url: 'https://example.com' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('fetch');

    const events = await executeRuntimeTools({ state, toolCallIds: ['fetch'] });

    expect(events.some((event) => event.type === 'approval.requested')).toBe(true);
    expect(events.some((event) => event.type === 'tool.started')).toBe(false);
  });

  test('auto-reviews a network read before execution in auto mode', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-auto-network',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'auto';
    state.tools.calls.fetch = {
      toolCallId: 'fetch',
      modelMessageId: 'model',
      ordinal: 0,
      name: 'web_fetch',
      args: { url: 'https://example.com' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('fetch');

    const events = await executeRuntimeTools({ state, toolCallIds: ['fetch'] });

    expect(events.some((event) => event.type === 'auto_review.requested')).toBe(true);
    expect(events.some((event) => event.type === 'tool.started')).toBe(false);
  });

  test('runs a proven workspace-only shell write directly in accept_edits mode', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-accept-edits-shell-write',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'accept_edits';
    setTestPlanning(state, {
      kind: 'executing',
      document: {
        planSchemaVersion: 2,
        planId: 'plan-approved',
        version: 1,
        title: 'Test',
        bodyMarkdown: 'Test plan.',
        steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
        completionEvidence: {
          schemaVersion: 1,
          verification: [],
          execution: [],
          skipped: [],
          unresolved: [],
        },
      },
      executionMode: 'accept_edits',
      approvedAtTurnId: state.turn.turnId,
    });
    state.tools.calls.shell = {
      toolCallId: 'shell',
      modelMessageId: 'model',
      ordinal: 0,
      name: 'shell_execute',
      args: { command: 'touch policy-proof.txt' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('shell');

    let executed = false;
    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['shell'],
      shellExecutor: async (input) => {
        executed = true;
        return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
    expect(executed).toBe(true);
    expect(events.some((event) => event.type === 'tool.finished')).toBe(true);
  });

  test('requires approval for a Git mutation in accept_edits mode', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-accept-edits-local-git',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'accept_edits';
    setTestPlanning(state, {
      kind: 'executing',
      document: {
        planSchemaVersion: 2,
        planId: 'plan-approved',
        version: 1,
        title: 'Test',
        bodyMarkdown: 'Test plan.',
        steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
        completionEvidence: {
          schemaVersion: 1,
          verification: [],
          execution: [],
          skipped: [],
          unresolved: [],
        },
      },
      executionMode: 'accept_edits',
      approvedAtTurnId: state.turn.turnId,
    });
    state.tools.calls.git = {
      toolCallId: 'git',
      modelMessageId: 'model',
      ordinal: 0,
      name: 'shell_execute',
      args: { command: 'git add policy-proof.txt' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('git');

    let executed = false;
    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['git'],
      shellExecutor: async (input) => {
        executed = true;
        return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(events.some((event) => event.type === 'approval.requested')).toBe(true);
    expect(executed).toBe(false);
  });

  test('write_file in auto mode inherits accept_edits direct execution', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-auto-write-'));
    const state = createInitialRuntimeState({
      threadId: 'runtime-auto-write',
      userId: 'user',
      workspace,
    });
    state.mode = 'auto';
    setTestPlanning(state, {
      kind: 'executing',
      document: {
        planSchemaVersion: 2,
        planId: 'plan-auto',
        version: 1,
        title: 'Auto',
        bodyMarkdown: 'Auto plan.',
        steps: [{ id: 's1', title: 'Step', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
        completionEvidence: {
          schemaVersion: 1,
          verification: [],
          execution: [],
          skipped: [],
          unresolved: [],
        },
      },
      executionMode: 'auto',
      approvedAtTurnId: state.turn.turnId,
    });
    state.tools.calls.wf = {
      toolCallId: 'wf',
      modelMessageId: 'model',
      ordinal: 0,
      name: 'write_file',
      args: { path: 'test.txt', content: 'hello' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('wf');

    try {
      const events = await executeRuntimeTools({ state, toolCallIds: ['wf'] });

      expect(events.some((event) => event.type === 'auto_review.requested')).toBe(false);
      expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
      expect(events.some((event) => event.type === 'tool.finished')).toBe(true);
      expect(readFileSync(join(workspace, 'test.txt'), 'utf8')).toBe('hello');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('classifies an unregistered tool as tool_not_found through the full pipeline', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-e2e-unknown-tool',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.unknown = {
      toolCallId: 'unknown',
      modelMessageId: 'model',
      name: 'nonexistent_tool_xyz',
      args: { foo: 'bar' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('unknown');

    const events = await executeRuntimeTools({ state, toolCallIds: ['unknown'] });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.failed',
        toolCallId: 'unknown',
        failure: expect.objectContaining({
          kind: 'tool_not_found',
          message: expect.stringContaining('nonexistent_tool_xyz'),
        }),
      }),
    ]);
  });

  test('propagates parseFailureCode through InvalidToolRequest to ClassifiedFailure', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-e2e-invalid-args-code',
      userId: 'user',
      workspace: process.cwd(),
    });
    // write_file has required 'path' and 'content' fields; empty args triggers
    // schema validation failure which flows:
    // Registry.parseToolCall(invalid_arguments) → toolRequestFromCall → InvalidToolRequest
    // → Controller classifyFailure('tool_invalid_args', ..., 'invalid_arguments')
    state.tools.calls.wf = {
      toolCallId: 'wf',
      modelMessageId: 'model',
      name: 'write_file',
      args: {},
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('wf');

    const events = await executeRuntimeTools({ state, toolCallIds: ['wf'] });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.failed',
        toolCallId: 'wf',
        failure: expect.objectContaining({
          kind: 'tool_invalid_args',
          parseFailureCode: 'invalid_arguments',
        }),
      }),
    ]);
  });
});

describe('buildBlockedToolRequest', () => {
  const availCtx = toolAvailabilityContext({ workspace: '/tmp/test' });

  test('returns a proper PendingBuiltinToolRequest for a registered builtin tool', () => {
    const blocked = {
      toolCallId: 'tc-1',
      toolName: 'read_file',
      args: { path: 'src/index.ts' },
      command: 'read_file src/index.ts',
    };
    const request = buildBlockedToolRequest(blocked, availCtx);
    expect(request.source).toBe('builtin');
    expect(request.name).toBe('read_file');
    expect(request.id).toBe('tc-1');
    expect(request.args).toEqual({ path: 'src/index.ts' });
    expect(request.protectedCommand).toBe('read_file src/index.ts');
  });

  test('returns a PendingMcpToolRequest for an MCP tool name in the fallback path', () => {
    const blocked = {
      toolCallId: 'tc-2',
      toolName: 'mcp__github__read',
      args: { query: 'test' },
      command: 'mcp__github__read',
    };
    const request = buildBlockedToolRequest(blocked, availCtx);
    expect(request.source).toBe('mcp');
    expect(request.name).toBe('mcp__github__read');
    expect(request.id).toBe('tc-2');
    expect(request.args).toEqual({ query: 'test' });
  });

  test('returns a fallback PendingBuiltinToolRequest for an unknown tool name', () => {
    const blocked = {
      toolCallId: 'tc-3',
      toolName: 'nonexistent_tool',
      args: { foo: 'bar' },
      command: 'nonexistent_tool',
    };
    const request = buildBlockedToolRequest(blocked, availCtx);
    expect(request.source).toBe('builtin');
    expect(request.name as string).toBe('nonexistent_tool');
    expect(request.args).toEqual({ foo: 'bar' });
    expect(request.reason).toContain('blocked for approval');
  });
});

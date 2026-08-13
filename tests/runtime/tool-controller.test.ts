import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '@/core/config/index';
import {
  blockedSubagentReviewEvent,
  buildBlockedToolRequest,
  executeRuntimeTools,
  serializeConcurrentSubagentApprovalEvents,
  toRuntimeSubagentEvent,
} from '@/core/controllers/tool-controller';
import { exposedMcpToolName } from '@/core/mcp';
import { McpConnectionManager } from '@/core/mcp/manager';
import { aiMessage } from '@/core/messages';
import { CapabilityArtifactStore } from '@/core/persistence/capability-artifacts';
import type { RuntimeEvent } from '@/core/runtime/events';
import { createRuntimeEffectExecutor } from '@/core/runtime/executor';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { createToolRecoveryJournalV1 } from '@/core/runtime/tool-recovery-journal';
import { serializeSubagentContinuation } from '@/core/subagent/continuation-codec';
import { getRoleConfig } from '@/core/subagent/roles';
import { toolAvailabilityContext } from '@/core/tools/definitions';
import { createMockModel } from '../mock-model';

function v2ExecutingPlanState() {
  const state = createInitialRuntimeState({
    threadId: 'runtime-plan-evidence',
    userId: 'user',
    workspace: process.cwd(),
  });
  state.planning = {
    kind: 'executing',
    document: {
      planSchemaVersion: 2,
      planId: 'plan-evidence',
      version: 2,
      title: 'Evidence-backed execution plan',
      bodyMarkdown: 'Execute the approved change and verify its observable behavior.',
      steps: [{ id: 'implement', title: 'Implement the approved change', status: 'pending' }],
      structuralDigest: 'digest-evidence',
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
  };
  return state;
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
    const emitted: RuntimeEvent[] = [];
    const executor = createRuntimeEffectExecutor({ config, model });

    const terminal = await executor(
      { type: 'run_tools', toolCallIds: ['task-a', 'task-b'] },
      state,
      (event) => emitted.push(event),
    );

    expect(Array.isArray(terminal)).toBe(true);
    if (!Array.isArray(terminal)) throw new Error('Expected terminal RuntimeEvents.');
    expect(model.callCount.count).toBe(2);
    expect(emitted.filter((event) => event.type === 'subagent.started')).toHaveLength(2);
    expect(emitted.some((event) => event.type === 'approval.requested')).toBe(false);
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

  test('rejects direct tool execution while a legacy V1 plan is executing', async () => {
    const state = createInitialRuntimeState({
      threadId: 'legacy-plan-direct-tool',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.planning = {
      kind: 'executing',
      document: {
        planId: 'legacy-plan',
        version: 1,
        title: 'Legacy Plan',
        bodyMarkdown: 'A legacy plan restored from a V1 snapshot.',
        steps: [{ id: 'legacy-step', title: 'Legacy step', status: 'pending' }],
        structuralDigest: 'legacy-digest',
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
      },
      executionMode: 'auto',
      approvedAtTurnId: state.turn.turnId,
    };
    state.tools.calls.shell = {
      toolCallId: 'shell',
      modelMessageId: 'legacy-model',
      name: 'shell_execute',
      args: { command: 'pwd' },
      status: 'queued',
      effectClass: 'read_only',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('shell');
    let dispatched = false;

    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['shell'],
      shellExecutor: async () => {
        dispatched = true;
        return { ok: true, command: 'pwd', exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(dispatched).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.rejected',
        reason: expect.stringContaining('legacy_plan_replan_required'),
      }),
    );
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
          toolCallId: 'child-shell',
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

      expect(order).toEqual([
        'reserve-tool',
        'tool-dispatch',
        'reconcile-tool',
        'reserve-model',
        'model-dispatch',
        'reconcile-model',
      ]);
      expect(events).toContainEqual(expect.objectContaining({ type: 'subagent.completed' }));
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
    const descriptor = {
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
    };
    state.capabilities.bindings.binding = {
      bindingId: 'binding',
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      exposedToolName: exposedName,
      schemaDigest: 'schema',
      issuedForTurnId: state.turn.turnId,
    };
    state.tools.calls.mcp = {
      toolCallId: 'mcp',
      modelMessageId: 'model',
      name: exposedName,
      args: { query: 'runtime' },
      status: 'queued',
      bindingId: 'binding',
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
    const descriptor = {
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
    };
    const dynamicName = exposedMcpToolName('docs', 'search');
    state.capabilities.bindings.binding = {
      bindingId: 'binding',
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      exposedToolName: dynamicName,
      schemaDigest: 'schema',
      issuedForTurnId: state.turn.turnId,
    };
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
      bindingId: 'binding',
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
    const descriptor = {
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
    };
    state.capabilities.bindings.binding = {
      bindingId: 'binding',
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      exposedToolName: 'mcp__github__read',
      schemaDigest: 'schema',
      issuedForTurnId: state.turn.turnId,
    };
    state.tools.calls.mcp = {
      toolCallId: 'mcp',
      modelMessageId: 'model',
      name: 'mcp__github__read',
      args: {},
      status: 'queued',
      bindingId: 'binding',
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
    state.capabilities.bindings.binding = {
      bindingId: 'binding',
      capabilityId: 'mcp:github/publish',
      capabilityRevision: 'old-revision',
      exposedToolName: 'mcp__github__publish',
      schemaDigest: 'schema',
      issuedForTurnId: state.turn.turnId,
    };
    state.tools.calls.mcp = {
      toolCallId: 'mcp',
      modelMessageId: 'model',
      name: 'mcp__github__publish',
      args: {},
      status: 'queued',
      bindingId: 'binding',
      capabilityId: 'mcp:github/publish',
      capabilityRevision: 'old-revision',
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
    const descriptor = {
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
    };
    state.capabilities.bindings.binding = {
      bindingId: 'binding',
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      exposedToolName: 'mcp__fixture__write',
      schemaDigest: 'schema-digest',
      issuedForTurnId: state.turn.turnId,
    };
    state.tools.calls.mcp = {
      toolCallId: 'mcp',
      modelMessageId: 'model',
      name: 'mcp__fixture__write',
      args: { id: 'secret-argument' },
      status: 'approved',
      approvalGrant: 'approve_once',
      bindingId: 'binding',
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.active.push('mcp');
    const manager = new McpConnectionManager();
    manager.findCapability = (capabilityId) =>
      capabilityId === descriptor.capabilityId ? descriptor : undefined;
    manager.getCapabilityRoute = () => ({
      transport: 'stdio',
      serverIdentity: descriptor.provider.id,
      endpointRevision: 'stdio-v1',
      toolRevision: descriptor.revision,
    });
    manager.callCapability = async ({ arguments: args }) =>
      ({
        content: [
          { type: 'resource_link', uri: 'resource://fixture/secret-argument', name: 'fixture' },
        ],
        structuredContent: { ok: true },
        ...(typeof args.idempotency_key === 'string' ? {} : { isError: true }),
      }) as never;
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
      artifactId: 'a'.repeat(64),
      relativePath: 'capability-results/a.json',
      byteLength: 42,
      digest: 'artifact-digest',
    });
    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['mcp'],
      mcpManager: manager,
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
      artifact: { digest: 'artifact-digest' },
    });
    const verification = events.find((event) => event.type === 'verification.requested');
    expect(verification).toMatchObject({ mode: 'required' });
    expect(JSON.stringify(verification)).not.toContain('secret-argument');
    expect(events.map((event) => event.type)).toEqual([
      'capability.invocation_recorded',
      'tool.started',
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
      phase: 'planning',
    });
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
      phase: 'planning',
    });
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
      const state = createInitialRuntimeState({
        threadId: 'runtime-plan-write',
        userId: 'user',
        workspace,
        phase: 'planning',
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
        expect(finished.result.status).toBeUndefined();
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
    if (rollbackState.planning.kind !== 'executing') throw new Error('expected executing plan');
    rollbackState.planning.document.steps[0]!.status = 'completed';
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
      const state = createInitialRuntimeState({
        threadId: 'runtime-plan-barrier',
        userId: 'user',
        workspace: process.cwd(),
        phase: 'planning',
      });
      const document = {
        planId: `plan-${crypto.randomUUID()}`,
        version: 1,
        title: 'Inspect',
        bodyMarkdown: 'Inspect runtime state transitions in detail.',
        steps: [{ id: 'inspect', title: 'Inspect runtime', status: 'pending' as const }],
        structuralDigest: 'digest',
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
      };
      state.planning = { kind: 'planning_draft', document };
      state.tools.calls.submit = {
        toolCallId: 'submit',
        modelMessageId: 'message-1',
        ordinal: 0,
        name: 'write_plan',
        args: {
          title: 'Inspect',
          body_markdown: 'Inspect runtime state transitions in detail.',
          steps: [{ id: 'inspect', title: 'Inspect runtime' }],
          plan_id: document.planId,
          version: document.version,
          structural_digest: document.structuralDigest,
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
      state.planning = {
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
      };
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
      state.planning = {
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
      };
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
    state.planning = {
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
    };
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
    expect(events.some((event) => event.type === 'tool.execution_ready')).toBe(false);
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
    expect(events.some((event) => event.type === 'tool.execution_ready')).toBe(false);
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
    state.planning = {
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
    };
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
    state.planning = {
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
    };
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
    state.planning = {
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
    };
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

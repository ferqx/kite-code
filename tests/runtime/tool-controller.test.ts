import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '@/core/config/index';
import { executeRuntimeTools, toRuntimeSubagentEvent } from '@/core/controllers/tool-controller';
import { exposedMcpToolName } from '@/core/mcp';
import { McpConnectionManager } from '@/core/mcp/manager';
import { CapabilityArtifactStore } from '@/core/persistence/capability-artifacts';
import type { RuntimeEvent } from '@/core/runtime/events';
import { createInitialRuntimeState } from '@/core/runtime/state';

describe('executeRuntimeTools', () => {
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

  test('uses the first batch question when ask_user omits the summary question', async () => {
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
        questions: [{ id: 'scope', question: 'What scope should be covered?' }],
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
      args: { command: 'node -e "process.exit(0)"' },
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
        reason: 'Rejected shell_execute during planning phase.',
        failure: expect.objectContaining({ kind: 'policy_denied' }),
      }),
    ]);
  });

  test('finishes write_plan once and returns the persisted plan identity', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-plan-write',
      userId: 'user',
      workspace: process.cwd(),
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
  });

  test('cancels later sibling calls when write_plan action=submit opens review', async () => {
    const state = createInitialRuntimeState({
      threadId: 'runtime-plan-barrier',
      userId: 'user',
      workspace: process.cwd(),
      phase: 'planning',
    });
    const document = {
      planId: 'plan-1',
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
          planId: 'plan-approved',
          version: 1,
          title: 'Test',
          bodyMarkdown: 'Test plan.',
          steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
          structuralDigest: 'abc',
          createdAtTurnId: state.turn.turnId,
          updatedAtTurnId: state.turn.turnId,
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
          planId: 'plan-approved',
          version: 1,
          title: 'Test',
          bodyMarkdown: 'Test plan.',
          steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
          structuralDigest: 'abc',
          createdAtTurnId: state.turn.turnId,
          updatedAtTurnId: state.turn.turnId,
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
        planId: 'plan-approved',
        version: 1,
        title: 'Test',
        bodyMarkdown: 'Test plan.',
        steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
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
    const returned = await executeRuntimeTools({
      state,
      toolCallIds: ['stream'],
      shellExecutor: async (input) => {
        input.onProgress?.('live output', 'stdout');
        return {
          ok: true,
          command: input.command,
          exitCode: 0,
          stdout: 'live output\n',
          stderr: '',
        };
      },
      emitRuntimeEvent: (event) => streamed.push(event),
    });

    expect(returned).toEqual([]);
    expect(streamed.map((event) => event.type)).toEqual([
      'tool.started',
      'tool.progress',
      'tool.finished',
    ]);
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
        planId: 'plan-approved',
        version: 1,
        title: 'Test',
        bodyMarkdown: 'Test plan.',
        steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
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
        planId: 'plan-approved',
        version: 1,
        title: 'Test',
        bodyMarkdown: 'Test plan.',
        steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
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
        planId: 'plan-auto',
        version: 1,
        title: 'Auto',
        bodyMarkdown: 'Auto plan.',
        steps: [{ id: 's1', title: 'Step', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
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
});

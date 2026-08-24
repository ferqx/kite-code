import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  McpProviderDirectorySnapshot,
  McpResourceDirectorySnapshot,
  McpRuntimeProvider,
} from '@kite/builtin-runtime/mcp';
import type { SkillCatalogSnapshot } from '@kite/builtin-runtime/skills';
import type { CapabilitySnapshot } from '@kite/runtime-contract';
import { createRuntimeHostStateInitialState } from '@kite/runtime-host/kernel-adapter';
import { createPreparedAppShellExecutor } from '#app/sandbox/composition';
import {
  executeTestRuntimeTools,
  testRuntimeCapabilityExecutionPort,
} from '../helpers/runtime-model';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function inventoryProvider(calls: { capability: number; provider: number; resource: number }) {
  const capabilities: CapabilitySnapshot = {
    revision: 'capabilities-1',
    descriptors: [],
  };
  const providers: McpProviderDirectorySnapshot = {
    revision: 'providers-1',
    entries: [],
  };
  const resources: McpResourceDirectorySnapshot = {
    revision: 'resources-1',
    resources: [
      {
        providerId: 'docs',
        uri: 'docs://runtime',
        name: 'Runtime docs',
      },
    ],
  };
  return Object.freeze({
    getCapabilitySnapshot: () => {
      calls.capability += 1;
      return capabilities;
    },
    getProviderDirectorySnapshot: () => {
      calls.provider += 1;
      return providers;
    },
    getResourceDirectorySnapshot: () => {
      calls.resource += 1;
      return resources;
    },
    findCapability: () => undefined,
    callCapability: async () => ({ content: [] }),
    readResource: async () => '',
  }) satisfies McpRuntimeProvider;
}

function stateFor(name: 'list_mcp_tools' | 'list_mcp_resources') {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId: `production-cutover-${name}`,
    userId: 'user',
    workspace: '/workspace',
  });
  state.tools.calls.call = {
    toolCallId: 'call',
    modelMessageId: 'message-1',
    ordinal: 0,
    name,
    args: {},
    status: 'queued',
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue = [...state.tools.queue, 'call'];
  return state;
}

function activeSkillFixture(name: 'read_skill_reference' | 'complete_skill') {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-tool-pipeline-skill-'));
  temporaryRoots.push(workspace);
  const sourcePath = join(workspace, '.kite-code', 'skills', 'fixture');
  mkdirSync(join(sourcePath, 'references'), { recursive: true });
  writeFileSync(join(sourcePath, 'references', 'note.txt'), 'governed reference');
  const descriptor = {
    capabilityId: 'skill:fixture',
    revision: 'skill-fixture-r1',
    kind: 'skill' as const,
    displayName: 'fixture',
    description: 'Fixture Skill.',
    provider: {
      type: 'skill' as const,
      id: 'fixture',
      provenance: 'project' as const,
      version: '1.0.0',
    },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
    declaredEffects: {
      filesystem: 'read' as const,
      network: 'none' as const,
      externalState: 'none' as const,
    },
    effectiveEffects: {
      filesystem: 'read' as const,
      network: 'none' as const,
      externalState: 'none' as const,
    },
    policy: { workspaceTrustRequired: false, minimumApproval: 'none' as const },
    execution: { retry: 'never' as const },
    availability: 'available' as const,
    diagnostics: [],
  };
  const catalog: SkillCatalogSnapshot = {
    revision: 'skill-catalog-r1',
    capabilities: { revision: 'skill-catalog-r1', descriptors: [descriptor] },
    entries: [
      {
        sourcePath,
        source: 'project',
        origin: '.kite-code',
        diagnostics: [],
        descriptor,
        contract: {
          schemaVersion: 1,
          name: 'fixture',
          version: '1.0.0',
          description: 'Fixture Skill.',
          instructions: 'Use the governed fixture.',
          invocation: { allowImplicit: true, allowManual: true },
          context: { mode: 'inline', agent: 'code' },
          inputSchema: descriptor.inputSchema,
          outputSchema: descriptor.outputSchema,
          capabilityCeiling: ['builtin:read_skill_reference', 'builtin:complete_skill'],
          deniedCapabilities: [],
          effectiveCapabilityCeiling: ['builtin:read_skill_reference', 'builtin:complete_skill'],
          effects: descriptor.declaredEffects,
          effectiveEffects: descriptor.effectiveEffects,
          minimumApproval: 'none',
          effectiveMinimumApproval: 'none',
          execution: { timeoutMs: 1_000, maxAttempts: 1 },
          verification: { mode: 'not_required' },
          recovery: { retry: 'never' },
          files: ['references/note.txt'],
          dependencyRevisions: {},
        },
      },
    ],
  };
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId: `production-cutover-${name}`,
    userId: 'user',
    workspace,
  });
  state.activeTaskId = 'task-1';
  state.skills.catalogRevision = catalog.revision;
  state.skills.frames.activation = {
    activationId: 'activation',
    skillId: descriptor.capabilityId,
    skillRevision: descriptor.revision,
    taskId: 'task-1',
    input: {},
    contextMode: 'inline',
    agent: 'code',
    capabilityCeiling: ['builtin:read_skill_reference', 'builtin:complete_skill'],
    verificationMode: 'not_required',
    requestedBy: 'model',
    activatedAt: '2026-08-22T00:00:00.000Z',
    status: 'active',
  };
  state.tools.calls.call = {
    toolCallId: 'call',
    modelMessageId: 'message-1',
    ordinal: 0,
    name,
    args:
      name === 'read_skill_reference'
        ? { activation_id: 'activation', path: 'references/note.txt' }
        : { activation_id: 'activation', output: { ok: true } },
    status: 'queued',
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue = [...state.tools.queue, 'call'];
  return { catalog, state };
}

function webFetchState(workspace: string) {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId: 'production-cutover-web-fetch',
    userId: 'user',
    workspace,
  });
  state.mode = 'accept_edits';
  state.tools.calls.call = {
    toolCallId: 'call',
    modelMessageId: 'message-1',
    ordinal: 0,
    name: 'web_fetch',
    args: { url: 'https://example.com' },
    status: 'queued',
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue = [...state.tools.queue, 'call'];
  return state;
}

function askUserState() {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId: 'production-cutover-ask-user',
    userId: 'user',
    workspace: '/workspace',
  });
  state.tools.calls.call = {
    toolCallId: 'call',
    modelMessageId: 'message-1',
    ordinal: 0,
    name: 'ask_user',
    args: {
      questions: [
        {
          question: 'Continue?',
          options: [
            { label: 'Yes', description: 'Continue the task.', recommended: true },
            { label: 'No', description: 'Stop the task.', recommended: false },
          ],
        },
      ],
    },
    status: 'queued',
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue = [...state.tools.queue, 'call'];
  return state;
}

function shellState(workspace: string) {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId: 'production-cutover-shell',
    userId: 'user',
    workspace,
  });
  state.authorization.mode = 'full_access';
  state.tools.calls.call = {
    toolCallId: 'call',
    modelMessageId: 'message-1',
    ordinal: 0,
    name: 'shell_execute',
    args: { command: 'pwd' },
    status: 'queued',
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue = [...state.tools.queue, 'call'];
  return state;
}

describe('RM-16 production Tool Pipeline cutover', () => {
  test('routes ask_user only through Kernel governance and emits no capability attempt', async () => {
    const events = await executeTestRuntimeTools({
      state: askUserState(),
      toolCallIds: ['call'],
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'user_input.requested',
        toolCallId: 'call',
        request: expect.objectContaining({ question: 'Continue?' }),
      }),
    );
    expect(
      events.filter(
        (event) =>
          event.type === 'capability.invocation_recorded' ||
          event.type === 'capability.execution_started' ||
          event.type === 'capability.execution_succeeded' ||
          event.type === 'capability.execution_failed',
      ),
    ).toEqual([]);
    expect(events.filter((event) => event.type === 'tool.finished')).toEqual([]);
  });

  test('routes MCP inventory through the effect-scoped Host/Builtin attempt exactly once', async () => {
    const calls = { capability: 0, provider: 0, resource: 0 };
    const events = await executeTestRuntimeTools({
      state: stateFor('list_mcp_tools'),
      toolCallIds: ['call'],
      mcpManager: inventoryProvider(calls),
    });

    expect(events.filter((event) => event.type === 'capability.invocation_recorded')).toHaveLength(
      1,
    );
    expect(events.filter((event) => event.type === 'capability.execution_started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'capability.execution_succeeded')).toHaveLength(
      1,
    );
    const terminal = events.find((event) => event.type === 'tool.finished');
    expect(terminal?.type === 'tool.finished' && JSON.parse(terminal.result.stdout)).toMatchObject({
      ok: true,
      configured_provider_count: 0,
      available_tool_count: 0,
    });
    expect(events.filter((event) => event.type === 'tool.failed')).toHaveLength(0);
    expect(calls.capability).toBeGreaterThan(0);
    expect(calls.provider).toBeGreaterThan(0);
  });

  test('routes write_file through one acknowledged mutation intent, ready, Provider, and terminal', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-tool-pipeline-write-'));
    temporaryRoots.push(workspace);
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0'.repeat(64),
      threadId: 'production-cutover-write-file',
      userId: 'user',
      workspace,
    });
    state.mode = 'accept_edits';
    state.tools.calls.call = {
      toolCallId: 'call',
      modelMessageId: 'message-1',
      ordinal: 0,
      name: 'write_file',
      args: { path: 'ordinary.txt', content: 'ordinary mutation\n' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'call'];
    const host = testRuntimeCapabilityExecutionPort();
    let hostInvokes = 0;

    const events = await executeTestRuntimeTools({
      state,
      toolCallIds: ['call'],
      capabilityExecution: Object.freeze({
        invoke: async (invocation: Parameters<typeof host.invoke>[0]) => {
          hostInvokes += 1;
          return host.invoke(invocation);
        },
      }),
    });

    expect(hostInvokes).toBe(1);
    expect(events.filter((event) => event.type === 'capability.invocation_recorded')).toHaveLength(
      1,
    );
    expect(
      events.filter((event) => event.type === 'capability.filesystem_intent_recorded'),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === 'capability.filesystem_mutation_ready'),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === 'capability.execution_succeeded')).toHaveLength(
      1,
    );
    expect(events.filter((event) => event.type === 'tool.file_change')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool.finished')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'capability.execution_unknown')).toEqual([]);
    expect(readFileSync(join(workspace, 'ordinary.txt'), 'utf8')).toBe('ordinary mutation\n');
  });

  test('routes Shell through the App-selected prepared port and one Host/Builtin attempt', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-tool-pipeline-shell-'));
    temporaryRoots.push(workspace);
    let processCalls = 0;
    const shellExecutor = createPreparedAppShellExecutor({
      workspace,
      sandboxEnabled: false,
      resolveBackend: () => 'none',
      createNativeExecutor: () => async () => {
        throw new Error('native provider must not run');
      },
      createHostExecutor: () => async (input) => {
        processCalls += 1;
        return {
          ok: true,
          command: input.command,
          exitCode: 0,
          stdout: 'production-shell',
          stderr: '',
        };
      },
    });
    const host = testRuntimeCapabilityExecutionPort();
    let hostInvokes = 0;
    const events = await executeTestRuntimeTools({
      state: shellState(workspace),
      toolCallIds: ['call'],
      sandboxAvailable: true,
      shellExecutor,
      capabilityExecution: Object.freeze({
        invoke: async (invocation: Parameters<typeof host.invoke>[0]) => {
          hostInvokes += 1;
          return host.invoke(invocation);
        },
      }),
    });

    expect(processCalls).toBe(1);
    expect(hostInvokes).toBe(1);
    expect(events.filter((event) => event.type === 'capability.invocation_recorded')).toHaveLength(
      1,
    );
    expect(events.filter((event) => event.type === 'capability.execution_started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'capability.execution_succeeded')).toHaveLength(
      1,
    );
    expect(events.filter((event) => event.type === 'capability.execution_unknown')).toEqual([]);
    expect(events.filter((event) => event.type === 'tool.finished')).toHaveLength(1);
  });

  test('routes resource inventory through the same port and fails before acknowledgement without it', async () => {
    const calls = { capability: 0, provider: 0, resource: 0 };
    const events = await executeTestRuntimeTools({
      state: stateFor('list_mcp_resources'),
      toolCallIds: ['call'],
      mcpManager: inventoryProvider(calls),
    });
    const terminal = events.find((event) => event.type === 'tool.finished');
    expect(terminal?.type === 'tool.finished' && JSON.parse(terminal.result.stdout)).toMatchObject({
      ok: true,
      resource_count: 1,
    });
    expect(calls.resource).toBe(1);

    const unavailable = await executeTestRuntimeTools({
      state: stateFor('list_mcp_tools'),
      toolCallIds: ['call'],
    });
    expect(unavailable.filter((event) => event.type === 'capability.invocation_recorded')).toEqual(
      [],
    );
    expect(unavailable).toContainEqual(
      expect.objectContaining({
        type: 'tool.failed',
        failure: expect.objectContaining({ kind: 'mandatory_policy_unavailable' }),
      }),
    );
  });

  test('routes active Skill reference and completion through one Host/Builtin attempt each', async () => {
    const reference = activeSkillFixture('read_skill_reference');
    const referenceEvents = await executeTestRuntimeTools({
      state: reference.state,
      toolCallIds: ['call'],
      skillCatalog: reference.catalog,
    });
    expect(
      referenceEvents.filter((event) => event.type === 'capability.invocation_recorded'),
    ).toHaveLength(1);
    expect(
      referenceEvents.filter((event) => event.type === 'capability.execution_succeeded'),
    ).toHaveLength(1);
    const referenceTerminal = referenceEvents.find((event) => event.type === 'tool.finished');
    expect(
      referenceTerminal?.type === 'tool.finished' && JSON.parse(referenceTerminal.result.stdout),
    ).toMatchObject({
      ok: true,
      activation_id: 'activation',
      path: 'references/note.txt',
      content: 'governed reference',
    });

    const completion = activeSkillFixture('complete_skill');
    const completionEvents = await executeTestRuntimeTools({
      state: completion.state,
      toolCallIds: ['call'],
      skillCatalog: completion.catalog,
    });
    expect(
      completionEvents.filter((event) => event.type === 'capability.invocation_recorded'),
    ).toHaveLength(1);
    expect(completionEvents).toContainEqual(
      expect.objectContaining({
        type: 'skill.frame_closed',
        activationId: 'activation',
        status: 'closed',
      }),
    );
    expect(completionEvents.filter((event) => event.type === 'tool.finished')).toHaveLength(1);
  });

  test('rejects Skill lifecycle calls without an active frame before Host acknowledgement', async () => {
    const fixture = activeSkillFixture('read_skill_reference');
    fixture.state.skills.frames = {};
    const events = await executeTestRuntimeTools({
      state: fixture.state,
      toolCallIds: ['call'],
      skillCatalog: fixture.catalog,
    });
    expect(events.filter((event) => event.type === 'capability.invocation_recorded')).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.failed',
        failure: expect.objectContaining({ kind: 'tool_not_found' }),
      }),
    );
  });

  test('resumes an exactly approved web fetch through one sealed network attempt', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-tool-pipeline-web-'));
    temporaryRoots.push(workspace);
    const state = webFetchState(workspace);
    const taskConfig = {
      apiKey: '',
      baseURL: 'http://localhost',
      modelName: 'test',
      providerName: 'test',
      providerType: 'openai-compatible' as const,
      sandbox: { enabled: false },
      features: { networkBoundary: false },
      executionBoundary: {
        filesystemScope: 'read_only' as const,
        workspaceRoot: workspace,
        networkMode: 'allowlist' as const,
        networkAllowlist: ['example.com'],
        allowLocalAndPrivateNetwork: false as const,
        protectedPathPolicy: 'deny' as const,
        maxProcessTreeSizePerShellInvocation: 16,
        sandboxRequired: false,
        sandboxUnavailable: 'verified_in_process_read_only' as const,
      },
    };
    const requested = await executeTestRuntimeTools({
      state,
      toolCallIds: ['call'],
      taskConfig,
    });
    const approval = requested.find(
      (event) => event.type === 'approval.requested' && event.toolCallId === 'call',
    );
    expect(approval?.type).toBe('approval.requested');
    expect(requested.filter((event) => event.type === 'capability.invocation_recorded')).toEqual(
      [],
    );
    if (approval?.type !== 'approval.requested') throw new Error('Missing approval fixture.');
    state.tools.calls.call!.status = 'approved';
    state.tools.calls.call!.approvalGrant = 'approve_once';
    state.tools.calls.call!.approvalHash = approval.approval.approvalHash;
    const decisions: unknown[] = [];
    const executed = await executeTestRuntimeTools({
      state,
      toolCallIds: ['call'],
      taskConfig,
      recordNetworkDecision: async (decision) => {
        decisions.push(decision);
      },
    });
    expect(
      executed.filter((event) => event.type === 'capability.invocation_recorded'),
    ).toHaveLength(1);
    expect(executed.filter((event) => event.type === 'capability.execution_started')).toHaveLength(
      1,
    );
    expect(executed.filter((event) => event.type === 'capability.execution_failed')).toHaveLength(
      1,
    );
    expect(executed.filter((event) => event.type === 'tool.finished')).toHaveLength(1);
    expect(decisions).toContainEqual(expect.objectContaining({ failureCode: 'network_off' }));
  });
});

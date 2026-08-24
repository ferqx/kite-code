import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite/agent-kernel';
import { exposedMcpToolName, McpConnectionManager } from '@kite/builtin-runtime/mcp';
import type { ExecutionBoundary, ShellExecutor } from '@kite/builtin-runtime/sandbox';
import {
  type BuiltinPreparedShellExecutionInput,
  createNetworkBoundaryFetch,
  type NetworkAdmissionReceipt,
  type NetworkDecisionReceipt,
  type NetworkResolvedAddress,
  networkBoundaryPolicyFromExecutionBoundary,
  SandboxPreparationArtifactStore,
} from '@kite/builtin-runtime/sandbox';
import { createRuntimeHostStateInitialState } from '@kite/runtime-host/kernel-adapter';
import {
  APP_PREPARED_SHELL_EXECUTION_,
  projectAppHostShellResult,
} from '../../apps/kite/src/sandbox/prepared-tool-pipeline';
import { StateHostSessionHarness as AgentKernel } from '../../scripts/support/runtime-host-state';
import { openStateStoreForTest } from '../../scripts/support/runtime-storage';
import { createTestRuntimeEffectExecutor } from '../helpers/runtime-model';

const publicAddress: NetworkResolvedAddress = { address: '93.184.216.34', family: 4 };
const privateAddress: NetworkResolvedAddress = { address: '127.0.0.1', family: 4 };

function allowlist(hosts: string[]) {
  const boundary: ExecutionBoundary = {
    filesystemScope: 'workspace_write',
    workspaceRoot: process.cwd(),
    networkMode: 'allowlist',
    networkAllowlist: hosts,
    allowLocalAndPrivateNetwork: false,
    protectedPathPolicy: 'deny',
    maxProcessTreeSizePerShellInvocation: 8,
    sandboxRequired: true,
    sandboxUnavailable: 'fail',
  };
  return networkBoundaryPolicyFromExecutionBoundary(boundary, true);
}

function testSandboxPreparationArtifacts(label: string) {
  return new SandboxPreparationArtifactStore({
    root: join(mkdtempSync(join('/tmp', `kite-network-${label}-`)), 'sandbox-preparations'),
  });
}

function preparedShellExecutor(executor: ShellExecutor): ShellExecutor {
  const wrapped = ((input) => executor(input)) as ShellExecutor &
    Partial<Record<typeof APP_PREPARED_SHELL_EXECUTION_, unknown>>;
  Object.defineProperty(wrapped, APP_PREPARED_SHELL_EXECUTION_, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      execute: async (input: BuiltinPreparedShellExecutionInput) =>
        projectAppHostShellResult(
          await executor({
            workspace: input.workspace,
            command: input.command,
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
            ...(input.onProgress ? { onProgress: input.onProgress } : {}),
            ...(input.networkMode ? { networkMode: input.networkMode } : {}),
            ...(input.filesystemMode ? { filesystemMode: input.filesystemMode } : {}),
            ...(input.executionTrust ? { executionTrust: input.executionTrust } : {}),
            sandboxInvocationIdentity: input.identity,
          }),
        ),
    }),
  });
  return Object.freeze(wrapped);
}

describe('network boundary concurrent invocation isolation', () => {
  test('keeps public, private, redirect, and rebinding decisions independent', async () => {
    const receipts: NetworkAdmissionReceipt[] = [];
    const decisions: NetworkDecisionReceipt[] = [];
    const requests: string[] = [];
    const resolutionCounts = new Map<string, number>();
    const fetchImpl = createNetworkBoundaryFetch(
      allowlist([
        'public.example',
        'private.example',
        'redirect.example',
        'redirect-private.example',
        'rebind.example',
      ]),
      {
        resolver: async (hostname) => {
          const count = (resolutionCounts.get(hostname) ?? 0) + 1;
          resolutionCounts.set(hostname, count);
          if (hostname === 'private.example' || hostname === 'redirect-private.example') {
            return [privateAddress];
          }
          if (hostname === 'rebind.example' && count > 1) return [privateAddress];
          return [publicAddress];
        },
        onAdmission: (receipt) => receipts.push(receipt),
        recordDecision: (decision) => {
          decisions.push(decision);
        },
        request: async (input) => {
          requests.push(input.url.href);
          if (input.url.hostname === 'redirect.example') {
            return new Response(null, {
              status: 302,
              headers: { location: 'https://redirect-private.example/secret' },
            });
          }
          if (input.url.hostname === 'rebind.example') {
            return new Response(null, { status: 302, headers: { location: '/next' } });
          }
          return new Response('public-ok', { status: 200 });
        },
      },
    );

    const results = await Promise.allSettled([
      fetchImpl('https://public.example/data'),
      fetchImpl('https://private.example/data'),
      fetchImpl('https://redirect.example/start'),
      fetchImpl('https://rebind.example/start'),
    ]);

    expect(results[0]?.status).toBe('fulfilled');
    expect(results.slice(1).map((result) => result.status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
    ]);
    expect(requests).toContain('https://public.example/data');
    expect(requests).not.toContain('https://private.example/data');
    expect(requests).not.toContain('https://redirect-private.example/secret');
    expect(requests.filter((url) => url.startsWith('https://rebind.example/'))).toHaveLength(1);

    const invocationIds = new Set(receipts.map((receipt) => receipt.invocationId));
    const receiptDigests = new Set(receipts.map((receipt) => receipt.receiptDigest));
    expect(invocationIds.size).toBe(3);
    expect(receiptDigests.size).toBe(receipts.length);
    expect(new Set(decisions.map((decision) => decision.invocationId)).size).toBe(4);
    expect(new Set(decisions.map((decision) => decision.receiptDigest)).size).toBe(
      decisions.length,
    );
    expect(decisions.filter((decision) => decision.outcome === 'denied')).toHaveLength(3);
  });

  test('a controller failure does not cancel or rewrite a public sibling receipt', async () => {
    const receipts: NetworkAdmissionReceipt[] = [];
    const decisions: NetworkDecisionReceipt[] = [];
    const fetchImpl = createNetworkBoundaryFetch(allowlist(['public.example', 'crash.example']), {
      resolver: async (hostname) => {
        if (hostname === 'crash.example') throw new Error('controller crash');
        return [publicAddress];
      },
      onAdmission: (receipt) => receipts.push(receipt),
      recordDecision: (decision) => {
        decisions.push(decision);
      },
      request: async () => new Response('ok', { status: 200 }),
    });

    const [publicResult, crashResult] = await Promise.allSettled([
      fetchImpl('https://public.example/data'),
      fetchImpl('https://crash.example/data'),
    ]);
    expect(publicResult.status).toBe('fulfilled');
    expect(crashResult.status).toBe('rejected');
    if (crashResult.status === 'rejected') {
      expect(crashResult.reason).toMatchObject({ code: 'controller_unavailable' });
    }
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.host).toBe('public.example');
    expect(decisions).toHaveLength(2);
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'allowed', host: 'public.example' }),
        expect.objectContaining({ outcome: 'denied', failureCode: 'controller_unavailable' }),
      ]),
    );
  });

  test('forwards a pre-dispatch approval from the Tool Pipeline through the effect adapter', async () => {
    const store = openStateStoreForTest(':memory:');
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'network-approval-forwarding',
      userId: 'user',
      workspace: process.cwd(),
      interactionMode: 'accept_edits',
    });
    state.tools.calls.web = {
      toolCallId: 'web',
      modelMessageId: 'model',
      name: 'web_fetch',
      args: { url: 'https://approval.example/data' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'web'];
    const kernel = new AgentKernel({ store, initialState: state, interactionMode: 'accept_edits' });
    const executor = createTestRuntimeEffectExecutor({
      config: {
        apiKey: 'test',
        baseURL: 'http://localhost',
        modelName: 'mock',
        providerName: 'mock',
        providerType: 'openai-compatible',
        sandbox: { enabled: true },
        executionBoundary: {
          filesystemScope: 'workspace_write',
          workspaceRoot: process.cwd(),
          networkMode: 'allowlist',
          networkAllowlist: ['approval.example'],
          allowLocalAndPrivateNetwork: false,
          protectedPathPolicy: 'deny',
          maxProcessTreeSizePerShellInvocation: 8,
          sandboxRequired: true,
          sandboxUnavailable: 'fail',
        },
      },
      model: {} as never,
      runtimeStore: store,
      sandboxBackend: 'seatbelt',
    });
    const emitted: unknown[] = [];
    const terminalEvents = await executor(
      { type: 'run_tools', toolCallIds: ['web'] },
      kernel.getState(),
      (event) => {
        emitted.push(event);
        kernel.processEvent(event);
      },
      {
        reservationIds: [],
        getState: () => kernel.getState(),
        persistEvent: async (event) => kernel.processEvent(event).status === 'applied',
        persistEvents: async (events) => {
          kernel.processEventBatch(events);
          return true;
        },
        persistAttemptStartEvents: async (events) => {
          kernel.processEventBatch(events);
          return true;
        },
        persistTerminalRecoveryEvents: async (events) => {
          kernel.processEventBatch(events);
          return true;
        },
      },
    );

    expect(emitted).toContainEqual(
      expect.objectContaining({ type: 'approval.requested', toolCallId: 'web' }),
    );
    expect(terminalEvents).toEqual([]);
    expect(kernel.getState().interactions).toMatchObject({
      kind: 'awaiting_tool_approval',
      toolCallId: 'web',
    });
    kernel.close();
  });

  test('persists independent outcomes for a mixed Runtime network batch before provider access', async () => {
    const store = openStateStoreForTest(':memory:');
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'mixed-network-batch',
      userId: 'user',
      workspace: process.cwd(),
      interactionMode: 'full',
    });
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
    const calls = {
      web: {
        name: 'web_fetch',
        args: { url: 'https://mixed-batch.example/data' },
      },
      shell: {
        name: 'shell_execute',
        args: { command: 'curl https://mixed-batch.example/data' },
      },
      inventory: { name: 'list_mcp_resources', args: {} },
      resource: {
        name: 'read_mcp_resource',
        args: { server: 'docs', uri: 'docs://one' },
      },
      dynamic: {
        name: dynamicName,
        args: { query: 'runtime' },
        bindingId: 'binding',
        capabilityId: descriptor.capabilityId,
        capabilityRevision: descriptor.revision,
      },
    } as const;
    for (const [toolCallId, call] of Object.entries(calls)) {
      state.tools.queue = [...state.tools.queue, toolCallId];
      state.tools.calls[toolCallId] = {
        toolCallId,
        modelMessageId: 'model',
        ...call,
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
    }
    const kernel = new AgentKernel({
      store,
      initialState: state,
      interactionMode: 'full',
      sandboxAvailable: true,
    });

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

    let reportShellEntered!: () => void;
    const shellEntered = new Promise<void>((resolve) => {
      reportShellEntered = resolve;
    });
    let releaseShell!: () => void;
    const shellRelease = new Promise<void>((resolve) => {
      releaseShell = resolve;
    });
    let observedShellNetworkMode: string | undefined;
    let reportReceiptPersisted!: () => void;
    const receiptPersisted = new Promise<void>((resolve) => {
      reportReceiptPersisted = resolve;
    });
    const executor = createTestRuntimeEffectExecutor({
      config: {
        apiKey: 'test',
        baseURL: 'http://localhost',
        modelName: 'mock',
        providerName: 'mock',
        providerType: 'openai-compatible',
        sandbox: { enabled: true },
        features: {
          capabilityCatalog: true,
          mcpRuntimeBinding: true,
          networkBoundary: false,
        },
        executionBoundary: {
          filesystemScope: 'workspace_write',
          workspaceRoot: process.cwd(),
          networkMode: 'allowlist',
          networkAllowlist: ['mixed-batch.example'],
          allowLocalAndPrivateNetwork: false,
          protectedPathPolicy: 'deny',
          maxProcessTreeSizePerShellInvocation: 8,
          sandboxRequired: true,
          sandboxUnavailable: 'fail',
        },
      },
      model: {} as never,
      sandboxPreparationArtifacts: testSandboxPreparationArtifacts('mixed-batch'),
      mcpManager: runtimeManager,
      runtimeStore: store,
      sandboxBackend: 'seatbelt',
      shellExecutor: preparedShellExecutor(async (input) => {
        observedShellNetworkMode = input.networkMode;
        reportShellEntered();
        await shellRelease;
        return { ok: true, command: input.command, exitCode: 0, stdout: 'ok', stderr: '' };
      }),
    });
    const toolCallIds = Object.keys(calls);
    const persistedEvents: RuntimeEvent[] = [];
    const execution = executor(
      { type: 'run_tools', toolCallIds },
      kernel.getState(),
      (event) => {
        kernel.processEvent(event);
      },
      {
        reservationIds: [],
        getState: () => kernel.getState(),
        persistEvent: async (event) => {
          persistedEvents.push(event);
          const applied = kernel.processEvent(event).status === 'applied';
          if (event.type === 'network.admission_decided') reportReceiptPersisted();
          return applied;
        },
        persistEvents: async (events) => {
          persistedEvents.push(...events);
          kernel.processEventBatch(events);
          return true;
        },
        persistAttemptStartEvents: async (events) => {
          persistedEvents.push(...events);
          kernel.processEventBatch(events);
          return true;
        },
        persistTerminalRecoveryEvents: async (events) => {
          persistedEvents.push(...events);
          kernel.processEventBatch(events);
          return true;
        },
      },
    );
    const [shellWasEntered, receiptWasPersisted] = await Promise.all([
      Promise.race([shellEntered.then(() => true), Bun.sleep(250).then(() => false)]),
      Promise.race([receiptPersisted.then(() => true), Bun.sleep(250).then(() => false)]),
    ]);
    releaseShell();
    const terminalEvents = await execution;
    kernel.processEventBatch(terminalEvents);

    const combinedEvents = [...persistedEvents, ...terminalEvents];
    const terminalByToolCallId = new Map<string, RuntimeEvent>();
    for (const event of combinedEvents) {
      if (
        event.type === 'tool.finished' ||
        event.type === 'tool.failed' ||
        event.type === 'tool.rejected' ||
        event.type === 'tool.cancelled'
      ) {
        terminalByToolCallId.set(event.toolCallId, event);
      }
    }
    const capabilityTerminalInvocationIds = new Set(
      combinedEvents.flatMap((event) =>
        event.type === 'capability.execution_succeeded' ||
        event.type === 'capability.execution_failed'
          ? [event.invocationId]
          : [],
      ),
    );

    expect({ shellWasEntered, receiptWasPersisted }).toEqual({
      shellWasEntered: true,
      receiptWasPersisted: true,
    });
    expect(providerCalls).toBe(0);
    expect(observedShellNetworkMode).toBe('allow_all');
    expect(terminalByToolCallId.size).toBe(toolCallIds.length);
    expect(capabilityTerminalInvocationIds.size).toBe(2);
    expect(kernel.getState().tools.calls.web?.status).toBe('failed');
    expect(kernel.getState().tools.calls.shell?.status).toBe('succeeded');
    for (const toolCallId of ['inventory', 'resource', 'dynamic']) {
      expect(kernel.getState().tools.calls[toolCallId]?.status).toBe('failed');
    }
    const webDecisions = kernel.getState().tools.calls.web?.networkDecisions ?? [];
    expect(webDecisions).toHaveLength(2);
    expect(webDecisions.every((decision) => decision.outcome === 'denied')).toBe(true);
    expect(new Set(webDecisions.map((decision) => decision.invocationId)).size).toBe(2);
    expect(new Set(webDecisions.map((decision) => decision.receiptDigest)).size).toBe(2);
    expect(
      store.loadSnapshot<ReturnType<typeof createRuntimeHostStateInitialState>>(
        'mixed-network-batch',
      )?.tools.calls.web?.networkDecisions,
    ).toEqual(webDecisions);
    kernel.close();
  });
});

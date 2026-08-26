import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import { BuiltinMcpExecutionUnknownError } from '@kite-ai/builtin-runtime';
import { McpProviderError, type McpRuntimeProvider } from '@kite-ai/builtin-runtime/mcp';
import {
  createRuntimeHostStateInitialState,
  type RuntimeState,
} from '@kite-ai/runtime-host/kernel-adapter';
import { createAppMcpReadinessRuntime } from '#kite-cli/bootstrap/runtime/mcp-readiness-runtime';
import { ProviderReadinessCoordinator } from '#kite-cli/bootstrap/runtime/provider-readiness';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';

function stateHarness(input?: {
  readonly reject?: (event: RuntimeEvent) => boolean;
  readonly afterPersist?: (event: RuntimeEvent) => void;
}) {
  let state: RuntimeState = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId: 'mcp-readiness-runtime',
    userId: 'user',
    workspace: '/workspace',
  });
  const events: RuntimeEvent[] = [];
  return {
    events,
    getState: () => state,
    persistEvent: async (event: RuntimeEvent) => {
      if (input?.reject?.(event)) return false;
      events.push(event);
      state = reduceRuntimeState(state, event);
      input?.afterPersist?.(event);
      return true;
    },
  };
}

function providerFixture(input?: {
  readonly readinessFailure?: McpProviderError;
  readonly onRead?: () => void;
  readonly revision?: () => string;
}): McpRuntimeProvider {
  let status: 'connecting' | 'ready' | 'login_required' = input?.readinessFailure
    ? 'login_required'
    : 'connecting';
  return {
    getCapabilitySnapshot: () => ({ revision: 'capabilities-v1', descriptors: [] }),
    getProviderDirectorySnapshot: () => ({
      revision: input?.revision?.() ?? `directory-${status}`,
      entries: [
        {
          providerId: 'docs',
          status,
          required: false,
          source: 'user',
          lastKnownCapabilityNames: [],
          retryable: false,
        },
      ],
    }),
    getResourceDirectorySnapshot: () => ({ revision: 'resources-v1', resources: [] }),
    findCapability: () => undefined,
    ensureProviderReady: async () => {
      if (input?.readinessFailure) throw input.readinessFailure;
      status = 'ready';
    },
    callCapability: async () => ({ content: [] }),
    readResource: async () => {
      input?.onRead?.();
      return 'resource body';
    },
  };
}

function readinessRuntime(provider: McpRuntimeProvider, state: ReturnType<typeof stateHarness>) {
  return createAppMcpReadinessRuntime({
    runtime: provider,
    readinessCoordinator: new ProviderReadinessCoordinator(provider),
    getState: state.getState,
    persistEvent: state.persistEvent,
    toolCallId: 'call-1',
    executionBoundaryDigest: 'boundary-v1',
    signal: new AbortController().signal,
  });
}

describe('App MCP readiness runtime', () => {
  test('persists the exact lifecycle before one read on the same manager', async () => {
    let reads = 0;
    const state = stateHarness();
    const runtime = readinessRuntime(
      providerFixture({
        onRead: () => {
          reads += 1;
        },
      }),
      state,
    );

    await expect(runtime.readResource('docs', 'docs://one')).resolves.toBe('resource body');
    expect(reads).toBe(1);
    expect(state.events.map((event) => event.type)).toEqual([
      'provider.readiness_intent_recorded',
      'provider.readiness_waiter_registered',
      'provider.readiness_attempt_started',
      'provider.readiness_succeeded',
    ]);
  });

  test('keeps persistence failure and receipt drift unknown with zero reads', async () => {
    let reads = 0;
    const rejected = stateHarness({
      reject: (event) => event.type === 'provider.readiness_intent_recorded',
    });
    const provider = providerFixture({
      onRead: () => {
        reads += 1;
      },
    });
    await expect(
      readinessRuntime(provider, rejected).readResource('docs', 'docs://one'),
    ).rejects.toBeInstanceOf(BuiltinMcpExecutionUnknownError);
    expect(reads).toBe(0);

    let drift = false;
    const driftedState = stateHarness({
      afterPersist: (event) => {
        if (event.type === 'provider.readiness_succeeded') drift = true;
      },
    });
    const driftedProvider = providerFixture({
      revision: () => (drift ? 'directory-drifted' : 'directory-stable'),
      onRead: () => {
        reads += 1;
      },
    });
    await expect(
      readinessRuntime(driftedProvider, driftedState).readResource('docs', 'docs://one'),
    ).rejects.toBeInstanceOf(BuiltinMcpExecutionUnknownError);
    expect(reads).toBe(0);
  });

  test('preserves typed unavailable facts and never calls the resource provider', async () => {
    let reads = 0;
    const failure = new McpProviderError({
      providerId: 'docs',
      kind: 'provider_auth_required',
      message: 'Login required.',
      recoveryAction: 'login',
    });
    const provider = providerFixture({
      readinessFailure: failure,
      onRead: () => {
        reads += 1;
      },
    });
    const state = stateHarness();
    const runtime = readinessRuntime(provider, state);

    await expect(runtime.readResource('docs', 'docs://one')).rejects.toBe(failure);
    await expect(runtime.readResource('docs', 'docs://one')).rejects.toMatchObject({
      name: 'McpProviderError',
      providerId: 'docs',
      kind: 'provider_auth_required',
      recoveryAction: 'login',
      retryable: false,
    });
    expect(reads).toBe(0);
  });
});

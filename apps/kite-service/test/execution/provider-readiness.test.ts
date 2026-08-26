import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import type { McpRuntimeProvider } from '@kite-ai/builtin-runtime/mcp';
import {
  createRuntimeHostStateInitialState,
  type RuntimeState,
} from '@kite-ai/runtime-host/kernel-adapter';
import {
  ProviderReadinessCoordinator,
  ProviderReadinessUnknownError,
} from '#kite-service/bootstrap/runtime/provider-readiness';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function providerFixture(input: {
  status?: 'connecting' | 'ready' | 'failed';
  ensure?: () => Promise<void>;
}): McpRuntimeProvider & {
  setStatus(status: 'connecting' | 'ready' | 'failed'): void;
} {
  let status = input.status ?? 'connecting';
  return {
    setStatus(next) {
      status = next;
    },
    getCapabilitySnapshot: () => ({ revision: 'capabilities-v1', descriptors: [] }),
    getProviderDirectorySnapshot: () => ({
      revision: `directory-${status}`,
      entries: [
        {
          providerId: 'fixture',
          status,
          required: false,
          source: 'user',
          lastKnownCapabilityNames: [],
          retryable: status !== 'ready',
        },
      ],
    }),
    getResourceDirectorySnapshot: () => ({ revision: 'resources-v1', resources: [] }),
    findCapability: () => undefined,
    ensureProviderReady: input.ensure ?? (async () => {}),
    callCapability: async () => ({ content: [] }),
    readResource: async () => '',
  };
}

function persistenceHarness(input?: { reject?: (event: RuntimeEvent) => boolean }): {
  events: RuntimeEvent[];
  getState: () => Readonly<RuntimeState>;
  persistEvent: (event: RuntimeEvent) => Promise<boolean>;
} {
  let state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'provider-readiness',
    userId: 'user',
    workspace: '/workspace',
  });
  const events: RuntimeEvent[] = [];
  return {
    events,
    getState: () => state,
    persistEvent: async (event) => {
      if (input?.reject?.(event)) return false;
      events.push(event);
      state = reduceRuntimeState(state, event);
      return true;
    },
  };
}

const request = {
  providerId: 'fixture',
  routeRevision: 'route-v1',
  executionBoundaryDigest: 'boundary-v1',
  toolCallId: 'tool-1',
} as const;

describe('ProviderReadinessCoordinator', () => {
  test('performs zero provider calls when the intent acknowledgement fails', async () => {
    let calls = 0;
    const provider = providerFixture({
      ensure: async () => {
        calls += 1;
      },
    });
    const persistence = persistenceHarness({
      reject: (event) => event.type === 'provider.readiness_intent_recorded',
    });
    const coordinator = new ProviderReadinessCoordinator(provider);

    await expect(coordinator.ensureReady(request, persistence)).rejects.toMatchObject({
      code: 'PROVIDER_READINESS_PERSISTENCE_UNAVAILABLE',
    });
    expect(calls).toBe(0);
    expect(persistence.events).toHaveLength(0);
  });

  test('coalesces exact-key waiters behind one acknowledged attempt', async () => {
    const gate = deferred();
    let calls = 0;
    const provider = providerFixture({
      ensure: async () => {
        calls += 1;
        await gate.promise;
        provider.setStatus('ready');
      },
    });
    const persistence = persistenceHarness();
    const coordinator = new ProviderReadinessCoordinator(provider);

    const first = coordinator.ensureReady(request, persistence);
    const second = coordinator.ensureReady({ ...request, toolCallId: 'tool-2' }, persistence);
    await Bun.sleep(0);
    expect(calls).toBe(1);
    gate.resolve();
    const [firstReceipt, secondReceipt] = await Promise.all([first, second]);

    expect(secondReceipt.lifecycleId).toBe(firstReceipt.lifecycleId);
    expect(
      persistence.events.filter((event) => event.type === 'provider.readiness_attempt_started'),
    ).toHaveLength(1);
    expect(
      persistence.events.filter((event) => event.type === 'provider.readiness_waiter_registered'),
    ).toHaveLength(2);
  });

  test('restores an attempted lifecycle without a receipt as unknown and never retries it', async () => {
    let calls = 0;
    const provider = providerFixture({
      ensure: async () => {
        calls += 1;
      },
    });
    const persistence = persistenceHarness({
      reject: (event) => event.type === 'provider.readiness_succeeded',
    });
    const firstCoordinator = new ProviderReadinessCoordinator(provider);

    await expect(firstCoordinator.ensureReady(request, persistence)).rejects.toBeInstanceOf(
      ProviderReadinessUnknownError,
    );
    expect(calls).toBe(1);
    expect(Object.values(persistence.getState().providerReadiness ?? {})[0]?.status).toBe(
      'attempted',
    );

    const restoredCoordinator = new ProviderReadinessCoordinator(provider);
    await expect(restoredCoordinator.ensureReady(request, persistence)).rejects.toBeInstanceOf(
      ProviderReadinessUnknownError,
    );
    expect(calls).toBe(1);
  });

  test('reuses only an unexpired exact-key receipt and isolates route revisions', async () => {
    let now = 1_000;
    let calls = 0;
    const provider = providerFixture({
      ensure: async () => {
        calls += 1;
        provider.setStatus('ready');
      },
    });
    const persistence = persistenceHarness();
    const coordinator = new ProviderReadinessCoordinator(provider, {
      now: () => now,
      ttlMs: 500,
    });

    const first = await coordinator.ensureReady(request, persistence);
    await coordinator.ensureReady({ ...request, toolCallId: 'tool-2' }, persistence);
    expect(calls).toBe(1);

    provider.setStatus('connecting');
    now += 100;
    const changed = await coordinator.ensureReady(
      { ...request, routeRevision: 'route-v2', toolCallId: 'tool-3' },
      persistence,
    );
    expect(calls).toBe(2);
    expect(changed.readinessKey).not.toBe(first.readinessKey);
  });

  test('keeps Provider readiness out of Controller and discovery paths', () => {
    for (const relativePath of [
      '../../src/runtime/tool-execution/router.ts',
      '../../../../packages/builtin-runtime/src/tool-search.ts',
    ]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source).not.toContain('.ensureProviderReady');
    }
  });
});

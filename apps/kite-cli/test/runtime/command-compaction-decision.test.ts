import { describe, expect, test } from 'bun:test';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import type { AgentConfig } from '#kite-cli/config';
import { ContextCompactionService } from '#kite-cli/runtime/session/context-compaction-service';

const config: AgentConfig = {
  apiKey: 'test',
  baseURL: 'http://localhost',
  modelName: 'manual',
  providerName: 'manual',
  providerType: 'openai-compatible',
  sandbox: { enabled: false },
  modelCapabilities: { contextWindowTokens: 10_000, maxOutputTokens: 1_000 },
  compaction: {},
};

function harness() {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId: 'compaction-command',
    userId: 'user',
    workspace: '/workspace',
  });
  let writes = 0;
  const coordinator = {
    getState: () => state,
    executePendingCompaction: async () => [],
    session: {
      commitCommandBatch: () => {
        writes += 1;
        return undefined;
      },
    },
  };
  const runtime = {
    config,
    workspace: '/workspace',
    threadId: state.session.threadId,
    skillManifests: [],
  };
  const service = new ContextCompactionService(
    () =>
      ({
        runtimeSessionCoordinator: { get: () => coordinator },
        builtinToolCatalog: { forTurn: () => ({ entries: [], toolSet: {} }) } as never,
        modelInvocationRuntimeFactory: () => ({
          builtinToolCatalog: { forTurn: () => ({ entries: [], toolSet: {} }) } as never,
        }),
        capabilityExecution: {} as never,
      }) as never,
    () => runtime as never,
  );
  return { state, service, writes: () => writes };
}

describe('Host compaction command plan', () => {
  test('inspect is deterministic and makes zero writes', () => {
    const h = harness();
    const input = {
      threadId: h.state.session.threadId,
      commandId: 'compact-1',
      mode: 'manual' as const,
    };
    const first = h.service.inspectHostCompactionCommand(input);
    const second = h.service.inspectHostCompactionCommand(input);
    expect(first).toEqual(second);
    expect(h.writes()).toBe(0);
    expect(first.shouldSchedule).toBe(false);
    expect(first.events.map((event) => event.type)).toEqual([
      'user.command_invoked',
      'context.compaction_requested',
      'context.compaction_failed',
    ]);
  });

  test('reset rejects absent checkpoint and pending state without events', () => {
    const h = harness();
    const plan = h.service.inspectHostCompactionCommand({
      threadId: h.state.session.threadId,
      commandId: 'reset-1',
      mode: 'reset',
    });
    expect(plan).toMatchObject({ shouldSchedule: false, events: [] });
    h.state.context.pendingCompaction = { compactionId: 'pending', reason: 'manual' } as never;
    expect(
      h.service.inspectHostCompactionCommand({
        threadId: h.state.session.threadId,
        commandId: 'reset-2',
        mode: 'reset',
      }).events,
    ).toEqual([]);
    expect(h.writes()).toBe(0);
  });

  test('never dispatches an unsafe plan before any caller commits it', async () => {
    const h = harness();
    const plan = h.service.inspectHostCompactionCommand({
      threadId: h.state.session.threadId,
      commandId: 'compact-2',
      mode: 'manual',
    });
    await expect(
      h.service.executeCommittedHostCompaction(h.state.session.threadId, plan),
    ).resolves.toEqual([]);
    expect(h.writes()).toBe(0);
  });
});

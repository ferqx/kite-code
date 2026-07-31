import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyRemoteMcpArgumentsV1,
  createRemoteMcpEgressPermitV1,
  createRemoteMcpEgressReceiptV1,
  remoteMcpArgumentDigestV1,
} from '@/core/mcp';
import { createAgentKernel } from '@/core/runtime/kernel';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { LIMITED_RESOURCE_BUDGET_V1 } from '@/core/runtime/resource-budget';
import { createInitialRuntimeState, RUNTIME_STATE_SCHEMA_VERSION } from '@/core/runtime/state';
import { createRuntimeStore, RemoteMcpEgressNonceConflictError } from '@/core/runtime/store';

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`, { force: true });
    }
  }
});

describe('runtime schema v17-v21 migration', () => {
  test('preserves the v18 ledger while adding v19 waiter and terminal fields', () => {
    const path = join(tmpdir(), `kite-v18-v19-${crypto.randomUUID()}.db`);
    paths.push(path);
    let state = createInitialRuntimeState({ threadId: 'v18', userId: 'u', workspace: '/' });
    state = reduceRuntimeState(state, {
      type: 'resource_budget.configured',
      runId: 'v18-run',
      startedAt: '2026-07-30T00:00:00Z',
      deadlineAt: '2026-07-30T00:30:00Z',
      budget: LIMITED_RESOURCE_BUDGET_V1,
    });
    const budget = state.resourceBudget;
    if (budget.status !== 'active') throw new Error('expected active test ledger');
    const { waiters: _waiters, nextWaiterSequence: _sequence, ...v18Budget } = budget;
    const store = createRuntimeStore(path);
    store.saveSnapshot('v18', { ...state, schemaVersion: 18, resourceBudget: v18Budget });
    store.close();

    const kernel = createAgentKernel({
      threadId: 'v18',
      userId: 'u',
      workspace: '/',
      storePath: path,
    });
    expect(kernel.getState()).toMatchObject({
      schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      resourceBudget: {
        status: 'active',
        runId: 'v18-run',
        waiters: {},
        nextWaiterSequence: 0,
      },
    });
    expect(kernel.getState().terminalOutcome).toBeUndefined();
    kernel.close();
  });

  test('upgrades a v20 snapshot to v21 without inventing egress decisions', () => {
    const path = join(tmpdir(), `kite-v19-v20-${crypto.randomUUID()}.db`);
    paths.push(path);
    const state = createInitialRuntimeState({ threadId: 'v19', userId: 'u', workspace: '/' });
    state.tools.calls.fetch = {
      toolCallId: 'fetch',
      modelMessageId: 'model',
      name: 'web_fetch',
      args: { url: 'https://example.com' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('fetch');
    const store = createRuntimeStore(path);
    store.saveSnapshot('v19', { ...state, schemaVersion: 20 });
    store.close();

    const kernel = createAgentKernel({
      threadId: 'v19',
      userId: 'u',
      workspace: '/',
      storePath: path,
    });
    expect(kernel.getState().schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);
    expect(kernel.getState().tools.calls.fetch?.networkDecisions).toBeUndefined();
    expect(kernel.getState().tools.calls.fetch?.remoteMcpEgressDecisions).toBeUndefined();
    kernel.close();
  });

  test('retains one redacted MCP egress receipt idempotently on the owning call', () => {
    let state = createInitialRuntimeState({ threadId: 'v21', userId: 'u', workspace: '/' });
    state.tools.calls.remote = {
      toolCallId: 'remote',
      modelMessageId: 'model',
      name: 'mcp__docs__search',
      args: { query: 'raw content must not enter receipt' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    const content = classifyRemoteMcpArgumentsV1({ query: 'raw content must not enter receipt' });
    const decision = createRemoteMcpEgressReceiptV1({
      enabled: false,
      request: {
        transport: 'http',
        serverIdentity: 'docs',
        endpointRevision: 'endpoint-v1',
        toolRevision: 'tool-v1',
        invocationId: 'invocation',
        toolCallId: 'remote',
        argumentDigest: remoteMcpArgumentDigestV1({
          query: 'raw content must not enter receipt',
        }),
        content,
      },
    });
    const event = { type: 'mcp.egress_decided' as const, toolCallId: 'remote', decision };
    state = reduceRuntimeState(state, event);
    state = reduceRuntimeState(state, event);
    expect(state.tools.calls.remote?.remoteMcpEgressDecisions).toHaveLength(1);
    expect(JSON.stringify(state.tools.calls.remote?.remoteMcpEgressDecisions)).not.toContain(
      'raw content',
    );
  });

  test('rejects a still-live MCP egress nonce after the Runtime Store is reopened', () => {
    const path = join(tmpdir(), `kite-v21-egress-nonce-${crypto.randomUUID()}.db`);
    paths.push(path);
    const args = { query: 'content stays outside the receipt' };
    const request = {
      transport: 'http' as const,
      serverIdentity: 'docs',
      endpointRevision: 'endpoint-v1',
      toolRevision: 'tool-v1',
      invocationId: 'invocation-v1',
      toolCallId: 'remote-call',
      argumentDigest: remoteMcpArgumentDigestV1(args),
      content: classifyRemoteMcpArgumentsV1(args),
    };
    const permit = createRemoteMcpEgressPermitV1({
      request,
      nonce: 'restart-replay-nonce',
      approvedAt: new Date('2026-08-01T00:00:00.000Z'),
      expiresAt: new Date('2026-08-01T00:04:00.000Z'),
    });
    const decision = createRemoteMcpEgressReceiptV1({
      enabled: true,
      request,
      permit,
      now: new Date('2026-08-01T00:01:00.000Z'),
    });
    expect(decision).toMatchObject({ admitted: true, reason: 'permit_consumed' });
    const event = { type: 'mcp.egress_decided' as const, toolCallId: 'remote-call', decision };

    const first = createRuntimeStore(path);
    first.appendEvents('nonce-owner', [event]);
    first.close();

    const reopened = createRuntimeStore(path);
    expect(() => reopened.appendEvents('nonce-replay', [event])).toThrow(
      RemoteMcpEgressNonceConflictError,
    );
    expect(reopened.loadEventsStrict('nonce-owner')).toHaveLength(1);
    expect(reopened.loadEventsStrict('nonce-replay')).toHaveLength(0);
    reopened.close();
  });
});

import { expect, test } from 'bun:test';
import { pathToFileURL } from 'node:url';
import { type AgentRuntime, createRuntime } from '@kite-ai/agent';
import type { Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { createWebSearchTest, type WebSearchTestRoute } from '../../src/web-search-test';

const set = {
  userEtag: '1'.repeat(64),
  workspaceEtag: null,
  explicitDigest: '2'.repeat(64),
  effectiveDigest: '3'.repeat(64),
};
const binding = '4'.repeat(64);
const obj = (v: unknown): Record<string, Json> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : {};

async function fixture() {
  const root = temporaryDirectory('kite-search-test-action-');
  const profile = selectProfile({ dataRoot: root, profile: 'owned' });
  privateDirectory(profile.profilePath);
  let runtime: AgentRuntime;
  let current = set;
  let mode: 'native' | 'provider' = 'native';
  let observed = true;
  let permitted = true;
  const calls: string[] = [];
  let resolutions = 0;
  let onResolve: (() => void) | undefined;
  let deferred = false;
  let cancelled = false;
  const action = createWebSearchTest({
    runtime: () => runtime,
    async readSettings(storeId) {
      return {
        storeId,
        readSet: current,
        webSearch: { mode: 'auto' },
        searchProviders: [],
        errors: [],
      };
    },
    async resolveRoute(input): Promise<WebSearchTestRoute> {
      expect(input.subjectId).toBe('owner');
      expect(input.workspaceId).toBe('w');
      resolutions++;
      onResolve?.();
      return {
        route: mode,
        provider: 'owned',
        bindingDigest: binding,
        async search(query, signal, id) {
          expect(query).toBe('Kite web search connectivity test');
          calls.push(id);
          if (deferred) {
            await new Promise<void>((_, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  cancelled = true;
                  reject(Error('fixture-abort'));
                },
                { once: true },
              );
            });
          }
          return {
            observed,
            sources:
              mode === 'native'
                ? [
                    { url: 'https://example.test/article', title: 'A source' },
                    { url: 'file:///fixture-secret-path', title: 'invalid' },
                  ]
                : [],
          };
        },
      };
    },
  });
  const open = async () =>
    createRuntime({
      store: await openSqliteStore(profile),
      extensions: [action.extension],
      permissions: {
        authorize: async () => ({
          allowed: permitted,
          revision: 'owned',
          reason: permitted ? undefined : 'denied',
        }),
      },
    });
  runtime = await open();
  const expectedStoreId = (await runtime.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'test',
    rootUri: pathToFileURL(root).href,
  });
  for (const sessionId of ['s', 'other'])
    await runtime.createSession({
      expectedStoreId,
      sessionId,
      workspaceId: 'w',
      commandId: `create-${sessionId}`,
      subjectId: 'owner',
      title: 'test',
    });
  const identity = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  const run = (commandId: string, expectedReadSet = set) =>
    action.run({ ...identity, commandId, expectedReadSet, signal: new AbortController().signal });
  async function result(id: string) {
    await runtime.waitForCommand(id, { timeoutMs: 5000 });
    const command = await runtime.getCommand(id);
    const executionId = obj(command?.receipt).executionId;
    if (typeof executionId !== 'string') throw Error('fixture_missing_execution');
    return (await runtime.getExecution(executionId))!;
  }
  return {
    identity,
    action,
    run,
    result,
    calls,
    get resolutions() {
      return resolutions;
    },
    get cancelled() {
      return cancelled;
    },
    qualify: (options: Partial<typeof identity & { bindingDigest: string }> = {}) =>
      action.isNativeQualified({ ...identity, bindingDigest: binding, ...options }),
    provider() {
      mode = 'provider';
      observed = false;
    },
    unobserved() {
      observed = false;
    },
    deny() {
      permitted = false;
    },
    change() {
      current = { ...set, userEtag: 'a'.repeat(64) };
    },
    driftBeforeSend() {
      onResolve = () => {
        if (resolutions === 2) current = { ...set, userEtag: 'a'.repeat(64) };
      };
    },
    pause() {
      deferred = true;
    },
    async cancel(id: string) {
      await runtime.cancelExecution({ ...identity, commandId: 'cancel', executionId: id });
    },
    async reopen() {
      await runtime.close();
      runtime = await open();
    },
    async close() {
      await runtime.close();
      removeTemporaryDirectory(root);
    },
  };
}

test('explicit native search qualifies only its original observed binding, across restart and retry', async () => {
  const f = await fixture();
  try {
    expect(await f.qualify()).toBe(false);
    const foreign = await f.action
      .run({
        ...f.identity,
        subjectId: 'foreign',
        commandId: 'unauthorized',
        expectedReadSet: set,
        signal: new AbortController().signal,
      })
      .catch((e: Error) => e);
    expect(foreign instanceof Error && foreign.message === 'host_control_scope_denied').toBe(true);
    expect(f.resolutions).toBe(0);
    await f.run('one');
    const execution = await f.result('one');
    expect(execution.status).toBe('succeeded');
    expect(f.calls).toEqual([execution.id]);
    expect(obj(execution.result).details).toEqual({
      route: 'native',
      provider: 'owned',
      observed: true,
      sources: [{ url: 'https://example.test/article', title: 'A source' }],
    });
    await f.reopen();
    f.change();
    expect((await f.run('one')).id).toBe('one');
    expect(f.calls).toEqual([execution.id]);
    expect(await f.qualify()).toBe(true);
    for (const mismatch of [
      { bindingDigest: 'a'.repeat(64) },
      { sessionId: 'other' },
      { subjectId: 'someone-else' },
    ])
      expect(await f.qualify(mismatch)).toBe(false);
    const conflict = await f
      .run('one', { ...set, userEtag: 'a'.repeat(64) })
      .catch((e: Error) => e);
    expect(conflict instanceof Error && conflict.message === 'command_conflict').toBe(true);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('empty provider result succeeds; native response without observed search is unqualified', async () => {
  const f = await fixture();
  try {
    f.unobserved();
    await f.run('native');
    const unobserved = await f.result('native');
    expect(unobserved.status).toBe('failed');
    expect(obj(unobserved.result).content).toBe('search_not_performed');
    expect(await f.qualify()).toBe(false);
    f.provider();
    await f.run('provider');
    const provider = await f.result('provider');
    expect(provider.status).toBe('succeeded');
    expect(obj(provider.result).details).toEqual({
      route: 'provider',
      provider: 'owned',
      observed: false,
      sources: [],
    });
    expect(await f.qualify()).toBe(false);
    expect(f.calls).toEqual([unobserved.id, provider.id]);
  } finally {
    await f.close();
  }
});

test('policy denial and last-moment configuration drift each stop the explicit request before sending', async () => {
  const f = await fixture();
  try {
    f.deny();
    await f.run('denied');
    expect((await f.result('denied')).status).toBe('failed');
    expect(f.calls).toEqual([]);
    expect(await f.qualify()).toBe(false);
  } finally {
    await f.close();
  }
  const drift = await fixture();
  try {
    drift.driftBeforeSend();
    await drift.run('drift');
    const result = await drift.result('drift');
    expect(result.status).toBe('failed');
    expect(obj(result.result).content).toBe('configuration_read_set_conflict');
    expect(drift.calls).toEqual([]);
    expect(await drift.qualify()).toBe(false);
  } finally {
    await drift.close();
  }
});

test('cancelling an in-flight explicit search does not prove an effect or replay the request', async () => {
  const f = await fixture();
  try {
    f.pause();
    await f.run('slow');
    const end = Date.now() + 4000;
    while (!f.calls.length && Date.now() < end) await Bun.sleep(5);
    expect(f.calls).toHaveLength(1);
    await f.cancel(f.calls[0]!);
    const result = await f.result('slow');
    expect(['outcome_unknown', 'cancelled']).toContain(result.status);
    expect(f.cancelled).toBe(true);
    expect(await f.qualify()).toBe(false);
    await f.run('slow');
    expect(f.calls).toEqual([result.id]);
  } finally {
    await f.close();
  }
});

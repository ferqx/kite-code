import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import type { Extension } from '@kite-ai/agent/extensions';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import {
  type AgentClient,
  createClient,
  type ExtensionCatalogue,
  type PublicView,
} from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { NativeCaller } from '../../electron/native-caller';
import type {
  NativeExtensionChunk,
  NativeExtensionHead,
  NativeExtensionSubmission,
  NativeExtensionsRequest,
} from '../../src/extensions-bridge';
import type { NativeState } from '../../src/native-bridge';
import { memoryPrivateData } from '../private-data.fixture';

test('Native formal extensions caller completes mini-review through real SQLite, HTTP and Client without replaying read or cold intents', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-native-extensions-main-'));
  const fixture = (await import(
    join(import.meta.dir, '../../../../tests/fixtures/extensions/mini-review/src/index.ts')
  )) as {
    createMiniReview(): { extension: Extension; readonly analyses: number };
  };
  const review = fixture.createMiniReview();
  const profile = resolveProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  const store = await openSqliteStore(profile);
  const model = createFixedModel([
    [
      { type: 'text_delta', text: 'A durable source result. 雪🙂' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
  ]);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    extensions: [review.extension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned' };
      },
    },
  });
  const storeId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'Owned',
    rootUri: `file://${root}/`,
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    subjectId: 'owner',
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'Review',
  });
  const service = await startService({
    runtime,
    buildId: 'native-review',
    subjectId: 'owner',
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['commands', 'extension_queries', 'extensions_actions', 'public_views'],
    },
  });
  const wire: { method: string; path: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(service.endpoint))
        wire.push({
          method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
          path: new URL(url).pathname,
        });
      return originalFetch(input, init);
    },
    originalFetch,
  );
  let drop = false;
  let delayedQuery: { arrived(): void; released: Promise<void> } | undefined;
  const tracked = new Proxy(client, {
    get(target, property) {
      if (property === 'queryExtension')
        return async (...args: Parameters<AgentClient['queryExtension']>) => {
          const delay = delayedQuery;
          const result = await target.queryExtension(...args);
          if (delay) {
            delay.arrived();
            await delay.released;
          }
          return result;
        };
      if (property === 'invokeExtension')
        return async (...args: Parameters<AgentClient['invokeExtension']>) => {
          const result = await target.invokeExtension(...args);
          if (drop) {
            drop = false;
            throw Error('owned_reply_lost');
          }
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const data = memoryPrivateData();
  let caller: NativeCaller | undefined;
  const posts = () => wire.filter((entry) => entry.method === 'POST').length;
  const send = (request: NativeExtensionsRequest) => caller!.invoke(request);
  async function select() {
    const attached = (await caller!.invoke({ method: 'attach' })) as NativeState;
    await caller!.invoke({ method: 'select', generation: attached.generation, sessionId: 's' });
    const state = caller!.state();
    expect(state.selection?.canReadExtensions).toBe(true);
    expect(state.selection?.canInvokeExtensions).toBe(true);
    return state;
  }
  async function body<T>(head: NativeExtensionHead): Promise<T> {
    const chunks: Buffer[] = [];
    let offset = 0;
    do {
      const chunk = (await send({
        method: 'extensions.read',
        generation: head.scope.generation,
        readId: head.readId,
        offset,
        limit: 97,
      })) as NativeExtensionChunk;
      expect(chunk.offset).toBe(offset);
      chunks.push(Buffer.from(chunk.data, 'base64'));
      offset = chunk.nextOffset;
      if (chunk.eof) break;
    } while (offset < head.bodyBytes);
    const bytes = Buffer.concat(chunks);
    expect(bytes.length).toBe(head.bodyBytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(head.sha256);
    await send({
      method: 'extensions.close',
      generation: head.scope.generation,
      readId: head.readId,
    });
    return JSON.parse(bytes.toString()) as T;
  }
  try {
    await client.connect();
    await client.startRun('s', {
      kind: 'run.start',
      expectedStoreId: storeId,
      commandId: 'source',
      content: 'Source',
    });
    await runtime.waitForCommand('source');
    const source = await client.getView('s');
    const run = source.runs[0]!;
    const execution = source.executions.find((entry) => entry.kind === 'model')!;
    expect(execution.status).toBe('succeeded');
    caller = new NativeCaller(tracked, () => {}, data);
    const state = await select();
    const generation = state.generation;
    const head = (await send({
      method: 'extensions.open',
      generation,
      readId: 'catalogue',
      viewSelection: state.selection!.viewSelection!,
      historyEpoch: state.historyEpoch!,
    })) as NativeExtensionHead;
    const beforeReads = posts();
    const catalogue = await body<ExtensionCatalogue[]>(head);
    expect(
      catalogue
        .find((entry) => entry.extensionId === review.extension.id)
        ?.actions.map((entry) => entry.id),
    ).toEqual([`${review.extension.id}.analyze`, `${review.extension.id}.mark`]);
    const input = { businessKey: 'first', sourceRunId: run.id, sourceExecutionId: execution.id };
    const first: NativeExtensionsRequest = {
      method: 'extensions.invoke',
      generation,
      observationId: head.observationId,
      commandId: 'analyze',
      extensionId: review.extension.id,
      actionId: `${review.extension.id}.analyze`,
      definitionVersion: '1',
      input,
    };
    const query = async (readId: string) => {
      const result = (await send({
        method: 'extensions.query',
        generation,
        readId,
        observationId: head.observationId,
        extensionId: review.extension.id,
        queryId: `${review.extension.id}.results`,
        input: {},
      })) as NativeExtensionHead;
      return { head: result, views: await body<PublicView[]>(result) };
    };
    expect((await query('empty')).views).toEqual([]);
    expect(posts()).toBe(beforeReads);
    expect(['accepted', 'applied']).toContain(
      ((await send(first)) as NativeExtensionSubmission).commandStatus!,
    );
    await runtime.waitForCommand('analyze');
    const found = (await send({
      method: 'extensions.lookup',
      generation,
      commandId: 'analyze',
    })) as NativeExtensionSubmission;
    const command = await client.getCommand('analyze');
    expect(found).toMatchObject({
      commandStatus: 'applied',
      outcome: 'succeeded',
      execution: {
        id: (command.receipt as { executionId: string }).executionId,
        status: 'succeeded',
      },
    });
    expect(review.analyses).toBe(1);
    const beforeRepeat = posts();
    await send(first);
    expect(posts()).toBe(beforeRepeat);
    expect(review.analyses).toBe(1);
    const result = await query('findings');
    expect(result.views).toHaveLength(1);
    expect(result.views[0]!.payload).toEqual({
      businessKey: 'first',
      findings: ['Check the saved source result.'],
      marked: false,
      source: {
        runId: run.id,
        executionId: execution.id,
        resultRevision: execution.resultRevision,
        result: execution.result,
      },
    });
    const actionIndex = result.views[0]!.actions.findIndex((action) =>
      action.actionId.endsWith('.mark'),
    );
    const mark = result.views[0]!.actions[actionIndex]!;
    await send({
      method: 'extensions.invoke',
      generation,
      observationId: result.head.observationId,
      commandId: 'mark',
      extensionId: review.extension.id,
      actionId: mark.actionId,
      definitionVersion: mark.definitionVersion,
      input: mark.input,
      viewIndex: 0,
      actionIndex,
    });
    await runtime.waitForCommand('mark');
    expect((await query('marked')).views[0]!.payload).toMatchObject({ marked: true });
    expect(review.analyses).toBe(1);
    drop = true;
    const second = { ...first, commandId: 'reanalyze', input: { ...input, businessKey: 'second' } };
    expect(((await send(second)) as NativeExtensionSubmission).outcome).toBe('unknown');
    await runtime.waitForCommand('reanalyze');
    const beforeLookup = posts();
    expect(
      (
        (await send({
          method: 'extensions.lookup',
          generation,
          commandId: 'reanalyze',
        })) as NativeExtensionSubmission
      ).outcome,
    ).toBe('succeeded');
    expect(posts()).toBe(beforeLookup);
    expect(review.analyses).toBe(2);
    expect((await query('two')).views).toHaveLength(2);
    let arrived!: () => void, release!: () => void;
    const arrival = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    delayedQuery = {
      arrived,
      released: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const late = send({
      method: 'extensions.query',
      generation,
      readId: 'late',
      observationId: head.observationId,
      extensionId: review.extension.id,
      queryId: `${review.extension.id}.results`,
      input: {},
    });
    const rejectedLate = late.then(
      () => null,
      (error: unknown) => error,
    );
    await arrival;
    await send({ method: 'extensions.release', generation });
    release();
    expect(await rejectedLate).toBeInstanceOf(Error);
    expect(((await rejectedLate) as Error).message).toBe('extensions_observation_unavailable');
    await expect(send(first)).rejects.toThrow('extensions_observation_unavailable');
    expect(posts()).toBe(beforeLookup);
    await caller.close();
    caller = new NativeCaller(tracked, () => {}, data);
    const cold = (await caller.invoke({ method: 'attach' })) as NativeState;
    const beforeCold = wire.length;
    expect(
      (
        (await send({
          method: 'extensions.lookup',
          generation: cold.generation,
          commandId: 'reanalyze',
        })) as NativeExtensionSubmission
      ).outcome,
    ).toBe('succeeded');
    expect(
      wire.slice(beforeCold).filter((entry) => entry.path === '/v1/commands/reanalyze'),
    ).toEqual([{ method: 'GET', path: '/v1/commands/reanalyze' }]);
    expect(posts()).toBe(beforeLookup);
    await caller.close();
    const foreign = new Proxy(tracked, {
      get(target, property) {
        return property === 'serverInfo'
          ? { ...target.serverInfo!, storeId: 'foreign-store' }
          : Reflect.get(target, property, target);
      },
    });
    caller = new NativeCaller(foreign, () => {}, data);
    const beforeForeign = wire.length;
    expect(
      (
        (await send({
          method: 'extensions.lookup',
          generation: 0,
          commandId: 'reanalyze',
        })) as NativeExtensionSubmission
      ).outcome,
    ).toBe('unknown');
    expect(wire.length).toBe(beforeForeign);
    expect(model.requests).toHaveLength(1);
    expect(review.analyses).toBe(2);
    expect(posts()).toBe(4);
    const final = await store.getView('s');
    expect(final.runs).toHaveLength(1);
    expect(final.executions.filter((entry) => entry.kind === 'tool')).toHaveLength(2);
  } finally {
    await caller?.close();
    client.disposeNetwork();
    globalThis.fetch = originalFetch;
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

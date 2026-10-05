import { expect, test } from 'bun:test';
import { ClientError } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  type ModelInputDirectory,
  type ModelInputPort,
  type ModelInputSnapshot,
  ModelInputs,
  readModelDirectory,
} from '../src/model-input';

function snapshot(id = 'm1', content = 'exact original'): ModelInputSnapshot {
  return {
    storeId: 'store',
    sessionId: 'session',
    rootSessionId: 'session',
    runId: 'run',
    executionId: id,
    originCommandId: 'command',
    rootWorkCommandId: 'command',
    rootWorkSeq: '1',
    attempt: 1,
    status: 'succeeded',
    confirmation: 'succeeded',
    bodyHash: 'a'.repeat(64),
    bodyBytes: String(content.length),
    snapshotCursor: '1',
    metadata: {
      version: 1,
      adapter: { availability: 'unavailable', reason: 'not_recorded' },
      assembly: null,
      context: null,
      authorization: { availability: 'unavailable', reason: 'not_dispatched' },
    },
    request: {
      modelId: 'fixed',
      requestId: id,
      messages: [
        { role: 'system', content: 'original system' },
        { role: 'user', content },
      ],
      tools: [
        {
          id: 'neutral',
          definitionVersion: '2',
          description: 'whole tool',
          inputSchema: { type: 'object' },
        },
      ],
    },
  };
}
function directory(first: number, last: number, next: string | null = null): ModelInputDirectory {
  return {
    storeId: 'store',
    sessionId: 'session',
    rootSessionId: 'session',
    highWaterSeq: '201',
    upperSeq: '201',
    snapshotCursor: '1',
    items: Array.from({ length: last - first + 1 }, (_, i) => ({
      seq: String(first + i),
      sessionId: 'session',
      originCommandId: 'command',
      rootWorkCommandId: 'command',
      rootWorkSeq: '1',
      modelId: 'fixed',
      executionId: `m${first + i}`,
      runId: 'run',
      attempt: 1,
      status: 'succeeded',
      confirmation: 'succeeded',
    })),
    nextAfterSeq: next,
  };
}
function port(extra: Partial<ModelInputPort> = {}): ModelInputPort {
  return {
    serverInfo: {
      storeId: 'store',
      capabilities: ['model_inputs'],
      instanceId: 'instance',
      buildId: 'build',
      pageIdentity: 'a'.repeat(64),
      dataAvailability: 'available',
    },
    async listModelInputs() {
      return directory(1, 1);
    },
    async getModelInput(_s, id) {
      return snapshot(id);
    },
    ...extra,
  };
}
async function fixture(client: ModelInputPort) {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const old = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    old.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  async function render(sessionId = 'session', suspended = false, initialExecutionId?: string) {
    await act(async () =>
      root.render(
        <ModelInputs
          client={client}
          sessionId={sessionId}
          storeId="store"
          window={dom.window as unknown as Window}
          suspended={suspended}
          initialExecutionId={initialExecutionId}
        />,
      ),
    );
  }
  async function click(text: string) {
    const button = [...dom.window.document.querySelectorAll('button')].find(
      (b) => b.textContent === text || b.textContent?.startsWith(text),
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
  }
  await render();
  return {
    dom,
    render,
    click,
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of old) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('shared Inspector log navigation selects the original execution without reading, and replaces scope without a parent remount', async () => {
  const reads: string[] = [];
  let directories = 0;
  const f = await fixture(
    port({
      async listModelInputs() {
        directories++;
        return directory(1, 1);
      },
      async getModelInput(_session, id) {
        reads.push(id);
        return snapshot(id, `original ${id} body`);
      },
    }),
  );
  try {
    await f.render('session', false, 'm2');
    expect(reads).toEqual([]);
    expect(directories).toBe(0);
    expect(f.dom.window.document.body.textContent).toContain('complete sensitive input of m2');
    await f.click('Confirm read original input');
    expect(reads).toEqual(['m2']);
    expect(f.dom.window.document.body.textContent).toContain('original m2 body');
    await f.render('session', false, 'm3');
    expect(reads).toEqual(['m2']);
    expect(f.dom.window.document.body.textContent).not.toContain('original m2 body');
    expect(f.dom.window.document.body.textContent).toContain('complete sensitive input of m3');
    await f.render('other', false);
    expect(f.dom.window.document.body.textContent).not.toContain('complete sensitive input');
    expect(reads).toEqual(['m2']);
  } finally {
    await f.close();
  }
});

test('201 calls use frozen upper; changing observation cursor is not a directory identity conflict', async () => {
  const queries: { afterSeq?: string; upperSeq?: string }[] = [];
  const client = port({
    async listModelInputs(_session, query = {}) {
      queries.push(query);
      return query.afterSeq === '0'
        ? directory(1, 200, '200')
        : { ...directory(201, 201), snapshotCursor: '9' };
    },
  });
  const result = await readModelDirectory(client, 'session', 'store', new AbortController().signal);
  expect(result.length).toBe(201);
  expect(result.at(-1)?.executionId).toBe('m201');
  expect(queries[1]?.upperSeq).toBe('201');
  expect(queries[1]?.afterSeq).toBe('200');
});

test('duplicate directory/scope/upper/cursor cannot publish a partial call list', async () => {
  for (const changed of [
    { storeId: 'wrong' },
    { sessionId: 'foreign' },
    { upperSeq: '202' },
    { nextAfterSeq: '0' },
    { items: [...directory(1, 1).items, ...directory(1, 1).items] },
  ]) {
    await expect(
      readModelDirectory(
        port({
          async listModelInputs() {
            return { ...directory(1, 1), ...changed };
          },
        }),
        'session',
        'store',
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  }
});

test('sensitive confirmation gates all body reads; full >17MiB original tail/system/tool schema survive DOM and close clears body', async () => {
  let reads = 0;
  const full = `${'x'.repeat(17 * 1024 * 1024 + 1)}EXACT ORIGINAL TAIL`;
  const f = await fixture(
    port({
      async getModelInput(_session, id) {
        reads++;
        return snapshot(id, full);
      },
    }),
  );
  try {
    await f.click('Model calls');
    expect(reads).toBe(0);
    await f.click('m1');
    expect(reads).toBe(0);
    await f.click('Confirm read original input');
    expect(reads).toBe(1);
    const text = f.dom.window.document.body.textContent!;
    expect(text).toContain(full);
    expect(text).toContain('original system');
    expect(text).toContain('whole tool');
    expect(text).toContain('"type": "object"');
    expect(text).toContain('Adapter and request settings unavailable · not_recorded');
    expect(text).toContain('Dispatch authorization unavailable · not_dispatched');
    await f.click('Close Model inspector');
    expect(f.dom.window.document.body.textContent).not.toContain('EXACT ORIGINAL TAIL');
  } finally {
    await f.close();
  }
});

test('late original body cannot cover new session; hide aborts owned read without any cancel or client disposal', async () => {
  let resolve!: (value: ModelInputSnapshot) => void;
  let signal: AbortSignal | undefined;
  const f = await fixture(
    port({
      getModelInput(_s, _id, options) {
        signal = options?.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    }),
  );
  try {
    await f.click('Model calls');
    await f.click('m1');
    await f.click('Confirm read original input');
    Object.defineProperty(f.dom.window.document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    await act(async () => {
      f.dom.window.document.dispatchEvent(new f.dom.window.Event('visibilitychange'));
    });
    expect(signal?.aborted).toBe(true);
    await f.render('other');
    await act(async () => resolve(snapshot('m1', 'LATE PRIVATE BODY')));
    expect(f.dom.window.document.body.textContent).not.toContain('LATE PRIVATE BODY');
  } finally {
    await f.close();
  }
});

test('wrong exact identity and unavailable capability never show another call or fabricate settings', async () => {
  const f = await fixture(
    port({
      async getModelInput() {
        return { ...snapshot('other', 'FOREIGN BODY'), storeId: 'foreign' };
      },
    }),
  );
  try {
    await f.click('Model calls');
    await f.click('m1');
    await f.click('Confirm read original input');
    expect(f.dom.window.document.body.textContent).not.toContain('FOREIGN BODY');
    expect(f.dom.window.document.querySelector('[role=alert]')?.textContent).toContain(
      'model_input_identity_conflict',
    );
  } finally {
    await f.close();
  }
  const absent = await fixture(
    port({
      serverInfo: { ...port().serverInfo!, capabilities: [] },
      async getModelInput() {
        throw new ClientError('should_not_read');
      },
    }),
  );
  try {
    expect(absent.dom.window.document.querySelector('button')?.disabled).toBe(true);
    expect(absent.dom.window.document.body.textContent).toContain('capability unavailable');
  } finally {
    await absent.close();
  }
});

test('pending body read is single flight; suspended document aborts and late completion remains cleared; failure has no prefix', async () => {
  let reads = 0;
  let signal: AbortSignal | undefined;
  let resolve!: (value: ModelInputSnapshot) => void;
  const f = await fixture(
    port({
      getModelInput(_s, _id, options) {
        reads++;
        signal = options?.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    }),
  );
  try {
    await f.click('Model calls');
    await f.click('m1');
    await f.click('Confirm read original input');
    await f.click('Confirm read original input');
    expect(reads).toBe(1);
    await f.render('session', true);
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve(snapshot('m1', 'ABORTED BODY')));
    expect(f.dom.window.document.body.textContent).not.toContain('ABORTED BODY');
  } finally {
    await f.close();
  }
  const failed = await fixture(
    port({
      async getModelInput() {
        throw new ClientError('model_input_hash_mismatch');
      },
    }),
  );
  try {
    await failed.click('Model calls');
    await failed.click('m1');
    await failed.click('Confirm read original input');
    expect(failed.dom.window.document.querySelector('[role=alert]')?.textContent).toContain(
      'model_input_hash_mismatch',
    );
    expect(failed.dom.window.document.body.textContent).not.toContain('original system');
  } finally {
    await failed.close();
  }
});

test('original metadata renders frozen settings/assembly/source/policy, never later configuration', async () => {
  const original = snapshot();
  original.metadata = {
    version: 1,
    adapter: {
      availability: 'available',
      adapterId: 'kite.sdk',
      adapterVersion: '1',
      provider: {
        availability: 'available',
        family: 'openai-compatible',
        modelId: 'original-remote',
      },
      settings: {
        temperature: 0.25,
        maxOutputTokens: 333,
        maxRetries: 0,
        maxSteps: 1,
        allowSystemInMessages: true,
      },
      transformation: { id: 'kite.sdk.messages', version: '1' },
    },
    assembly: {
      extensions: [{ id: 'original.extension', version: '8' }],
      tools: [{ id: 'neutral', definitionVersion: '2', extensionId: 'original.extension' }],
      capabilitySnapshotDigest: 'a'.repeat(64),
    },
    context: {
      transformationId: 'kite.model-request',
      transformationVersion: '1',
      messageOrder: 'request.messages',
      sourceOrder: 'request.messages[].sourceIds',
      sources: [{ id: 'original-source', digest: 'original-digest' }],
    },
    authorization: {
      availability: 'available',
      allowed: true,
      revision: 'original-policy',
      definitionVersion: '1',
      inputDigest: 'b'.repeat(64),
      controlReads: [{ kind: 'workspace.trust', scope: 'workspace:w', revision: '7' }],
      policy: {
        namespace: 'builtin.permissions',
        version: '1',
        data: { mode: 'ask', workspaceTrust: true },
      },
    },
  };
  let reads = 0;
  const f = await fixture(
    port({
      async getModelInput() {
        reads++;
        return structuredClone(original);
      },
    }),
  );
  try {
    await f.click('Model calls');
    await f.click('m1');
    expect(f.dom.window.document.body.textContent).not.toContain('original-policy');
    await f.click('Confirm read original input');
    const text = f.dom.window.document.body.textContent!;
    expect(text).toContain('original-remote');
    expect(text).toContain('"temperature": 0.25');
    expect(text).toContain('"maxOutputTokens": 333');
    expect(text).toContain('original.extension');
    expect(text).toContain('original-source');
    expect(text).toContain('original-digest');
    expect(text).toContain('original-policy');
    expect(text).toContain('"mode": "ask"');
    expect(text).toContain('"revision": "7"');
    expect(text).toContain('Current configuration is not substituted');
    expect(reads).toBe(1);
  } finally {
    await f.close();
  }
});

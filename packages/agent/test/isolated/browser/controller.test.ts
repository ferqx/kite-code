import { afterEach, expect, test } from 'bun:test';
import type { JobContext, Json, ToolContext } from '../../../src/extensions';
import {
  type BrowserController,
  BrowserTransportError,
  createBrowserController,
  createBrowserExtension,
  createUnavailableBrowserController,
  type NativeBrowserTransport,
} from '../../../src/tools/browser';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const barrier = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function transport(
  options: {
    pendingReady?: boolean;
    stopConfirmed?: boolean;
    request?: (command: Record<string, Json>) => Promise<Json>;
  } = {},
) {
  const ready = barrier<void>(),
    completion = barrier<{ confirmed: boolean }>();
  if (!options.pendingReady) ready.resolve();
  const requests: Record<string, Json>[] = [];
  let closes = 0,
    captures = 0,
    disposes = 0;
  const native: NativeBrowserTransport = {
    ready: ready.promise,
    completion: completion.promise,
    async request(command): Promise<Json> {
      requests.push(command);
      return options.request
        ? options.request(command)
        : {
            success: true,
            data: command.action === 'snapshot' ? { snapshot: '- button "Submit" [ref=e1]' } : {},
          };
    },
    async capture() {
      captures++;
      return {
        frame: { mimeType: 'image/jpeg', data: 'bounded-jpeg', width: 960, height: 540 },
        annotations: [
          {
            ref: '@e1',
            number: 1,
            role: 'button',
            name: 'Submit',
            box: { x: 10, y: 20, width: 60, height: 30 },
          },
        ],
      };
    },
    async close() {
      closes++;
      const end = { confirmed: options.stopConfirmed !== false };
      completion.resolve(end);
      ready.resolve();
      return end;
    },
    async dispose() {
      disposes++;
    },
  };
  return {
    native,
    requests,
    ready,
    completion,
    get closes() {
      return closes;
    },
    get captures() {
      return captures;
    },
    get disposes() {
      return disposes;
    },
  };
}
async function started(options: Parameters<typeof transport>[0] = {}, captureIntervalMs = 60000) {
  const fake = transport(options),
    abort = new AbortController();
  let factories = 0;
  const controller = createBrowserController({
    createTransport() {
      factories++;
      return fake.native;
    },
    captureIntervalMs,
  });
  const context: JobContext = {
    sessionId: 'session-one',
    executionId: 'job-one',
    signal: abort.signal,
  };
  const handle = await controller.job.start(
    { browserId: 'browser-one', url: 'https://example.test/' },
    context,
  );
  cleanups.push(async () => {
    await controller.job.cancel(handle);
  });
  return {
    controller,
    fake,
    abort,
    handle,
    context,
    get factories() {
      return factories;
    },
  };
}
const current = (controller: BrowserController) => {
  const view = controller.view('session-one')!;
  return { browserId: view.browserId, generation: view.generation };
};
async function snapshot(controller: BrowserController) {
  return controller.command(
    'session-one',
    current(controller),
    { action: 'snapshot' },
    new AbortController().signal,
  );
}
function toolContext() {
  const values = new Map<string, Record<string, unknown>>();
  let revision = 0;
  const context = {
    sessionId: 'session-one',
    executionId: 'tool-one',
    signal: new AbortController().signal,
    records: {
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async write(value: Record<string, unknown>) {
        const existing = values.get(String(value.key));
        if ((existing?.revision ?? null) !== value.expectedRevision)
          throw Error('revision_conflict');
        const saved = { ...value, revision: String(++revision) };
        values.set(String(value.key), saved);
        return saved;
      },
    },
  } as unknown as ToolContext;
  return { context, values };
}

test('factories and read-only Query acquire no resource; unavailable is explicit and bounded', async () => {
  let starts = 0;
  const controller = createBrowserController({
    createTransport() {
      starts++;
      throw Error('must_not_start');
    },
  });
  const extension = createBrowserExtension({ controller });
  expect(extension.lifecycle).toBeUndefined();
  expect(extension.jobs?.map((job) => job.id)).toEqual(['browser.session']);
  expect(extension.tools?.map((tool) => tool.id)).toEqual([
    'browser.open',
    'browser.navigate',
    'browser.snapshot',
    'browser.click',
    'browser.fill',
    'browser.scroll',
    'browser.close',
  ]);
  expect(await extension.queries![0]!.execute({}, { sessionId: 'session-one' } as never)).toEqual(
    [],
  );
  expect(starts).toBe(0);
  const unavailable = createBrowserExtension({
    controller: createUnavailableBrowserController('browser_native_platform_unavailable'),
  });
  const views = await unavailable.queries![0]!.execute({}, { sessionId: 'session-one' } as never);
  expect(views[0]?.payload).toMatchObject({
    state: 'unavailable',
    error: 'browser_native_platform_unavailable',
    frame: null,
  });
  expect(views[0]?.actions).toEqual([]);
  expect(JSON.stringify(views).length).toBeLessThan(1024 * 1024);
});

test('ordinary attached Job owns launch, bounded views and actual stop/dispose; panel reads do not close', async () => {
  const fixture = await started();
  await snapshot(fixture.controller);
  expect(fixture.factories).toBe(1);
  expect(fixture.fake.requests.slice(0, 3).map((command) => command.action)).toEqual([
    'launch',
    'viewport',
    'navigate',
  ]);
  expect(fixture.fake.requests[0]).toEqual({
    action: 'launch',
    headless: true,
    engine: 'chrome',
    webmcp: false,
  });
  expect(fixture.controller.view('another-session')).toBeNull();
  const extension = createBrowserExtension({ controller: fixture.controller });
  const [view] = await extension.queries![0]!.execute({}, { sessionId: 'session-one' } as never);
  expect(view?.payload).toMatchObject({
    state: 'agent',
    frame: { mimeType: 'image/jpeg', width: 960, height: 540 },
    annotations: [{ ref: '@e1' }],
  });
  expect(fixture.fake.closes).toBe(0);
  const iterator = fixture.controller.job.observe(fixture.handle)[Symbol.asyncIterator]();
  expect((await iterator.next()).value.type).toBe('progress');
  expect(await fixture.controller.job.cancel(fixture.handle)).toEqual({ status: 'stopped' });
  expect((await iterator.next()).value).toMatchObject({ type: 'terminal', supervision: 'ended' });
  await fixture.controller.job.dispose(fixture.handle);
  expect(fixture.fake.disposes).toBe(1);
  cleanups.pop();
});

test('snapshot identity rejects foreign Session, old generation and stale element without dispatch', async () => {
  const { controller, fake } = await started();
  await snapshot(controller);
  const view = controller.view('session-one')!,
    target = current(controller),
    before = fake.requests.length;
  for (const [session, destination, seq] of [
    ['wrong', target, view.seq],
    ['session-one', { ...target, generation: 'old' }, view.seq],
    ['session-one', target, '0'],
  ] as const) {
    const result = await controller.command(
      session,
      destination,
      { action: 'click', ref: '@e1', seq },
      new AbortController().signal,
    );
    expect(result.outcome).toBe('failed');
  }
  expect(fake.requests.length).toBe(before);
  expect(
    (
      await controller.command(
        'session-one',
        target,
        { action: 'click', ref: '@e1', seq: view.seq },
        new AbortController().signal,
      )
    ).outcome,
  ).toBe('succeeded');
  expect(fake.requests.at(-1)).toEqual({ action: 'click', selector: '@e1' });
});

test('handoff fences queued model work before waiting for in-flight input and never uses native pause', async () => {
  const dispatch = barrier<void>(),
    release = barrier<Json>();
  const { controller, fake } = await started({
    request: async (command) => {
      if (command.action === 'click') {
        dispatch.resolve();
        return release.promise;
      }
      return { success: true, data: {} };
    },
  });
  await snapshot(controller);
  const target = current(controller),
    seq = controller.view('session-one')!.seq,
    signal = new AbortController().signal;
  const inFlight = controller.command(
    'session-one',
    target,
    { action: 'click', ref: '@e1', seq },
    signal,
  );
  await dispatch.promise;
  const handoff = controller.handoff('session-one', target, signal);
  expect(controller.view('session-one')?.state).toBe('pausing');
  const stale = controller.command(
    'session-one',
    target,
    { action: 'navigate', url: 'https://forbidden-repeat.test' },
    signal,
  );
  release.resolve({ success: true, data: {} });
  expect((await inFlight).outcome).toBe('succeeded');
  expect((await handoff).outcome).toBe('succeeded');
  expect((await stale).outcome).toBe('failed');
  expect(controller.view('session-one')?.state).toBe('human');
  const human = current(controller);
  expect(
    (
      await controller.command(
        'session-one',
        human,
        { action: 'scroll', direction: 'down', amount: 100 },
        signal,
        true,
      )
    ).outcome,
  ).toBe('succeeded');
  expect(
    (await controller.command('session-one', human, { action: 'snapshot' }, signal)).outcome,
  ).toBe('failed');
  expect((await controller.resume('session-one', human, signal)).outcome).toBe('succeeded');
  expect(controller.view('session-one')?.generation).not.toBe(human.generation);
  expect(fake.requests.some((value) => value.action === 'pause')).toBe(false);
  expect(fake.requests.some((value) => value.url === 'https://forbidden-repeat.test')).toBe(false);
});

test('ambiguous dispatch closes owned lifetime, records unknown and never repeats original effect', async () => {
  const fixture = await started({
    request: async (command) => {
      if (command.action === 'click') throw new BrowserTransportError('lost_reply', true);
      return { success: true, data: {} };
    },
  });
  await snapshot(fixture.controller);
  const { context } = toolContext(),
    extension = createBrowserExtension({ controller: fixture.controller });
  const click = extension.tools!.find((value) => value.id === 'browser.click')!;
  const input = {
    key: 'original',
    ...current(fixture.controller),
    seq: fixture.controller.view('session-one')!.seq,
    ref: '@e1',
  };
  expect((await click.execute(input, context)).outcome).toBe('outcome_unknown');
  expect((await click.execute(input, context)).outcome).toBe('outcome_unknown');
  expect(fixture.fake.requests.filter((value) => value.action === 'click')).toHaveLength(1);
  expect(fixture.fake.closes).toBe(1);
  expect(fixture.controller.view('session-one')?.state).toBe('outcome_unknown');
});

test('same key preserves intent; pending durable intent returns unknown with no replay', async () => {
  const fixture = await started();
  await snapshot(fixture.controller);
  const extension = createBrowserExtension({ controller: fixture.controller }),
    { context, values } = toolContext();
  const navigate = extension.tools!.find((value) => value.id === 'browser.navigate')!;
  const input = { key: 'one', ...current(fixture.controller), url: 'https://example.test/next' };
  expect((await navigate.execute(input, context)).outcome).toBe('succeeded');
  const count = fixture.fake.requests.length;
  expect((await navigate.execute(input, context)).outcome).toBe('succeeded');
  expect(
    (await navigate.execute({ ...input, url: 'https://different.test/' }, context)).content,
  ).toBe('browser_intent_conflict');
  const prior = values.get('intent/tool/one')!;
  values.set('intent/tool/one', {
    ...prior,
    value: { ...(prior.value as object), status: 'pending', result: undefined },
  });
  expect((await navigate.execute(input, context)).outcome).toBe('outcome_unknown');
  expect(fixture.fake.requests.length).toBe(count);
});

test('stop uncertainty is not a terminal stopped claim and keeps Job dispose blocked', async () => {
  const fixture = await started({ stopConfirmed: false });
  await snapshot(fixture.controller);
  expect(await fixture.controller.job.cancel(fixture.handle)).toEqual({ status: 'unknown' });
  const iterator = fixture.controller.job.observe(fixture.handle)[Symbol.asyncIterator]();
  await iterator.next();
  expect((await iterator.next()).value).toMatchObject({
    type: 'terminal',
    supervision: 'unknown',
    result: { outcome: 'outcome_unknown' },
  });
  await expect(fixture.controller.job.dispose(fixture.handle)).rejects.toThrow(
    'browser_cleanup_unconfirmed',
  );
  expect(fixture.fake.disposes).toBe(0);
});

test('cancellation during startup cannot escape owner or launch a later browser', async () => {
  const fixture = await started({ pendingReady: true });
  fixture.abort.abort();
  await fixture.controller.job.cancel(fixture.handle);
  fixture.fake.ready.resolve();
  await Promise.resolve();
  expect(fixture.fake.closes).toBe(1);
  expect(fixture.fake.requests).toHaveLength(0);
  await fixture.controller.job.dispose(fixture.handle);
  cleanups.pop();
});

test('open uses exact original ensure key with attached cancellation; URLs cannot request local file/eval/credentials', async () => {
  const controller = createUnavailableBrowserController(),
    extension = createBrowserExtension({ controller }),
    { context } = toolContext();
  const calls: unknown[] = [];
  Object.assign(context, {
    operations: {
      async ensure(value: unknown) {
        calls.push(value);
        return { executionId: 'original' };
      },
    },
  });
  const open = extension.tools![0]!;
  const input = { key: 'intent', url: 'https://example.test' };
  expect((await open.execute(input, context)).outcome).toBe('succeeded');
  expect((await open.execute(input, context)).outcome).toBe('succeeded');
  expect(calls).toEqual(
    [0, 1].map(() => ({
      key: 'intent',
      cancellation: 'attached',
      request: {
        kind: 'job',
        definitionId: 'browser.session',
        definitionVersion: '1',
        input: { browserId: 'intent', url: 'https://example.test/' },
      },
    })),
  );
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:password@example.test/',
  ])
    await expect(open.execute({ key: 'bad', url }, context)).rejects.toThrow('browser_url_denied');
  expect(calls).toHaveLength(2);
});

test('changing frame pixels do not invalidate stable refs, but observation failure clears all selection evidence', async () => {
  const fixture = await started({}, 100);
  await snapshot(fixture.controller);
  const original = fixture.fake.native.capture;
  let changing = 0;
  fixture.fake.native.capture = async (signal) => {
    const captured = await original(signal);
    return { ...captured, frame: { ...captured.frame, data: `animated-${++changing}` } };
  };
  const view = fixture.controller.view('session-one')!,
    target = current(fixture.controller);
  await fixture.controller.select('session-one', target, view.seq, '@e1');
  await Bun.sleep(160);
  expect(fixture.controller.view('session-one')!.seq).toBe(view.seq);
  expect(fixture.controller.view('session-one')!.frame!.seq).not.toBe(view.frame!.seq);
  expect(fixture.controller.view('session-one')!.selectedAnnotation?.ref).toBe('@e1');
  expect(
    (
      await fixture.controller.command(
        'session-one',
        target,
        { action: 'click', ref: '@e1', seq: view.seq },
        new AbortController().signal,
      )
    ).outcome,
  ).toBe('succeeded');
  const beforeFailure = fixture.controller.view('session-one')!;
  await fixture.controller.select('session-one', target, beforeFailure.seq, '@e1');
  fixture.fake.native.capture = async () => {
    throw Error('capture_unavailable');
  };
  await Bun.sleep(160);
  const failed = fixture.controller.view('session-one')!;
  expect(failed.frame).toBeNull();
  expect(failed.annotations).toEqual([]);
  expect(failed.selectedAnnotation).toBeNull();
  expect(failed.seq).not.toBe(beforeFailure.seq);
  const before = fixture.fake.requests.length;
  expect(
    (
      await fixture.controller.command(
        'session-one',
        target,
        { action: 'click', ref: '@e1', seq: beforeFailure.seq },
        new AbortController().signal,
      )
    ).outcome,
  ).toBe('failed');
  expect(fixture.fake.requests).toHaveLength(before);
});

test('startup navigation lost response remains outcome_unknown even when process cleanup is confirmed', async () => {
  const fixture = await started({
    request: async (command) => {
      if (command.action === 'navigate') throw new BrowserTransportError('reply_lost', true);
      return { success: true, data: {} };
    },
  });
  const iterator = fixture.controller.job.observe(fixture.handle)[Symbol.asyncIterator]();
  await iterator.next();
  expect((await iterator.next()).value).toMatchObject({
    type: 'terminal',
    supervision: 'ended',
    result: { outcome: 'outcome_unknown', details: { code: 'browser_startup_outcome_unknown' } },
  });
  expect(fixture.fake.closes).toBe(1);
  expect(fixture.fake.requests.filter((value) => value.action === 'navigate')).toHaveLength(1);
  await fixture.controller.job.dispose(fixture.handle);
  cleanups.pop();
});

test('browser owners and finite command admission have fixed bounds, independent of process-slot settings', async () => {
  let starts = 0;
  const controller = createBrowserController({
    createTransport() {
      starts++;
      return transport().native;
    },
    captureIntervalMs: 60000,
  });
  for (let index = 0; index < 8; index++) {
    const handle = await controller.job.start(
      { browserId: 'browser', url: 'https://example.test/' },
      {
        sessionId: `session-${index}`,
        executionId: `job-${index}`,
        signal: new AbortController().signal,
      },
    );
    cleanups.push(() => controller.job.cancel(handle));
  }
  await expect(
    controller.job.start(
      { browserId: 'browser', url: 'https://example.test/' },
      { sessionId: 'ninth', executionId: 'ninth', signal: new AbortController().signal },
    ),
  ).rejects.toThrow('browser_session_capacity');
  expect(starts).toBe(8);
  const entered = barrier<void>(),
    release = barrier<Json>();
  const fixture = await started({
    request: async (command) => {
      if (command.action === 'click') {
        entered.resolve();
        return release.promise;
      }
      return { success: true, data: {} };
    },
  });
  await snapshot(fixture.controller);
  const target = current(fixture.controller),
    signal = new AbortController().signal;
  const inFlight = fixture.controller.command(
    'session-one',
    target,
    { action: 'click', ref: '@e1', seq: fixture.controller.view('session-one')!.seq },
    signal,
  );
  await entered.promise;
  const queued = Array.from({ length: 15 }, () =>
    fixture.controller.command('session-one', target, { action: 'snapshot' }, signal),
  );
  await Promise.resolve();
  expect(
    (await fixture.controller.command('session-one', target, { action: 'snapshot' }, signal))
      .details,
  ).toEqual({ code: 'browser_command_capacity' });
  const handoff = fixture.controller.handoff('session-one', target, signal);
  release.resolve({ success: true, data: {} });
  await inFlight;
  expect((await Promise.all(queued)).every((result) => result.outcome === 'failed')).toBe(true);
  expect((await handoff).outcome).toBe('succeeded');
});

test('snapshot discovers current generation after asynchronous open, while a second open cannot acquire another Job', async () => {
  const fixture = await started();
  const extension = createBrowserExtension({ controller: fixture.controller }),
    { context } = toolContext();
  const snapshotTool = extension.tools!.find((tool) => tool.id === 'browser.snapshot')!;
  expect(snapshotTool.inputSchema.required as string[]).not.toContain('generation');
  const result = await snapshotTool.execute(
    { key: 'observe-current', browserId: 'browser-one' },
    context,
  );
  expect(result.outcome).toBe('succeeded');
  expect(result.details).toMatchObject({
    generation: fixture.controller.view('session-one')!.generation,
    state: 'agent',
  });
  Object.assign(context, {
    operations: {
      ensure() {
        throw Error('second_job_must_not_be_admitted');
      },
    },
  });
  expect(
    (
      await extension.tools![0]!.execute(
        { key: 'another-browser', url: 'https://example.test/' },
        context,
      )
    ).details,
  ).toEqual({ code: 'browser_session_already_owned' });
});

test('known startup launch failure with confirmed cleanup reports unavailable, not successful navigation or user cancellation', async () => {
  const fixture = await started({
    request: async (command): Promise<Json> =>
      command.action === 'launch'
        ? { success: false, error: 'runtime_missing' }
        : { success: true, data: {} },
  });
  const iterator = fixture.controller.job.observe(fixture.handle)[Symbol.asyncIterator]();
  await iterator.next();
  expect((await iterator.next()).value).toMatchObject({
    type: 'terminal',
    supervision: 'ended',
    result: { outcome: 'failed', details: { code: 'browser_startup_failed' } },
  });
  expect(fixture.controller.view('session-one')).toMatchObject({
    state: 'unavailable',
    error: 'browser_startup_failed',
  });
  expect(fixture.fake.requests.some((command) => command.action === 'navigate')).toBe(false);
  await fixture.controller.job.dispose(fixture.handle);
  cleanups.pop();
});

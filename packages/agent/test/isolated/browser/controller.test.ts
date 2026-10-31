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
test('only trusted successful shared acquisition retains a private copied Main identity', async () => {
  const fake = transport();
  const identity = { pageId: 'main-retained-page', incarnation: 'main-original-incarnation' };
  Object.assign(fake.native, { sharedPage: true, sharedPageIdentity: () => identity });
  const controller = createBrowserController({
    sharedPage: true,
    createTransport: () => fake.native,
    captureIntervalMs: 60000,
  });
  const signal = new AbortController().signal;
  const handle = await controller.job.start(
    { browserId: 'new-browser', url: 'https://example.test/' },
    { sessionId: 'private', executionId: 'private-job', signal },
  );
  cleanups.push(() => controller.job.cancel(handle));
  const result = await controller.command(
    'private',
    controller.view('private')!,
    { action: 'snapshot' },
    signal,
  );
  expect(result.outcome).toBe('succeeded');
  expect(controller.releasedPage!('private')).toBeNull();
  expect(JSON.stringify(controller.view('private'))).not.toContain(identity.pageId);
  expect(JSON.stringify(result)).not.toContain(identity.incarnation);
  await controller.close('private', controller.view('private')!);
  const copied = { ...identity };
  identity.pageId = 'later-mutation';
  expect(controller.releasedPage!('private')?.identity).toEqual(copied);
  const projected = controller.releasedPage!('private')!;
  (projected.identity as { pageId: string }).pageId = 'caller-mutation';
  expect(controller.releasedPage!('private')?.identity).toEqual(copied);
  expect(controller.releasedPage!('another-session')).toBeNull();
});

for (const drift of ['url', 'identity', 'missing-identity'] as const)
  test(`existing-only startup never navigates a retained page after ${drift} drift`, async () => {
    const identity = { pageId: 'retained-main', incarnation: 'original-incarnation' };
    const first = transport({
      request: async () => ({ success: true, data: { url: 'https://example.test/' } }),
    });
    const second = transport({
      request: async () => ({
        success: true,
        data: {
          url: drift === 'url' ? 'https://example.test/changed' : 'https://example.test/',
          title: 'Unbound replacement title',
        },
      }),
    });
    Object.assign(first.native, { sharedPage: true, sharedPageIdentity: () => identity });
    Object.assign(second.native, {
      sharedPage: true,
      sharedPageIdentity: () =>
        drift === 'missing-identity'
          ? null
          : {
              ...identity,
              ...(drift === 'identity' ? { incarnation: 'replacement-incarnation' } : {}),
            },
    });
    let creates = 0;
    const controller = createBrowserController({
      sharedPage: true,
      createTransport: () => (++creates === 1 ? first.native : second.native),
      captureIntervalMs: 60000,
    });
    const signal = new AbortController().signal;
    const old = await controller.job.start(
      { browserId: 'first', url: 'https://example.test/' },
      { sessionId: 'retained', executionId: 'first-job', signal },
    );
    await controller.command(
      'retained',
      controller.view('retained')!,
      { action: 'snapshot' },
      signal,
    );
    await controller.close('retained', controller.view('retained')!);
    await controller.job.dispose(old);
    const current = await controller.job.start(
      { browserId: 'fresh', url: 'https://example.test/' },
      { sessionId: 'retained', executionId: 'fresh-job', signal },
    );
    cleanups.push(() => controller.job.cancel(current));
    const events = [];
    for await (const event of controller.job.observe(current)) events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: 'terminal',
      supervision: 'ended',
      result: { outcome: 'failed', content: 'browser_page_existing_mismatch' },
    });
    expect(second.requests.filter((request) => request.action === 'navigate')).toEqual([]);
    expect(controller.view('retained')?.title).not.toBe('Unbound replacement title');
    expect(
      second.requests.filter((request) =>
        ['click', 'fill', 'snapshot'].includes(String(request.action)),
      ),
    ).toEqual([]);
    expect(second.closes).toBe(1);
    expect(creates).toBe(2);
  });
test('shared-page Job keeps the real viewport and waits for lease confirmation at both handoff boundaries', async () => {
  const fake = transport(),
    pause = barrier<void>(),
    resume = barrier<void>();
  Object.assign(fake.native, {
    sharedPage: true,
    handoff: () => pause.promise,
    resume: () => resume.promise,
  });
  const controller = createBrowserController({
    sharedPage: true,
    createTransport: () => fake.native,
    captureIntervalMs: 60000,
  });
  const signal = new AbortController().signal;
  const handle = await controller.job.start(
    { browserId: 'browser-shared', url: 'https://example.test/' },
    { sessionId: 'shared', executionId: 'job-shared', signal },
  );
  cleanups.push(() => controller.job.cancel(handle));
  let view = controller.view('shared')!;
  await controller.command('shared', view, { action: 'snapshot' }, signal);
  expect(fake.requests.some((value) => value.action === 'viewport')).toBe(false);
  view = controller.view('shared')!;
  const yielding = controller.handoff('shared', view, signal);
  expect(controller.view('shared')!.state).toBe('pausing');
  pause.resolve();
  expect((await yielding).outcome).toBe('succeeded');
  expect(controller.view('shared')!.state).toBe('human');
  const returning = controller.resume('shared', controller.view('shared')!, signal);
  expect(controller.view('shared')!.state).toBe('pausing');
  resume.resolve();
  expect((await returning).outcome).toBe('succeeded');
  expect(controller.view('shared')!.state).toBe('agent');
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

function semanticOrderFixture(
  snapshot: (read: number) => { snapshot: string; refs: Record<string, Json> },
) {
  let reads = 0;
  const fake = transport({
    request: async (command): Promise<Json> => ({
      success: true,
      data:
        command.action === 'snapshot'
          ? snapshot(++reads)
          : command.action === 'url'
            ? { url: 'https://example.test/' }
            : {},
    }),
  });
  Object.assign(fake.native, { sharedPage: true });
  const controller = createBrowserController({
    createTransport: () => fake.native,
    observationMode: async () => 'on-demand',
    captureIntervalMs: 60000,
  });
  const signal = new AbortController().signal;
  return {
    fake,
    controller,
    signal,
    async start() {
      const handle = await controller.job.start(
        { browserId: 'ordered-page', url: 'https://example.test/' },
        { sessionId: 'ordered-session', executionId: 'ordered-job', signal },
      );
      cleanups.push(() => controller.job.cancel(handle));
      return controller.command(
        'ordered-session',
        controller.view('ordered-session')!,
        { action: 'snapshot' },
        signal,
      );
    },
  };
}

function orderedSemanticData(count: number, reverse = false) {
  const documentOrder = [30, 31, 32, 65];
  for (let ref = 1; ref <= count; ref++) if (!documentOrder.includes(ref)) documentOrder.push(ref);
  const metadata = (ref: number) => ({
    role: ref === 65 ? 'textbox' : 'link',
    name: ref === 65 ? 'City search' : `Page link ${ref}`,
  });
  const keys = Array.from({ length: count }, (_, index) => `e${index + 1}`).sort();
  if (reverse) keys.reverse();
  return {
    snapshot: documentOrder
      .map((ref) => `- ${metadata(ref).role} "${metadata(ref).name}" [ref=e${ref}]`)
      .join('\n'),
    refs: Object.fromEntries(keys.map((ref) => [ref, metadata(Number(ref.slice(1)))])) as Record<
      string,
      Json
    >,
  };
}

for (const ordering of ['growing', 'reordered'] as const)
  test(`document-order clipping retains the top textbox through ${ordering} refs and fresh validation dispatches one fill`, async () => {
    const f = semanticOrderFixture((read) =>
      orderedSemanticData(
        read === 1 && ordering === 'growing' ? 221 : 300,
        read === 1 && ordering === 'reordered',
      ),
    );
    const observed = await f.start();
    expect(observed.outcome).toBe('succeeded');
    const details = observed.details as {
      elements: { ref: string; role: string }[];
      snapshot: string;
      truncated: boolean;
    };
    expect(details.elements).toHaveLength(200);
    expect(details.elements.slice(0, 4).map((element) => element.ref)).toEqual([
      '@e30',
      '@e31',
      '@e32',
      '@e65',
    ]);
    expect(details.snapshot).toContain('[ref=e65]');
    expect(details.truncated).toBe(true);
    const original = f.controller.view('ordered-session')!;
    expect(
      await f.controller.command(
        'ordered-session',
        original,
        { action: 'fill', ref: '@e65', seq: original.seq, value: 'Beijing' },
        f.signal,
      ),
    ).toMatchObject({ outcome: 'succeeded' });
    expect(f.fake.requests.filter((request) => request.action === 'fill')).toEqual([
      { action: 'fill', selector: '@e65', value: 'Beijing' },
    ]);
    expect(
      await f.controller.command(
        'ordered-session',
        original,
        { action: 'fill', ref: '@e65', seq: original.seq, value: 'must-not-repeat' },
        f.signal,
      ),
    ).toMatchObject({ outcome: 'failed', content: 'browser_stale_element' });
    const fresh = await f.controller.command(
      'ordered-session',
      f.controller.view('ordered-session')!,
      { action: 'snapshot' },
      f.signal,
    );
    expect(
      (fresh.details as typeof details).elements.slice(0, 4).map((element) => element.ref),
    ).toEqual(['@e30', '@e31', '@e32', '@e65']);
    expect(f.fake.requests.filter((request) => request.action === 'fill')).toHaveLength(1);
  });

for (const change of ['role', 'name', 'missing', 'replacement-ref'] as const)
  test(`stable document ordering does not conceal a real ${change} change during fresh action validation`, async () => {
    const f = semanticOrderFixture((read) => {
      const data = orderedSemanticData(read === 1 ? 221 : 300);
      if (read > 1) {
        if (change === 'role') data.refs.e65 = { role: 'button', name: 'City search' };
        if (change === 'name') data.refs.e65 = { role: 'textbox', name: 'Different control' };
        if (change === 'missing' || change === 'replacement-ref') delete data.refs.e65;
        if (change === 'replacement-ref') {
          data.refs.e365 = { role: 'textbox', name: 'City search' };
          data.snapshot = data.snapshot.replace('[ref=e65]', '[ref=e365]');
        }
      }
      return data;
    });
    expect((await f.start()).outcome).toBe('succeeded');
    const view = f.controller.view('ordered-session')!;
    expect(
      await f.controller.command(
        'ordered-session',
        view,
        { action: 'fill', ref: '@e65', seq: view.seq, value: 'forbidden' },
        f.signal,
      ),
    ).toMatchObject({ outcome: 'failed', content: 'browser_stale_element' });
    expect(f.fake.requests.filter((request) => request.action === 'fill')).toHaveLength(0);
  });

test('text markers without matching metadata never mint refs and unselected invalid metadata still fails the whole read', async () => {
  const f = semanticOrderFixture(() => {
    const data = orderedSemanticData(300, true);
    data.snapshot = `- textbox "Unverified text marker" [ref=e999]\n${data.snapshot}`;
    return data;
  });
  const observed = await f.start();
  expect(observed.outcome).toBe('succeeded');
  const elements = (observed.details as { elements: { ref: string }[] }).elements;
  expect(elements[0]?.ref).toBe('@e30');
  expect(elements.some((element) => element.ref === '@e999')).toBe(false);
  const view = f.controller.view('ordered-session')!;
  expect(
    await f.controller.command(
      'ordered-session',
      view,
      { action: 'fill', ref: '@e999', seq: view.seq, value: 'unverified' },
      f.signal,
    ),
  ).toMatchObject({ outcome: 'failed', content: 'browser_stale_element' });
  expect(f.fake.requests.filter((request) => request.action === 'fill')).toHaveLength(0);
  for (const invalid of [
    ['e999', { role: 42, name: 'invalid unselected tail' }],
    ['e01', { role: 'textbox', name: 'invalid ref spelling' }],
  ] as const) {
    const bad = semanticOrderFixture(() => {
      const data = orderedSemanticData(300);
      data.refs[invalid[0]] = invalid[1];
      return data;
    });
    expect(await bad.start()).toMatchObject({
      outcome: 'failed',
      content: 'browser_snapshot_failed',
    });
    expect(bad.fake.requests.filter((request) => request.action === 'fill')).toHaveLength(0);
  }
});

function releasedPagesFixture() {
  const documents = new Map<string, { url: string; value: string; loads: number }>();
  const queue: NativeBrowserTransport[] = [];
  const acquisitions: { url: string; identity: unknown }[] = [];
  const controller = createBrowserController({
    sharedPage: true,
    observationMode: async () => 'on-demand',
    captureIntervalMs: 60000,
    createTransport(context, binding) {
      acquisitions.push({
        url: binding.url,
        identity: controller.releasedPage!(context.sessionId, binding.url)?.identity,
      });
      return queue.shift()!;
    },
  });
  let sequence = 0;
  async function start(
    url: string,
    identity: { pageId: string; incarnation: string },
    sessionId = 'session',
    confirmed = true,
  ) {
    const key = JSON.stringify(identity);
    if (!documents.has(key)) documents.set(key, { url: 'about:blank', value: '', loads: 0 });
    const document = documents.get(key)!;
    const fake = transport({
      stopConfirmed: confirmed,
      request: async (command): Promise<Json> => {
        if (command.action === 'navigate') {
          document.url = new URL(String(command.url)).href;
          document.loads++;
        }
        return {
          success: true,
          data:
            command.action === 'snapshot'
              ? {
                  snapshot: `- textbox "Plain text" ${document.value}`,
                  refs: {},
                  url: document.url,
                }
              : command.action === 'url' || command.action === 'navigate'
                ? { url: document.url, title: identity.pageId }
                : {},
        };
      },
    });
    Object.assign(fake.native, { sharedPage: true, sharedPageIdentity: () => identity });
    queue.push(fake.native);
    const signal = new AbortController().signal;
    const handle = await controller.job.start(
      { browserId: `browser-${++sequence}`, url },
      { sessionId, executionId: `job-${sequence}`, signal },
    );
    let disposed = false;
    cleanups.push(() => (disposed ? Promise.resolve() : controller.job.cancel(handle)));
    const snapshot = await controller.command(
      sessionId,
      controller.view(sessionId)!,
      { action: 'snapshot' },
      signal,
    );
    expect(snapshot.outcome).toBe('succeeded');
    return {
      fake,
      document,
      snapshot,
      async close() {
        const result = await controller.close(sessionId, controller.view(sessionId)!);
        if (confirmed) {
          await controller.job.dispose(handle);
          disposed = true;
        }
        return result;
      },
    };
  }
  return {
    controller,
    acquisitions,
    start,
    async visit(
      url: string,
      identity: { pageId: string; incarnation: string },
      sessionId = 'session',
    ) {
      const page = await start(url, identity, sessionId);
      await page.close();
      return page;
    },
  };
}

test('only the exact confirmed missing released identity is forgotten before a new opening', async () => {
  const f = releasedPagesFixture();
  const a = { pageId: 'main-a', incarnation: 'original-a' };
  const b = { pageId: 'main-b', incarnation: 'original-b' };
  await f.visit('https://example.test/a', a);
  await f.visit('https://example.test/b', b);
  expect(f.controller.invalidateMissingReleasedPage!('foreign', b)).toBe(false);
  expect(
    f.controller.invalidateMissingReleasedPage!('session', { ...b, incarnation: 'replacement' }),
  ).toBe(false);
  expect(f.controller.releasedPages!('session').map((page) => page.identity)).toEqual([a, b]);
  expect(f.controller.invalidateMissingReleasedPage!('session', b)).toBe(true);
  expect(f.controller.invalidateMissingReleasedPage!('session', b)).toBe(false);
  expect(f.controller.releasedPages!('session').map((page) => page.identity)).toEqual([a]);
  expect(f.controller.releasedPage!('session')).toBeNull();
  expect(f.controller.releasedPage!('session', 'https://example.test/b')).toBeNull();
  const replacement = { pageId: 'new-main-b', incarnation: 'new-b' };
  await f.visit('https://example.test/b', replacement);
  expect(f.acquisitions.at(-1)).toEqual({ url: 'https://example.test/b', identity: undefined });
  expect(f.controller.releasedPages!('session').map((page) => page.identity)).toEqual([
    a,
    replacement,
  ]);
});

test('confirmed shared pages retain A and B so a later A acquisition uses its original identity without navigation', async () => {
  const f = releasedPagesFixture();
  const a = { pageId: 'main-a', incarnation: 'incarnation-a' };
  const b = { pageId: 'main-b', incarnation: 'incarnation-b' };
  const original = await f.visit('https://example.test/a', a);
  original.document.value = 'HUMAN-UPDATED';
  const other = await f.visit('https://example.test/b', b);
  expect(f.controller.releasedPages!('session').map((page) => page.identity)).toEqual([a, b]);
  expect(f.controller.releasedPage!('session')?.identity).toEqual(b);
  expect(f.controller.releasedPage!('session', 'https://EXAMPLE.test:443/a')?.identity).toEqual(a);
  const returned = await f.visit('https://example.test/a', a);
  expect(f.acquisitions.map((acquisition) => acquisition.identity)).toEqual([
    undefined,
    undefined,
    a,
  ]);
  expect(returned.document).toBe(original.document);
  expect(returned.document).toEqual({
    url: 'https://example.test/a',
    value: 'HUMAN-UPDATED',
    loads: 1,
  });
  expect(JSON.stringify(returned.snapshot)).toContain('HUMAN-UPDATED');
  expect(other.document.loads).toBe(1);
  expect(returned.fake.requests.some((request) => request.action === 'navigate')).toBe(false);
  expect(f.controller.releasedPages!('session').map((page) => page.identity)).toEqual([b, a]);
  const copied = f.controller.releasedPages!('session');
  (copied[1]!.identity as { pageId: string }).pageId = 'untrusted-mutation';
  expect(f.controller.releasedPage!('session', 'https://example.test/a')?.identity).toEqual(a);
});

test('released listing omits only the active exact identity and preserves another incarnation at the same URL', async () => {
  const f = releasedPagesFixture();
  const a = { pageId: 'main-page', incarnation: 'incarnation-a' };
  const b = { pageId: 'main-page', incarnation: 'incarnation-b' };
  await f.visit('https://example.test/a', a);
  await f.visit('https://example.test/b', b);
  const active = await f.start('https://example.test/a', a);
  expect(f.controller.releasedPages!('session').map((page) => page.identity)).toEqual([b]);
  // Internal lookup still knows A; filtering the public observation must not
  // alter exact existing-only acquisition or the original ambiguity fence.
  expect(f.controller.releasedPage!('session', 'https://example.test/a')?.identity).toEqual(a);
  expect(
    (
      await f.controller.command(
        'session',
        f.controller.view('session')!,
        { action: 'navigate', url: 'https://example.test/b' },
        new AbortController().signal,
      )
    ).outcome,
  ).toBe('succeeded');
  expect(f.controller.view('session')?.url).toBe('https://example.test/b');
  expect(f.controller.releasedPages!('session').map((page) => page.identity)).toEqual([b]);
  await active.close();
  expect(f.controller.releasedPages!('session').map((page) => page.identity)).toEqual([b, a]);
  expect(() => f.controller.releasedPage!('session', 'https://example.test/b')).toThrow(
    'browser_page_existing_ambiguous',
  );
  expect(f.acquisitions).toHaveLength(3);
});

test('same-URL distinct identities remain separate and exact lookup or open refuses ambiguity before another transport', async () => {
  const f = releasedPagesFixture();
  const a = { pageId: 'main-a', incarnation: 'incarnation-a' };
  const b = { pageId: 'main-b', incarnation: 'incarnation-b' };
  await f.visit('https://example.test/a', a);
  const other = await f.start('https://example.test/b', b);
  expect(
    (
      await f.controller.command(
        'session',
        f.controller.view('session')!,
        { action: 'navigate', url: 'https://example.test/a' },
        new AbortController().signal,
      )
    ).outcome,
  ).toBe('succeeded');
  await other.close();
  expect(f.controller.releasedPages!('session').map((page) => page.identity)).toEqual([a, b]);
  expect(() => f.controller.releasedPage!('session', 'https://example.test/a')).toThrow(
    'browser_page_existing_ambiguous',
  );
  expect(f.controller.releasedPage!('session')?.identity).toEqual(b);
  await expect(
    f.controller.job.start(
      { browserId: 'must-not-start', url: 'https://example.test/a' },
      { sessionId: 'session', executionId: 'no-job', signal: new AbortController().signal },
    ),
  ).rejects.toThrow('browser_page_existing_ambiguous');
  expect(f.acquisitions).toHaveLength(2);
});

test('released metadata is session-local, remains passive during a healthy new lifetime, and cannot bypass unknown cleanup', async () => {
  const f = releasedPagesFixture();
  const a = { pageId: 'main-a', incarnation: 'incarnation-a' };
  await f.visit('https://example.test/a', a);
  expect(f.controller.releasedPages!('foreign')).toEqual([]);
  expect(f.controller.releasedPage!('foreign', 'https://example.test/a')).toBeNull();
  const uncertain = await f.start(
    'https://example.test/b',
    { pageId: 'main-b', incarnation: 'incarnation-b' },
    'session',
    false,
  );
  expect(f.controller.releasedPages!('session').map((page) => page.identity)).toEqual([a]);
  expect(f.controller.releasedPage!('session')).toBeNull();
  expect((await uncertain.close()).outcome).toBe('outcome_unknown');
  expect(f.controller.releasedPages!('session')).toEqual([]);
  expect(f.controller.releasedPage!('session', 'https://example.test/a')).toBeNull();
  await expect(f.controller.prepareRun!('session', 'new-run')).rejects.toThrow(
    'browser_previous_cleanup_unconfirmed',
  );
  expect(f.acquisitions).toHaveLength(2);
});

test('released metadata is bounded to eight identities in each of at most 128 sessions', async () => {
  const f = releasedPagesFixture();
  for (let index = 0; index < 9; index++) {
    await f.visit(`https://example.test/page-${index}`, {
      pageId: `page-${index}`,
      incarnation: `incarnation-${index}`,
    });
  }
  expect(f.controller.releasedPages!('session')).toHaveLength(8);
  expect(f.controller.releasedPage!('session', 'https://example.test/page-0')).toBeNull();
  expect(f.controller.releasedPage!('session')?.identity?.pageId).toBe('page-8');
  for (let index = 0; index < 128; index++) {
    await f.visit(
      'https://example.test/',
      { pageId: `session-page-${index}`, incarnation: `session-incarnation-${index}` },
      `session-${index}`,
    );
  }
  expect(f.controller.releasedPages!('session')).toEqual([]);
  expect(f.controller.releasedPages!('session-0')).toHaveLength(1);
  expect(f.controller.releasedPages!('session-127')).toHaveLength(1);
});

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
    'browser.request_human',
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
    request: async (command): Promise<Json> => {
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
    request: async (command): Promise<Json> => {
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
    request: async (command): Promise<Json> => {
      if (command.action === 'navigate') throw new BrowserTransportError('reply_lost', true);
      return { success: true, data: {} };
    },
  });
  const iterator = fixture.controller.job.observe(fixture.handle)[Symbol.asyncIterator]();
  await iterator.next();
  expect((await iterator.next()).value).toMatchObject({
    type: 'terminal',
    supervision: 'ended',
    result: {
      outcome: 'outcome_unknown',
      details: {
        code: 'browser_startup_outcome_unknown',
        startup: { phase: 'navigation', cause: 'reply_lost', dispatched: true },
      },
    },
  });
  expect(fixture.fake.closes).toBe(1);
  expect(fixture.fake.requests.filter((value) => value.action === 'navigate')).toHaveLength(1);
  await fixture.controller.job.dispose(fixture.handle);
  cleanups.pop();
});

for (const error of [
  new BrowserTransportError('private adapter message '.repeat(30), true),
  new Error('browser_native_response_lost'),
])
  test(`startup uncertainty records its phase without exposing ${error.constructor.name} adapter text`, async () => {
    const fixture = await started({
      request: async (command): Promise<Json> => {
        if (command.action === 'navigate') throw error;
        return { success: true, data: {} };
      },
    });
    const iterator = fixture.controller.job.observe(fixture.handle)[Symbol.asyncIterator]();
    await iterator.next();
    const terminal = (await iterator.next()).value;
    expect(terminal).toMatchObject({
      type: 'terminal',
      supervision: 'ended',
      result: {
        outcome: 'outcome_unknown',
        details: { code: 'browser_startup_outcome_unknown', startup: { phase: 'navigation' } },
      },
    });
    expect(terminal?.type === 'terminal' && terminal.result.details).toEqual({
      code: 'browser_startup_outcome_unknown',
      startup: { phase: 'navigation' },
    });
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
    request: async (command): Promise<Json> => {
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

for (const code of [
  'browser_page_explicit_grant_required',
  'browser_page_grant_changed',
  'page_request_invalid',
  'browser_page_capacity',
]) {
  test(`confirmed pre-lease ${code} survives pending commands, Job disposal and snapshot generation discovery`, async () => {
    const fixture = await started({ pendingReady: true });
    const target = current(fixture.controller),
      signal = new AbortController().signal;
    const pendingSnapshot = fixture.controller.command(
      'session-one',
      target,
      { action: 'snapshot' },
      signal,
    );
    const pendingNavigate = fixture.controller.command(
      'session-one',
      target,
      { action: 'navigate', url: 'https://other.test/' },
      signal,
    );
    fixture.fake.ready.reject(new BrowserTransportError(code, false));
    expect(await pendingSnapshot).toEqual({ outcome: 'failed', content: code, details: { code } });
    expect(await pendingNavigate).toEqual({ outcome: 'failed', content: code, details: { code } });
    const iterator = fixture.controller.job.observe(fixture.handle)[Symbol.asyncIterator]();
    await iterator.next();
    expect((await iterator.next()).value).toMatchObject({
      type: 'terminal',
      supervision: 'ended',
      result: { outcome: 'failed', content: code, details: { code } },
    });
    expect(fixture.controller.view('session-one')).toMatchObject({
      state: 'unavailable',
      error: code,
    });
    expect(fixture.fake.requests).toHaveLength(0);
    expect(fixture.fake.captures).toBe(0);
    expect(fixture.fake.closes).toBe(1);
    expect(await snapshot(fixture.controller)).toEqual({
      outcome: 'failed',
      content: code,
      details: { code },
    });
    expect(
      (
        await fixture.controller.command(
          'session-one',
          { ...target, generation: 'foreign-live-generation' },
          { action: 'snapshot' },
          signal,
        )
      ).details,
    ).toEqual({ code: 'browser_stale_or_foreign_target' });
    await fixture.controller.job.dispose(fixture.handle);
    cleanups.pop();
    const snapshotTool = createBrowserExtension({ controller: fixture.controller }).tools!.find(
      (tool) => tool.id === 'browser.snapshot',
    )!;
    const { context } = toolContext();
    expect(
      await snapshotTool.execute(
        { key: 'read-original-startup-failure', browserId: target.browserId },
        context,
      ),
    ).toEqual({ outcome: 'failed', content: code, details: { code } });
    expect(
      await fixture.controller.command(
        'session-one',
        target,
        { action: 'navigate', url: 'https://other.test/' },
        signal,
      ),
    ).toEqual({ outcome: 'failed', content: code, details: { code } });
    for (const [sessionId, foreign] of [
      ['foreign-session', target],
      ['session-one', { ...target, browserId: 'foreign-browser' }],
      ['session-one', { ...target, generation: 'foreign-generation' }],
    ] as const) {
      expect(
        (await fixture.controller.command(sessionId, foreign, { action: 'snapshot' }, signal))
          .details,
      ).toEqual({ code: 'browser_stale_or_foreign_target' });
    }
    expect(fixture.fake.requests).toHaveLength(0);
  });
}

test('a pre-lease admission denial cannot hide unconfirmed transport cleanup', async () => {
  const fixture = await started({ pendingReady: true, stopConfirmed: false });
  const pending = snapshot(fixture.controller);
  fixture.fake.ready.reject(
    new BrowserTransportError('browser_page_explicit_grant_required', false),
  );
  expect(await pending).toMatchObject({
    outcome: 'outcome_unknown',
    details: { code: 'browser_stop_unconfirmed' },
  });
  const iterator = fixture.controller.job.observe(fixture.handle)[Symbol.asyncIterator]();
  await iterator.next();
  expect((await iterator.next()).value).toMatchObject({
    type: 'terminal',
    supervision: 'unknown',
    result: { outcome: 'outcome_unknown', details: { code: 'browser_stop_unconfirmed' } },
  });
  await expect(fixture.controller.job.dispose(fixture.handle)).rejects.toThrow(
    'browser_cleanup_unconfirmed',
  );
  expect(fixture.fake.requests).toHaveLength(0);
});

test('admission-looking errors after readiness and unrecognized readiness failures stay generic', async () => {
  const afterReady = await started({
    request: async () => {
      throw new BrowserTransportError('browser_page_explicit_grant_required', false);
    },
  });
  const iterator = afterReady.controller.job.observe(afterReady.handle)[Symbol.asyncIterator]();
  await iterator.next();
  expect((await iterator.next()).value).toMatchObject({
    result: { outcome: 'failed', details: { code: 'browser_startup_failed' } },
  });
  expect(afterReady.fake.requests.map((command) => command.action)).toEqual(['launch']);
  for (const error of [
    Error('untrusted_readiness_failure'),
    Error('browser_page_grant_consumed'),
    Object.assign(Error('browser_page_explicit_grant_required'), { dispatched: false }),
    new BrowserTransportError('browser_page_explicit_grant_required', true),
  ]) {
    const beforeReady = await started({ pendingReady: true });
    beforeReady.fake.ready.reject(error);
    const events = beforeReady.controller.job.observe(beforeReady.handle)[Symbol.asyncIterator]();
    await events.next();
    expect((await events.next()).value).toMatchObject({
      result: { outcome: 'failed', details: { code: 'browser_startup_failed' } },
    });
    expect(beforeReady.fake.requests).toHaveLength(0);
  }
});

test('shared open binds its lease and URL without requiring title or semantic observation', async () => {
  const queried = barrier<void>(),
    fake = transport({
      request: async (command): Promise<Json> => {
        if (command.action === 'url') {
          queried.resolve();
          return { success: true, data: { url: 'https://example.test/' } };
        }
        if (command.action === 'launch') return { success: true, data: {} };
        throw Error('observation_not_ready');
      },
    });
  Object.assign(fake.native, { sharedPage: true });
  const controller = createBrowserController({
    createTransport: () => fake.native,
    sharedPage: true,
    observationMode: async () => 'on-demand',
  });
  const handle = await controller.job.start(
    { browserId: 'browser', url: 'https://example.test/' },
    { sessionId: 'session', executionId: 'job', signal: new AbortController().signal },
  );
  cleanups.push(() => controller.job.cancel(handle));
  await queried.promise;
  await Bun.sleep(0);
  expect(controller.view('session')?.state).toBe('agent');
  expect(fake.requests.map((r) => r.action)).toEqual(['launch', 'url']);
  expect(fake.captures).toBe(0);
  expect(fake.closes).toBe(0);
});

for (const title of ['Current Main title', ''])
  test(`same-page rebind preserves its current atomic Main title ${JSON.stringify(title)} through on-demand close`, async () => {
    const identity = { pageId: 'exact-original-page', incarnation: 'original-incarnation' },
      url = 'https://example.test/current',
      natives: ReturnType<typeof transport>[] = [];
    let acquired = 0;
    const controller = createBrowserController({
      sharedPage: true,
      observationMode: async () => 'on-demand',
      createTransport() {
        const currentTitle = acquired++ === 0 ? 'Old released title' : title;
        const fake = transport({
          request: async (command): Promise<Json> => {
            if (command.action === 'url')
              return { success: true, data: { url, title: currentTitle } };
            if (command.action === 'snapshot')
              return { success: true, data: { snapshot: '- heading "Current page"', refs: {} } };
            if (['launch', 'scroll'].includes(String(command.action)))
              return { success: true, data: {} };
            throw Error('metadata_pair_must_not_require_another_read_or_navigation');
          },
        });
        Object.assign(fake.native, {
          sharedPage: true,
          sharedPageIdentity: () => ({ ...identity }),
        });
        natives.push(fake);
        return fake.native;
      },
    });
    for (const iteration of [0, 1]) {
      const signal = new AbortController().signal;
      const handle = await controller.job.start(
        { browserId: `browser-${iteration}`, url },
        { sessionId: 'same-page', executionId: `job-${iteration}`, signal },
      );
      let disposed = false;
      cleanups.push(() => (disposed ? Promise.resolve() : controller.job.cancel(handle)));
      const expected = iteration === 0 ? 'Old released title' : title;
      expect(
        (
          await controller.command(
            'same-page',
            controller.view('same-page')!,
            { action: 'snapshot' },
            signal,
          )
        ).outcome,
      ).toBe('succeeded');
      expect(controller.view('same-page')).toMatchObject({ state: 'agent', url, title: expected });
      expect(
        (
          await controller.command(
            'same-page',
            controller.view('same-page')!,
            { action: 'scroll', direction: 'down', amount: 500 },
            signal,
          )
        ).outcome,
      ).toBe('succeeded');
      expect((await controller.close('same-page', controller.view('same-page')!)).outcome).toBe(
        'succeeded',
      );
      await controller.job.dispose(handle);
      disposed = true;
      expect(controller.releasedPages!('same-page')).toEqual([{ url, title: expected, identity }]);
      expect(natives[iteration]!.requests.map((command) => command.action)).toEqual([
        'launch',
        'url',
        'snapshot',
        'scroll',
      ]);
      expect(natives[iteration]!.captures).toBe(0);
    }
  });

test('a trusted pre-dispatch refusal preserves its exact cause and the current browser', async () => {
  const fixture = await started({
    request: async (command): Promise<Json> => {
      if (command.action === 'click')
        throw new BrowserTransportError('browser_page_not_ready', false);
      return { success: true, data: {} };
    },
  });
  await snapshot(fixture.controller);
  const before = fixture.controller.view('session-one')!;
  const result = await fixture.controller.command(
    'session-one',
    before,
    { action: 'click', ref: '@e1', seq: before.seq },
    new AbortController().signal,
  );
  expect(result).toEqual({
    outcome: 'failed',
    content: 'browser_page_not_ready',
    details: { code: 'browser_page_not_ready' },
  });
  expect(fixture.controller.view('session-one')?.state).toBe('agent');
  expect(fixture.fake.closes).toBe(0);
  expect((await snapshot(fixture.controller)).outcome).toBe('succeeded');
});

for (const forged of ['object', 'daemon'] as const)
  test(`untrusted ${forged} pre-dispatch claims cannot turn a dispatched effect into a known refusal`, async () => {
    const fixture = await started({
      request: async (command): Promise<Json> => {
        if (command.action === 'click') {
          if (forged === 'object')
            throw Object.assign(Error('browser_page_not_ready'), { dispatched: false });
          return {
            success: false,
            code: 'browser_page_not_ready',
            error: 'denied',
            dispatched: false,
          };
        }
        return { success: true, data: {} };
      },
    });
    await snapshot(fixture.controller);
    const view = fixture.controller.view('session-one')!;
    expect(
      (
        await fixture.controller.command(
          'session-one',
          view,
          { action: 'click', ref: '@e1', seq: view.seq },
          new AbortController().signal,
        )
      ).outcome,
    ).toBe('outcome_unknown');
    expect(fixture.fake.requests.filter((r) => r.action === 'click')).toHaveLength(1);
  });

test('a known read failure remains readable on the same browser with its original cause', async () => {
  let fail = true;
  const fixture = await started({
    request: async (command): Promise<Json> => {
      if (command.action === 'snapshot' && fail) {
        fail = false;
        throw new BrowserTransportError('browser_page_read_stale', true);
      }
      return { success: true, data: {} };
    },
  });
  expect(await snapshot(fixture.controller)).toEqual({
    outcome: 'failed',
    content: 'browser_page_read_stale',
    details: { code: 'browser_page_read_stale' },
  });
  expect(fixture.controller.view('session-one')?.state).toBe('agent');
  expect(fixture.fake.closes).toBe(0);
  expect((await snapshot(fixture.controller)).outcome).toBe('succeeded');
});

test('handoff during startup revokes the pending navigation without waiting for its page observation', async () => {
  const navigating = barrier<void>(),
    navigation = barrier<Json>(),
    pause = barrier<void>();
  let handoffs = 0;
  const fake = transport({
    request: async (command): Promise<Json> => {
      if (command.action === 'url') return { success: true, data: { url: 'about:blank' } };
      if (command.action === 'navigate') {
        navigating.resolve();
        return navigation.promise;
      }
      return { success: true, data: {} };
    },
  });
  Object.assign(fake.native, {
    sharedPage: true,
    async handoff() {
      handoffs++;
      navigation.reject(new BrowserTransportError('browser_native_aborted', true));
      await pause.promise;
    },
  });
  const controller = createBrowserController({
    createTransport: () => fake.native,
    sharedPage: true,
    observationMode: async () => 'on-demand',
  });
  const handle = await controller.job.start(
    { browserId: 'browser', url: 'https://example.test/' },
    { sessionId: 'session', executionId: 'job', signal: new AbortController().signal },
  );
  cleanups.push(() => controller.job.cancel(handle));
  await navigating.promise;
  const target = controller.view('session')!,
    handoff = controller.handoff('session', target, new AbortController().signal);
  await Bun.sleep(0);
  expect(handoffs).toBe(1);
  expect(controller.view('session')?.state).toBe('pausing');
  expect(fake.closes).toBe(0);
  pause.resolve();
  expect((await handoff).outcome).toBe('succeeded');
  expect(controller.view('session')?.state).toBe('human');
  expect(fake.requests.filter((r) => r.action === 'navigate')).toHaveLength(1);
  expect(fake.requests.some((r) => r.action === 'snapshot')).toBe(false);
});

test('an unconfirmed startup handoff retains outcome unknown and never claims manual readiness', async () => {
  const navigating = barrier<void>(),
    navigation = barrier<Json>();
  const fake = transport({
    request: async (command): Promise<Json> => {
      if (command.action === 'url') return { success: true, data: { url: 'about:blank' } };
      if (command.action === 'navigate') {
        navigating.resolve();
        return navigation.promise;
      }
      return { success: true, data: {} };
    },
  });
  Object.assign(fake.native, {
    sharedPage: true,
    async handoff() {
      navigation.reject(new BrowserTransportError('browser_native_aborted', true));
      throw Error('handoff_unknown');
    },
  });
  const controller = createBrowserController({
    createTransport: () => fake.native,
    sharedPage: true,
    observationMode: async () => 'on-demand',
  });
  const handle = await controller.job.start(
    { browserId: 'browser', url: 'https://example.test/' },
    { sessionId: 'session', executionId: 'job', signal: new AbortController().signal },
  );
  cleanups.push(() => controller.job.cancel(handle));
  await navigating.promise;
  expect(
    (await controller.handoff('session', controller.view('session')!, new AbortController().signal))
      .outcome,
  ).toBe('outcome_unknown');
  expect(controller.view('session')?.state).toBe('outcome_unknown');
  expect(fake.requests.filter((r) => r.action === 'navigate')).toHaveLength(1);
});

function runOwnerFixture(foreign = false) {
  const base = {
    originStoreId: 'store',
    sessionId: 'session',
    rootWorkCommandId: 'root-command',
    rootWorkSeq: '1',
    cancelRequestedAt: null,
    status: 'running',
  };
  const executions = new Map([
    [
      'job',
      {
        ...base,
        id: 'job',
        kind: 'job',
        definitionId: 'browser.session',
        definitionVersion: '1',
        originCommandId: 'open-command',
        parentExecutionId: 'open',
        runId: null,
      },
    ],
    [
      'open',
      {
        ...base,
        id: 'open',
        kind: 'tool',
        definitionId: 'browser.open',
        definitionVersion: '1',
        originCommandId: 'open-command',
        parentExecutionId: 'execute',
        runId: null,
      },
    ],
    [
      'execute',
      {
        ...base,
        id: 'execute',
        kind: 'tool',
        definitionId: 'browser.execute',
        definitionVersion: '1',
        originStoreId: foreign ? 'other-store' : 'store',
        originCommandId: 'root-command',
        parentExecutionId: null,
        runId: 'run',
      },
    ],
  ]);
  const run = {
    ...base,
    id: 'run',
    originCommandId: 'root-command',
    contextSelectionId: 'selection',
    isActive: true,
  };
  const runs = new Map([[run.id, run]]);
  let unavailable = false,
    commandCancelledAt: number | null = null;
  const host = {
    getExecution: async (id: string) => executions.get(id) ?? null,
    getCommand: async (id: string) => ({
      id,
      originStoreId: 'store',
      subjectId: 'user',
      cancelRequestedAt: commandCancelledAt,
    }),
    getRun: async (id: string) => {
      if (unavailable) throw Error('store_unavailable');
      return runs.get(id) ?? null;
    },
  } as unknown as Pick<
    import('../../../src/runtime').AgentRuntime,
    'getExecution' | 'getCommand' | 'getRun'
  >;
  return {
    host,
    run,
    runs,
    executions,
    unavailable() {
      unavailable = true;
    },
    cancel() {
      commandCancelledAt = Date.now();
    },
  };
}

for (const end of ['completed', 'cancelled', 'unverifiable'] as const)
  test(`the original Browser Job retains a human page while its Run waits and closes on ${end}`, async () => {
    const owner = runOwnerFixture(),
      fake = transport();
    Object.assign(fake.native, { sharedPage: true, handoff: async () => {} });
    const controller = createBrowserController({
      createTransport: () => fake.native,
      runtime: () => owner.host,
      observationMode: async () => 'on-demand',
      captureIntervalMs: 100,
    });
    const handle = await controller.job.start(
      { browserId: 'browser', url: 'https://example.test/' },
      { sessionId: 'session', executionId: 'job', signal: new AbortController().signal },
    );
    cleanups.push(() => controller.job.cancel(handle));
    await controller.command(
      'session',
      controller.view('session')!,
      { action: 'snapshot' },
      new AbortController().signal,
    );
    expect(
      (
        await controller.handoff(
          'session',
          controller.view('session')!,
          new AbortController().signal,
        )
      ).outcome,
    ).toBe('succeeded');
    owner.run.status = 'waiting_execution';
    await Bun.sleep(125);
    expect(controller.view('session')?.state).toBe('human');
    expect(fake.closes).toBe(0);
    expect(fake.captures).toBe(0);
    if (end === 'unverifiable') owner.unavailable();
    else if (end === 'completed') owner.run.isActive = false;
    else owner.cancel();
    for (let n = 0; n < 30 && fake.closes === 0; n++) await Bun.sleep(10);
    expect(fake.closes).toBe(1);
    expect(controller.view('session')?.state).toBe('closed');
  });

test('a foreign parent Run cannot acquire a browser transport under a local Job identity', async () => {
  const owner = runOwnerFixture(true),
    fake = transport();
  let creates = 0;
  const controller = createBrowserController({
    createTransport() {
      creates++;
      return fake.native;
    },
    runtime: () => owner.host,
    observationMode: async () => 'on-demand',
  });
  const handle = await controller.job.start(
    { browserId: 'browser', url: 'https://example.test/' },
    { sessionId: 'session', executionId: 'job', signal: new AbortController().signal },
  );
  cleanups.push(() => controller.job.cancel(handle));
  const events = controller.job.observe(handle)[Symbol.asyncIterator]();
  await events.next();
  expect((await events.next()).value).toMatchObject({
    type: 'terminal',
    result: { outcome: 'failed' },
  });
  expect(creates).toBe(0);
  expect(fake.requests).toHaveLength(0);
});

test('the pre-admission barrier preserves the same active Run and refuses a different or unverifiable owner', async () => {
  const owner = runOwnerFixture(),
    fake = transport();
  const controller = createBrowserController({
    runtime: () => owner.host,
    createTransport: () => fake.native,
    observationMode: async () => 'on-demand',
    captureIntervalMs: 60000,
  });
  const handle = await controller.job.start(
    { browserId: 'browser', url: 'https://example.test/' },
    { sessionId: 'session', executionId: 'job', signal: new AbortController().signal },
  );
  cleanups.push(() => controller.job.cancel(handle));
  await controller.command(
    'session',
    controller.view('session')!,
    { action: 'snapshot' },
    new AbortController().signal,
  );
  await controller.prepareRun!('session', 'run');
  expect(fake.closes).toBe(0);
  await expect(controller.prepareRun!('session', 'different-run')).rejects.toThrow(
    'browser_session_already_owned',
  );
  expect(fake.closes).toBe(0);
  owner.unavailable();
  await expect(controller.prepareRun!('session', 'different-run')).rejects.toThrow(
    'browser_owner_run_unverifiable',
  );
  expect(fake.closes).toBe(0);
});

test('Run ownership is supervised without accelerating a sixty-second preview interval', async () => {
  const owner = runOwnerFixture(),
    fake = transport();
  const controller = createBrowserController({
    runtime: () => owner.host,
    createTransport: () => fake.native,
    captureIntervalMs: 60000,
  });
  const handle = await controller.job.start(
    { browserId: 'browser', url: 'https://example.test/' },
    { sessionId: 'session', executionId: 'job', signal: new AbortController().signal },
  );
  cleanups.push(() => controller.job.cancel(handle));
  await Bun.sleep(0);
  expect(controller.view('session')?.state).toBe('agent');
  expect(fake.captures).toBe(1);
  await Bun.sleep(650);
  expect(fake.captures).toBe(1);
  expect(fake.closes).toBe(0);
  owner.run.isActive = false;
  for (let n = 0; n < 50 && fake.closes === 0; n++) await Bun.sleep(10);
  expect(fake.closes).toBe(1);
  expect(fake.captures).toBe(1);
});

test('a second Run joins the failed first Run browser close and gets fresh references on the retained page', async () => {
  const owner = runOwnerFixture();
  const secondRun = {
    ...owner.run,
    id: 'run-two',
    originCommandId: 'second-command',
    rootWorkCommandId: 'second-command',
    rootWorkSeq: '2',
  };
  owner.runs.set(secondRun.id, secondRun);
  const secondJob = {
    ...owner.executions.get('job')!,
    id: 'job-two',
    originCommandId: 'second-command',
    rootWorkCommandId: 'second-command',
    rootWorkSeq: '2',
    parentExecutionId: 'second-open',
    runId: null,
  };
  owner.executions.set('job-two', secondJob);
  owner.executions.set('second-open', {
    ...secondJob,
    id: 'second-open',
    kind: 'tool',
    definitionId: 'browser.open',
    parentExecutionId: null,
    runId: 'run-two',
  });
  let failedRead = true,
    creates = 0;
  const first = transport({
      request: async (command): Promise<Json> => {
        if (command.action === 'url')
          return { success: true, data: { url: 'https://example.test/' } };
        if (command.action === 'snapshot' && failedRead) {
          failedRead = false;
          throw new BrowserTransportError('browser_page_read_stale', true);
        }
        return { success: true, data: {} };
      },
    }),
    second = transport({
      request: async (command): Promise<Json> => ({
        success: true,
        data:
          command.action === 'url'
            ? { url: 'https://example.test/' }
            : command.action === 'snapshot'
              ? {
                  snapshot: '- button "Fresh" [ref=e1]',
                  refs: { e1: { role: 'button', name: 'Fresh' } },
                }
              : {},
      }),
    });
  Object.assign(first.native, { sharedPage: true });
  Object.assign(second.native, { sharedPage: true });
  const controller = createBrowserController({
    runtime: () => owner.host,
    observationMode: async () => 'on-demand',
    captureIntervalMs: 60000,
    createTransport() {
      if (++creates === 1) return first.native;
      expect(first.closes).toBe(1);
      expect(first.disposes).toBe(1);
      return second.native;
    },
  });
  const firstHandle = await controller.job.start(
    { browserId: 'first-browser', url: 'https://example.test/' },
    { sessionId: 'session', executionId: 'job', signal: new AbortController().signal },
  );
  cleanups.push(() => controller.job.cancel(firstHandle));
  const old = controller.view('session')!;
  expect((await controller.observe!('session', old, new AbortController().signal)).content).toBe(
    'browser_page_read_stale',
  );
  owner.run.isActive = false;
  await controller.prepareRun!('session', 'run-two');
  expect(first.closes).toBe(1);
  expect(first.disposes).toBe(1);
  const secondHandle = await controller.job.start(
    { browserId: 'second-browser', url: 'https://example.test/' },
    { sessionId: 'session', executionId: 'job-two', signal: new AbortController().signal },
  );
  cleanups.push(() => controller.job.cancel(secondHandle));
  const fresh = controller.view('session')!;
  expect(await controller.observe!('session', fresh, new AbortController().signal)).toMatchObject({
    outcome: 'succeeded',
    details: { browserId: 'second-browser', elements: [{ ref: '@e1', name: 'Fresh' }] },
  });
  expect(
    (
      await controller.command(
        'session',
        old,
        { action: 'click', ref: '@e1', seq: old.seq },
        new AbortController().signal,
      )
    ).content,
  ).toBe('browser_stale_or_foreign_target');
  expect(second.requests.filter((r) => r.action === 'click')).toHaveLength(0);
  await controller.job.dispose(firstHandle);
  expect(controller.view('session')?.browserId).toBe('second-browser');
  expect(first.disposes).toBe(1);
  expect(creates).toBe(2);
  cleanups.shift();
});

test('a second Run cannot conceal an unknown first navigation by acquiring a replacement browser', async () => {
  const owner = runOwnerFixture();
  let creates = 0;
  const fake = transport({
    request: async (command): Promise<Json> => {
      if (command.action === 'navigate') throw new BrowserTransportError('response_lost', true);
      return { success: true, data: {} };
    },
  });
  const controller = createBrowserController({
    runtime: () => owner.host,
    observationMode: async () => 'on-demand',
    createTransport() {
      creates++;
      return fake.native;
    },
  });
  const handle = await controller.job.start(
    { browserId: 'first-browser', url: 'https://example.test/' },
    { sessionId: 'session', executionId: 'job', signal: new AbortController().signal },
  );
  cleanups.push(() => controller.job.cancel(handle));
  const events = controller.job.observe(handle)[Symbol.asyncIterator]();
  await events.next();
  expect((await events.next()).value).toMatchObject({
    type: 'terminal',
    result: { outcome: 'outcome_unknown' },
  });
  owner.run.isActive = false;
  await expect(controller.prepareRun!('session', 'run-two')).rejects.toThrow(
    'browser_previous_cleanup_unconfirmed',
  );
  await expect(
    controller.job.start(
      { browserId: 'second-browser', url: 'https://example.test/' },
      { sessionId: 'session', executionId: 'job-two', signal: new AbortController().signal },
    ),
  ).rejects.toThrow('browser_previous_cleanup_unconfirmed');
  expect(creates).toBe(1);
  expect(fake.requests.filter((r) => r.action === 'navigate')).toHaveLength(1);
  expect(controller.view('session')?.state).toBe('outcome_unknown');
});

async function initialNavigationRecoveryFixture(
  options: {
    receipt?: 'missing' | 'wrong-identity' | 'invalid-url' | 'throws';
    stopConfirmed?: boolean;
    disposeFails?: boolean;
    shared?: boolean;
    ownerMissing?: boolean;
    phase?: 'input' | 'later-navigation';
    failRecoverySnapshot?: boolean;
    replacementIdentity?: boolean;
    duplicateActualUrl?: boolean;
  } = {},
) {
  const owner = runOwnerFixture();
  const nextRun = {
    ...owner.run,
    id: 'run-two',
    originCommandId: 'second-command',
    rootWorkCommandId: 'second-command',
    rootWorkSeq: '2',
  };
  owner.runs.set(nextRun.id, nextRun);
  const nextJob = {
    ...owner.executions.get('job')!,
    id: 'job-two',
    originCommandId: 'second-command',
    rootWorkCommandId: 'second-command',
    rootWorkSeq: '2',
    parentExecutionId: 'second-open',
    runId: null,
  };
  owner.executions.set(nextJob.id, nextJob);
  owner.executions.set('second-open', {
    ...nextJob,
    id: 'second-open',
    kind: 'tool',
    definitionId: 'browser.open',
    parentExecutionId: null,
    runId: nextRun.id,
  });
  const requestedUrl = 'https://example.test/requested',
    actualUrl = 'https://example.test/redirected',
    identity = { pageId: 'original-main-page', incarnation: 'original-main-incarnation' };
  const first = transport({
    stopConfirmed: options.stopConfirmed,
    request: async (command): Promise<Json> => {
      if (command.action === 'navigate' || (options.phase === 'input' && command.action === 'fill'))
        throw new BrowserTransportError('browser_native_response_lost', true);
      return {
        success: true,
        data:
          command.action === 'url'
            ? { url: options.phase ? requestedUrl : 'about:blank' }
            : command.action === 'snapshot'
              ? {
                  snapshot: '- textbox "Original" [ref=e1]',
                  refs: { e1: { role: 'textbox', name: 'Original' } },
                }
              : {},
      };
    },
  });
  if (options.disposeFails) {
    const dispose = first.native.dispose;
    first.native.dispose = async () => {
      await dispose();
      throw Error('original_dispose_unconfirmed');
    };
  }
  Object.assign(first.native, {
    ...(options.shared === false ? {} : { sharedPage: true }),
    sharedPageIdentity: () => identity,
    releasedSharedPage: () => {
      if (options.receipt === 'throws') throw Error('private_receipt_unavailable');
      if (options.receipt === 'missing' || !first.disposes) return null;
      return {
        url: options.receipt === 'invalid-url' ? 'file:///private/original' : actualUrl,
        title: 'Original current document',
        identity: {
          ...identity,
          ...(options.receipt === 'wrong-identity' ? { incarnation: 'another-incarnation' } : {}),
        },
      };
    },
  });
  let snapshots = 0,
    images = 0,
    creates = 0;
  const second = transport({
    request: async (command): Promise<Json> => {
      if (command.action === 'snapshot' && ++snapshots === 1 && options.failRecoverySnapshot)
        throw new BrowserTransportError('browser_page_document_not_ready', true);
      return {
        success: true,
        data:
          command.action === 'url'
            ? { url: actualUrl }
            : command.action === 'snapshot'
              ? {
                  snapshot: '- textbox "Fresh current document" [ref=e1]',
                  refs: { e1: { role: 'textbox', name: 'Fresh current document' } },
                  origin: actualUrl,
                }
              : {},
      };
    },
  });
  Object.assign(second.native, {
    sharedPage: true,
    sharedPageIdentity: () => ({
      ...identity,
      ...(options.replacementIdentity ? { incarnation: 'replacement-incarnation' } : {}),
    }),
    async capturePng() {
      images++;
      return { data: 'fresh-image', width: 1, height: 1 };
    },
  });
  let seedPending = options.duplicateActualUrl === true;
  const seed = transport({
    request: async (command): Promise<Json> => ({
      success: true,
      data:
        command.action === 'url'
          ? { url: actualUrl }
          : command.action === 'snapshot'
            ? { snapshot: '- paragraph "Other page"', refs: {} }
            : {},
    }),
  });
  Object.assign(seed.native, {
    sharedPage: true,
    sharedPageIdentity: () => ({ pageId: 'another-main-page', incarnation: 'another-incarnation' }),
  });
  const controller = createBrowserController({
    ...(options.shared === false ? {} : { sharedPage: true }),
    ...(options.ownerMissing ? {} : { runtime: () => owner.host }),
    observationMode: async () => 'on-demand',
    createTransport: () => {
      if (seedPending) {
        seedPending = false;
        return seed.native;
      }
      return ++creates === 1 ? first.native : second.native;
    },
    captureIntervalMs: 60000,
  });
  const signal = new AbortController().signal;
  if (options.duplicateActualUrl) {
    const seedRun = {
      ...owner.run,
      id: 'seed-run',
      originCommandId: 'seed-command',
      rootWorkCommandId: 'seed-command',
      rootWorkSeq: '0',
    };
    owner.runs.set(seedRun.id, seedRun);
    owner.executions.set('seed-job', {
      ...owner.executions.get('job')!,
      id: 'seed-job',
      originCommandId: 'seed-command',
      rootWorkCommandId: 'seed-command',
      rootWorkSeq: '0',
      runId: seedRun.id,
      parentExecutionId: null,
    });
    const handle = await controller.job.start(
      { browserId: 'other-browser', url: actualUrl },
      { sessionId: 'session', executionId: 'seed-job', signal },
    );
    await controller.observe!('session', controller.view('session')!, signal);
    await controller.close('session', controller.view('session')!);
    await controller.job.dispose(handle);
    seedRun.isActive = false;
    seedRun.status = 'completed';
  }
  const original = await controller.job.start(
    { browserId: 'original-browser', url: requestedUrl },
    { sessionId: 'session', executionId: 'job', signal },
  );
  cleanups.push(() => controller.job.cancel(original).catch(() => {}));
  if (options.phase) {
    const target = controller.view('session')!;
    expect((await controller.observe!('session', target, signal)).outcome).toBe('succeeded');
    const current = controller.view('session')!;
    await controller.command(
      'session',
      current,
      options.phase === 'input'
        ? { action: 'fill', seq: current.seq, ref: '@e1', value: 'once' }
        : { action: 'navigate', url: actualUrl },
      signal,
    );
  }
  const events = controller.job.observe(original)[Symbol.asyncIterator]();
  await events.next();
  const terminal = (await events.next()).value;
  expect(terminal).toMatchObject({ type: 'terminal', result: { outcome: 'outcome_unknown' } });
  return {
    owner,
    first,
    second,
    controller,
    original,
    terminal,
    signal,
    requestedUrl,
    actualUrl,
    identity,
    get creates() {
      return creates;
    },
    get images() {
      return images;
    },
    async endOriginalRun() {
      owner.run.status = 'completed';
      owner.run.isActive = false;
      await controller.prepareRun!('session', nextRun.id);
    },
    async bindRecovered() {
      const handle = await controller.job.start(
        { browserId: 'recovered-browser', url: actualUrl },
        { sessionId: 'session', executionId: nextJob.id, signal },
      );
      cleanups.push(() => controller.job.cancel(handle).catch(() => {}));
      return handle;
    },
  };
}

test('only a disposed original initial-navigation unknown can rebind its accurate retained page for a fresh snapshot', async () => {
  const f = await initialNavigationRecoveryFixture({ failRecoverySnapshot: true });
  const originalResult = structuredClone(f.terminal);
  await f.controller.job.dispose(f.original);
  expect(f.first.disposes).toBe(1);
  expect(f.controller.releasedPages!('session')).toEqual([]);
  await expect(f.controller.prepareRun!('session', 'run-two')).rejects.toThrow(
    'browser_previous_cleanup_unconfirmed',
  );
  expect(() => f.controller.releasedPage!('session', f.actualUrl)).toThrow(
    'browser_page_recovery_required',
  );
  await f.endOriginalRun();
  expect(f.controller.view('session')?.state).toBe('outcome_unknown');
  await expect(f.controller.prepareRun!('session', 'run')).rejects.toThrow(
    'browser_control_released',
  );
  expect(f.controller.releasedPages!('session')).toEqual([
    {
      url: f.actualUrl,
      title: 'Original current document',
      identity: f.identity,
      observationRequired: true,
    },
  ]);
  for (const url of [f.requestedUrl, 'https://example.test/unrelated'])
    expect(() => f.controller.releasedPage!('session', url)).toThrow(
      'browser_page_recovery_required',
    );
  await expect(
    f.controller.job.start(
      { browserId: 'forbidden-replacement', url: f.requestedUrl },
      { sessionId: 'session', executionId: 'job-two', signal: f.signal },
    ),
  ).rejects.toThrow('browser_page_recovery_required');
  expect(f.creates).toBe(1);
  await f.bindRecovered();
  const target = f.controller.view('session')!;
  for (const operation of [
    { action: 'press', key: 'Enter' },
    { action: 'pointer', imageRef: 'old-image', kind: 'click', from: { x: 0, y: 0 } },
  ] as const)
    expect(await f.controller.control!('session', target, operation, f.signal)).toMatchObject({
      outcome: 'failed',
      content: 'browser_page_observation_required',
    });
  expect(
    await f.controller.command(
      'session',
      target,
      { action: 'navigate', url: f.requestedUrl },
      f.signal,
    ),
  ).toMatchObject({ outcome: 'failed', content: 'browser_page_observation_required' });
  await expect(f.controller.image!('session', target, f.signal)).rejects.toThrow(
    'browser_page_observation_required',
  );
  expect(f.images).toBe(0);
  expect(await f.controller.observe!('session', target, f.signal)).toMatchObject({
    outcome: 'failed',
    content: 'browser_page_document_not_ready',
  });
  expect(
    await f.controller.control!('session', target, { action: 'press', key: 'Enter' }, f.signal),
  ).toMatchObject({ outcome: 'failed', content: 'browser_page_observation_required' });
  expect((await f.controller.observe!('session', target, f.signal)).outcome).toBe('succeeded');
  expect(
    await f.controller.control!('session', target, { action: 'press', key: 'Tab' }, f.signal),
  ).toMatchObject({ outcome: 'succeeded' });
  expect(await f.controller.image!('session', target, f.signal)).toMatchObject({
    data: 'fresh-image',
  });
  expect(f.images).toBe(1);
  expect(f.first.requests.filter((request) => request.action === 'navigate')).toHaveLength(1);
  expect(f.second.requests.filter((request) => request.action === 'navigate')).toEqual([]);
  expect(f.second.requests.filter((request) => request.action === 'press')).toEqual([
    { action: 'press', key: 'Tab' },
  ]);
  expect(f.controller.releasedPages!('session')).toEqual([]);
  expect(f.terminal).toEqual(originalResult);
  expect(f.creates).toBe(2);
});

for (const [name, options] of [
  ['missing receipt', { receipt: 'missing' }],
  ['wrong original identity', { receipt: 'wrong-identity' }],
  ['invalid current URL', { receipt: 'invalid-url' }],
  ['failed passive metadata read', { receipt: 'throws' }],
  ['unconfirmed stop', { stopConfirmed: false }],
  ['failed dispose', { disposeFails: true }],
  ['independent browser', { shared: false }],
  ['unverifiable original Run', { ownerMissing: true }],
  ['business input unknown', { phase: 'input' }],
  ['navigation unknown after Agent admission', { phase: 'later-navigation' }],
] as const)
  test(`${name} cannot turn an unknown result into a retained-page recovery`, async () => {
    const f = await initialNavigationRecoveryFixture(options);
    await f.controller.job.dispose(f.original).catch(() => {});
    await expect(f.endOriginalRun()).rejects.toThrow('browser_previous_cleanup_unconfirmed');
    expect(f.controller.releasedPages!('session')).toEqual([]);
    expect(f.controller.view('session')?.state).toBe('outcome_unknown');
    expect(f.creates).toBe(1);
  });

test('a same-URL replacement never inherits a retained startup-navigation recovery', async () => {
  const f = await initialNavigationRecoveryFixture({ replacementIdentity: true });
  await f.controller.job.dispose(f.original);
  await f.endOriginalRun();
  const recovered = await f.bindRecovered();
  const events = f.controller.job.observe(recovered)[Symbol.asyncIterator]();
  await events.next();
  expect((await events.next()).value).toMatchObject({
    type: 'terminal',
    result: { outcome: 'failed', content: 'browser_page_existing_mismatch' },
  });
  expect(f.second.requests).toEqual([]);
});

test('another retained page at the same URL cannot disambiguate or replace an unknown original', async () => {
  const f = await initialNavigationRecoveryFixture({ duplicateActualUrl: true });
  await f.controller.job.dispose(f.original);
  await f.endOriginalRun();
  expect(f.controller.releasedPages!('session')).toHaveLength(2);
  expect(() => f.controller.releasedPage!('session', f.actualUrl)).toThrow(
    'browser_page_existing_ambiguous',
  );
  await expect(f.bindRecovered()).rejects.toThrow('browser_page_existing_ambiguous');
  expect(f.creates).toBe(1);
  expect(f.second.requests).toEqual([]);
});

for (const status of ['running', 'cancelling', 'interrupted'])
  test(`a ${status} original Run cannot activate a disposed navigation recovery`, async () => {
    const f = await initialNavigationRecoveryFixture();
    await f.controller.job.dispose(f.original);
    f.owner.run.status = status;
    f.owner.run.isActive = status !== 'interrupted';
    f.owner.cancel();
    await expect(f.controller.prepareRun!('session', 'run-two')).rejects.toThrow(
      'browser_previous_cleanup_unconfirmed',
    );
    expect(f.controller.releasedPages!('session')).toEqual([]);
    expect(f.creates).toBe(1);
  });

test('releasing after a failed recovery snapshot does not authorize another page or old input', async () => {
  const f = await initialNavigationRecoveryFixture({ failRecoverySnapshot: true });
  await f.controller.job.dispose(f.original);
  await f.endOriginalRun();
  const handle = await f.bindRecovered();
  const target = f.controller.view('session')!;
  expect((await f.controller.observe!('session', target, f.signal)).outcome).toBe('failed');
  await f.controller.close('session', f.controller.view('session')!);
  await f.controller.job.dispose(handle);
  expect(f.controller.releasedPages!('session')[0]).toMatchObject({ observationRequired: true });
  expect(() => f.controller.releasedPage!('session', f.requestedUrl)).toThrow(
    'browser_page_recovery_required',
  );
  expect(
    f.second.requests.filter((request) =>
      ['navigate', 'fill', 'press'].includes(String(request.action)),
    ),
  ).toEqual([]);
});

test('confirmed later absence of a navigation recovery candidate cannot clear the original unknown fence', async () => {
  const f = await initialNavigationRecoveryFixture();
  await f.controller.job.dispose(f.original);
  await f.endOriginalRun();
  expect(f.controller.invalidateMissingReleasedPage!('session', f.identity)).toBe(true);
  expect(f.controller.releasedPages!('session')).toEqual([]);
  await expect(f.controller.prepareRun!('session', 'run-two')).rejects.toThrow(
    'browser_previous_cleanup_unconfirmed',
  );
  expect(f.controller.view('session')?.state).toBe('outcome_unknown');
  expect(f.creates).toBe(1);
});

for (const release of ['close', 'handoff'] as const)
  test(`explicit ${release} fences this Run while a new Run may reacquire the retained page`, async () => {
    const owner = runOwnerFixture();
    let creates = 0;
    const pageTransport = () =>
      transport({
        request: async (command): Promise<Json> => ({
          success: true,
          data:
            command.action === 'snapshot'
              ? {
                  snapshot: '- button "Fresh" [ref=e1]',
                  refs: { e1: { role: 'button', name: 'Fresh' } },
                }
              : {},
        }),
      });
    const fakes = [pageTransport(), pageTransport()];
    for (const fake of fakes)
      Object.assign(fake.native, { sharedPage: true, handoff: async () => {} });
    const controller = createBrowserController({
      runtime: () => owner.host,
      createTransport: () => fakes[creates++]!.native,
      observationMode: async () => 'on-demand',
      captureIntervalMs: 60000,
    });
    const firstHandle = await controller.job.start(
      { browserId: 'first-browser', url: 'https://example.test/' },
      { sessionId: 'session', executionId: 'job', signal: new AbortController().signal },
    );
    cleanups.push(() => controller.job.cancel(firstHandle));
    await controller.command(
      'session',
      controller.view('session')!,
      { action: 'snapshot' },
      new AbortController().signal,
    );
    const released =
      release === 'close'
        ? await controller.close('session', controller.view('session')!)
        : await controller.handoff(
            'session',
            controller.view('session')!,
            new AbortController().signal,
          );
    expect(released.outcome).toBe('succeeded');
    await expect(controller.prepareRun!('session', 'run')).rejects.toThrow(
      'browser_control_released',
    );
    expect(creates).toBe(1);
    if (release === 'close') {
      await controller.job.dispose(firstHandle);
      cleanups.shift();
      await expect(controller.prepareRun!('session', 'run')).rejects.toThrow(
        'browser_control_released',
      );
      owner.executions.set('duplicate-job', {
        ...owner.executions.get('job')!,
        id: 'duplicate-job',
      });
      const duplicate = await controller.job.start(
        { browserId: 'duplicate-browser', url: 'https://example.test/' },
        {
          sessionId: 'session',
          executionId: 'duplicate-job',
          signal: new AbortController().signal,
        },
      );
      const events = controller.job.observe(duplicate)[Symbol.asyncIterator]();
      await events.next();
      expect((await events.next()).value).toMatchObject({
        type: 'terminal',
        result: { outcome: 'failed', content: 'browser_control_released' },
      });
      expect(creates).toBe(1);
      await controller.job.dispose(duplicate);
      await expect(controller.prepareRun!('session', 'run')).rejects.toThrow(
        'browser_control_released',
      );
    }
    owner.run.isActive = false;
    const next = {
      ...owner.run,
      id: 'next-run',
      originCommandId: 'next-command',
      rootWorkCommandId: 'next-command',
      rootWorkSeq: '2',
      isActive: true,
    };
    owner.runs.set(next.id, next);
    const job = {
      ...owner.executions.get('job')!,
      id: 'next-job',
      originCommandId: 'next-command',
      rootWorkCommandId: 'next-command',
      rootWorkSeq: '2',
      parentExecutionId: 'next-open',
      runId: null,
    };
    owner.executions.set(job.id, job);
    owner.executions.set('next-open', {
      ...job,
      id: 'next-open',
      kind: 'tool',
      definitionId: 'browser.open',
      parentExecutionId: null,
      runId: 'next-run',
    });
    await controller.prepareRun!('session', 'next-run');
    const nextHandle = await controller.job.start(
      { browserId: 'next-browser', url: 'https://example.test/' },
      { sessionId: 'session', executionId: 'next-job', signal: new AbortController().signal },
    );
    cleanups.push(() => controller.job.cancel(nextHandle));
    expect(
      (
        await controller.command(
          'session',
          controller.view('session')!,
          { action: 'snapshot' },
          new AbortController().signal,
        )
      ).outcome,
    ).toBe('succeeded');
    expect(creates).toBe(2);
    expect(controller.view('session')).not.toHaveProperty('releasedRunId');
  });
test('human reason appears only after confirmed handoff; lifecycle observers never resume or authorize operations', async () => {
  const f = await started();
  await snapshot(f.controller);
  const pause = barrier<void>();
  let pauses = 0,
    resumes = 0;
  Object.assign(f.fake.native, {
    handoff: () => {
      pauses++;
      return pause.promise;
    },
    resume: async () => {
      resumes++;
    },
  });
  const abort = new AbortController();
  const old = current(f.controller);
  const pending = f.controller.handoff(
    'session-one',
    old,
    abort.signal,
    'Review this form and explicitly continue.',
  );
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(f.controller.view('session-one')?.state).toBe('pausing');
  expect(f.controller.view('session-one')?.humanRequest).toBeUndefined();
  pause.resolve();
  expect((await pending).outcome).toBe('succeeded');
  expect(f.controller.view('session-one')?.humanRequest).toBe(
    'Review this form and explicitly continue.',
  );
  const observed: string[] = [];
  const unwatch = f.controller.watchControl('session-one', current(f.controller), (state) =>
    observed.push(state),
  );
  expect(observed).toEqual(['human']);
  const before = f.fake.requests.length;
  expect(
    (
      await f.controller.command(
        'session-one',
        current(f.controller),
        { action: 'navigate', url: 'https://example.test/forbidden' },
        abort.signal,
      )
    ).outcome,
  ).toBe('failed');
  expect(f.fake.requests).toHaveLength(before);
  expect(resumes).toBe(0);
  expect(pauses).toBe(1);
  expect(
    (await f.controller.resume('session-one', current(f.controller), abort.signal)).outcome,
  ).toBe('succeeded');
  expect(observed).toEqual(['human', 'agent']);
  expect(resumes).toBe(1);
  expect(f.controller.view('session-one')?.humanRequest).toBeUndefined();
  expect(
    (await f.controller.command('session-one', old, { action: 'snapshot' }, abort.signal)).outcome,
  ).toBe('failed');
  unwatch();
  await f.controller.close('session-one', current(f.controller));
  expect(observed).toEqual(['human', 'agent']);
});

test('a model cannot request human continuation without a trusted host, and failed handoff never reports human control', async () => {
  const f = await started();
  await snapshot(f.controller);
  const extension = createBrowserExtension({ controller: f.controller });
  const { context } = toolContext();
  const tool = extension.tools!.find((tool) => tool.id === 'browser.request_human')!;
  expect(extension.tools!.some((tool) => tool.id === 'browser.resume')).toBe(false);
  expect(
    await tool.execute(
      { key: 'human', ...current(f.controller), reason: 'Review this form' },
      context,
    ),
  ).toMatchObject({ outcome: 'failed', content: 'browser_human_continuation_unavailable' });
  expect(f.controller.view('session-one')?.state).toBe('agent');
  Object.assign(f.fake.native, {
    handoff: async () => {
      throw Error('handoff_unconfirmed');
    },
  });
  expect(
    (
      await f.controller.handoff(
        'session-one',
        current(f.controller),
        context.signal,
        'Review this form',
      )
    ).outcome,
  ).toBe('outcome_unknown');
  expect(f.controller.view('session-one')?.state).not.toBe('human');
  expect(f.controller.view('session-one')?.humanRequest).toBeUndefined();
});

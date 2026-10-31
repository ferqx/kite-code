import { expect, test } from 'bun:test';
import {
  type BrowserPagePort,
  BrowserPagePreflightError,
  NativeBrowserPageHost,
  serializeBrowserPageFailure,
} from '../../electron/browser-page-host';

function describePage(
  f: Awaited<ReturnType<typeof activeFixture>>,
  describe: () => { url: string; title: string } | undefined,
) {
  f.host.configureGrantContext({
    selectedScope: () => ({ ...f.scope, generation: 1, viewSelection: 1 }),
    create: () => {
      throw Error('unexpected_create');
    },
    describe,
    close: () => {
      throw Error('unexpected_close');
    },
  });
}

for (const url of ['https://example.test/current', '', 'about:blank'])
  test(`owned state reads Main facts with a complete exact identity for ${url || 'initial blank'}`, async () => {
    const f = await activeFixture();
    describePage(f, () => ({ url, title: 'Actual title' }));
    expect(await f.host.request({ op: 'pageState', leaseId: f.lease.leaseId })).toEqual({
      leaseId: f.lease.leaseId,
      pageId: f.port.id,
      incarnation: f.lease.incarnation,
      navigation: 0,
      url: url || 'about:blank',
      title: 'Actual title',
    });
    expect(f.calls).toEqual([]);
  });

for (const boundary of [
  'credentials',
  'protocol',
  'url-size',
  'title-size',
  'navigation',
  'revoke',
])
  test(`owned state refuses ${boundary} without dispatching page effects`, async () => {
    const f = await activeFixture();
    describePage(f, () => {
      if (boundary === 'navigation') f.host.navigate(f.port.id);
      if (boundary === 'revoke') void f.host.request({ op: 'revoke', leaseId: f.lease.leaseId });
      return {
        url:
          boundary === 'credentials'
            ? 'https://user:secret@example.test/'
            : boundary === 'protocol'
              ? 'file:///private'
              : boundary === 'url-size'
                ? `https://example.test/${'x'.repeat(8192)}`
                : 'https://example.test/current',
        title: boundary === 'title-size' ? 'x'.repeat(129) : 'Page',
      };
    });
    const request = { op: 'pageState', leaseId: f.lease.leaseId };
    const result = await f.host.request(request).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(serializeBrowserPageFailure(result, request)).toEqual({
      ...request,
      kind: 'read_failed',
    });
    expect(f.calls).toEqual([]);
  });

test('owned navigation returns actual redirected Main state and a new observation basis', async () => {
  const f = await activeFixture();
  describePage(f, () => ({ url: 'https://redirect.example.test/actual', title: 'Actual' }));
  f.port.navigate = async (url, _signal, beforeDispatch) => {
    beforeDispatch();
    f.calls.push({ method: 'Page.navigate', params: { url } });
    f.host.navigate(f.port.id);
    return { navigation: f.host.state(f.port.id)!.navigation, current: () => true };
  };
  expect(
    await f.host.request({
      op: 'navigate',
      leaseId: f.lease.leaseId,
      url: 'https://example.test/',
    }),
  ).toEqual({
    leaseId: f.lease.leaseId,
    pageId: f.port.id,
    incarnation: f.lease.incarnation,
    navigation: 1,
    url: 'https://redirect.example.test/actual',
    title: 'Actual',
  });
  expect(f.calls).toEqual([{ method: 'Page.navigate', params: { url: 'https://example.test/' } }]);
});

for (const boundary of [
  'raw-error',
  'lease',
  'attachment',
  'metadata',
  'late-navigation',
  'cancel',
])
  test(`owned navigation keeps ${boundary} after its one dispatch unknown`, async () => {
    const f = await activeFixture(),
      abort = new AbortController();
    describePage(f, () => {
      if (boundary === 'late-navigation') f.host.navigate(f.port.id);
      return {
        url: boundary === 'metadata' ? 'about:blank' : 'https://example.test/',
        title: 'Page',
      };
    });
    f.port.navigate = async (url, _signal, beforeDispatch) => {
      beforeDispatch();
      f.calls.push({ method: 'Page.navigate', params: { url } });
      if (boundary === 'raw-error') throw Error('private_cdp_error');
      if (boundary === 'lease') await f.host.request({ op: 'revoke', leaseId: f.lease.leaseId });
      if (boundary === 'cancel') abort.abort(Error('stopped'));
      return { navigation: 0, current: () => boundary !== 'attachment' };
    };
    const request = { op: 'navigate', leaseId: f.lease.leaseId, url: 'https://example.test/' };
    const result = await f.host.request(request, abort.signal).catch((error: unknown) => error);
    expect(result).toMatchObject({ message: 'browser_page_navigation_outcome_unknown' });
    expect(serializeBrowserPageFailure(result, request)).toEqual({
      op: request.op,
      leaseId: request.leaseId,
      kind: 'effect_unknown',
    });
    expect(f.calls).toHaveLength(1);
  });

for (const boundary of ['url', 'missing-driver', 'phase', 'preflight', 'cancel', 'extra-field'])
  test(`owned navigation proves no dispatch before ${boundary}`, async () => {
    const f = await activeFixture(),
      abort = new AbortController();
    f.port.navigate = async () => {
      throw Error('native_preflight_failed');
    };
    if (boundary === 'missing-driver') delete f.port.navigate;
    if (boundary === 'phase') await f.host.request({ op: 'revoke', leaseId: f.lease.leaseId });
    if (boundary === 'cancel') abort.abort(Error('stopped'));
    const request = {
      op: 'navigate',
      leaseId: f.lease.leaseId,
      url: boundary === 'url' ? 'file:///private' : 'https://example.test/',
      ...(boundary === 'extra-field' ? { target: 'another-page' } : {}),
    };
    const result = await f.host.request(request, abort.signal).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(serializeBrowserPageFailure(result, request)).toEqual({
      op: request.op,
      leaseId: request.leaseId,
      kind: 'not_dispatched',
    });
    expect(f.calls).toEqual([]);
  });

test('only one matching Main preflight receipt establishes that the requested CDP call was not sent', async () => {
  const f = await activeFixture();
  const request = {
    op: 'cdp',
    leaseId: f.lease.leaseId,
    method: 'Runtime.evaluate',
    params: { expression: '1' },
  };
  const original = new BrowserPagePreflightError(f.port.id, 'Runtime.evaluate', 'stale');
  f.port.send = async () => {
    throw original;
  };
  const first = await f.host.request(request).catch((error: unknown) => error);
  expect(serializeBrowserPageFailure(first, request)).toEqual({
    op: 'cdp',
    leaseId: f.lease.leaseId,
    method: request.method,
    kind: 'not_dispatched',
  });
  const second = await f.host.request(request).catch((error: unknown) => error);
  expect(serializeBrowserPageFailure(second, request)).toEqual({
    op: 'cdp',
    leaseId: f.lease.leaseId,
    method: request.method,
    kind: 'effect_unknown',
  });
});

for (const variant of ['text', 'prototype', 'foreign-page', 'foreign-method'])
  test(`a ${variant} error cannot forge a Main preflight no-dispatch proof`, async () => {
    const f = await activeFixture();
    const request = { op: 'cdp', leaseId: f.lease.leaseId, method: 'Runtime.evaluate', params: {} };
    const error =
      variant === 'foreign-page'
        ? new BrowserPagePreflightError('another-page', 'Runtime.evaluate', 'stale')
        : variant === 'foreign-method'
          ? new BrowserPagePreflightError(f.port.id, 'Runtime.callFunctionOn', 'stale')
          : Object.assign(Error('browser_page_read_stale'), { name: 'BrowserPagePreflightError' });
    if (variant === 'prototype') Object.setPrototypeOf(error, BrowserPagePreflightError.prototype);
    f.port.send = async () => {
      throw error;
    };
    const result = await f.host.request(request).catch((cause: unknown) => cause);
    expect(serializeBrowserPageFailure(result, request)).toMatchObject({ kind: 'effect_unknown' });
    expect(error.message).toBe('browser_page_read_stale');
  });

test('confirmed release describes only the exact live original page after detach and drain', async () => {
  const f = await activeFixture();
  const actual = { url: 'https://redirect.example.test/current', title: 'Current page' };
  f.host.configureGrantContext({
    selectedScope: () => ({ ...f.scope, generation: 1, viewSelection: 1 }),
    create: () => {
      throw Error('unexpected_create');
    },
    describe: () => ({ ...actual }),
    close: () => {
      throw Error('unexpected_close');
    },
  });
  await f.host.request({ op: 'revoke', leaseId: f.lease.leaseId });
  expect(
    await f.host.request({ op: 'release', leaseId: f.lease.leaseId, channelRevoked: true }),
  ).toEqual({
    confirmed: true,
    detached: true,
    retainedPage: {
      leaseId: f.lease.leaseId,
      pageId: f.port.id,
      incarnation: f.lease.incarnation,
      ...actual,
    },
  });
  expect(f.host.state(f.port.id)?.phase).toBe('human');
  expect(f.calls).toEqual([]);
});

for (const boundary of [
  'credentials',
  'protocol',
  'url-size',
  'title-size',
  'read-failed',
  'destroyed',
  'replaced',
  'navigation',
  'pause',
  'detach',
  'channel',
] as const)
  test(`release cannot offer a recovery page after ${boundary}`, async () => {
    const f = await activeFixture();
    let alive = true;
    f.port.alive = () => alive;
    if (boundary === 'detach') f.port.detach = () => false;
    f.host.configureGrantContext({
      selectedScope: () => ({ ...f.scope, generation: 1, viewSelection: 1 }),
      create: () => {
        throw Error('unexpected_create');
      },
      describe: () => {
        if (boundary === 'read-failed') throw Error('no_description');
        if (boundary === 'destroyed') alive = false;
        if (boundary === 'replaced') {
          f.remove();
          f.host.add({ ...f.port });
        }
        if (boundary === 'navigation') f.host.navigate(f.port.id);
        return {
          url:
            boundary === 'credentials'
              ? 'https://user:secret@example.test/'
              : boundary === 'protocol'
                ? 'file:///private'
                : boundary === 'url-size'
                  ? `https://example.test/${'x'.repeat(8192)}`
                  : 'https://example.test/current',
          title: boundary === 'title-size' ? 'x'.repeat(129) : 'Page',
        };
      },
      close: () => {
        throw Error('unexpected_close');
      },
    });
    await f.host.request({ op: 'revoke', leaseId: f.lease.leaseId });
    const result = (await f.host.request({
      op: 'release',
      leaseId: f.lease.leaseId,
      pause: boundary === 'pause',
      channelRevoked: boundary !== 'channel',
    })) as { retainedPage?: unknown };
    expect(result.retainedPage).toBeUndefined();
    expect(f.calls).toEqual([]);
  });

test('a destroyed original page proves only idempotent cleanup of its retired lease', async () => {
  const f = await activeFixture();
  let alive = true;
  f.port.alive = () => alive;
  f.remove();
  await expect(f.host.request({ op: 'revoke', leaseId: f.lease.leaseId })).rejects.toThrow(
    'browser_page_lease_stale',
  );
  alive = false;
  const closure = {
    kind: 'page_destroyed',
    leaseId: f.lease.leaseId,
    pageId: f.port.id,
    incarnation: f.lease.incarnation,
  };
  const replacement = { ...f.port, alive: () => true };
  const removeReplacement = f.host.add(replacement);
  const request = { op: 'cdp', leaseId: f.lease.leaseId, method: 'Page.getFrameTree' };
  let failure: unknown;
  try {
    await f.host.request(request);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ message: 'browser_page_closed' });
  expect(serializeBrowserPageFailure(failure, request)).toEqual({
    ...request,
    kind: 'not_dispatched',
  });
  expect(await f.host.request({ op: 'revoke', leaseId: f.lease.leaseId })).toEqual({
    revoked: true,
    closure,
  });
  for (let attempt = 0; attempt < 2; attempt++)
    expect(
      await f.host.request({
        op: 'release',
        leaseId: f.lease.leaseId,
        pause: false,
        channelRevoked: true,
      }),
    ).toEqual({ confirmed: true, detached: true, closure });
  await expect(f.host.request({ op: 'resume', leaseId: f.lease.leaseId })).rejects.toThrow(
    'browser_page_closed',
  );
  expect(
    await f.host.request({
      op: 'release',
      leaseId: f.lease.leaseId,
      pause: true,
      channelRevoked: true,
    }),
  ).toMatchObject({ confirmed: false });
  expect(f.host.state(f.port.id)).toMatchObject({ phase: 'human' });
  expect(f.host.state(f.port.id)?.incarnation).not.toBe(f.lease.incarnation);
  expect(f.calls).toEqual([]);
  removeReplacement();
});

for (const method of ['Input.insertText', 'Accessibility.getFullAXTree'])
  test(`destroyed-page cleanup drains ${method} without changing its original dispatch proof`, async () => {
    const f = await activeFixture();
    let alive = true,
      reject!: (error: Error) => void,
      started!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.port.alive = () => alive;
    f.port.send = () => {
      started();
      return new Promise((_resolve, fail) => {
        reject = fail;
      });
    };
    const request = {
      op: 'cdp',
      leaseId: f.lease.leaseId,
      method,
      params: method === 'Input.insertText' ? { text: 'once' } : {},
    };
    const effect = f.host.request(request).catch((error: unknown) => error);
    await dispatched;
    f.remove();
    alive = false;
    await f.host.request({ op: 'revoke', leaseId: f.lease.leaseId });
    let settled = false;
    const release = f.host
      .request({ op: 'release', leaseId: f.lease.leaseId, channelRevoked: true })
      .then((value) => {
        settled = true;
        return value;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    reject(Error('original_effect_response_lost'));
    const error = await effect;
    expect(error).toMatchObject({ message: 'browser_page_closed' });
    expect(serializeBrowserPageFailure(error, request)).toEqual({
      kind: method === 'Input.insertText' ? 'effect_unknown' : 'read_failed',
      op: request.op,
      leaseId: request.leaseId,
      method: request.method,
    });
    expect(await release).toMatchObject({ confirmed: true, detached: true });
    expect(f.host.state(f.port.id)).toBeUndefined();
  });

test('retired cleanup receipts are bounded and cannot authorize an evicted lease', async () => {
  const f = fixture();
  f.remove();
  const leases: { leaseId: string }[] = [];
  for (let index = 0; index < 129; index++) {
    let alive = true;
    const remove = f.host.add({ ...f.port, alive: () => alive });
    f.host.arm(f.port.id, f.scope);
    const lease = (await f.host.request({
      op: 'acquire',
      ...f.scope,
      browserId: `browser-${index}`,
      executionId: `job-${index}`,
    })) as { leaseId: string };
    leases.push(lease);
    remove();
    alive = false;
  }
  await expect(f.host.request({ op: 'revoke', leaseId: leases[0]!.leaseId })).rejects.toThrow(
    'browser_page_lease_stale',
  );
  expect(await f.host.request({ op: 'revoke', leaseId: leases.at(-1)!.leaseId })).toMatchObject({
    revoked: true,
    closure: { kind: 'page_destroyed' },
  });
  expect(f.calls).toEqual([]);
});

function fixture() {
  const host = new NativeBrowserPageHost(),
    scope = { storeId: 'store-a', sessionId: 'session-a' };
  const calls: unknown[] = [],
    paints: any[] = [],
    listeners: ((method: string, params: unknown, sessionId?: string) => void)[] = [];
  let attached = false;
  const port: BrowserPagePort = {
    id: 'page-a',
    scope,
    attach() {
      attached = true;
    },
    detach() {
      attached = false;
      return true;
    },
    alive: () => true,
    async send(method, params) {
      calls.push({ method, params });
      return {};
    },
    async typingCursor() {
      return null;
    },
    onEvent(listener) {
      listeners.push(listener);
      return () => {};
    },
    decorate: (value) => paints.push(value),
    changed() {},
    async capture() {
      return { annotations: [] };
    },
    captureMeta() {
      return null;
    },
  };
  const remove = host.add(port);
  return { host, scope, port, calls, paints, listeners, remove, attached: () => attached };
}

const captureId = '00000000-0000-4000-8000-000000000001';
function visualProof(f: Awaited<ReturnType<typeof activeFixture>>) {
  const metadata = {
    captureId,
    sha256: 'a'.repeat(64),
    navigation: 0,
    width: 800,
    height: 600,
    imageWidth: 400,
    imageHeight: 300,
  };
  f.port.captureMeta = () => ({ metadata, navigation: 0 });
  f.port.validateCapture = async (value) => value === captureId;
  return (kind: 'click' | 'drag' = 'click', to?: { x: number; y: number }, signal?: AbortSignal) =>
    f.host.request(
      {
        op: 'pointer',
        leaseId: f.lease.leaseId,
        captureId,
        kind,
        from: { x: 100, y: 75 },
        ...(to ? { to } : {}),
      },
      signal,
    );
}

test('formal image pointer proof maps pixels to CSS once and rejects replay or out-of-image points', async () => {
  const f = await activeFixture(),
    pointer = visualProof(f);
  expect(await pointer()).toEqual({ dispatched: true });
  expect(f.calls).toEqual([
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x: 200, y: 150, button: 'left', buttons: 0, clickCount: 0 },
    },
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 200, y: 150, button: 'left', buttons: 1, clickCount: 1 },
    },
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseReleased', x: 200, y: 150, button: 'left', buttons: 0, clickCount: 1 },
    },
  ]);
  await expect(pointer()).rejects.toThrow('pointer_stale');
  expect(f.calls).toHaveLength(3);
  const fresh = await activeFixture();
  visualProof(fresh);
  await expect(
    fresh.host.request({
      op: 'pointer',
      leaseId: fresh.lease.leaseId,
      captureId,
      kind: 'click',
      from: { x: 400, y: 2 },
    }),
  ).rejects.toThrow('pointer_invalid');
  expect(fresh.calls).toHaveLength(0);
});

test('drag uses a bounded path and never sends another event after proof loss or request cancellation', async () => {
  const f = await activeFixture(),
    pointer = visualProof(f);
  await pointer('drag', { x: 200, y: 150 });
  expect(f.calls).toHaveLength(11);
  expect(f.calls.at(-1)).toMatchObject({ params: { type: 'mouseReleased', x: 400, y: 300 } });
  for (const change of ['proof', 'cancel'] as const) {
    const changed = await activeFixture(),
      invoke = visualProof(changed),
      abort = new AbortController();
    changed.port.send = async (method, params) => {
      changed.calls.push({ method, params });
      if (change === 'proof') changed.port.validateCapture = async () => false;
      else abort.abort();
      return {};
    };
    await expect(invoke('drag', { x: 200, y: 150 }, abort.signal)).rejects.toThrow(
      'pointer_outcome_unknown',
    );
    expect(changed.calls).toHaveLength(1);
    expect(changed.host.state('page-a')?.phase).toBe('unknown');
  }
});

test('pointer checks the latest viewport before the first event and release drains an interrupted pointer', async () => {
  const stale = await activeFixture(),
    stalePointer = visualProof(stale);
  stale.port.validateCapture = async () => false;
  await expect(stalePointer()).rejects.toThrow('pointer_stale');
  expect(stale.calls).toHaveLength(0);
  const f = await activeFixture(),
    pointer = visualProof(f);
  let finish!: () => void, entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.port.send = async (method, params) => {
    f.calls.push({ method, params });
    entered();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {};
  };
  const result = pointer().catch((error) => error.message);
  await pending;
  await f.host.request({ op: 'revoke', leaseId: f.lease.leaseId });
  let released = false;
  const release = f.host
    .request({ op: 'release', leaseId: f.lease.leaseId, pause: true, channelRevoked: true })
    .then((value) => {
      released = true;
      return value;
    });
  await Promise.resolve();
  expect(released).toBe(false);
  finish();
  expect(await result).toBe('browser_page_pointer_outcome_unknown');
  expect(await release).toEqual({ confirmed: false, detached: true });
  expect(f.calls).toHaveLength(1);
});

test('dialog identities are issued by the current page, omit prompt content and reject replaced or closed dialogs', async () => {
  const f = await activeFixture();
  f.listeners.at(-1)!('Page.javascriptDialogOpening', {
    type: 'prompt',
    message: 'private message',
    defaultPrompt: 'secret',
  });
  const first = (await f.host.request({ op: 'dialogs', leaseId: f.lease.leaseId })) as {
    dialogs: { dialogRef: string; type: string }[];
  };
  expect(first.dialogs).toHaveLength(1);
  expect(first.dialogs[0]?.type).toBe('prompt');
  expect(JSON.stringify(first)).not.toContain('secret');
  expect(JSON.stringify(first)).not.toContain('message');
  f.listeners.at(-1)!('Page.javascriptDialogOpening', { type: 'confirm', message: 'next' });
  await expect(
    f.host.request({
      op: 'dialog',
      leaseId: f.lease.leaseId,
      dialogRef: first.dialogs[0]!.dialogRef,
      response: 'accept',
    }),
  ).rejects.toThrow('dialog_stale');
  const next = (await f.host.request({ op: 'dialogs', leaseId: f.lease.leaseId })) as typeof first;
  f.listeners.at(-1)!('Page.javascriptDialogClosed', {});
  await expect(
    f.host.request({
      op: 'dialog',
      leaseId: f.lease.leaseId,
      dialogRef: next.dialogs[0]!.dialogRef,
      response: 'accept',
    }),
  ).rejects.toThrow('dialog_stale');
  expect(f.calls).toHaveLength(0);
  f.listeners.at(-1)!('Page.javascriptDialogOpening', { type: 'alert' }, 'foreign-frame');
  expect(await f.host.request({ op: 'dialogs', leaseId: f.lease.leaseId })).toEqual({
    dialogs: [],
  });
  f.listeners.at(-1)!('Page.javascriptDialogOpening', { type: 'beforeunload' });
  expect(await f.host.request({ op: 'dialogs', leaseId: f.lease.leaseId })).toMatchObject({
    dialogs: [{ type: 'beforeunload' }],
  });
});

test('a still-held mouse press prevents a false confirmed manual handoff', async () => {
  const f = await activeFixture();
  await f.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: 30, button: 'left' });
  await f.host.request({ op: 'revoke', leaseId: f.lease.leaseId });
  expect(
    await f.host.request({
      op: 'release',
      leaseId: f.lease.leaseId,
      pause: true,
      channelRevoked: true,
    }),
  ).toEqual({ confirmed: false, detached: true });
  expect(f.host.state('page-a')?.phase).toBe('unknown');
  expect(f.calls).toHaveLength(1);
});

test('exact dialog handling completes a held semantic click once; unknown replies never replay', async () => {
  for (const fails of [false, true]) {
    const f = await activeFixture();
    await f.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: 30, button: 'left' });
    f.listeners.at(-1)!('Page.javascriptDialogOpening', { type: 'confirm', message: 'Continue?' });
    const { dialogs } = (await f.host.request({ op: 'dialogs', leaseId: f.lease.leaseId })) as {
      dialogs: { dialogRef: string }[];
    };
    f.port.send = async (method, params) => {
      f.calls.push({ method, params });
      if (fails) throw Error('lost_ack');
      return {};
    };
    const request = {
      op: 'dialog',
      leaseId: f.lease.leaseId,
      dialogRef: dialogs[0]!.dialogRef,
      response: 'accept',
    };
    if (fails) {
      await expect(f.host.request(request)).rejects.toThrow('dialog_outcome_unknown');
      expect(f.host.state('page-a')?.phase).toBe('unknown');
    } else {
      expect(await f.host.request(request)).toEqual({ handled: true });
      expect(f.calls.at(-1)).toMatchObject({
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseReleased', x: 20, y: 30 },
      });
    }
    const count = f.calls.length;
    await expect(f.host.request(request)).rejects.toThrow('dialog_stale');
    expect(f.calls).toHaveLength(count);
  }
});

test('a dialog decision invalidated during dispatch remains unknown without releasing an old press', async () => {
  for (const change of ['navigation', 'dialog', 'cancel']) {
    const f = await activeFixture();
    const abort = new AbortController();
    await f.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: 30, button: 'left' });
    f.listeners.at(-1)!('Page.javascriptDialogOpening', { type: 'confirm' });
    const { dialogs } = (await f.host.request({ op: 'dialogs', leaseId: f.lease.leaseId })) as {
      dialogs: { dialogRef: string }[];
    };
    f.calls.length = 0;
    f.port.send = async (method, params) => {
      f.calls.push({ method, params });
      if (change === 'navigation') f.host.navigate('page-a');
      if (change === 'dialog')
        f.listeners.at(-1)!('Page.javascriptDialogOpening', { type: 'confirm' });
      if (change === 'cancel') abort.abort();
      return {};
    };
    const input = {
      op: 'dialog',
      leaseId: f.lease.leaseId,
      dialogRef: dialogs[0]!.dialogRef,
      response: 'accept',
    };
    const error: unknown = await f.host.request(input, abort.signal).then(
      () => undefined,
      (reason) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw Error('fixture_expected_dialog_failure');
    expect(error.message).toBe('browser_page_dialog_outcome_unknown');
    expect(serializeBrowserPageFailure(error, input)).toEqual({
      op: 'dialog',
      leaseId: f.lease.leaseId,
      kind: 'effect_unknown',
    });
    expect(f.calls).toEqual([{ method: 'Page.handleJavaScriptDialog', params: { accept: true } }]);
    expect(f.host.state('page-a')?.phase).toBe('unknown');
  }
});

async function activeFixture() {
  const f = fixture();
  f.host.arm('page-a', f.scope);
  const lease = (await f.host.request({
    op: 'acquire',
    ...f.scope,
    browserId: 'b',
    executionId: 'j',
  })) as { leaseId: string; incarnation: string };
  await f.host.request({ op: 'confirm', leaseId: lease.leaseId });
  f.host.present('page-a', true);
  return {
    ...f,
    lease,
    cdp: (method: string, params = {}) =>
      f.host.request({ op: 'cdp', leaseId: lease.leaseId, method, params }),
  };
}

test('confirmed frame and full AX reads wait for the current document and dispatch only once after ready', async () => {
  for (const method of ['Page.getFrameTree', 'Accessibility.getFullAXTree']) {
    const f = await activeFixture(),
      abort = new AbortController();
    let ready!: (value: boolean) => void,
      waiting = 0;
    f.port.waitForDocument = (signal) => {
      expect(signal).toBe(abort.signal);
      waiting++;
      return new Promise((resolve) => {
        ready = resolve;
      });
    };
    const input = { op: 'cdp', leaseId: f.lease.leaseId, method };
    const read = f.host.request(input, abort.signal);
    expect(waiting).toBe(1);
    expect(f.calls).toHaveLength(0);
    ready(true);
    expect(await read).toEqual({});
    expect(f.calls).toEqual([{ method, params: {} }]);
    expect(f.host.state('page-a')?.phase).toBe('agent');
  }
});

test('document readiness never blocks setup or other CDP methods, and an empty ready document is a valid read', async () => {
  const f = fixture();
  let gates = 0;
  f.port.waitForDocument = async () => {
    gates++;
    return true;
  };
  f.host.arm('page-a', f.scope);
  const lease = (await f.host.request({
    op: 'acquire',
    ...f.scope,
    browserId: 'b',
    executionId: 'j',
  })) as { leaseId: string };
  for (const method of ['Page.getFrameTree', 'Accessibility.getFullAXTree'])
    await f.host.request({ op: 'cdp', leaseId: lease.leaseId, method });
  await f.host.request({ op: 'confirm', leaseId: lease.leaseId });
  for (const method of ['Accessibility.getPartialAXTree', 'Page.getLayoutMetrics', 'Page.enable'])
    await f.host.request({ op: 'cdp', leaseId: lease.leaseId, method });
  expect(gates).toBe(0);
  f.port.send = async () => ({ nodes: [] });
  expect(
    await f.host.request({
      op: 'cdp',
      leaseId: lease.leaseId,
      method: 'Accessibility.getFullAXTree',
    }),
  ).toEqual({ nodes: [] });
  expect(gates).toBe(1);
});

test('an unready document has exact read_failed proof and leaves the original lease usable for a later ready read', async () => {
  for (const method of ['Page.getFrameTree', 'Accessibility.getFullAXTree']) {
    const f = await activeFixture();
    f.port.waitForDocument = async () => false;
    const input = { op: 'cdp', leaseId: f.lease.leaseId, method };
    const error: unknown = await f.host.request(input).catch((cause) => cause);
    expect((error as Error).message).toBe('browser_page_document_not_ready');
    expect(serializeBrowserPageFailure(error, input)).toEqual({ kind: 'read_failed', ...input });
    expect(
      serializeBrowserPageFailure(error, { ...input, method: 'DOM.getDocument' }),
    ).toBeUndefined();
    expect(f.calls).toHaveLength(0);
    expect(f.host.state('page-a')?.phase).toBe('agent');
    f.port.waitForDocument = async () => true;
    expect(await f.host.request(input)).toEqual({});
    expect(f.calls).toEqual([{ method, params: {} }]);
    await f.host.request({ op: 'revoke', leaseId: f.lease.leaseId });
    expect(
      await f.host.request({ op: 'release', leaseId: f.lease.leaseId, channelRevoked: true }),
    ).toEqual({ confirmed: true, detached: true });
  }
});

test('navigation, revoke, close and cancellation during the document wait never send a late read or leak the reservation', async () => {
  for (const method of ['Page.getFrameTree', 'Accessibility.getFullAXTree'])
    for (const change of ['navigation', 'revoke', 'close', 'cancel'] as const) {
      const f = await activeFixture(),
        abort = new AbortController();
      let ready!: (value: boolean) => void;
      f.port.waitForDocument = (signal) =>
        new Promise((resolve, reject) => {
          ready = resolve;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      // Native's changed hook wakes a stopped/closed page before release waits idle.
      f.port.changed = () => {
        if (f.host.state('page-a')?.phase !== 'agent') ready(false);
      };
      const input = { op: 'cdp', leaseId: f.lease.leaseId, method };
      const read = f.host.request(input, abort.signal).catch((cause) => cause as Error);
      expect(f.calls).toHaveLength(0);
      if (change === 'navigation') {
        f.host.navigate('page-a');
        ready(true); // Even a late ready result cannot validate the previous document.
      } else if (change === 'close') f.remove();
      else if (change === 'cancel') abort.abort(Error('cancelled fixture read'));
      else await f.host.request({ op: 'revoke', leaseId: f.lease.leaseId });
      const error = (await read) as Error;
      expect(error.message).toBe(
        change === 'cancel' ? 'browser_page_request_failed' : 'browser_page_read_stale',
      );
      expect(serializeBrowserPageFailure(error, input)).toEqual({ kind: 'read_failed', ...input });
      ready(true);
      await Promise.resolve();
      expect(f.calls).toHaveLength(0);
      if (change === 'close') expect(f.host.state('page-a')).toBeUndefined();
      else {
        if (change !== 'revoke') await f.host.request({ op: 'revoke', leaseId: f.lease.leaseId });
        expect(
          await f.host.request({ op: 'release', leaseId: f.lease.leaseId, channelRevoked: true }),
        ).toEqual({ confirmed: true, detached: true });
      }
    }
});

test('revocation wakes a pending document read so concurrent release drains before detaching', async () => {
  const f = await activeFixture();
  let ready!: (value: boolean) => void;
  f.port.waitForDocument = () =>
    new Promise((resolve) => {
      ready = resolve;
    });
  f.port.changed = () => {
    if (f.host.state('page-a')?.phase !== 'agent') ready(false);
  };
  const input = { op: 'cdp', leaseId: f.lease.leaseId, method: 'Accessibility.getFullAXTree' };
  const read = f.host.request(input).catch((cause) => cause as Error);
  const revoke = f.host.request({ op: 'revoke', leaseId: f.lease.leaseId });
  const release = f.host.request({ op: 'release', leaseId: f.lease.leaseId, channelRevoked: true });
  expect(((await read) as Error).message).toBe('browser_page_read_stale');
  await revoke;
  expect(await release).toEqual({ confirmed: true, detached: true });
  expect(f.calls).toHaveLength(0);
});

function responsePayload(bytes: number) {
  const overhead = Buffer.byteLength(JSON.stringify({ ok: true, value: { data: '' } }));
  const available = bytes - overhead;
  return { data: '界'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3) };
}

test('only full AX reads use two MiB and all response ceilings count the complete UTF-8 success envelope', async () => {
  for (const [method, maximum] of [
    ['Accessibility.getFullAXTree', 2 * 1024 * 1024],
    ['Accessibility.getPartialAXTree', 512 * 1024],
    ['DOM.getDocument', 512 * 1024],
    ['Page.captureScreenshot', 6 * 1024 * 1024],
  ] as const) {
    const f = await activeFixture();
    let value = responsePayload(maximum);
    f.port.send = async () => value;
    const input = { op: 'cdp', leaseId: f.lease.leaseId, method };
    const body = await f.host.requestSerialized(input);
    expect(Buffer.byteLength(body)).toBe(maximum);
    expect(body.length).toBeLessThan(maximum);
    expect(JSON.parse(body)).toEqual({ ok: true, value });
    expect(await f.host.request(input)).toBe(value); // Existing direct callers retain raw values.
    value = responsePayload(maximum + 1);
    const error: unknown = await f.host.requestSerialized(input).catch((cause) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('browser_page_response_limit');
    expect(serializeBrowserPageFailure(error, input)).toEqual({
      kind: 'read_failed',
      ...input,
    });
    expect(f.host.state('page-a')?.phase).toBe('agent');
    expect(f.attached()).toBe(true);
  }
});

test('an AX response above the former ceiling survives and an oversized read keeps exact proof without closing the page', async () => {
  const f = await activeFixture();
  const input = {
    op: 'cdp',
    leaseId: f.lease.leaseId,
    method: 'Accessibility.getFullAXTree',
  };
  let value = responsePayload(548721);
  f.port.send = async () => value;
  expect(Buffer.byteLength(await f.host.requestSerialized(input))).toBe(548721);
  value = responsePayload(2 * 1024 * 1024 + 1);
  const error: unknown = await f.host.request(input).catch((cause) => cause);
  expect((error as Error).message).toBe('browser_page_response_limit');
  expect(serializeBrowserPageFailure(error, input)).toEqual({ kind: 'read_failed', ...input });
  for (const wrong of [
    { ...input, op: 'capture' },
    { ...input, leaseId: 'another-lease' },
    { ...input, method: 'DOM.getDocument' },
  ])
    expect(serializeBrowserPageFailure(error, wrong)).toBeUndefined();
  expect(
    serializeBrowserPageFailure(
      Object.assign(Error('browser_page_response_limit'), {
        failure: { kind: 'not_dispatched', ...input },
      }),
      input,
    ),
  ).toBeUndefined();
  expect(f.host.state('page-a')?.phase).toBe('agent');
  expect(f.attached()).toBe(true);
  value = { data: 'small-current-read' };
  expect(await f.host.request(input)).toEqual(value);
  expect(f.host.state('page-a')?.phase).toBe('agent');
});

test('serialization stays inside the proof boundary and a foreign same-code error cannot forge a size failure', async () => {
  const f = await activeFixture();
  const input = {
    op: 'cdp',
    leaseId: f.lease.leaseId,
    method: 'Accessibility.getFullAXTree',
  };
  let serialized = 0;
  f.port.send = async () => ({
    toJSON() {
      serialized++;
      return { nodes: [] };
    },
  });
  expect(await f.host.requestSerialized(input)).toBe('{"ok":true,"value":{"nodes":[]}}');
  expect(serialized).toBe(1);
  f.port.send = async () => {
    throw Object.assign(Error('browser_page_response_limit'), {
      failure: { kind: 'not_dispatched', ...input },
    });
  };
  const error: unknown = await f.host.requestSerialized(input).catch((cause) => cause);
  expect((error as Error).message).toBe('browser_page_request_failed');
  expect(serializeBrowserPageFailure(error, input)).toEqual({ kind: 'read_failed', ...input });
});

test('an oversized potentially effectful CDP result keeps effect_unknown rather than minting a read or no-dispatch proof', async () => {
  const f = await activeFixture();
  const input = { op: 'cdp', leaseId: f.lease.leaseId, method: 'Runtime.evaluate', params: {} };
  let calls = 0;
  f.port.send = async () => {
    calls++;
    return responsePayload(512 * 1024 + 1);
  };
  const error: unknown = await f.host.requestSerialized(input).catch((cause) => cause);
  expect((error as Error).message).toBe('browser_page_response_limit');
  expect(serializeBrowserPageFailure(error, input)).toEqual({
    kind: 'effect_unknown',
    op: 'cdp',
    leaseId: f.lease.leaseId,
    method: 'Runtime.evaluate',
  });
  expect(calls).toBe(1);
});

test('typing paints only fresh focused coordinates after actual dispatch; absent focus clears old location', async () => {
  const f = await activeFixture();
  f.port.typingCursor = async () => ({ x: 40, y: 60 });
  f.port.send = async () => {
    expect(f.paints.at(-1).cursor).toBeNull();
    return {};
  };
  await f.cdp('Input.insertText', { text: 'ordinary' });
  expect(f.paints.at(-1).cursor).toEqual({ x: 40, y: 60, phase: 'type', navigation: 0 });
  f.port.send = async () => ({});
  f.port.typingCursor = async () => null;
  await f.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' });
  expect(f.paints.at(-1).cursor).toBeNull();
});

test('navigation during typing focus read refuses the input and late coordinates', async () => {
  const f = await activeFixture();
  let finish!: (point: { x: number; y: number }) => void;
  f.port.typingCursor = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const result = f.cdp('Input.insertText', { text: 'stale' });
  f.host.navigate('page-a');
  finish({ x: 50, y: 80 });
  await expect(result).rejects.toThrow('read_stale');
  expect(f.calls).toHaveLength(0);
  expect(f.paints.at(-1).cursor).toBeNull();
});

test('handoff drains typing focus read and never dispatches its late input', async () => {
  const f = await activeFixture();
  let finish!: (point: null) => void;
  f.port.typingCursor = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const input = f.cdp('Input.insertText', { text: 'stale' }).catch((error) => error.message);
  await f.host.request({ op: 'revoke', leaseId: f.lease.leaseId });
  let released = false;
  const release = f.host
    .request({ op: 'release', leaseId: f.lease.leaseId, pause: true, channelRevoked: true })
    .then((value) => {
      released = true;
      return value;
    });
  await Promise.resolve();
  expect(released).toBe(false);
  finish(null);
  expect(await input).toContain('read_stale');
  expect(await release).toEqual({ confirmed: true, detached: true });
  expect(f.calls).toHaveLength(0);
});

test('failed real dispatch clears its marker and issues its own effect proof without trusting a foreign error', async () => {
  const f = await activeFixture();
  f.port.send = async () => {
    throw Object.assign(Error('browser_page_navigation_denied'), {
      dispatched: false,
      failure: { kind: 'not_dispatched' },
    });
  };
  const input = {
    op: 'cdp',
    leaseId: f.lease.leaseId,
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mousePressed', x: 20, y: 30 },
  };
  const error = await f.host.request(input).catch((error) => error);
  expect(error instanceof Error ? error.message : undefined).toBe('browser_page_request_failed');
  expect(serializeBrowserPageFailure(error, input)).toEqual({
    kind: 'effect_unknown',
    op: 'cdp',
    leaseId: f.lease.leaseId,
    method: 'Input.dispatchMouseEvent',
  });
  expect(
    serializeBrowserPageFailure(error, { ...input, method: 'Page.getLayoutMetrics' }),
  ).toBeUndefined();
  expect(
    serializeBrowserPageFailure(
      Object.assign(Error('browser_page_request_failed'), { failure: { kind: 'not_dispatched' } }),
      input,
    ),
  ).toBeUndefined();
  expect(f.paints.at(-1).cursor).toBeNull();
});

test('release waits for asynchronous detach cleanup and keeps failed cleanup unknown', async () => {
  for (const fails of [false, true]) {
    const f = await activeFixture();
    let finish!: () => void;
    f.port.detach = async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (fails) throw Error('style_removal_failed');
      return true;
    };
    await f.host.request({ op: 'revoke', leaseId: f.lease.leaseId });
    let settled = false;
    const release = f.host
      .request({ op: 'release', leaseId: f.lease.leaseId, pause: true, channelRevoked: true })
      .then((value) => {
        settled = true;
        return value;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.host.state('page-a')?.phase).toBe('revoking');
    finish();
    expect(await release).toEqual({ confirmed: !fails, detached: !fails });
    expect(f.host.state('page-a')?.phase).toBe(fails ? 'unknown' : 'human');
  }
});

for (const failure of ['attach-rejected', 'late-success'] as const)
  test(`resume publishes sticky unknown after ${failure} and cannot reuse the old lease`, async () => {
    const f = await activeFixture();
    const published: (string | undefined)[] = [];
    f.port.changed = () => published.push(f.host.state('page-a')?.phase);
    await f.host.request({ op: 'revoke', leaseId: f.lease.leaseId });
    await f.host.request({
      op: 'release',
      leaseId: f.lease.leaseId,
      pause: true,
      channelRevoked: true,
    });
    expect(published.at(-1)).toBe('human');
    let resolve!: () => void, reject!: (error: Error) => void;
    f.port.attach = () =>
      new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
    const resuming = f.host.request({ op: 'resume', leaseId: f.lease.leaseId });
    const observed = resuming.then(
      (value) => ({ value, error: undefined }),
      (error: Error) => ({ value: undefined, error }),
    );
    expect(f.host.state('page-a')?.phase).toBe('acquiring');
    if (failure === 'attach-rejected') reject(Error('debugger_attach_failed'));
    else {
      f.host.fail('page-a');
      resolve();
    }
    const result = await observed;
    expect(result.error?.message).toBe(
      failure === 'attach-rejected' ? 'browser_page_request_failed' : 'browser_page_lease_stale',
    );
    expect(result.value).toBeUndefined();
    expect(f.host.state('page-a')?.phase).toBe('unknown');
    expect(published.at(-1)).toBe('unknown');
    expect(f.host.retained('page-a')).toBe(true);
    expect(f.paints.at(-1).agent).toBe(false);
    expect(f.listeners).toHaveLength(1);
    for (const op of ['confirm', 'resume', 'revoke', 'release'])
      await expect(f.host.request({ op, leaseId: f.lease.leaseId })).rejects.toThrow('stale');
    expect(f.host.state('page-a')?.phase).toBe('unknown');
    expect(() => f.host.arm('page-a', f.scope)).toThrow();
  });

test('acquire rejects a late attach success after failure without publishing a lease or watching events', async () => {
  const f = fixture();
  const published: (string | undefined)[] = [];
  f.port.changed = () => published.push(f.host.state('page-a')?.phase);
  f.host.arm('page-a', f.scope);
  let resolve!: () => void;
  f.port.attach = () =>
    new Promise<void>((done) => {
      resolve = done;
    });
  const acquiring = f.host.request({
    op: 'acquire',
    ...f.scope,
    browserId: 'b',
    executionId: 'j',
  });
  const observed = acquiring.then(
    (value) => ({ value, error: undefined }),
    (error: Error) => ({ value: undefined, error }),
  );
  expect(f.host.state('page-a')?.phase).toBe('acquiring');
  f.host.fail('page-a');
  resolve();
  const result = await observed;
  expect(result.error?.message).toBe('browser_page_lease_stale');
  expect(result.value).toBeUndefined();
  expect(f.host.state('page-a')?.phase).toBe('unknown');
  expect(published.at(-1)).toBe('unknown');
  expect(f.host.retained('page-a')).toBe(true);
  expect(f.paints.at(-1).agent).toBe(false);
  expect(f.listeners).toHaveLength(0);
  expect(() => f.host.arm('page-a', f.scope)).toThrow();
  await expect(
    f.host.request({ op: 'acquire', ...f.scope, browserId: 'b', executionId: 'j' }),
  ).rejects.toThrow('explicit_grant_required');
});

test('same normal page is granted, attached and confirmed; hidden view never cancels commands', async () => {
  const f = fixture();
  await expect(
    f.host.request({
      op: 'acquire',
      storeId: f.scope.storeId,
      sessionId: f.scope.sessionId,
      browserId: 'b',
      executionId: 'j',
    }),
  ).rejects.toThrow('explicit_grant_required');
  f.host.arm('page-a', f.scope);
  await expect(
    f.host.request({
      op: 'acquire',
      storeId: 'another-store',
      sessionId: f.scope.sessionId,
      browserId: 'b',
      executionId: 'j',
    }),
  ).rejects.toThrow('explicit_grant_required');
  expect(f.attached()).toBe(false);
  const lease: any = await f.host.request({
    op: 'acquire',
    storeId: f.scope.storeId,
    sessionId: f.scope.sessionId,
    browserId: 'b',
    executionId: 'j',
  });
  await expect(
    f.host.request({
      op: 'cdp',
      leaseId: lease.leaseId,
      method: 'Input.dispatchMouseEvent',
      params: { x: 1, y: 2 },
    }),
  ).rejects.toThrow('not_ready');
  await f.host.request({ op: 'confirm', leaseId: lease.leaseId });
  f.host.present('page-a', true);
  expect(f.paints.at(-1).agent).toBe(true);
  f.host.present('page-a', false);
  await f.host.request({
    op: 'cdp',
    leaseId: lease.leaseId,
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mousePressed', x: 100, y: 80 },
  });
  expect(f.calls).toHaveLength(1);
  expect(f.paints.at(-1).visible).toBe(false);
  expect(f.host.retained('page-a')).toBe(true);
  expect(f.host.state('page-a')?.browserId).toBe('b');
  for (const request of [
    { method: 'Browser.close' },
    { method: 'Target.attachToTarget', params: { targetId: 'outside' } },
    { method: 'Page.navigate', params: { url: 'file:///private.txt' } },
    { method: 'Input.insertText', sessionId: 'outside' },
  ])
    await expect(
      f.host.request({ op: 'cdp', leaseId: lease.leaseId, ...request }),
    ).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
});
test('handoff drains a real in-flight promise before detach; resume rotates identity and ignores old events', async () => {
  const f = fixture();
  f.host.arm('page-a', f.scope);
  let lease: any = await f.host.request({
    op: 'acquire',
    storeId: f.scope.storeId,
    sessionId: f.scope.sessionId,
    browserId: 'b',
    executionId: 'j',
  });
  await f.host.request({ op: 'confirm', leaseId: lease.leaseId });
  let resolve!: () => void;
  f.port.send = () =>
    new Promise<void>((done) => {
      resolve = done;
    });
  const command = f.host.request({
    op: 'cdp',
    leaseId: lease.leaseId,
    method: 'Input.insertText',
    params: { text: 'test' },
  });
  await Promise.resolve();
  await f.host.request({ op: 'revoke', leaseId: lease.leaseId });
  const release = f.host.request({
    op: 'release',
    leaseId: lease.leaseId,
    pause: true,
    channelRevoked: true,
  });
  expect(f.attached()).toBe(true);
  resolve();
  await command;
  expect(await release).toEqual({ confirmed: true, detached: true });
  expect(f.host.state('page-a')?.phase).toBe('human');
  const old = lease;
  lease = await f.host.request({ op: 'resume', leaseId: old.leaseId });
  expect(lease.leaseId).not.toBe(old.leaseId);
  f.listeners[0]!('Page.frameNavigated', {});
  expect(
    ((await f.host.request({ op: 'events', leaseId: lease.leaseId, after: 0 })) as any).events,
  ).toHaveLength(0);
  await expect(f.host.request({ op: 'confirm', leaseId: old.leaseId })).rejects.toThrow('stale');
  await f.host.request({ op: 'confirm', leaseId: lease.leaseId });
  await f.host.request({ op: 'revoke', leaseId: lease.leaseId });
  expect(
    await f.host.request({
      op: 'release',
      leaseId: lease.leaseId,
      pause: false,
      channelRevoked: true,
    }),
  ).toEqual({ confirmed: true, detached: true });
  expect(f.host.retained('page-a')).toBe(false);
});
test('unconfirmed channel revocation never claims manual ownership or allows a new grant', async () => {
  const f = fixture();
  f.host.arm('page-a', f.scope);
  const lease: any = await f.host.request({
    op: 'acquire',
    storeId: f.scope.storeId,
    sessionId: f.scope.sessionId,
    browserId: 'b',
    executionId: 'j',
  });
  await f.host.request({ op: 'confirm', leaseId: lease.leaseId });
  await f.host.request({ op: 'revoke', leaseId: lease.leaseId });
  expect(
    (
      (await f.host.request({
        op: 'release',
        leaseId: lease.leaseId,
        pause: true,
        channelRevoked: false,
      })) as any
    ).confirmed,
  ).toBe(false);
  expect(f.host.state('page-a')?.phase).toBe('unknown');
  expect(f.host.retained('page-a')).toBe(true);
  expect(() => f.host.arm('page-a', f.scope)).toThrow();
  await expect(
    f.host.request({
      op: 'cdp',
      leaseId: lease.leaseId,
      method: 'Runtime.evaluate',
      params: { expression: '1' },
    }),
  ).rejects.toThrow();
});

test('capture is an owned in-flight read; revocation drains it and refuses its late pixels', async () => {
  const f = fixture();
  f.host.arm('page-a', f.scope);
  const lease: any = await f.host.request({
    op: 'acquire',
    ...f.scope,
    browserId: 'b',
    executionId: 'j',
  });
  await f.host.request({ op: 'confirm', leaseId: lease.leaseId });
  await f.host.request({ op: 'revoke', leaseId: lease.leaseId });
  await f.host.request({
    op: 'release',
    leaseId: lease.leaseId,
    pause: true,
    channelRevoked: true,
  });
  let resolve!: (value: unknown) => void,
    calls = 0;
  f.port.capture = () => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  };
  const capture = f.host.request({ op: 'capture', leaseId: lease.leaseId });
  const captured = capture.then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error }),
  );
  await f.host.request({ op: 'revoke', leaseId: lease.leaseId });
  let settled = false;
  const release = f.host
    .request({ op: 'release', leaseId: lease.leaseId, pause: false, channelRevoked: true })
    .then((value) => {
      settled = true;
      return value;
    });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const before = { settled, retained: f.host.retained('page-a'), attached: f.attached() };
  resolve({ pixels: 'old-frame' });
  const result = await captured;
  expect(before).toEqual({ settled: false, retained: true, attached: false });
  expect(result.error?.message).toContain('read_stale');
  expect(await release).toEqual({ confirmed: true, detached: true });
  expect(calls).toBe(1);
  expect(f.host.retained('page-a')).toBe(false);
});

test('unknown capture never calls the port, while exact paused capture remains available', async () => {
  const f = fixture();
  f.host.arm('page-a', f.scope);
  const lease: any = await f.host.request({
    op: 'acquire',
    ...f.scope,
    browserId: 'b',
    executionId: 'j',
  });
  await f.host.request({ op: 'confirm', leaseId: lease.leaseId });
  await f.host.request({ op: 'revoke', leaseId: lease.leaseId });
  await f.host.request({
    op: 'release',
    leaseId: lease.leaseId,
    pause: true,
    channelRevoked: true,
  });
  let calls = 0;
  f.port.capture = async () => {
    calls++;
    return { pixels: 'paused-frame' };
  };
  expect(await f.host.request({ op: 'capture', leaseId: lease.leaseId })).toEqual({
    pixels: 'paused-frame',
  });
  expect(calls).toBe(1);
  f.host.fail('page-a');
  await expect(f.host.request({ op: 'capture', leaseId: lease.leaseId })).rejects.toThrow();
  expect(calls).toBe(1);
  let metadataCalls = 0;
  f.port.captureMeta = () => {
    metadataCalls++;
    return {};
  };
  await expect(f.host.request({ op: 'captureMeta', leaseId: lease.leaseId })).rejects.toThrow();
  expect(metadataCalls).toBe(0);
});

test('navigation rejects an old in-flight frame without leaking its read reservation', async () => {
  const f = fixture();
  f.host.arm('page-a', f.scope);
  const lease: any = await f.host.request({
    op: 'acquire',
    ...f.scope,
    browserId: 'b',
    executionId: 'j',
  });
  await f.host.request({ op: 'confirm', leaseId: lease.leaseId });
  let resolve!: (value: unknown) => void;
  f.port.capture = () =>
    new Promise((done) => {
      resolve = done;
    });
  const read = f.host.request({ op: 'capture', leaseId: lease.leaseId }).then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error }),
  );
  f.host.navigate('page-a');
  resolve({ pixels: 'before-navigation' });
  const reply = await read;
  expect(reply.error?.message).toContain('read_stale');
  expect(reply.value).toBeUndefined();
  f.port.capture = async () => ({ pixels: 'current-navigation' });
  expect(await f.host.request({ op: 'capture', leaseId: lease.leaseId })).toEqual({
    pixels: 'current-navigation',
  });
  await f.host.request({ op: 'revoke', leaseId: lease.leaseId });
  expect(
    await f.host.request({
      op: 'release',
      leaseId: lease.leaseId,
      pause: false,
      channelRevoked: true,
    }),
  ).toEqual({ confirmed: true, detached: true });
});

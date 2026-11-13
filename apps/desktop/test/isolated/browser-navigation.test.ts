import { expect, test } from '#kite-test';
import { createBrowserNavigation } from '../../electron/browser-navigation';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const navigation = createBrowserNavigation(),
    ack = deferred<unknown>(),
    abort = new AbortController();
  let owned = true,
    url = 'https://example.test/old',
    calls = 0;
  const input = {
    url: 'https://example.test/requested',
    epoch: 4,
    ready: true,
    signal: abort.signal,
    current: () => owned,
    actualUrl: () => url,
    dispatch: () => {
      calls++;
      return ack.promise;
    },
  };
  return {
    navigation,
    ack,
    abort,
    input,
    calls: () => calls,
    lose: () => {
      owned = false;
    },
    url: (value: string) => {
      url = value;
    },
  };
}

for (const order of ['ack-first', 'ready-first'])
  test(`one navigation waits for its current committed DOM-ready with ${order}`, async () => {
    const f = fixture();
    let settled = false;
    const running = f.navigation.run(f.input).then(() => {
      settled = true;
    });
    expect(f.calls()).toBe(1);
    if (order === 'ack-first') {
      f.ack.resolve({ frameId: 'main', loaderId: 'new-document' });
      await Promise.resolve();
    }
    f.navigation.ready(4); // Old document events cannot complete a new navigation.
    f.navigation.commit(4);
    f.navigation.start(5);
    f.navigation.ready(5); // DOM-ready without the new commit is insufficient.
    f.navigation.commit(5);
    f.navigation.ready(4);
    await Promise.resolve();
    expect(settled).toBe(false);
    f.url('https://redirect.example.test/actual');
    f.navigation.ready(5);
    if (order === 'ready-first') {
      await Promise.resolve();
      expect(settled).toBe(false);
      f.ack.resolve({ frameId: 'main', loaderId: 'new-document' });
    }
    await running;
    expect(settled).toBe(true);
    expect(f.calls()).toBe(1);
  });

test('a later main-frame redirect replaces the pending document and rejects old readiness', async () => {
  const f = fixture();
  let settled = false;
  const running = f.navigation.run(f.input).then(() => {
    settled = true;
  });
  f.ack.resolve({ frameId: 'main', loaderId: 'first-document' });
  f.navigation.start(5);
  f.navigation.commit(5);
  f.navigation.start(6);
  f.navigation.commit(5);
  f.navigation.ready(5);
  await Promise.resolve();
  expect(settled).toBe(false);
  f.navigation.commit(6);
  f.navigation.ready(6);
  await running;
  expect(f.calls()).toBe(1);
});

for (const kind of ['hash', 'same-url'])
  test(`a no-loader ${kind} navigation completes on the current ready document`, async () => {
    const f = fixture();
    const running = f.navigation.run(f.input);
    f.url(f.input.url);
    if (kind === 'hash') f.navigation.inPage(4);
    f.ack.resolve({ frameId: 'main' });
    await running;
    expect(f.calls()).toBe(1);
  });

test('same-document completion cannot return before the original document is DOM-ready', async () => {
  const f = fixture();
  let settled = false;
  const running = f.navigation.run({ ...f.input, ready: false }).then(() => {
    settled = true;
  });
  f.navigation.inPage(4);
  f.ack.resolve({ frameId: 'main' });
  await Promise.resolve();
  expect(settled).toBe(false);
  f.navigation.ready(4);
  await running;
});

for (const boundary of ['abort', 'revoke', 'detach', 'destroyed'])
  test(`${boundary} after dispatch drains the raw acknowledgement without accepting late success`, async () => {
    const f = fixture();
    let settled = false;
    const result = f.navigation.run(f.input).catch((cause) => {
      settled = true;
      return cause;
    });
    if (boundary === 'abort') f.abort.abort(Error('cancelled'));
    else if (boundary === 'revoke') {
      f.lose();
      f.navigation.check();
    } else if (boundary === 'destroyed') f.navigation.dispose();
    else f.navigation.cancel();
    f.navigation.start(5);
    f.navigation.commit(5);
    f.navigation.ready(5);
    await Promise.resolve();
    expect(settled).toBe(false);
    f.ack.resolve({ frameId: 'main', loaderId: 'new-document' });
    expect(await result).toBeInstanceOf(Error);
    expect(f.calls()).toBe(1);
  });

test('cancellation before dispatch issues no command and does not reserve an owner', async () => {
  const f = fixture();
  f.abort.abort(Error('cancelled'));
  expect(() => f.navigation.run(f.input)).toThrow('cancelled');
  expect(f.calls()).toBe(0);
});

test('loss of ownership before dispatch issues no command', async () => {
  const f = fixture();
  f.lose();
  await expect(f.navigation.run(f.input)).rejects.toThrow('browser_page_navigation_stale');
  expect(f.calls()).toBe(0);
});

for (const outcome of ['raw-error', 'invalid-reply', 'navigation-error', 'stopped'])
  test(`a dispatched ${outcome} is not retried`, async () => {
    const f = fixture();
    const result = f.navigation.run(f.input).catch((cause) => cause);
    if (outcome === 'raw-error') f.ack.reject(Error('cdp-disconnected'));
    else if (outcome === 'invalid-reply') f.ack.resolve({});
    else if (outcome === 'navigation-error')
      f.ack.resolve({ frameId: 'main', errorText: 'navigation denied' });
    else {
      f.navigation.start(5);
      f.ack.resolve({ frameId: 'main', loaderId: 'new-document' });
      f.navigation.stopped(5);
    }
    expect(await result).toBeInstanceOf(Error);
    expect(f.calls()).toBe(1);
  });

test('a prior owner drains before another navigation can register', async () => {
  const f = fixture();
  const first = f.navigation.run(f.input).catch((cause) => cause);
  f.navigation.cancel();
  await expect(f.navigation.run(f.input)).rejects.toThrow('browser_page_navigation_busy');
  f.ack.resolve({ frameId: 'main' });
  expect(await first).toBeInstanceOf(Error);
  const next = deferred<unknown>();
  const second = f.navigation.run({ ...f.input, dispatch: () => next.promise });
  f.navigation.start(5);
  f.navigation.commit(5);
  f.navigation.ready(5);
  next.resolve({ frameId: 'main', loaderId: 'next-document' });
  await second;
  expect(f.calls()).toBe(1);
});

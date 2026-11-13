import { expect, test } from '#kite-test';
import { createBrowserDocumentReady } from '../../electron/browser-document-ready';

test('document readiness waits for the started epoch to commit and reach its first DOM-ready', async () => {
  const gate = createBrowserDocumentReady(),
    signal = new AbortController().signal;
  expect(await gate.wait(signal)).toBe(true); // a ready empty document is readable
  const epoch = gate.start();
  let settled = false;
  const waiting = gate.wait(signal).then((value) => {
    settled = true;
    return value;
  });
  gate.ready(epoch);
  await Promise.resolve();
  expect(settled).toBe(false);
  gate.commit(epoch);
  await Promise.resolve();
  expect(settled).toBe(false);
  gate.ready(epoch);
  expect(await waiting).toBe(true);
  expect(await gate.wait(signal)).toBe(true);
});

test('a later document ends the old wait without adopting its DOM-ready event', async () => {
  const gate = createBrowserDocumentReady(),
    signal = new AbortController().signal;
  const old = gate.start(),
    first = gate.wait(signal);
  const current = gate.start();
  expect(await first).toBe(false);
  let settled = false;
  const second = gate.wait(signal).then((value) => {
    settled = true;
    return value;
  });
  gate.commit(old);
  gate.ready(old);
  await Promise.resolve();
  expect(settled).toBe(false);
  gate.commit(current);
  gate.ready(current);
  expect(await second).toBe(true);
});

test('abort and revoked read reservations wake without cancelling the actual document', async () => {
  const gate = createBrowserDocumentReady(),
    owner = new AbortController();
  const epoch = gate.start(),
    aborted = gate.wait(owner.signal);
  const reason = Error('original owner cancelled');
  owner.abort(reason);
  await expect(aborted).rejects.toBe(reason);
  expect(() => gate.wait(owner.signal)).toThrow(reason);
  let current = true;
  const revoked = gate.wait(new AbortController().signal, () => current);
  current = false;
  gate.check();
  expect(await revoked).toBe(false);
  const next = gate.wait(new AbortController().signal);
  gate.commit(epoch);
  gate.ready(epoch);
  expect(await next).toBe(true);
});

test('failed, detached and disposed documents settle all pending readers', async () => {
  for (const end of ['fail', 'cancel', 'dispose'] as const) {
    const gate = createBrowserDocumentReady(),
      signal = new AbortController().signal;
    const epoch = gate.start(),
      first = gate.wait(signal),
      second = gate.wait(signal);
    gate[end]();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    gate.commit(epoch);
    gate.ready(epoch);
    if (end !== 'cancel') expect(await gate.wait(signal)).toBe(false);
  }
});

test('stopped reads retire without rejecting a later readiness event for the same committed epoch', async () => {
  const gate = createBrowserDocumentReady();
  const epoch = gate.start();
  gate.commit(epoch);
  const pending = gate.wait();
  gate.stopped();
  expect(await pending).toBe(false);
  expect(await gate.wait()).toBe(false);
  gate.ready(epoch);
  expect(await gate.wait()).toBe(true);
  const successor = gate.start();
  gate.commit(successor);
  gate.fail();
  gate.ready(successor);
  expect(await gate.wait()).toBe(false);
});

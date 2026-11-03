import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { browserDecorationScript } from '../../electron/browser-decoration';
import { BrowserPageLease } from '../../electron/browser-lease';

const scope = { storeId: 'store-a', sessionId: 'session-a' };
const binding = { ...scope, pageId: 'page-a', incarnation: 'page-a-1' };
function active() {
  const page = new BrowserPageLease(binding);
  page.arm(scope);
  const lease = page.acquire(scope, 'browser-a', 'run-a');
  page.confirm(lease);
  return { page, lease };
}
test('exact explicit grant, ready and real dispatch control the page; foreign bindings cannot adopt it', () => {
  const page = new BrowserPageLease(binding);
  expect(page.phase).toBe('human');
  expect(() => page.acquire(scope, 'browser', 'run')).toThrow();
  expect(() => page.arm({ ...scope, sessionId: 'session-b' })).toThrow();
  page.arm(scope);
  const lease = page.acquire(scope, 'browser', 'run');
  expect(page.phase).toBe('acquiring');
  expect(() => page.dispatch(lease)).toThrow();
  expect(() => page.confirm({ ...lease })).toThrow();
  page.confirm(lease);
  const end = page.dispatch(lease, { x: 20, y: 30, phase: 'press' });
  expect(page.cursor).toEqual({ x: 20, y: 30, phase: 'press', navigation: 0 });
  page.navigate();
  expect(page.cursor).toBeNull();
  end();
  end();
  expect(page.cursor).toBeNull();
});
test('confirmed pause preserves the reserved page; resume has a separate ready boundary', () => {
  const { page, lease: first } = active();
  let lease = first;
  page.revoke(lease);
  expect(() => page.dispatch(lease)).toThrow();
  expect(page.pause(lease, { channelRevoked: true, detached: true })).toBe(true);
  expect(page.phase).toBe('human');
  expect(page.retained).toBe(true);
  expect(() => page.arm(scope)).toThrow();
  lease = page.reacquire(lease);
  expect(() => page.confirm(first)).toThrow();
  expect(page.phase).toBe('acquiring');
  expect(() => page.dispatch(lease)).toThrow();
  page.confirm(lease);
  page.revoke(lease);
  expect(page.release(lease, { channelRevoked: true, detached: true })).toBe(true);
  expect(page.retained).toBe(false);
  expect(page.phase).toBe('human');
});
test('late completion from an old navigation cannot clear a newer real cursor', () => {
  const { page, lease } = active();
  const first = page.dispatch(lease, { x: 10, y: 20, phase: 'move' });
  page.navigate();
  const second = page.dispatch(lease, { x: 30, y: 40, phase: 'type' });
  first();
  expect(page.cursor).toEqual({ x: 30, y: 40, phase: 'type', navigation: 1 });
  second();
});
test('failed dispatch clears its cursor without removing a later dispatch on the same navigation', () => {
  const { page, lease } = active();
  const first = page.dispatch(lease, { x: 10, y: 20, phase: 'press' });
  const second = page.dispatch(lease, { x: 30, y: 40, phase: 'move' });
  first(false);
  expect(page.cursor).toEqual({ x: 30, y: 40, phase: 'move', navigation: 0 });
  second(false);
  expect(page.cursor).toBeNull();
  const third = page.dispatch(lease, { x: 50, y: 60, phase: 'press' });
  third();
  third(false);
  expect(page.cursor).toEqual({ x: 50, y: 60, phase: 'press', navigation: 0 });
});
test('failed input without coordinates clears only the cursor present when it began', () => {
  const { page, lease } = active();
  page.dispatch(lease, { x: 10, y: 20, phase: 'press' })();
  const failedTyping = page.dispatch(lease);
  failedTyping(false);
  expect(page.cursor).toBeNull();
  page.dispatch(lease, { x: 30, y: 40, phase: 'press' })();
  const oldTyping = page.dispatch(lease);
  page.dispatch(lease, { x: 50, y: 60, phase: 'type' })();
  oldTyping(false);
  expect(page.cursor).toEqual({ x: 50, y: 60, phase: 'type', navigation: 0 });
});
test('explicitly absent focus clears old coordinates while a later cursor survives its failure', () => {
  const { page, lease } = active();
  page.dispatch(lease, { x: 10, y: 20, phase: 'press' })();
  const missingFocus = page.dispatch(lease, null);
  expect(page.cursor).toBeNull();
  page.dispatch(lease, { x: 30, y: 40, phase: 'type' })();
  missingFocus(false);
  expect(page.cursor).toEqual({ x: 30, y: 40, phase: 'type', navigation: 0 });
});
test('in-flight or missing revocation evidence remains sticky unknown after a late ACK', () => {
  for (const mode of ['pending', 'channel', 'detach'] as const) {
    const { page, lease } = active();
    const end = page.dispatch(lease);
    if (mode !== 'pending') end();
    page.revoke(lease);
    expect(
      page.pause(lease, { channelRevoked: mode !== 'channel', detached: mode !== 'detach' }),
    ).toBe(false);
    end();
    expect(page.phase).toBe('unknown');
    expect(page.release(lease, { channelRevoked: true, detached: true })).toBe(false);
    expect(() => page.reacquire(lease)).toThrow();
    expect(page.retained).toBe(true);
  }
});
test('decoration is inside actual-page DOM, does not steal focus, and has no element target box', () => {
  const dom = new JSDOM('<html><body><input id="text"></body></html>');
  const document = dom.window.document;
  document.getElementById('text')!.focus();
  const id = 'kite-control-00000000-0000-0000-0000-000000000001';
  const apply = (value: Parameters<typeof browserDecorationScript>[1]) =>
    runInNewContext(browserDecorationScript(id, value), {
      document,
      innerWidth: 500,
      innerHeight: 400,
    });
  const value = {
    agent: true,
    visible: true,
    navigation: 2,
    cursor: { x: 100, y: 80, phase: 'press' as const, navigation: 2 },
  };
  apply(value);
  const host = document.getElementById(id)!;
  expect(host.style.pointerEvents).toBe('none');
  expect(host.getAttribute('aria-hidden')).toBe('true');
  expect(host.shadowRoot!.querySelector('svg')!.style.left).toBe('100px');
  expect(host.shadowRoot!.querySelectorAll('rect')).toHaveLength(0);
  expect(document.activeElement!.id).toBe('text');
  apply({ ...value, navigation: 3 });
  expect(host.shadowRoot!.querySelector('svg')).toBeNull();
  apply({ ...value, visible: false });
  expect(document.getElementById(id)).toBeNull();
  apply({ ...value, agent: false });
  expect(document.getElementById(id)).toBeNull();
  dom.window.close();
});

import { expect, test } from 'bun:test';
import { type AgentBrowserObservation, AgentBrowserObserver } from '../src/agent-browser-observer';
import { browserFixture, browserScope } from './agent-browser.fixture';

async function until(check: () => boolean, timeout = 2500) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw Error('condition_timeout');
    await Bun.sleep(10);
  }
}
function observe(f = browserFixture(), scope = browserScope) {
  let state: AgentBrowserObservation = {
    fresh: false,
    loading: true,
    available: false,
    pending: false,
  };
  const owner = new AgentBrowserObserver(
    f.bridge,
    scope,
    (value) => {
      state = value;
    },
    true,
  );
  return {
    f,
    owner,
    get state() {
      return state;
    },
  };
}
const queryCount = (f: ReturnType<typeof browserFixture>) =>
  f.calls.filter((call) => call.method === 'extensions.query').length;

test('browser actions use verified Main catalogue and original command, reject foreign/stale inputs', async () => {
  const o = observe();
  o.owner.start(true);
  try {
    await until(() => o.state.fresh);
    expect(
      await o.owner.invoke('handoff', {
        browserId: 'foreign',
        generation: o.state.view!.generation,
      }),
    ).toBe(false);
    expect(
      await o.owner.invoke('input', {
        browserId: 'browser',
        generation: o.state.view!.generation,
        command: { action: 'scroll', direction: 'down', amount: 500 },
      }),
    ).toBe(false);
    expect(o.f.submitted).toHaveLength(0);
    expect(
      await o.owner.invoke('handoff', {
        browserId: 'browser',
        generation: o.state.view!.generation,
      }),
    ).toBe(true);
    await until(() => o.state.fresh && o.state.view?.state === 'human');
    expect(o.f.submitted[0]).toMatchObject({
      kind: 'extension.invoke',
      extensionId: 'builtin.browser',
      actionId: 'browser.handoff',
      expectedStoreId: 'store',
    });
    expect(
      await o.owner.invoke('select', {
        browserId: 'browser',
        generation: o.state.view!.generation,
        seq: '0',
        ref: '@e1',
      }),
    ).toBe(false);
    expect(
      await o.owner.invoke('select', {
        browserId: 'browser',
        generation: o.state.view!.generation,
        seq: '1',
        ref: '@e1',
      }),
    ).toBe(true);
    await until(() => o.state.fresh && o.state.view?.selectedAnnotation?.ref === '@e1');
    expect(o.f.submitted.map((item) => item.actionId)).toEqual([
      'browser.handoff',
      'browser.select',
    ]);
    expect(o.f.calls.every((call) => call.method.startsWith('extensions.'))).toBe(true);
  } finally {
    o.owner.stop();
  }
  expect(o.f.submitted.some((item) => item.actionId === 'browser.close')).toBe(false);
});

test('polling is single-flight, drops late frames and stops hidden/unmounted without cancelling work', async () => {
  const o = observe();
  let release!: () => void;
  o.f.queryGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  o.owner.start(true);
  try {
    await until(() => queryCount(o.f) === 1);
    await Bun.sleep(650);
    expect(queryCount(o.f)).toBe(1);
    expect(o.f.maxInFlight).toBe(1);
    o.owner.setVisible(false);
    o.f.view.title = 'Latest page';
    release();
    await Bun.sleep(450);
    expect(o.state.view).toBeUndefined();
    expect(queryCount(o.f)).toBe(1);
    expect(o.f.calls.some((call) => call.method === 'extensions.release')).toBe(true);
    o.f.queryGate = undefined;
    o.owner.setVisible(true);
    await until(() => o.state.fresh && o.state.view?.title === 'Latest page');
    const count = queryCount(o.f);
    o.owner.stop();
    await Bun.sleep(450);
    expect(queryCount(o.f)).toBe(count);
    expect(o.f.submitted).toHaveLength(0);
  } finally {
    release();
    o.owner.stop();
  }
});

test('stale sequence/frame cannot replace current display or regain action authority', async () => {
  const o = observe();
  o.owner.start(true);
  try {
    await until(() => o.state.fresh);
    o.f.view.seq = '0';
    o.f.view.frame!.seq = '0';
    await until(() => !o.state.fresh && !!o.state.error);
    expect(o.state.view?.seq).toBe('1');
    expect(
      await o.owner.invoke('handoff', { browserId: 'browser', generation: 'browser-generation' }),
    ).toBe(false);
    o.f.view.seq = '2';
    o.f.view.frame!.seq = '2';
    await until(() => o.state.fresh && o.state.view?.seq === '2');
    expect(o.f.submitted).toHaveLength(0);
  } finally {
    o.owner.stop();
  }
});

test('foreign scope bodies never become browser content or action authority', async () => {
  const o = observe();
  o.f.foreignHead = true;
  o.owner.start(true);
  try {
    await until(() => !!o.state.error);
    expect(o.state.view).toBeUndefined();
    expect(o.state.fresh).toBe(false);
    expect(queryCount(o.f)).toBe(0);
    expect(
      await o.owner.invoke('handoff', { browserId: 'browser', generation: 'browser-generation' }),
    ).toBe(false);
    expect(o.f.submitted).toHaveLength(0);
  } finally {
    o.owner.stop();
  }
});

test('lost action acknowledgement survives panel reopen and only looks up the original command', async () => {
  const f = browserFixture();
  const first = observe(f);
  first.owner.start(true);
  let second: ReturnType<typeof observe> | undefined;
  try {
    await until(() => first.state.fresh);
    f.drop = true;
    await first.owner.invoke('handoff', { browserId: 'browser', generation: 'browser-generation' });
    expect(first.state.pending).toBe(true);
    first.owner.stop();
    second = observe(f);
    second.owner.start(true);
    await until(() => second!.state.fresh && second!.state.pending);
    expect(
      await second.owner.invoke('resume', { browserId: 'browser', generation: 'human-generation' }),
    ).toBe(false);
    expect(f.submitted).toHaveLength(1);
    f.drop = false;
    second.owner.checkOriginal();
    await until(() => !second!.state.pending);
    const original = f.submitted[0]!.commandId;
    expect(
      f.calls
        .filter((call) => call.method === 'extensions.lookup')
        .every((call) => 'commandId' in call && call.commandId === original),
    ).toBe(true);
    expect(f.submitted).toHaveLength(1);
  } finally {
    first.owner.stop();
    second?.owner.stop();
  }
});

test('an in-flight read from the old page cannot override a completed handoff', async () => {
  const o = observe();
  o.owner.start(true);
  let release!: () => void;
  try {
    await until(() => o.state.fresh);
    o.f.queryGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await until(() => queryCount(o.f) === 2);
    await o.owner.invoke('handoff', { browserId: 'browser', generation: 'browser-generation' });
    expect(o.state.fresh).toBe(false);
    o.f.queryGate = undefined;
    release();
    await until(() => o.state.fresh && o.state.view?.state === 'human');
    expect(o.state.view?.generation).toBe('human-generation');
    expect(o.f.maxInFlight).toBe(1);
  } finally {
    release?.();
    o.owner.stop();
  }
});

test('a stalled latest read expires input and quote eligibility without queuing another read', async () => {
  const o = observe();
  o.owner.start(true);
  let release!: () => void;
  try {
    await until(() => o.state.fresh);
    o.f.queryGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await until(() => queryCount(o.f) === 2);
    await until(() => !o.state.fresh);
    expect(queryCount(o.f)).toBe(2);
    expect(
      await o.owner.invoke('handoff', { browserId: 'browser', generation: 'browser-generation' }),
    ).toBe(false);
    expect(o.f.submitted).toHaveLength(0);
  } finally {
    release?.();
    o.owner.stop();
  }
});

test('repeated handoff and resume cannot revive an earlier human generation after hiding and reopening', async () => {
  const o = observe();
  o.owner.start(true);
  try {
    await until(() => o.state.fresh);
    const generations = new Set([o.state.view!.generation]);
    let retired = structuredClone(o.state.view!);
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const action of ['handoff', 'resume'] as const) {
        const input = { browserId: 'browser', generation: o.state.view!.generation };
        const submitted = o.owner.invoke(action, input);
        expect(await o.owner.invoke(action, input)).toBe(false);
        expect(await submitted).toBe(true);
        await until(
          () => o.state.fresh && o.state.view?.state === (action === 'handoff' ? 'human' : 'agent'),
        );
        expect(generations.has(o.state.view!.generation)).toBe(false);
        generations.add(o.state.view!.generation);
        if (cycle === 0 && action === 'handoff') retired = structuredClone(o.state.view!);
      }
    }
    const latest = structuredClone(o.state.view!);
    o.owner.setVisible(false);
    o.f.view = retired;
    o.owner.setVisible(true);
    await until(() => !!o.state.error);
    expect(o.state.fresh).toBe(false);
    expect(o.state.view).toEqual(latest);
    expect(
      await o.owner.invoke('resume', {
        browserId: retired.browserId,
        generation: retired.generation,
      }),
    ).toBe(false);
    o.f.view = latest;
    await until(() => o.state.fresh && !o.state.error);
    expect(o.f.submitted.map((request) => request.actionId)).toEqual([
      'browser.handoff',
      'browser.resume',
      'browser.handoff',
      'browser.resume',
      'browser.handoff',
      'browser.resume',
    ]);
    expect(new Set(o.f.submitted.map((request) => request.commandId)).size).toBe(6);
  } finally {
    o.owner.stop();
  }
});

test('a late successful action callback cannot publish into the next session or inherit its pending command', async () => {
  const f = browserFixture(),
    first = observe(f),
    response = f.deferNextResponse('extensions.invoke');
  let second: ReturnType<typeof observe> | undefined;
  let action: Promise<boolean> | undefined;
  first.owner.start(true);
  try {
    await until(() => first.state.fresh);
    action = first.owner.invoke('handoff', {
      browserId: 'browser',
      generation: first.state.view!.generation,
    });
    await until(() => response.held);
    expect(first.state.pending).toBe(true);
    first.owner.stop();
    const stopped = first.state;
    const scope = { ...browserScope, generation: 2, viewSelection: 2, sessionId: 'next-session' };
    f.scope = scope;
    f.view = {
      ...f.view,
      browserId: 'next-browser',
      generation: 'next-generation',
      state: 'agent',
      title: 'Next session',
    };
    second = observe(f, scope);
    second.owner.start(true);
    await until(() => second!.state.fresh);
    expect(second.state.pending).toBe(false);
    expect(
      await second.owner.invoke('handoff', {
        browserId: 'next-browser',
        generation: 'next-generation',
      }),
    ).toBe(true);
    await until(() => second!.state.fresh && second!.state.view?.state === 'human');
    const current = second.state;
    response.release();
    expect(await action).toBe(true);
    expect(first.state).toBe(stopped);
    expect(second.state).toBe(current);
    expect(second.state.view?.browserId).toBe('next-browser');
    expect(f.records.map((row) => row.intent.scope.sessionId)).toEqual(['session', 'next-session']);
    expect(f.calls.filter((call) => call.method === 'extensions.lookup')).toHaveLength(0);
    expect(f.submitted).toHaveLength(2);
  } finally {
    response.release();
    await action;
    first.owner.stop();
    second?.owner.stop();
  }
});

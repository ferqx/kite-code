import { setTimeout as fixtureDelay } from 'node:timers/promises';
import type { Change, SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import { expect, test } from '#kite-test';
import {
  activity,
  TuiController,
  type TuiDomainUpdate,
  type TuiPort,
  type TuiReadDomain,
  TuiSession,
  type TuiSnapshot,
  tuiChangeDomains,
} from '../../src/tui';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await fixtureDelay(5);
  expect(check()).toBe(true);
}
function snapshot(id = 'a', cursor = '1', active = true): TuiSnapshot {
  return {
    storeId: 'store',
    connectionInstanceId: 'owner',
    activityOwner: { instanceId: 'owner', generation: '1' },
    view: {
      storeId: 'store',
      snapshotCursor: cursor,
      session: {
        id,
        workspaceId: 'w',
        rootSessionId: id,
        parentSessionId: null,
        title: id,
        nextSeq: '1',
        controlRevision: '1',
        contextSelectionId: 'context',
        deletedAt: null,
      },
      runs: [
        {
          id: `run-${id}`,
          sessionId: id,
          originStoreId: 'store',
          originCommandId: 'original',
          isActive: active,
          status: active ? 'waiting_execution' : 'completed',
          createdAt: 1,
          finishedAt: active ? null : 2,
          reason: null,
        },
      ],
      executions: [],
      messages: [],
    } as SessionView,
    messages: [
      {
        id: 'message',
        sessionId: id,
        seq: '1',
        runId: null,
        role: 'assistant',
        status: 'complete',
        content: 'saved body',
      },
    ],
    interactions: [],
    environment: { workspacePath: 'workspace' },
  };
}
function change(type: string, cursor: string, sessionId: string | null = 'a'): Change {
  return { type, cursor, sessionId, objectId: 'original', revision: cursor, payload: {} };
}
function fixture() {
  let fullReads = 0,
    reconciliations = 0,
    writes = 0;
  const calls: TuiReadDomain[] = [];
  let current = snapshot();
  const read: NonNullable<TuiPort['readSessionDomain']> = async (
    domain,
    source,
    cursor,
  ): Promise<TuiDomainUpdate> => {
    calls.push(domain);
    switch (domain) {
      case 'execution':
        return {
          domain,
          facts: {
            view: current.view,
            activityOwner: current.activityOwner,
            connectionInstanceId: current.connectionInstanceId,
          },
        };
      case 'history':
        return {
          domain,
          messages: current.messages,
          cursor: cursor ?? current.view.snapshotCursor,
        };
      case 'admission':
        return {
          domain,
          source: source.view,
          facts: { interactions: [], activeCommand: undefined, pendingInputs: [] },
        };
      case 'models':
        return { domain, environment: {} };
      case 'metadata':
        return { domain, sessionId: source.view.session.id, title: 'new title' };
      case 'display':
        return { domain, facts: {}, environment: {} };
      case 'progress':
      case 'jobs':
      case 'labels':
      case 'live':
        return { domain, facts: {} };
    }
  };
  const forbidden = async () => {
    writes++;
    throw Error('unexpected_write');
  };
  const port: TuiPort = {
    storeId: 'store',
    messageChanges: true,
    nextCommandId: () => {
      throw Error('unexpected_identity');
    },
    listSessions: async () => [],
    reconcileSession: async () => {
      reconciliations++;
    },
    readSession: async (id) => {
      fullReads++;
      return snapshot(id);
    },
    readSessionDomain: read,
    submit: forbidden,
    answer: forbidden,
    cancel: forbidden,
    getCommand: forbidden,
  };
  return {
    controller: new TuiController(port),
    port,
    read,
    calls,
    set current(value: TuiSnapshot) {
      current = value;
    },
    get counts() {
      return { fullReads, reconciliations, writes };
    },
  };
}

test('terminal execution publishes before held admission/history; draft and write fences remain', async () => {
  const f = fixture(),
    admission = deferred<void>(),
    history = deferred<void>();
  let admissionStarted = false;
  f.port.readSessionDomain = async (domain, source, cursor, signal) => {
    if (domain === 'admission' && !admissionStarted) {
      admissionStarted = true;
      await admission.promise;
    }
    if (domain === 'history') await history.promise;
    return f.read(domain, source, cursor, signal);
  };
  let app: ReturnType<typeof render> | undefined;
  try {
    await f.controller.select('a');
    f.controller.setDraft('unfinished 中文 draft');
    app = render(<TuiSession controller={f.controller} />);
    await fixtureDelay(60);
    expect(app.lastFrame()).toContain('Waiting · background results');
    const reading = f.controller.refresh(['admission']);
    await until(() => admissionStarted);
    f.current = snapshot('a', '2', false);
    expect(f.controller.changed(change('run.finished', '2'))).toBeUndefined();
    expect(f.controller.state.snapshotStale).toBe(true);
    await until(() => f.controller.state.domains?.execution?.cursor === '2');
    expect(activity(f.controller.state.snapshot)).toBe('Idle');
    expect(f.controller.state.snapshotStale).toBe(true);
    expect(f.controller.state.draft).toBe('unfinished 中文 draft');
    await f.controller.send();
    expect(f.counts.writes).toBe(0);
    await fixtureDelay(60);
    expect(app.lastFrame()).not.toContain('Waiting · background results');
    admission.resolve();
    await reading;
    await until(() => !f.controller.state.snapshotStale);
    expect(f.controller.state.domains?.history?.phase).toBe('refreshing');
    expect(f.controller.state.snapshot?.view.runs[0]?.status).toBe('completed');
    expect(f.counts).toEqual({ fullReads: 1, reconciliations: 1, writes: 0 });
  } finally {
    admission.resolve();
    history.resolve();
    app?.unmount();
    f.controller.dispose();
  }
});

test('message changes keep admission fresh, replace same-seq body, and do not read View/settings/foreign scope', async () => {
  const f = fixture();
  try {
    await f.controller.select('a');
    const next = snapshot('a', '2');
    f.current = { ...next, messages: [{ ...next.messages[0]!, content: 'same-seq new body' }] };
    f.controller.changed(change('message.updated', '2'));
    expect(f.controller.state.snapshotStale).toBe(false);
    await until(() => f.controller.state.domains?.history?.cursor === '2');
    f.controller.changed(change('execution.finished', '999999', 'foreign'));
    f.controller.changed(change('session.renamed', '999999'));
    await fixtureDelay(10);
    expect(f.controller.state.snapshot?.messages.map((item) => item.content)).toEqual([
      'same-seq new body',
    ]);
    expect(f.calls).not.toContain('execution');
    expect(f.calls).not.toContain('models');
    expect(f.calls).not.toContain('admission');
    expect(f.controller.state.snapshotStale).toBe(false);
  } finally {
    f.controller.dispose();
  }
});

test('one in-flight execution read covers registered burst targets without foreign cursor pressure', async () => {
  const f = fixture(),
    first = deferred<TuiDomainUpdate>();
  let reads = 0;
  f.port.readSessionDomain = async (domain, source, cursor, signal) => {
    if (domain === 'execution') {
      reads++;
      return first.promise;
    }
    return f.read(domain, source, cursor, signal);
  };
  try {
    await f.controller.select('a');
    f.controller.changed(change('execution.running', '2'));
    await until(() => reads === 1);
    for (let cursor = 3; cursor <= 5; cursor++)
      f.controller.changed(change('execution.running', String(cursor)));
    f.controller.changed(change('run.finished', '999999', 'foreign'));
    first.resolve({ domain: 'execution', facts: { view: snapshot('a', '5').view } });
    await until(() => f.controller.state.domains?.execution?.phase === 'fresh');
    expect(reads).toBe(1);
    expect(f.controller.state.domains?.execution?.cursor).toBe('5');
    expect(f.calls).not.toContain('admission');
  } finally {
    f.controller.dispose();
  }
});

test('an uncovered dirty target schedules exactly one successor instead of publishing stale execution', async () => {
  const f = fixture(),
    first = deferred<TuiDomainUpdate>();
  let reads = 0;
  f.port.readSessionDomain = async (domain, source, cursor, signal) => {
    if (domain === 'execution' && ++reads === 1) return first.promise;
    return f.read(domain, source, cursor, signal);
  };
  try {
    await f.controller.select('a');
    f.controller.changed(change('execution.running', '2'));
    await until(() => reads === 1);
    f.current = snapshot('a', '5', false);
    f.controller.changed(change('run.finished', '5'));
    first.resolve({ domain: 'execution', facts: { view: snapshot('a', '2').view } });
    await until(() => f.controller.state.domains?.execution?.cursor === '5');
    expect(reads).toBe(2);
    expect(activity(f.controller.state.snapshot)).toBe('Idle');
  } finally {
    f.controller.dispose();
  }
});

test('history failure preserves last complete facts and does not fence fresh admission or resurrect activity', async () => {
  const f = fixture();
  f.current = snapshot('a', '2', false);
  f.port.readSessionDomain = async (domain, source, cursor, signal) => {
    if (domain === 'history') throw Error('page_failed');
    return f.read(domain, source, cursor, signal);
  };
  try {
    await f.controller.select('a');
    await f.controller.refresh(['execution'], '2');
    await until(() => !f.controller.state.snapshotStale);
    await f.controller.refresh(['history'], '2');
    expect(f.controller.state.domains?.history?.phase).toBe('unavailable');
    expect(f.controller.state.snapshot?.messages[0]?.content).toBe('saved body');
    expect(f.controller.state.snapshotStale).toBe(false);
    expect(activity(f.controller.state.snapshot)).toBe('Idle');
  } finally {
    f.controller.dispose();
  }
});

test('streamed message watermarks do not starve a held admission read with unchanged write targets', async () => {
  const f = fixture(),
    held = deferred<void>();
  let admissions = 0;
  f.port.readSessionDomain = async (domain, source, cursor, signal) => {
    if (domain === 'admission') {
      admissions++;
      await held.promise;
    }
    return f.read(domain, source, cursor, signal);
  };
  try {
    await f.controller.select('a');
    const reading = f.controller.refresh(['admission']);
    await until(() => admissions === 1);
    for (let cursor = 2; cursor < 30; cursor++)
      f.controller.changed(change('message.updated', String(cursor)));
    await until(() => f.controller.state.domains?.history?.cursor === '29');
    held.resolve();
    await reading;
    expect(admissions).toBe(1);
    expect(f.controller.state.snapshotStale).toBe(false);
    expect(f.controller.state.snapshot?.view.snapshotCursor).toBe('1');
  } finally {
    held.resolve();
    f.controller.dispose();
  }
});

test('disconnect retires late readers; healthy HTTP does not restore stream authority', async () => {
  const f = fixture(),
    late = deferred<TuiDomainUpdate>();
  let signal: AbortSignal | undefined;
  f.port.readSessionDomain = async (domain, source, cursor, readSignal) => {
    if (domain === 'execution') {
      signal = readSignal;
      return late.promise;
    }
    return f.read(domain, source, cursor, readSignal);
  };
  try {
    await f.controller.select('a');
    const reading = f.controller.refresh(['execution']);
    await until(() => !!signal);
    f.controller.observationUnavailable('network');
    expect(signal?.aborted).toBe(true);
    late.resolve({ domain: 'execution', facts: { view: snapshot('a', '2', false).view } });
    await reading;
    expect(f.controller.state.snapshot?.view.snapshotCursor).toBe('1');
    f.port.readSessionDomain = f.read;
    f.current = snapshot('a', '3', false);
    await f.controller.refresh();
    expect(activity(f.controller.state.snapshot)).toBe('Idle');
    expect(f.controller.state.stale).toBe(true);
    expect(f.controller.state.observationState).toBe('unknown');
    expect(f.counts.writes).toBe(0);
  } finally {
    f.controller.dispose();
  }
});

test('navigation rejects a late original execution even when the reader ignores Abort', async () => {
  const f = fixture(),
    late = deferred<TuiDomainUpdate>();
  let started = false;
  f.port.readSessionDomain = async () => {
    started = true;
    return late.promise;
  };
  try {
    await f.controller.select('a');
    const reading = f.controller.refresh(['execution']);
    await until(() => started);
    await f.controller.select('b');
    late.resolve({ domain: 'execution', facts: { view: snapshot('a', '20', false).view } });
    await reading;
    expect(f.controller.state.sessionId).toBe('b');
    expect(f.controller.state.snapshot?.view.session.id).toBe('b');
  } finally {
    f.controller.dispose();
  }
});

test('events received during first selection retain their fences when the initial older snapshot publishes', async () => {
  const f = fixture(),
    initial = deferred<TuiSnapshot>(),
    execution = deferred<TuiDomainUpdate>();
  f.port.reconcileSession = undefined;
  f.port.readSession = async () => initial.promise;
  let executionStarted = false;
  f.port.readSessionDomain = async (domain, source, cursor, signal) => {
    if (domain === 'execution') {
      executionStarted = true;
      return execution.promise;
    }
    return f.read(domain, source, cursor, signal);
  };
  const unsafe: string[] = [];
  f.controller.subscribe(() => {
    if (
      f.controller.state.snapshot?.view.snapshotCursor === '1' &&
      !f.controller.state.snapshotStale
    )
      unsafe.push('old target opened');
  });
  try {
    const selecting = f.controller.select('a');
    f.controller.changed(change('run.finished', '2'));
    initial.resolve(snapshot());
    await selecting;
    await until(() => executionStarted);
    expect(f.controller.state.snapshotStale).toBe(true);
    expect(unsafe).toEqual([]);
    f.current = snapshot('a', '2', false);
    execution.resolve({ domain: 'execution', facts: { view: snapshot('a', '2', false).view } });
    await until(() => !f.controller.state.snapshotStale);
    expect(activity(f.controller.state.snapshot)).toBe('Idle');
  } finally {
    f.controller.dispose();
  }
});

test('failed activation remains read-only through automatic observations until an explicit successful activation', async () => {
  const f = fixture();
  f.port.reconcileSession = async () => {
    throw Error('owner_unknown');
  };
  try {
    await f.controller.select('a');
    f.controller.setDraft('retained');
    await f.controller.refresh();
    expect(f.controller.state.snapshotStale).toBe(true);
    expect(f.controller.state.error).toContain('owner_unknown');
    await f.controller.send();
    expect(f.counts.writes).toBe(0);
    f.port.reconcileSession = async () => {};
    await f.controller.select('a');
    expect(f.controller.state.snapshotStale).toBe(false);
  } finally {
    f.controller.dispose();
  }
});

test('event mapping uses exact root/workspace controls and keeps fallback execution off full-history scans', () => {
  const base = snapshot();
  expect(tuiChangeDomains(change('execution.finished', '2'), base, false)).not.toContain('history');
  expect(tuiChangeDomains(change('execution.finished', '2'), base, true)).toContain('history');
  expect(tuiChangeDomains(change('future.event', '2'), base, true)).toContain('admission');
  expect(
    tuiChangeDomains(
      {
        ...change('host_control.changed', '2', null),
        payload: {
          kind: 'workspace.trust',
          scope: 'workspace:w',
          receipt: { status: 'applied' },
        },
      },
      base,
      true,
    ),
  ).toEqual(['admission']);
  expect(tuiChangeDomains(change('execution.finished', '2', 'foreign'), base, true)).toEqual([]);
});

import { expect, test } from 'bun:test';
import type { SelectedContextPage, SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import {
  TuiController,
  type TuiManagementIntent,
  type TuiManagementOutcome,
  type TuiPort,
  TuiSession,
} from '../../src/tui';

function fixture() {
  let serial = 0;
  const writes: TuiManagementIntent[] = [];
  const queries: { intent: TuiManagementIntent; signal?: AbortSignal }[] = [];
  const reads: string[] = [];
  const effects = { models: 0, cancels: 0, creates: 0 };
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => `original-${++serial}`,
    listSessions: async () => [
      { id: 'a', title: 'a' },
      { id: 'b', title: 'b' },
    ],
    readSession: async (id) => {
      reads.push(id);
      return {
        storeId: 'store',
        view: {
          storeId: 'store',
          snapshotCursor: '1',
          session: {
            id,
            title: id,
            workspaceId: 'w',
            parentSessionId: null,
            rootSessionId: id,
            contextSelectionId: `selection-${id}`,
            controlRevision: '7',
            nextSeq: '1',
            deletedAt: null,
          },
          runs: [],
          executions: [],
          messages: [],
        } as unknown as SessionView,
        messages: [],
        interactions: [],
      };
    },
    submit: async () => {
      effects.models++;
      throw Error('unexpected_model');
    },
    answer: async () => {
      throw Error('unexpected_answer');
    },
    cancel: async () => {
      effects.cancels++;
      throw Error('unexpected_cancel');
    },
    getCommand: async () => {
      throw Error('unexpected_work_lookup');
    },
    management: {
      readContext: async (id) =>
        ({
          selection: {
            id: `selection-${id}`,
            sessionId: id,
            previousSelectionId: null,
            boundaryMessageId: null,
            boundarySeq: '0',
            tailFromSeq: '1',
            ranges: [],
          },
          highWaterSeq: '1',
          messages: [],
          resultSources: [],
          nextAfterSeq: null,
          nextAfterSourceId: null,
          snapshotCursor: '1',
        }) as SelectedContextPage,
      manage: async (intent) => {
        writes.push(structuredClone(intent));
        return { intent, status: 'outcome_unknown' };
      },
      lookup: async (intent, ...args: unknown[]) => {
        queries.push({
          intent: structuredClone(intent),
          signal: args[0] as AbortSignal | undefined,
        });
        return { intent, status: 'applied' };
      },
      newSession: async () => {
        effects.creates++;
        return 'new';
      },
      quit() {},
    },
  };
  return { port, controller: new TuiController(port), writes, queries, reads, effects };
}
const settle = () => Bun.sleep(50);
async function key(ui: ReturnType<typeof render>, value: string) {
  ui.stdin.write(value);
  await settle();
}
async function command(ui: ReturnType<typeof render>, value: string) {
  await key(ui, value);
  await key(ui, '\r');
}
const rename = (sessionId: string, commandId: string): TuiManagementIntent => ({
  kind: 'session.rename',
  sessionId,
  request: { expectedStoreId: 'store', commandId, ifRevision: '7', title: `full-${sessionId}-🙂` },
});

test('actual management request keys query both original Sessions without new writes, selection or work', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.manage({
    kind: 'session.fork',
    sessionId: 'a',
    request: {
      expectedStoreId: 'store',
      commandId: 'fork-a',
      expectedContextSelectionId: 'selection-a',
      newSessionId: 'fork-result',
      title: 'Full original fork 🙂',
    },
  });
  await f.controller.select('b');
  await f.controller.manage(rename('b', 'rename-b'));
  f.controller.setDraft('later draft');
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await settle();
    f.controller.setDraft('');
    await settle();
    await command(ui, '/context requests');
    expect(ui.lastFrame()).toContain('fork-a');
    expect(ui.lastFrame()).toContain('rename-b');
    expect(f.queries).toHaveLength(0);
    await key(ui, '\u001b[A'.repeat(3));
    await key(ui, 'k');
    expect(f.queries.map((q) => q.intent)).toEqual([f.writes[0]!]);
    expect(f.controller.state.sessionId).toBe('b');
    await key(ui, '\u001b[B');
    await key(ui, '\r');
    expect(f.queries.map((q) => q.intent)).toEqual(f.writes);
    expect(f.writes).toHaveLength(2);
    expect(f.controller.state.sessionId).toBe('b');
    expect(f.effects).toEqual({ models: 0, cancels: 0, creates: 0 });
    expect(f.reads).toEqual(['a', 'b']);
    await key(ui, '\u001b');
    await f.controller.select('a');
    await command(ui, '/context requests');
    expect(ui.lastFrame()).toContain('fork-a');
    expect(ui.lastFrame()).toContain('rename-b');
    expect(f.queries).toHaveLength(2);
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
}, 10000);

test('Context K owns only its query and Ctrl+C, Esc and Session switch retire late query displays', async () => {
  const f = fixture();
  const held: {
    intent: TuiManagementIntent;
    signal?: AbortSignal;
    finish: (value: TuiManagementOutcome) => void;
  }[] = [];
  f.port.management!.lookup = (intent, ...args: unknown[]) =>
    new Promise((finish) => {
      held.push({
        intent: structuredClone(intent),
        signal: args[0] as AbortSignal | undefined,
        finish,
      });
      f.queries.push({
        intent: structuredClone(intent),
        signal: args[0] as AbortSignal | undefined,
      });
    });
  await f.controller.select('a');
  await f.controller.manage(rename('a', 'held-original'));
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await settle();
    await command(ui, '/context');
    await key(ui, '\u000b');
    expect(ui.lastFrame()).toContain('Current selected Context projection');
    expect(held).toHaveLength(0);
    await key(ui, 'k');
    expect(ui.lastFrame()).toContain('held-original');
    await key(ui, 'k');
    expect(held).toHaveLength(1);
    expect(held[0]!.signal?.aborted).toBe(false);
    await key(ui, '\u0003');
    expect(held[0]!.signal?.aborted).toBe(true);
    expect(ui.lastFrame()).toContain('held-original');
    await key(ui, 'k');
    expect(held).toHaveLength(2);
    await key(ui, '\u001b');
    expect(held[1]!.signal?.aborted).toBe(true);
    await command(ui, '/context requests');
    await key(ui, 'k');
    // A background original GET may start during the brief return to the main
    // conversation. Opening this panel retires it; only its own read stays live.
    expect(held.filter((query) => !query.signal?.aborted)).toHaveLength(1);
    expect(held.every((query) => query.intent.request.commandId === 'held-original')).toBe(true);
    await f.controller.select('b');
    expect(held.every((query) => query.signal?.aborted)).toBe(true);
    f.controller.setDraft('new b draft');
    f.controller.observationUnavailable('new_b_observation_error');
    const before = f.controller.state;
    for (const query of held) query.finish({ intent: query.intent, status: 'applied' });
    await settle();
    expect(f.controller.state.sessionId).toBe('b');
    expect(f.controller.state.draft).toBe('new b draft');
    expect(f.controller.state.snapshot).toBe(before.snapshot);
    expect(f.controller.state.error).toBe(before.error);
    expect(f.controller.state.panel).toBe(before.panel);
    expect(f.writes).toHaveLength(1);
    expect(f.effects).toEqual({ models: 0, cancels: 0, creates: 0 });
  } finally {
    for (const query of held) query.finish({ intent: query.intent, status: 'outcome_unknown' });
    await settle();
    ui.unmount();
    f.controller.dispose();
  }
}, 10000);

test('actual original GET terminal survives a held same-ID POST unknown receipt', async () => {
  const f = fixture();
  let finish: ((value: TuiManagementOutcome) => void) | undefined;
  let writing: Promise<void> | undefined;
  f.port.management!.manage = (intent) => {
    f.writes.push(structuredClone(intent));
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  await f.controller.select('a');
  writing = f.controller.manage(rename('a', 'race-original'));
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await settle();
    await command(ui, '/context requests');
    expect(ui.lastFrame()).toContain('race-original');
    await key(ui, 'k');
    expect(f.queries.map((q) => q.intent)).toEqual(f.writes);
    expect(ui.lastFrame()).toContain('applied');
    finish!({ intent: f.writes[0]!, status: 'outcome_unknown' });
    await writing;
    await settle();
    expect(ui.lastFrame()).toContain('applied');
    await key(ui, '\u001b');
    await command(ui, '/context requests');
    expect(ui.lastFrame()).toContain('race-original');
    expect(ui.lastFrame()).toContain('applied');
    expect(f.writes).toHaveLength(1);
    expect(f.queries).toHaveLength(1);
    expect(f.controller.state.sessionId).toBe('a');
    expect(f.reads).toEqual(['a']);
    f.port.management!.lookup = async (intent, ...args: unknown[]) => {
      f.queries.push({ intent: structuredClone(intent), signal: args[0] as AbortSignal });
      return { intent, status: 'outcome_unknown' };
    };
    await key(ui, 'k');
    expect(ui.lastFrame()).toContain('applied');
    expect(ui.lastFrame()).toContain('Original result unverified; saved facts retained');
    expect(f.queries.map((query) => query.intent)).toEqual([f.writes[0]!, f.writes[0]!]);
    expect(f.writes).toHaveLength(1);
    expect(f.reads).toEqual(['a']);
    expect(f.effects).toEqual({ models: 0, cancels: 0, creates: 0 });
  } finally {
    if (f.writes[0]) finish?.({ intent: f.writes[0], status: 'outcome_unknown' });
    await Promise.allSettled([writing]);
    ui.unmount();
    f.controller.dispose();
  }
}, 10000);

test('automatic original management receipt recovery refreshes only history without lifecycle reconciliation or writes', async () => {
  const f = fixture();
  let reconciliations = 0;
  f.port.reconcileSession = async () => {
    reconciliations++;
  };
  await f.controller.select('a');
  await f.controller.manage(rename('a', 'automatic-original'));
  const before = reconciliations;
  try {
    const deadline = Date.now() + 2000;
    while (f.controller.state.management?.status !== 'applied') {
      if (Date.now() > deadline) throw Error('automatic_management_deadline');
      await Bun.sleep(10);
    }
    await Bun.sleep(30);
    expect(reconciliations).toBe(before);
    expect(f.queries.map((query) => query.intent.request.commandId)).toEqual([
      'automatic-original',
    ]);
    expect(f.writes).toHaveLength(1);
    expect(f.effects).toEqual({ models: 0, cancels: 0, creates: 0 });
    expect(f.reads).toEqual(['a', 'a']);
  } finally {
    f.controller.dispose();
  }
});

test('automatic management GET is aborted on scope change and an ignored abort cannot publish or reconcile', async () => {
  const f = fixture();
  let finish!: (value: TuiManagementOutcome) => void;
  let signal: AbortSignal | undefined;
  f.port.management!.lookup = (intent, readSignal) => {
    signal = readSignal;
    f.queries.push({ intent, signal });
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  await f.controller.select('a');
  await f.controller.manage(rename('a', 'automatic-held'));
  try {
    const deadline = Date.now() + 2000;
    while (!finish) {
      if (Date.now() > deadline) throw Error('automatic_management_deadline');
      await Bun.sleep(10);
    }
    await f.controller.select('b');
    expect(signal?.aborted).toBe(true);
    const before = f.controller.state;
    finish({ intent: f.writes[0]!, status: 'applied' });
    await Bun.sleep(30);
    expect(f.controller.state.management).toBe(before.management);
    expect(f.controller.state.sessionId).toBe('b');
    expect(f.reads).toEqual(['a', 'b']);
    expect(f.effects).toEqual({ models: 0, cancels: 0, creates: 0 });
  } finally {
    finish?.({ intent: f.writes[0]!, status: 'outcome_unknown' });
    f.controller.dispose();
  }
});

import { expect, test } from 'bun:test';
import type { Command, SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import {
  TuiController,
  type TuiPort,
  type TuiRecoveryIntent,
  type TuiRecoveryOutcome,
  TuiSession,
  type TuiSnapshot,
} from '../../src/tui';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

const snapshot = (id: string): TuiSnapshot => ({
  storeId: 'store',
  view: {
    storeId: 'store',
    snapshotCursor: '1',
    session: {
      id,
      rootSessionId: id,
      parentSessionId: null,
      workspaceId: 'w',
      title: id,
      controlRevision: '0',
      contextSelectionId: 'context',
      nextSeq: '1',
      deletedAt: null,
    },
    runs:
      id === 'b'
        ? [
            {
              id: 'new-active-run',
              sessionId: id,
              originStoreId: 'store',
              originCommandId: 'new-work',
              status: 'running',
              isActive: true,
              createdAt: 1,
              finishedAt: null,
              reason: null,
              waitingForResults: [],
              configuration: {},
            },
          ]
        : [],
    executions: [],
    messages: [],
  } as SessionView,
  messages: [],
  interactions: [],
});
function fixture() {
  let next = 0,
    cancels = 0,
    writes = 0,
    reads = 0;
  let original: TuiRecoveryIntent | undefined;
  let resolve!: (value: TuiRecoveryOutcome) => void;
  const pending = new Promise<TuiRecoveryOutcome>((r) => (resolve = r));
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => `recovery-${++next}`,
    listSessions: async () => [],
    readSession: async (id) => snapshot(id),
    submit: async () => {
      throw Error('unexpected new Run');
    },
    answer: async () => {
      throw Error('unexpected answer');
    },
    cancel: async () => {
      cancels++;
      throw Error('unexpected cancellation');
    },
    getCommand: async () => {
      throw Error('unexpected ordinary GET');
    },
    recovery: {
      submit: async (intent) => {
        writes++;
        original = structuredClone(intent);
        return pending;
      },
      lookup: async (intent) => {
        reads++;
        expect(intent).toEqual(original!);
        return { intent, status: 'outcome_unknown' };
      },
    },
  };
  return {
    port,
    controller: new TuiController(port),
    resolve,
    stats: () => ({ writes, reads, cancels }),
    original: () => original!,
  };
}
test('TUI original recovery survives view switch and independent read cancellation without remapping a new Run', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openRecovery();
  const submitted = f.controller.submitRecovery('run', 'original-run');
  expect(f.controller.state.recovery?.status).toBe('submitting');
  await f.controller.submitRecovery('run', 'another-run');
  expect(f.stats().writes).toBe(1);
  await f.controller.cancel();
  expect(f.stats().cancels).toBe(0);
  await f.controller.select('b');
  await f.controller.cancel();
  expect(f.stats().cancels).toBe(0);
  f.resolve({ intent: f.original(), status: 'outcome_unknown' });
  await submitted;
  await f.controller.lookup();
  expect(f.stats()).toEqual({ writes: 1, reads: 1, cancels: 0 });
  expect(f.controller.state.recovery?.intent.sessionId).toBe('a');
  await f.controller.select('a');
  f.controller.closePanel();
  await f.controller.cancel();
  expect(f.stats().cancels).toBe(0);
  f.controller.dispose();
});
for (const wrong of [
  'kind',
  'store',
  'session',
  'command',
  'receiptRun',
  'originalCommand',
  'runScope',
] as const)
  test(`TUI rejects ${wrong} recovery identity and retains the frozen unknown`, async () => {
    const f = fixture();
    await f.controller.select('a');
    await f.controller.openRecovery();
    const submitted = f.controller.submitRecovery('run', 'original-run');
    const intent = f.original();
    const command: Command = {
      kind: 'run.resume',
      id: intent.request.commandId,
      originStoreId: 'store',
      sessionId: 'a',
      status: 'applied',
      cancelRequestedAt: null,
      receipt: {
        outcome: 'run_resumed',
        runId: 'original-run',
        originalCommandId: 'work',
        boundary: 'tool_calls',
      },
    };
    const run = {
      id: 'original-run',
      originStoreId: 'store',
      sessionId: 'a',
      originCommandId: 'work',
      status: 'completed',
    };
    if (wrong === 'kind') command.kind = 'job.report.resume';
    if (wrong === 'store') command.originStoreId = 'other';
    if (wrong === 'session') command.sessionId = 'b';
    if (wrong === 'command') command.id = 'another-command';
    if (wrong === 'receiptRun') (command.receipt as Record<string, unknown>).runId = 'another-run';
    if (wrong === 'originalCommand') run.originCommandId = 'foreign';
    if (wrong === 'runScope') run.sessionId = 'b';
    f.resolve({ intent, status: 'resumed', command, run: run as TuiRecoveryOutcome['run'] });
    await submitted;
    expect(f.controller.state.recovery?.status).toBe('outcome_unknown');
    expect(f.controller.state.recovery?.intent).toEqual(intent);
    await f.controller.lookup();
    expect(f.stats()).toEqual({ writes: 1, reads: 1, cancels: 0 });
    f.controller.dispose();
  });
test('TUI interrupt requires explicit orphan-group confirmation and never infers a report ID', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openRecovery();
  await f.controller.submitRecovery('interrupt', 'current');
  await f.controller.submitRecovery('report', '');
  expect(f.stats().writes).toBe(0);
  const promise = f.controller.submitRecovery('interrupt', 'confirm');
  expect(f.original().request).toMatchObject({ kind: 'session.recover', decision: 'interrupt' });
  f.resolve({ intent: f.original(), status: 'outcome_unknown' });
  await promise;
  f.controller.dispose();
});

test('closing recovery automatically queries only the original receipt after a lost GET without another submission', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openRecovery();
  const submitted = f.controller.submitRecovery('run', 'original-run');
  f.resolve({ intent: f.original(), status: 'outcome_unknown' });
  await submitted;
  const original = structuredClone(f.original());
  const reads: TuiRecoveryIntent[] = [];
  f.port.recovery!.lookup = async (intent) => {
    reads.push(structuredClone(intent));
    if (reads.length === 1) throw Error('lost original GET');
    return {
      intent,
      status: 'resumed',
      command: {
        kind: 'run.resume',
        id: original.request.commandId,
        originStoreId: 'store',
        sessionId: 'a',
        status: 'applied',
        cancelRequestedAt: null,
        receipt: {
          outcome: 'run_resumed',
          runId: 'original-run',
          originalCommandId: 'work',
          boundary: 'tool_calls',
        },
      },
      run: {
        id: 'original-run',
        originStoreId: 'store',
        sessionId: 'a',
        originCommandId: 'work',
        status: 'completed',
      } as TuiRecoveryOutcome['run'],
    };
  };
  try {
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reads).toEqual([]);
    await f.controller.select('b');
    f.controller.closePanel();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reads).toEqual([]);
    await f.controller.select('a');
    const firstDeadline = Date.now() + 1500;
    while (!reads.length && Date.now() < firstDeadline) await tick();
    expect(reads).toEqual([original]);
    expect(f.controller.state.recovery?.status).toBe('outcome_unknown');
    const finalDeadline = Date.now() + 1500;
    while (f.controller.state.recovery?.status !== 'resumed' && Date.now() < finalDeadline)
      await tick();
    expect(reads).toEqual([original, original]);
    expect(f.controller.state.recovery?.status).toBe('resumed');
    expect(f.controller.state.recovery?.intent).toEqual(original);
    expect(f.stats()).toEqual({ writes: 1, reads: 0, cancels: 0 });
  } finally {
    f.controller.dispose();
  }
});

test('recovery native Ctrl+C aborts only the original read while the adjacent Ctrl+L is ignored', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openRecovery();
  const submitted = f.controller.submitRecovery('interrupt', 'confirm');
  f.resolve({ intent: f.original(), status: 'outcome_unknown' });
  await submitted;
  const original = structuredClone(f.original());
  const reads: { intent: TuiRecoveryIntent; signal: AbortSignal }[] = [];
  let finishFirst!: (outcome: TuiRecoveryOutcome) => void;
  f.port.recovery!.lookup = async (intent, signal) => {
    reads.push({ intent: structuredClone(intent), signal });
    return reads.length === 1
      ? await new Promise<TuiRecoveryOutcome>((resolve) => (finishFirst = resolve))
      : { intent, status: 'outcome_unknown' };
  };
  const app = render(<TuiSession controller={f.controller} />);
  let first: Promise<void> | undefined;
  try {
    await tick();
    first = f.controller.lookup();
    await tick();
    app.stdin.write('\u0003\u000c');
    await tick();
    expect(reads).toHaveLength(1);
    expect(reads[0]!.signal.aborted).toBe(true);
    expect(reads.map((read) => read.intent)).toEqual([original]);
    expect({ writes: f.stats().writes, cancels: f.stats().cancels }).toEqual({
      writes: 1,
      cancels: 0,
    });
    expect(f.controller.state.recovery?.intent).toEqual(original);
    expect(app.lastFrame()).not.toContain('\\u0003\\u000c');
    finishFirst({ intent: original, status: 'failed', error: 'late original GET' });
    await first;
    expect(f.controller.state.recovery?.status).toBe('outcome_unknown');
    expect(f.controller.state.recovery?.error).not.toBe('late original GET');
  } finally {
    if (reads.length) {
      finishFirst({ intent: original, status: 'outcome_unknown' });
      await first;
    }
    app.unmount();
    app.cleanup();
    f.controller.dispose();
  }
});

test('recovery bracketed paste keeps a Ctrl+L byte as text without querying the original intent', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openRecovery();
  const submitted = f.controller.submitRecovery('interrupt', 'confirm');
  f.resolve({ intent: f.original(), status: 'outcome_unknown' });
  await submitted;
  const app = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    app.stdin.write('\u001b[200~\u000c\u001b[201~');
    await tick();
    expect(f.stats()).toEqual({ writes: 1, reads: 0, cancels: 0 });
    expect(f.controller.state.recovery?.intent).toEqual(f.original());
  } finally {
    app.unmount();
    app.cleanup();
    f.controller.dispose();
  }
});

test('recovery bracketed paste cannot submit a typed interrupt confirmation with a pasted Enter', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openRecovery();
  const app = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    app.stdin.write('interrupt confirm');
    await tick();
    app.stdin.write('\u001b[200~\r\u001b[201~');
    await tick();
    expect(f.stats()).toEqual({ writes: 0, reads: 0, cancels: 0 });
    expect(f.controller.state.recovery).toBeUndefined();
  } finally {
    app.unmount();
    app.cleanup();
    f.controller.dispose();
  }
});

test('cold restore retains old Store/Session unknown and blocks new submission until original lookup', async () => {
  const f = fixture(),
    saved: TuiRecoveryIntent = {
      kind: 'report',
      sessionId: 'original-session',
      reportCommandId: 'original-report',
      request: { expectedStoreId: 'old-store', commandId: 'original-recovery' },
    };
  let resolveRestore!: (value: readonly TuiRecoveryOutcome[]) => void;
  f.port.recovery!.restore = () => new Promise((resolve) => (resolveRestore = resolve));
  let lookup = 0;
  f.port.recovery!.lookup = async (intent) => {
    lookup++;
    expect(intent).toEqual(saved);
    return { intent, status: 'outcome_unknown' };
  };
  await f.controller.select('a');
  const opening = f.controller.openRecovery();
  await f.controller.submitRecovery('interrupt', 'confirm');
  expect(f.stats().writes).toBe(0);
  resolveRestore([{ intent: saved, status: 'outcome_unknown' }]);
  await opening;
  expect(f.controller.state.recovery?.intent).toEqual(saved);
  await f.controller.cancel();
  expect(f.stats().cancels).toBe(0);
  await f.controller.lookup();
  expect(lookup).toBe(1);
  expect(f.controller.state.recovery?.intent.request.expectedStoreId).toBe('old-store');
  f.controller.dispose();
});
for (const failure of ['corrupt', 'privateAuthority'] as const)
  test(`unavailable ${failure} journal restore stays non-writable`, async () => {
    const f = fixture();
    f.port.recovery!.restore = async () => {
      if (failure === 'corrupt') throw Error('recovery_journal_unavailable');
      return [
        {
          intent: {
            kind: 'interrupt',
            sessionId: 'a',
            request: {
              kind: 'session.recover',
              expectedStoreId: 'store',
              commandId: 'saved',
              decision: 'interrupt',
              expectedOwnerGeneration: 5,
            },
          } as TuiRecoveryIntent,
          status: 'outcome_unknown',
        },
      ];
    };
    await f.controller.select('a');
    await f.controller.openRecovery();
    await f.controller.submitRecovery('interrupt', 'confirm');
    expect(f.stats().writes).toBe(0);
    expect(f.controller.state.error).toBeDefined();
    f.controller.dispose();
  });

test('automatic recovery checks every restored original in the selected Session even when the displayed intent belongs elsewhere', async () => {
  const f = fixture();
  const saved: TuiRecoveryIntent[] = ['b', 'a', 'a'].map((sessionId, index) => ({
    kind: 'report',
    sessionId,
    reportCommandId: `report-${index}`,
    request: { expectedStoreId: 'store', commandId: `restored-${index}` },
  }));
  const reads: TuiRecoveryIntent[] = [];
  f.port.recovery!.restore = async () =>
    saved.map((intent) => ({ intent, status: 'outcome_unknown' }));
  f.port.recovery!.lookup = async (intent) => {
    reads.push(structuredClone(intent));
    return { intent, status: 'outcome_unknown' };
  };
  try {
    await f.controller.select('a');
    await f.controller.openRecovery();
    expect(f.controller.state.recovery?.intent).toEqual(saved[0]);
    f.controller.closePanel();
    const deadline = Date.now() + 1500;
    while (reads.length < 2 && Date.now() < deadline) await tick();
    expect(reads).toEqual(saved.slice(1));
    expect(f.stats()).toEqual({ writes: 0, reads: 0, cancels: 0 });
  } finally {
    f.controller.dispose();
  }
});

import { expect, test } from 'bun:test';
import type { AgentClient, Command } from '@kite-ai/client';
import { decodeNativeRequest } from '../electron/native-ipc';
import { NativeRecovery } from '../electron/recovery';
import { memoryPrivateData } from './private-data.fixture';

function gate<T>() {
  let resolve!: (v: T) => void;
  return {
    promise: new Promise<T>((r) => {
      resolve = r;
    }),
    resolve: (v: T) => resolve(v),
  };
}
function fixture() {
  const journal = memoryPrivateData();
  let posts = 0,
    gets = 0,
    scope = { generation: 1, selection: 1, storeId: 'store', sessionId: 's' };
  const run = {
    id: 'original-run',
    sessionId: 's',
    originStoreId: 'store',
    originCommandId: 'original-work',
    status: 'active',
  };
  let mode = 'lost';
  let held: ReturnType<typeof gate<Command>> | undefined;
  const response = (id: string) =>
    ({
      id,
      sessionId: 's',
      originStoreId: 'store',
      kind: 'run.resume',
      status: 'applied',
      cancelRequestedAt: null,
      receipt: {
        outcome: 'run_resumed',
        runId: 'original-run',
        originalCommandId: 'original-work',
        boundary: 'tool_calls',
      },
    }) as Command;
  const client = {
    getView: async () => ({
      storeId: 'store',
      session: { id: 's', rootSessionId: 's', parentSessionId: null },
    }),
    getRun: async () => run,
    resumeRun: async (_s: string, input: { commandId: string }) => {
      posts++;
      if (mode === 'lost') throw Error('wire_lost');
      return response(input.commandId);
    },
    getCommand: async (id: string) => {
      gets++;
      return held ? held.promise : response(id);
    },
  } as unknown as AgentClient;
  const owner = new NativeRecovery(
    client,
    () => scope,
    () => {},
    journal,
  );
  return {
    owner,
    journal,
    client,
    run,
    response,
    get posts() {
      return posts;
    },
    get gets() {
      return gets;
    },
    setMode: (v: string) => {
      mode = v;
    },
    hold: () => {
      held = gate<Command>();
      return held;
    },
    switch: () => {
      scope = { ...scope, selection: 2, sessionId: 'other' };
      owner.release();
    },
  };
}
test('original observation shares one POST, journal exists before wire, unknown only queries original Command', async () => {
  const f = fixture();
  const facts = await f.owner.prepare('run', 'original-run', 'read');
  expect(facts.originalCommandId).toBe('original-work');
  const one = f.owner.submit(facts.observationId, false),
    two = f.owner.submit(facts.observationId, false);
  expect(one).toBe(two);
  expect(f.journal.recoveries()[0]?.phase).toBe('submitting');
  const unknown = await one;
  expect(unknown.phase).toBe('outcome_unknown');
  expect(f.posts).toBe(1);
  expect(f.gets).toBe(0);
  f.owner.release();
  const again = await f.owner.prepare('run', 'original-run', 'again');
  await expect(f.owner.submit(again.observationId, false)).rejects.toMatchObject({
    code: 'recovery_intent_pending',
  });
  const applied = await f.owner.lookup(unknown.commandId, 'lookup');
  expect(applied.phase).toBe('resumed');
  expect(f.posts).toBe(1);
  expect(f.gets).toBe(1);
});
test('closing or switching held lookup preserves independently unknown intent and performs no mutation', async () => {
  for (const close of ['close', 'switch']) {
    const f = fixture(),
      facts = await f.owner.prepare('run', 'original-run', 'r');
    const saved = await f.owner.submit(facts.observationId, false);
    const held = f.hold();
    const read = f.owner.lookup(saved.commandId, 'held');
    await Promise.resolve();
    if (close === 'close') f.owner.close('held');
    else f.switch();
    held.resolve(f.response(saved.commandId));
    expect((await read).phase).toBe('outcome_unknown');
    expect(f.journal.recoveries()[0]?.phase).toBe('outcome_unknown');
    expect(f.posts).toBe(1);
  }
});
test('cold unresolved journal keeps original GET identity, submitting is converted to unknown and cannot repost', async () => {
  const f = fixture(),
    facts = await f.owner.prepare('run', 'original-run', 'r');
  const saved = await f.owner.submit(facts.observationId, false);
  const cold = new NativeRecovery(
    f.client,
    () => ({ generation: 9, selection: 4, storeId: 'store', sessionId: 's' }),
    () => {},
    f.journal,
  );
  expect(cold.submissions[0]?.commandId).toBe(saved.commandId);
  expect((await cold.lookup(saved.commandId, 'cold')).phase).toBe('resumed');
  expect(f.posts).toBe(1);
});
test('interrupt requires explicit confirmation and renderer cannot inject private authority', async () => {
  const f = fixture();
  const facts = await f.owner.prepare('interrupt', undefined, 'r');
  await expect(f.owner.submit(facts.observationId, false)).rejects.toMatchObject({
    code: 'recovery_confirmation_required',
  });
  expect(f.posts).toBe(0);
  for (const key of ['token', 'profile', 'runtime', 'ownerGeneration', 'storeId', 'sessionId'])
    expect(() =>
      decodeNativeRequest({
        method: 'recovery.submit',
        generation: 1,
        observationId: 1,
        confirm: true,
        [key]: 'forged',
      }),
    ).toThrow();
});
test('missing persistent port forbids even qualified mutation', async () => {
  const f = fixture(),
    owner = new NativeRecovery(
      f.client,
      () => ({ generation: 1, selection: 1, storeId: 'store', sessionId: 's' }),
      () => {},
    );
  const facts = await owner.prepare('run', 'original-run', 'r');
  await expect(owner.submit(facts.observationId, false)).rejects.toMatchObject({
    code: 'recovery_storage_unavailable',
  });
  expect(f.posts).toBe(0);
});
test('report receipt remains tied to original job.report Command and resulting Run origin; malformed receipt stays unknown', async () => {
  for (const outcome of ['correct', 'wrong_report', 'wrong_origin']) {
    const f = fixture();
    let reportId = '';
    f.client.getCommand = (async (id) => ({
      id,
      kind: 'job.report',
      originStoreId: 'store',
      sessionId: 's',
    })) as AgentClient['getCommand'];
    f.client.resumeJobReport = (async (_s, id, input) => {
      reportId = id;
      return {
        id: input.commandId,
        originStoreId: 'store',
        sessionId: 's',
        kind: 'job.report.resume',
        status: 'applied',
        cancelRequestedAt: null,
        receipt: {
          reportCommandId: outcome === 'wrong_report' ? 'other' : id,
          runId: 'report-run',
          outcome: 'report_resumed',
        },
      };
    }) as AgentClient['resumeJobReport'];
    f.client.getRun = (async () => ({
      ...f.run,
      id: 'report-run',
      originCommandId: outcome === 'wrong_origin' ? 'other' : 'original-report',
    })) as unknown as AgentClient['getRun'];
    const facts = await f.owner.prepare('report', 'original-report', 'read');
    const result = await f.owner.submit(facts.observationId, false);
    expect(reportId).toBe('original-report');
    expect(facts.originalCommandId).toBe('original-report');
    expect(result.phase).toBe(outcome === 'correct' ? 'resumed' : 'outcome_unknown');
  }
});
test('wrong original Run receipt and cold submitting journal fail closed without replay', async () => {
  const f = fixture();
  f.journal.beginRecovery({
    observationId: 42,
    storeId: 'store',
    sessionId: 's',
    kind: 'run',
    targetId: 'original-run',
    originalCommandId: 'original-work',
    commandId: 'cold-submitting',
    phase: 'submitting',
  });
  const cold = new NativeRecovery(
    f.client,
    () => ({ generation: 1, selection: 1, storeId: 'store', sessionId: 's' }),
    () => {},
    f.journal,
  );
  expect(cold.submissions[0]?.phase).toBe('outcome_unknown');
  expect(f.journal.recoveries()[0]?.phase).toBe('outcome_unknown');
  const held = f.hold();
  const lookup = cold.lookup('cold-submitting', 'lookup');
  held.resolve({
    ...f.response('cold-submitting'),
    receipt: {
      outcome: 'run_resumed',
      runId: 'other',
      originalCommandId: 'original-work',
      boundary: 'tool_calls',
    },
  } as Command);
  expect((await lookup).phase).toBe('outcome_unknown');
  expect(f.posts).toBe(0);
});
test('restored current Store never relabels or automatically posts an old journal intent; old observation and lookup preserve original IDs', async () => {
  const f = fixture(),
    facts = await f.owner.prepare('run', 'original-run', 'read'),
    saved = await f.owner.submit(facts.observationId, false);
  const cold = new NativeRecovery(
    f.client,
    () => ({ generation: 7, selection: 2, storeId: 'restored-store', sessionId: 's' }),
    () => {},
    f.journal,
  );
  expect(cold.submissions[0]).toMatchObject({
    storeId: 'store',
    sessionId: 's',
    targetId: 'original-run',
    commandId: saved.commandId,
    phase: 'outcome_unknown',
  });
  expect((await cold.submit(saved.observationId, false)).commandId).toBe(saved.commandId);
  expect(f.posts).toBe(1);
  await expect(cold.prepare('run', 'original-run', 'new-read')).rejects.toMatchObject({
    code: 'recovery_scope_unavailable',
  });
  expect((await cold.lookup(saved.commandId, 'original-get')).commandId).toBe(saved.commandId);
  expect(f.gets).toBe(1);
  expect(f.posts).toBe(1);
});

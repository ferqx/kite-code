import { expect, test } from 'bun:test';
import { pathToFileURL } from 'node:url';
import type { AuthorizationRequest } from '../../../src/extensions';
import { createPermissionCheckContextReader } from '../../../src/permissions/check-context';
import type { AgentRuntime } from '../../../src/runtime';

function fixture(child = false, legacy = false) {
  const sessionId = child ? 'child' : 'root';
  const origin = child ? 'child-start' : 'user-command';
  const binding = { originStoreId: 'store', rootWorkCommandId: 'user-command', rootWorkSeq: '2' };
  const session = {
    id: sessionId,
    workspaceId: 'workspace',
    rootSessionId: 'root',
    parentSessionId: child ? 'root' : null,
    deletedAt: null,
  };
  const command = {
    id: origin,
    sessionId,
    subjectId: 'alice',
    ...binding,
    request: child
      ? { kind: 'child.start', input: { content: 'Inspect code', role: 'forged' } }
      : { kind: 'run.start', content: 'Fix the user problem' },
  };
  const root = {
    ...command,
    id: 'user-command',
    sessionId: 'root',
    request: { kind: 'run.start', content: 'Fix the user problem' },
  };
  const run = {
    id: 'run',
    sessionId,
    originCommandId: origin,
    ...binding,
    status: 'running',
    isActive: true,
    configuration: {
      snapshot: child ? { roleId: 'explore', roleVersion: '1' } : {},
      extensions: [{ id: 'builtin.planning' }],
    },
  };
  const execution = {
    id: 'tool',
    sessionId,
    runId: 'run',
    originCommandId: origin,
    ...binding,
    kind: 'tool',
    definitionId: 'files.read',
    definitionVersion: '1',
  };
  const records = new Map([
    [
      'plan.current',
      {
        originStoreId: 'store',
        contentType: 'builtin.planning.record',
        contentVersion: 1,
        value: { key: 'plan/real' },
      },
    ],
    [
      'plan/real',
      {
        originStoreId: 'store',
        contentType: 'builtin.planning.record',
        contentVersion: 1,
        value: { body: 'Real saved plan\nwith details' },
      },
    ],
  ]);
  const rejected = {
    ...execution,
    id: 'prior',
    authorization: {
      [legacy ? 'review' : 'check']: { decision: 'reject', reason: 'Saved refusal' },
    },
  };
  const runtime = {
    async getExecution() {
      return execution;
    },
    async getRun() {
      return run;
    },
    async getCommand(id: string) {
      return id === 'user-command' ? root : command;
    },
    async getSession(id: string) {
      return id === sessionId ? session : { ...session, id: 'root', parentSessionId: null };
    },
    async getWorkspace() {
      return { id: 'workspace', rootUri: pathToFileURL(process.cwd()).href };
    },
    async readRunExtensionRecord(input: { key: string }) {
      return records.get(input.key) ?? null;
    },
    async getView() {
      return {
        storeId: 'store',
        session,
        executions: [
          rejected,
          {
            ...rejected,
            originStoreId: 'foreign',
            authorization: { check: { decision: 'reject', reason: 'Foreign secret' } },
          },
        ],
      };
    },
  };
  const read = createPermissionCheckContextReader({
    readRuntime: () => runtime as unknown as AgentRuntime,
    subjectId: 'alice',
    originStoreId: 'store',
  });
  const request = {
    kind: 'tool',
    sessionId,
    runId: 'run',
    executionId: 'tool',
    definitionId: 'files.read',
    definitionVersion: '1',
    input: { role: 'forged' },
    signal: new AbortController().signal,
  } satisfies AuthorizationRequest;
  return { read, request, execution, command, root, run, records, runtime };
}

for (const legacy of [false, true])
  test(`check material reads exact task, workspace, plan and scoped ${legacy ? 'legacy' : 'current'} refusal without granting authority`, async () => {
    const f = fixture(false, legacy);
    const result = await f.read(f.request);
    expect(result.task).toMatchObject({
      availability: 'available',
      content: 'Fix the user problem',
      workspaceRoot: process.cwd(),
      isChild: false,
      role: null,
      trustedAsAuthority: false,
    });
    expect(result.plan).toEqual({ body: 'Real saved plan\nwith details' });
    expect(result.rejectionReasons).toEqual(['Saved refusal']);
  });

test('actual child role is sealed Run snapshot; input role cannot choose checker identity', async () => {
  const f = fixture(true);
  expect((await f.read(f.request)).task).toMatchObject({
    isChild: true,
    role: { id: 'explore', version: '1' },
    content: 'Inspect code',
    parentUserTask: 'Fix the user problem',
  });
  f.run.configuration.snapshot = {};
  expect((await f.read(f.request)).task).toMatchObject({
    isChild: true,
    role: null,
    roleAvailability: 'unknown',
  });
});

test('foreign subject/Store/Session and runless callers receive no task, plan or refusal disclosure', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.command.subjectId = 'bob';
      f.root.subjectId = 'bob';
    },
    (f: ReturnType<typeof fixture>) => {
      f.execution.originStoreId = 'foreign';
    },
    (f: ReturnType<typeof fixture>) => {
      f.execution.sessionId = 'foreign';
    },
    (f: ReturnType<typeof fixture>) => {
      f.request.runId = null as unknown as string;
    },
  ]) {
    const f = fixture();
    mutate(f);
    expect(await f.read(f.request)).toMatchObject({
      task: { availability: 'unknown' },
      plan: null,
      rejectionReasons: [],
    });
  }
});

test('abort during readonly source wait stops before reading further context', async () => {
  const f = fixture();
  const controller = new AbortController();
  let reads = 0;
  f.runtime.getExecution = async () => {
    controller.abort(new Error('cancelled'));
    return f.execution;
  };
  f.runtime.getRun = async () => {
    reads++;
    return f.run;
  };
  await expect(f.read({ ...f.request, signal: controller.signal })).rejects.toThrow('cancelled');
  expect(reads).toBe(0);
});

test('the current check cannot feed its own saved refusal back into the frozen request, while other scoped refusals remain evidence', async () => {
  const f = fixture();
  const before = await f.read(f.request);
  const originalView = f.runtime.getView.bind(f.runtime);
  let other = false;
  f.runtime.getView = async () => {
    const view = await originalView();
    return {
      ...view,
      executions: [
        ...view.executions,
        {
          ...f.execution,
          authorization: { check: { decision: 'reject', reason: 'Own newly saved refusal' } },
        },
        ...(other
          ? [
              {
                ...f.execution,
                id: 'other-prior',
                authorization: {
                  check: { decision: 'reject', reason: 'Another original refusal' },
                },
              },
            ]
          : []),
      ],
    };
  };
  expect(await f.read(f.request)).toEqual(before);
  f.run.status = 'waiting_interaction';
  expect(await f.read(f.request)).toEqual(before);
  f.run.status = 'running';
  expect(await f.read(f.request)).toEqual(before);
  expect(before.task).toMatchObject({ currentRun: { id: 'run' } });
  expect(before.rejectionReasons).toEqual(['Saved refusal']);
  other = true;
  expect((await f.read(f.request)).rejectionReasons).toEqual([
    'Saved refusal',
    'Another original refusal',
  ]);
});

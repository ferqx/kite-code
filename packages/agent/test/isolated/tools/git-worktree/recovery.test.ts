import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistentWorktreeDirectory } from '../../../../../../tests/fixtures/worktree-filesystem';
import type {
  ExtensionRecord,
  ExtensionRecordWrite,
  Json,
  OperationOptions,
  OperationRef,
  PublicExecution,
  ToolContext,
} from '../../../../src/extensions';
import { AgentError } from '../../../../src/storage/types';
import {
  createGitWorktreeTool,
  type GitWorktreeHost,
  gitWorktreeRecordDefinition,
} from '../../../../src/tools/git-worktree';
import {
  digest,
  type GitWorktreeConfiguration,
  parseWorkerCommand,
  resolveDefaultWorktreeTarget,
  type WorktreeFrame,
  type WorktreePlan,
  type WorktreeRequest,
} from '../../../../src/tools/git-worktree/protocol';

const config: GitWorktreeConfiguration = {
  configurationId: 'fixture',
  sourceCwd: '/repo',
  bunPath: '/trusted/bun',
  workerPath: '/trusted/worker.js',
  configPath: '/trusted/empty.toml',
  git: { path: '/trusted/git', sha256: 'a'.repeat(64) },
  hooksPath: '/trusted/hooks',
};
const id = { dev: '1', ino: '2', ctimeNs: '3', birthtimeNs: '4' };
const plan: WorktreePlan = {
  action: 'create',
  sourceCwd: '/repo',
  sourceRoot: '/repo',
  commonDir: '/repo/.git',
  targetPath: '/target',
  baseRef: 'HEAD',
  baseOid: 'f'.repeat(40),
  evidence: {
    repository: {
      root: '/repo',
      gitDir: '/repo/.git',
      commonDir: '/repo/.git',
      bare: false,
      rootIdentity: id,
      commonIdentity: id,
    },
    parent: { path: '/', identity: id },
  },
};
const removePlan: WorktreePlan = {
  ...plan,
  action: 'remove',
  evidence: {
    ...(plan.evidence as Record<string, Json>),
    target: {
      identity: id,
      pointerDigest: 'b'.repeat(64),
      adminGitDir: '/repo/.git/worktrees/target',
      adminIdentity: id,
      head: 'f'.repeat(40),
      branch: null,
      registrationDigest: 'c'.repeat(64),
    },
  },
};
const create: Json = { action: 'create', key: 'intent', path: '/target' };

test('short observation locates the exact unknown owner without result metadata, writes or new Jobs', async () => {
  const h = harness();
  const ownerId = '1172d244-0afd-48cc-b3bd-7c4906dd5e91';
  h.setMutationStatus('outcome_unknown');
  const result = await h.tool.execute({ action: 'create', path: '/target' }, h.context(ownerId));
  expect(result.outcome).toBe('outcome_unknown');
  const operationRef = (result.details as { operation_ref: string }).operation_ref;
  expect(operationRef.length).toBe(26);
  const before = { ensures: h.ensures.length, writes: h.writes.length };
  const context = h.context('observer');
  const original = {
    id: ownerId,
    sessionId: 'session',
    runId: 'run',
    kind: 'tool' as const,
    status: 'outcome_unknown' as const,
    resultRevision: '1',
    result: {},
    definitionId: 'git.worktree',
    definitionVersion: '1',
    extensionId: 'builtin.shell',
    originStoreId: 'store',
    authorization: { dispatched: true },
  };
  let source = original;
  context.getExecution = async (id) => (id === ownerId ? source : { ...original, id });
  expect(await h.tool.execute({ action: 'observe', operationRef }, context)).toMatchObject({
    outcome: 'succeeded',
    details: { original_execution_id: ownerId, phase: 'unresolved' },
  });
  for (const change of [
    { originStoreId: 'foreign' },
    { sessionId: 'foreign' },
    { extensionId: 'foreign' },
    { authorization: { dispatched: false } },
  ]) {
    source = { ...original, ...change };
    expect(await h.tool.execute({ action: 'observe', operationRef }, context)).toMatchObject({
      outcome: 'failed',
    });
  }
  expect({ ensures: h.ensures.length, writes: h.writes.length }).toEqual(before);
});

function harness(configuration = config) {
  const records = new Map<string, ExtensionRecord>();
  const jobs = new Map<
    string,
    { ref: OperationRef; execution: PublicExecution; frame: WorktreeFrame }
  >();
  const starts: WorktreeRequest[] = [];
  const ensures: OperationOptions[] = [];
  const writes: ExtensionRecordWrite[] = [];
  let failWrite: ((value: ExtensionRecordWrite) => boolean) | undefined;
  let mutationStatus: PublicExecution['status'] = 'succeeded';
  let roots: Awaited<ReturnType<GitWorktreeHost['readRegisteredWorkspaceRoots']>> = {
    originStoreId: 'store',
    complete: true,
    roots: ['/repo'],
  };
  let safetyUnconfirmed = false;
  const tool = createGitWorktreeTool({
    configuration,
    worktreeHost: {
      async readRegisteredWorkspaceRoots() {
        return roots;
      },
    },
  });
  function context(executionId = 'owner'): ToolContext {
    return {
      sessionId: 'session',
      executionId,
      runId: 'run',
      resourceCapacity: { model: 1, process: 1 },
      signal: new AbortController().signal,
      async getExecution(id: string) {
        return { id, originStoreId: 'store' };
      },
      async readRunExecutionSafety(runId: string) {
        return {
          originStoreId: 'store',
          sessionId: 'session',
          runId,
          revision: '1',
          unconfirmed: safetyUnconfirmed,
          excludedExecutionId: executionId,
          unconfirmedExecutionIds: [],
        };
      },
      records: {
        async get(key: string) {
          return structuredClone(records.get(key) ?? null);
        },
        async write(write: ExtensionRecordWrite) {
          writes.push(structuredClone(write));
          if (failWrite?.(write)) throw new Error('simulated boundary failure');
          const prior = records.get(write.key);
          if ((prior?.revision ?? null) !== write.expectedRevision)
            throw new AgentError('record_revision_conflict');
          const record: ExtensionRecord = {
            extensionId: 'builtin.shell',
            sessionId: 'session',
            key: write.key,
            revision: String(Number(prior?.revision ?? 0) + 1),
            originStoreId: 'store',
            contentType: write.contentType,
            contentVersion: write.contentVersion,
            value: structuredClone(write.value),
          };
          records.set(write.key, record);
          return structuredClone(record);
        },
      },
      operations: {
        async ensure(options: OperationOptions) {
          ensures.push(structuredClone(options));
          const existing = jobs.get(options.key);
          if (existing) {
            if (existing.execution.parentExecutionId !== executionId)
              throw new AgentError('operation_conflict');
            return structuredClone(existing.ref);
          }
          expect(options.planRecordKey).toBe('git-worktree/intent');
          expect(options.cancellation).toBe('attached');
          const request = parseWorkerCommand(
            (options.request as unknown as { input: { command: string } }).input.command,
            configuration,
          )!;
          expect(request).not.toBeNull();
          starts.push(request);
          const ref: OperationRef = {
            commandId: `command-${starts.length}`,
            sessionId: 'session',
            originStoreId: 'store',
            extensionId: 'builtin.shell',
            key: options.key,
            executionId: `job-${starts.length}`,
          };
          const prepared = request.phase.startsWith('prepare_');
          const frozenPlan =
            request.phase === 'prepare_remove'
              ? removePlan
              : request.resolvedTarget
                ? {
                    ...plan,
                    targetPath: request.resolvedTarget.path,
                    evidence: {
                      ...(plan.evidence as Record<string, Json>),
                      parent: {
                        path: request.resolvedTarget.defaultRoot,
                        identity: id,
                        defaultRoot: request.resolvedTarget.defaultRoot,
                        missingParents: [],
                      },
                    },
                  }
                : plan;
          const frame: WorktreeFrame = {
            protocolVersion: 1,
            operationToken: request.operationToken,
            phase: request.phase,
            businessOutcome: prepared ? 'prepared' : 'succeeded',
            details: {
              action: request.phase.endsWith('remove')
                ? 'remove'
                : request.phase === 'list'
                  ? 'list'
                  : 'create',
              cwdChanged: false,
              mutation: prepared || request.phase === 'list' ? 'not_started' : 'completed',
              observedAt: '2026-11-06T00:00:00.000Z',
              repository: { root: '/repo', commonDir: '/repo/.git' },
              ...(prepared
                ? {}
                : request.phase === 'list'
                  ? { sourceWorktree: '/repo', worktrees: [] }
                  : {
                      path: request.plan?.targetPath ?? '/target',
                      head: 'f'.repeat(40),
                      branch: null,
                      observed: {
                        pathExists: request.phase === 'create',
                        registered: request.phase === 'create',
                      },
                      ...(request.phase === 'create'
                        ? { baseRef: 'HEAD', baseCommit: 'f'.repeat(40), detached: true }
                        : { removed: true }),
                    }),
            },
            ...(prepared ? { plan: frozenPlan, planDigest: digest(frozenPlan) } : {}),
          };
          const execution: PublicExecution = {
            id: ref.executionId!,
            sessionId: 'session',
            runId: 'run',
            kind: 'job',
            status: prepared ? 'succeeded' : mutationStatus,
            result: { outcome: 'succeeded', content: 'preview deliberately not JSON' },
            resultRevision: '1',
            originStoreId: 'store',
            parentExecutionId: executionId,
            definitionId: 'shell.command',
            definitionVersion: '1',
            authorization: { dispatched: true },
          };
          jobs.set(options.key, { ref, frame, execution });
          return structuredClone(ref);
        },
        async get(ref: OperationRef) {
          return structuredClone(jobs.get(ref.key)?.execution ?? null);
        },
        async wait(ref: OperationRef) {
          return structuredClone(jobs.get(ref.key)!.execution);
        },
        async readOutput(ref: OperationRef) {
          return {
            highWaterSeq: '1',
            items: [
              {
                executionId: ref.executionId!,
                seq: '1',
                throughSeq: '1',
                stream: 'stdout',
                content: JSON.stringify(jobs.get(ref.key)!.frame) + '\n',
                droppedBytes: '0',
              },
            ],
          };
        },
      },
    } as unknown as ToolContext;
  }
  return {
    tool,
    context,
    records,
    jobs,
    starts,
    ensures,
    writes,
    setFailWrite(value: typeof failWrite) {
      failWrite = value;
    },
    setMutationStatus(value: typeof mutationStatus) {
      mutationStatus = value;
    },
    setRoots(value: typeof roots) {
      roots = value;
    },
    setBusy(value: boolean) {
      safetyUnconfirmed = value;
    },
  };
}
function value(record: ExtensionRecord | undefined): Record<string, Json> {
  return record!.value as Record<string, Json>;
}

test('omitted create path freezes a stable persistent target before ensure and replays across changed defaults', async () => {
  const root = persistentWorktreeDirectory('worktree-default-recovery-');
  const configuration = { ...config, defaultRoot: join(root, '.kite-code', 'worktrees') };
  const h = harness(configuration);
  const input = { action: 'create', key: 'intent' };
  const expected = resolveDefaultWorktreeTarget({
    defaultRoot: configuration.defaultRoot,
    sourceCwd: config.sourceCwd,
    sessionId: 'session',
    key: 'intent',
  });
  const result = await h.tool.execute(input, h.context());
  expect(result).toMatchObject({ outcome: 'succeeded', details: { path: expected } });
  expect(value(h.records.get('git-worktree/intent'))).toMatchObject({
    request: { action: 'create', key: 'intent' },
    resolvedTarget: { path: expected, defaultRoot: configuration.defaultRoot },
  });
  expect(
    (value(h.records.get('git-worktree/intent')).request as Record<string, Json>).path,
  ).toBeUndefined();
  expect(h.starts[0]).toMatchObject({
    resolvedTarget: { path: expected },
    input: { action: 'create' },
  });
  const changed = createGitWorktreeTool({
    configuration: { ...configuration, defaultRoot: join(tmpdir(), 'changed') },
  });
  expect(await changed.execute(input, h.context('later'))).toMatchObject({
    outcome: 'succeeded',
    details: { path: expected, replayed: true },
  });
  expect(h.starts).toHaveLength(2);
  expect(await changed.execute({ ...input, path: expected }, h.context('later'))).toMatchObject({
    outcome: 'failed',
    details: { code: 'worktree_intent_conflict' },
  });
});

test('default target survives accepted/ensure gap without a new Execution adopting it', async () => {
  const configuration = {
    ...config,
    defaultRoot: join(persistentWorktreeDirectory('worktree-default-gap-'), 'worktrees'),
  };
  const h = harness(configuration);
  h.setFailWrite((write) => value({ value: write.value } as ExtensionRecord).phase === 'preparing');
  expect((await h.tool.execute({ action: 'create', key: 'intent' }, h.context())).outcome).toBe(
    'outcome_unknown',
  );
  const original = structuredClone(value(h.records.get('git-worktree/intent')).resolvedTarget) as {
    path: string;
    defaultRoot: string;
  };
  h.setFailWrite(undefined);
  expect(
    (await h.tool.execute({ action: 'create', key: 'intent' }, h.context('later'))).outcome,
  ).toBe('outcome_unknown');
  expect(h.starts).toHaveLength(0);
  expect(value(h.records.get('git-worktree/intent')).resolvedTarget).toEqual(original);
  expect((await h.tool.resume!({ action: 'create', key: 'intent' }, h.context())).outcome).toBe(
    'succeeded',
  );
  expect(h.starts[0]!.resolvedTarget).toEqual(original);
});

test('temporary create targets fail before records or jobs, while explicit persistent input takes precedence', async () => {
  const h = harness({ ...config, defaultRoot: join(tmpdir(), 'forbidden-default') });
  const temporaryInputs: Json[] = [
    { action: 'create', key: 'intent' },
    { action: 'create', key: 'intent', path: join(tmpdir(), 'forbidden-explicit') },
  ];
  for (const input of temporaryInputs) {
    expect(await h.tool.execute(input, h.context())).toMatchObject({
      outcome: 'failed',
      details: { code: 'temporary_worktree_target', mutation: 'not_started' },
    });
  }
  expect(h.records.size).toBe(0);
  expect(h.starts).toHaveLength(0);
  expect((await h.tool.execute(create, h.context())).outcome).toBe('succeeded');
  expect(h.starts[0]!.resolvedTarget).toBeUndefined();
});

test('historical explicit-path receipts precede the new temporary-target policy and never dispatch again', async () => {
  const h = harness();
  expect((await h.tool.execute(create, h.context())).outcome).toBe('succeeded');
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = '/target';
  try {
    expect(await h.tool.execute(create, h.context('later'))).toMatchObject({
      outcome: 'succeeded',
      details: { path: '/target', replayed: true },
    });
    expect(h.starts).toHaveLength(2);
    expect(
      await h.tool.execute({ ...(create as object), key: 'new-intent' }, h.context('later')),
    ).toMatchObject({
      outcome: 'failed',
      details: { code: 'temporary_worktree_target', mutation: 'not_started' },
    });
    expect(h.starts).toHaveLength(2);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
});

test('changed stored default path cannot redirect a resumed original operation', async () => {
  const configuration = {
    ...config,
    defaultRoot: join(persistentWorktreeDirectory('worktree-default-tamper-'), 'worktrees'),
  };
  const h = harness(configuration);
  h.setFailWrite((write) => value({ value: write.value } as ExtensionRecord).phase === 'preparing');
  await h.tool.execute({ action: 'create', key: 'intent' }, h.context());
  const stored = value(h.records.get('git-worktree/intent'));
  (stored.resolvedTarget as Record<string, Json>).path = '/different';
  h.setFailWrite(undefined);
  expect(await h.tool.resume!({ action: 'create', key: 'intent' }, h.context())).toMatchObject({
    outcome: 'failed',
    details: { code: 'worktree_operation_unverifiable', mutation: 'not_started' },
  });
  expect(h.starts).toHaveLength(0);
});

test('first executable CAS and exact Job planRecordKey complete once; historical receipts preserve original time', async () => {
  const h = harness();
  const result = await h.tool.execute(create, h.context());
  expect(result.outcome).toBe('succeeded');
  expect(h.starts.map((x) => x.phase)).toEqual(['prepare_create', 'create']);
  expect(h.writes[0]).toMatchObject({ expectedRevision: null, executable: true });
  expect(gitWorktreeRecordDefinition.fork).toEqual({ mode: 'omit' });
  const repeated = await h.tool.execute(create, h.context('later'));
  expect(repeated.outcome).toBe('succeeded');
  expect(repeated.details).toMatchObject({
    replayed: true,
    observedAt: '2026-11-06T00:00:00.000Z',
  });
  expect(h.starts).toHaveLength(2);
  expect(
    await h.tool.execute({ ...(create as object), path: '/different' } as Json, h.context('later')),
  ).toMatchObject({ outcome: 'failed', details: { code: 'worktree_intent_conflict' } });
  expect(
    await h.tool.execute(
      {
        ...(create as object),
        permissions: { filesystem: 'full_access', network: 'none' },
      } as Json,
      h.context('later'),
    ),
  ).toMatchObject({ outcome: 'failed', details: { code: 'worktree_intent_conflict' } });
});

test('creation notification follows the stable CAS; mail uncertainty and historical replay never repeat Git', async () => {
  const h = harness();
  const context = h.context();
  context.getExecution = async (id) => ({
    id,
    sessionId: context.sessionId,
    runId: 'run',
    kind: 'tool',
    status: 'running',
    result: {},
    resultRevision: '0',
    definitionId: 'git.worktree',
    definitionVersion: '1',
    originStoreId: 'store',
  });
  context.readExecutionGroupSafety = async () =>
    ({
      originStoreId: 'store',
      sessionId: context.sessionId,
      rootSessionId: 'root',
      quiescent: false,
    }) as Awaited<ReturnType<NonNullable<ToolContext['readExecutionGroupSafety']>>>;
  context.operations.readAgentMessageTarget = async () => ({}) as never;
  const messages: string[] = [];
  context.operations.sendStableAgentMessage = async (target, content) => {
    expect(target).toBe('parent');
    expect(value(h.records.get('git-worktree/intent'))).toMatchObject({
      phase: 'completed',
      stableResult: { outcome: 'succeeded', details: { mutation: 'completed' } },
    });
    messages.push(content);
    if (messages.length === 1) throw Error('simulated original mail receipt loss');
  };
  const result = await h.tool.execute(create, context);
  expect(result).toMatchObject({
    outcome: 'succeeded',
    details: {
      mutation: 'completed',
      parentNotification: { status: 'outcome_unknown', accepted: null },
    },
  });
  const resumed = await h.tool.resume!(create, context);
  expect(resumed).toMatchObject({
    outcome: 'succeeded',
    details: { parentNotification: { status: 'queued', accepted: true } },
  });
  expect(messages).toHaveLength(2);
  expect(messages[0]).toBe(messages[1]);
  expect(h.starts.map((request) => request.phase)).toEqual(['prepare_create', 'create']);
  expect(await h.tool.execute(create, h.context('different-tool'))).toMatchObject({
    outcome: 'succeeded',
    details: { replayed: true },
  });
  expect(messages).toHaveLength(2);
  expect(h.starts).toHaveLength(2);
});

test('failed final creation CAS reports unsent notification while preserving the known Git result', async () => {
  const h = harness();
  const context = h.context();
  let sends = 0;
  context.operations.sendStableAgentMessage = async () => {
    sends++;
  };
  h.setFailWrite((write) => value({ value: write.value } as ExtensionRecord).phase === 'completed');
  const result = await h.tool.execute(create, context);
  expect(result).toMatchObject({
    outcome: 'succeeded',
    details: {
      mutation: 'completed',
      parentNotification: { status: 'failed', accepted: false },
    },
  });
  expect(sends).toBe(0);
  expect(h.starts.map((request) => request.phase)).toEqual(['prepare_create', 'create']);
});
test('accepted intent/ensure gap is never adopted by a new Execution', async () => {
  const h = harness();
  let fired = false;
  h.setFailWrite((write) => {
    const v = value({ value: write.value } as ExtensionRecord);
    if (!fired && v.phase === 'preparing') {
      fired = true;
      return true;
    }
    return false;
  });
  expect((await h.tool.execute(create, h.context())).outcome).toBe('outcome_unknown');
  expect(h.starts).toHaveLength(0);
  h.setFailWrite(undefined);
  expect((await h.tool.execute(create, h.context('later'))).outcome).toBe('outcome_unknown');
  expect(h.starts).toHaveLength(0);
  expect((await h.tool.resume!(create, h.context())).outcome).toBe('succeeded');
  expect(h.starts).toHaveLength(2);
});
test('ensure accepted/ref save gap reuses exact original frozen request only on owner resume', async () => {
  const h = harness();
  let fired = false;
  h.setFailWrite((write) => {
    const v = value({ value: write.value } as ExtensionRecord),
      steps = v.steps as Record<string, Json>;
    if (!fired && (steps.prepare as Record<string, Json>)?.ref) {
      fired = true;
      return true;
    }
    return false;
  });
  expect((await h.tool.execute(create, h.context())).outcome).toBe('outcome_unknown');
  expect(h.starts).toHaveLength(1);
  const original = structuredClone(h.ensures[0]!);
  h.setFailWrite(undefined);
  expect((await h.tool.execute(create, h.context('later'))).outcome).toBe('outcome_unknown');
  expect(h.ensures).toHaveLength(1);
  expect((await h.tool.resume!(create, h.context())).outcome).toBe('succeeded');
  expect(h.ensures[1]).toEqual(original);
  expect(h.starts).toHaveLength(2);
});
test('new Execution with only successful preparation neither claims success nor dispatches mutation', async () => {
  const h = harness();
  let fired = false;
  h.setFailWrite((write) => {
    const v = value({ value: write.value } as ExtensionRecord);
    if (!fired && v.phase === 'mutation_dispatching') {
      fired = true;
      return true;
    }
    return false;
  });
  expect((await h.tool.execute(create, h.context())).outcome).toBe('outcome_unknown');
  expect(h.starts).toHaveLength(1);
  h.setFailWrite(undefined);
  expect((await h.tool.execute(create, h.context('later'))).outcome).toBe('outcome_unknown');
  expect(h.starts).toHaveLength(1);
  expect((await h.tool.resume!(create, h.context())).outcome).toBe('succeeded');
  expect(h.starts).toHaveLength(2);
});
test('successful mutation/final record gap is recovered from original full Job output without ensure', async () => {
  const h = harness();
  h.setFailWrite((write) => (write.value as Record<string, Json>).phase === 'completed');
  expect((await h.tool.execute(create, h.context())).outcome).toBe('succeeded');
  expect(h.starts).toHaveLength(2);
  h.setFailWrite(undefined);
  expect((await h.tool.execute(create, h.context('later'))).outcome).toBe('succeeded');
  expect(h.ensures).toHaveLength(2);
});
test('unknown original Job can later supply definitive evidence; unknown is never a stable receipt', async () => {
  const h = harness();
  h.setMutationStatus('outcome_unknown');
  expect((await h.tool.execute(create, h.context())).outcome).toBe('outcome_unknown');
  expect(value(h.records.get('git-worktree/intent')).stableResult).toBeUndefined();
  const originalRecord = structuredClone(h.records.get('git-worktree/intent'));
  const writeCount = h.writes.length;
  expect((await h.tool.execute(create, h.context('later'))).outcome).toBe('outcome_unknown');
  expect(h.records.get('git-worktree/intent')).toEqual(originalRecord);
  expect(h.writes).toHaveLength(writeCount);
  const mutation = [...h.jobs.values()].at(-1)!;
  mutation.execution.status = 'succeeded';
  expect((await h.tool.execute(create, h.context('later'))).outcome).toBe('succeeded');
  expect(h.records.get('git-worktree/intent')).toEqual(originalRecord);
  expect(h.writes).toHaveLength(writeCount);
  expect(h.ensures).toHaveLength(2);
  expect((await h.tool.resume!(create, h.context())).outcome).toBe('succeeded');
  expect(value(h.records.get('git-worktree/intent')).stableResult).toMatchObject({
    outcome: 'succeeded',
  });
  expect(await h.tool.execute(create, h.context('later'))).toMatchObject({
    outcome: 'succeeded',
    details: { replayed: true },
  });
  expect(h.starts).toHaveLength(2);
  expect(h.ensures).toHaveLength(2);
});
test('expired original no-ref step does not reset deadline or re-ensure after acceptance window', async () => {
  const h = harness();
  let fired = false;
  h.setFailWrite((write) => {
    const steps = (write.value as Record<string, Json>).steps as Record<string, Json>;
    if (!fired && (steps.prepare as Record<string, Json>)?.ref) {
      fired = true;
      return true;
    }
    return false;
  });
  await h.tool.execute(create, h.context());
  h.setFailWrite(undefined);
  const record = h.records.get('git-worktree/intent')!;
  const v = value(record);
  v.acceptedAt = '2000-01-01T00:00:00.000Z';
  v.deadlineAt = '2000-01-01T00:01:00.000Z';
  const original = structuredClone(h.ensures[0]!);
  expect((await h.tool.resume!(create, h.context())).outcome).toBe('outcome_unknown');
  expect(h.ensures).toEqual([original]);
  expect(value(h.records.get('git-worktree/intent')).deadlineAt).toBe('2000-01-01T00:01:00.000Z');
});
test('remove occupancy rejects busy Runs, registered roots and incomplete foreign observations before mutation', async () => {
  for (const scenario of ['busy', 'registered', 'foreign', 'incomplete'] as const) {
    const h = harness();
    if (scenario === 'busy') h.setBusy(true);
    if (scenario === 'registered')
      h.setRoots({ originStoreId: 'store', complete: true, roots: ['/repo', '/target/nested'] });
    if (scenario === 'foreign') h.setRoots({ originStoreId: 'other', complete: true, roots: [] });
    if (scenario === 'incomplete')
      h.setRoots({ originStoreId: 'store', complete: false as true, roots: [] });
    const result = await h.tool.execute(
      { action: 'remove', key: 'intent', path: '/target' },
      h.context(),
    );
    expect(result.outcome).toBe('failed');
    expect(result.details).toMatchObject({
      mutation: 'not_started',
      code:
        scenario === 'busy'
          ? 'worktree_busy'
          : scenario === 'registered'
            ? 'worktree_registered_workspace'
            : 'worktree_occupancy_unavailable',
    });
    expect(h.starts.map((x) => x.phase)).toEqual(['prepare_remove']);
  }
});
test('foreign executable records cannot create authority; same-key concurrent admission starts once', async () => {
  const h = harness();
  const results = await Promise.all([
    h.tool.execute(create, h.context()),
    h.tool.execute(create, h.context('other')),
  ]);
  expect(results.some((x) => x.outcome === 'succeeded')).toBe(true);
  expect(h.starts).toHaveLength(2);
  const record = h.records.get('git-worktree/intent')!;
  record.originStoreId = 'foreign';
  delete value(record).stableResult;
  expect(await h.tool.resume!(create, h.context())).toMatchObject({
    outcome: 'failed',
    details: { code: 'worktree_operation_unverifiable' },
  });
  expect(h.starts).toHaveLength(2);
});
for (const checkpoint of [
  'accepted',
  'prepare_frozen',
  'prepare_ref_saved',
  'prepared',
  'mutation_frozen',
  'mutation_ref_saved',
] as const) {
  test(`same-key observer leaves the active owner record unchanged at ${checkpoint}`, async () => {
    const h = harness();
    const context = h.context();
    const write = context.records.write;
    let paused!: () => void;
    let release!: () => void;
    const reachedCheckpoint = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const continueOwner = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stopped = false;
    context.records.write = async (record) => {
      const saved = await write(record);
      const operation = value(saved);
      const steps = operation.steps as Record<string, Record<string, Json>>;
      const matches =
        (checkpoint === 'accepted' && operation.phase === 'accepted') ||
        (checkpoint === 'prepare_frozen' &&
          operation.phase === 'preparing' &&
          !steps.prepare?.ref) ||
        (checkpoint === 'prepare_ref_saved' &&
          operation.phase === 'preparing' &&
          !!steps.prepare?.ref) ||
        (checkpoint === 'prepared' && operation.phase === 'prepared') ||
        (checkpoint === 'mutation_frozen' && operation.phase === 'mutation_dispatching') ||
        (checkpoint === 'mutation_ref_saved' && operation.phase === 'mutation_observing');
      if (!stopped && matches) {
        stopped = true;
        paused();
        await continueOwner;
      }
      return saved;
    };
    const owner = h.tool.execute(create, context);
    try {
      await reachedCheckpoint;
      const originalRecord = structuredClone(h.records.get('git-worktree/intent'));
      const originalEnsures = structuredClone(h.ensures);
      const writeCount = h.writes.length;
      const observation = await h.tool.execute(create, h.context('observer'));
      expect(observation.outcome).toBe(
        checkpoint === 'mutation_ref_saved' ? 'succeeded' : 'outcome_unknown',
      );
      expect(h.records.get('git-worktree/intent')).toEqual(originalRecord);
      expect(h.writes).toHaveLength(writeCount);
      expect(h.ensures).toEqual(originalEnsures);
    } finally {
      release();
      await owner;
    }
    expect((await owner).outcome).toBe('succeeded');
    expect(h.starts.map((request) => request.phase)).toEqual(['prepare_create', 'create']);
    expect(h.ensures).toHaveLength(2);
    expect(value(h.records.get('git-worktree/intent'))).toMatchObject({
      phase: 'completed',
      stableResult: { outcome: 'succeeded' },
    });
  });
}
test('record closure, frozen intent/phase integrity and malformed stable success fail closed without dispatch', async () => {
  for (const damage of ['extra', 'digest', 'phase', 'stepPhase', 'stable'] as const) {
    const h = harness();
    await h.tool.execute(create, h.context());
    const record = h.records.get('git-worktree/intent')!,
      v = value(record);
    if (damage === 'extra') v.extra = true;
    if (damage === 'digest') v.requestDigest = 'd'.repeat(64);
    if (damage === 'phase') v.phase = 'invented';
    if (damage === 'stepPhase') {
      const step = (v.steps as Record<string, Json>).prepare as Record<string, Json>;
      (step.request as Record<string, Json>).phase = 'prepare_remove';
    }
    if (damage === 'stable')
      ((v.stableResult as Record<string, Json>).details as Record<string, Json>).cwdChanged = true;
    const result = await h.tool.execute(create, h.context('later'));
    expect(result).toMatchObject({
      outcome: 'failed',
      details: { code: 'worktree_operation_unverifiable' },
    });
    expect(h.starts).toHaveLength(2);
  }
});
test('unconfirmed occupancy must be explicitly false and precisely exclude this Tool', async () => {
  for (const bad of [
    { unconfirmed: undefined },
    { unconfirmed: false, excludedExecutionId: 'other' },
  ]) {
    const h = harness(),
      ctx = h.context();
    const original = ctx.readRunExecutionSafety!;
    ctx.readRunExecutionSafety = async (id) =>
      ({ ...(await original(id)), ...bad }) as Awaited<ReturnType<typeof original>>;
    const result = await h.tool.execute({ action: 'remove', key: 'intent', path: '/target' }, ctx);
    expect(result.outcome).toBe('failed');
    expect(h.starts).toHaveLength(1);
  }
});
test('attached cancellation waits for Runtime terminal and preserves unknown mutation effects', async () => {
  const h = harness();
  h.setMutationStatus('running');
  const ctx = h.context(),
    controller = new AbortController();
  Object.defineProperty(ctx, 'signal', { value: controller.signal });
  let observedCancellation = false;
  ctx.operations.wait = async (ref) => {
    const job = h.jobs.get(ref.key)!;
    if (job.frame.phase === 'create') {
      controller.abort();
      setTimeout(() => {
        observedCancellation = true;
        job.execution.status = 'cancelled';
        job.execution.result = { outcome: 'cancelled', content: 'Runtime confirmed tree stopped' };
      }, 10);
      throw new AgentError('wait_timeout');
    }
    return job.execution;
  };
  const result = await h.tool.execute(create, ctx);
  expect(observedCancellation).toBe(true);
  expect(result).toMatchObject({ outcome: 'cancelled', details: { mutation: 'unknown' } });
  expect(value(h.records.get('git-worktree/intent')).stableResult).toBeUndefined();
  expect(h.starts).toHaveLength(2);
});
test('deadline after a saved prepared plan fails without dispatching mutation and replays a stable timeout', async () => {
  const h = harness();
  const ctx = h.context();
  const write = ctx.records.write;
  const originalNow = Date.now;
  let expiredAtPrepared = false;
  ctx.records.write = async (record) => {
    const saved = await write(record);
    if ((record.value as Record<string, Json>).phase === 'prepared') {
      expiredAtPrepared = true;
      const deadline = Date.parse((record.value as Record<string, Json>).deadlineAt as string);
      Date.now = () => deadline + 1;
    }
    return saved;
  };
  try {
    const result = await h.tool.execute(create, ctx);
    expect(expiredAtPrepared).toBe(true);
    expect(result).toMatchObject({
      outcome: 'failed',
      details: { code: 'worktree_timeout', mutation: 'not_started' },
    });
    expect(h.starts.map((request) => request.phase)).toEqual(['prepare_create']);
    expect(h.ensures).toHaveLength(1);
    expect(value(h.records.get('git-worktree/intent')).stableResult).toMatchObject({
      outcome: 'failed',
    });
    expect(
      (value(h.records.get('git-worktree/intent')).steps as Record<string, Json>).mutation,
    ).toBeUndefined();
    expect(await h.tool.execute(create, h.context('later'))).toMatchObject({
      outcome: 'failed',
      details: { code: 'worktree_timeout', replayed: true, mutation: 'not_started' },
    });
    expect(h.ensures).toHaveLength(1);
  } finally {
    Date.now = originalNow;
  }
});
test('deadline after a mutation step is saved without ref preserves its unknown acceptance window', async () => {
  const h = harness();
  const ctx = h.context();
  const write = ctx.records.write;
  const originalNow = Date.now;
  ctx.records.write = async (record) => {
    const saved = await write(record);
    if ((record.value as Record<string, Json>).phase === 'mutation_dispatching') {
      const deadline = Date.parse((record.value as Record<string, Json>).deadlineAt as string);
      Date.now = () => deadline + 1;
    }
    return saved;
  };
  try {
    expect(await h.tool.execute(create, ctx)).toMatchObject({
      outcome: 'outcome_unknown',
      details: { code: 'worktree_timeout', mutation: 'unknown' },
    });
    expect(h.starts.map((request) => request.phase)).toEqual(['prepare_create']);
    expect(h.ensures).toHaveLength(1);
    expect(value(h.records.get('git-worktree/intent')).stableResult).toBeUndefined();
    const mutation = (value(h.records.get('git-worktree/intent')).steps as Record<string, Json>)
      .mutation as Record<string, Json>;
    expect(mutation).toBeDefined();
    expect(mutation.ref).toBeUndefined();
    expect((await h.tool.resume!(create, h.context())).outcome).toBe('outcome_unknown');
    expect(h.ensures).toHaveLength(1);
  } finally {
    Date.now = originalNow;
  }
});

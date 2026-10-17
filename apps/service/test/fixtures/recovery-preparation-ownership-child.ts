import { mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentError, ConfigurationPreparationCleanupError, createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Extension } from '@kite-ai/agent/extensions';
import * as filesModule from '@kite-ai/agent/files';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { startService } from '../../src';
import { createWorkspaceAssembly } from '../../src/assembly';
import { resumeBinding } from './run-resume-binding';

let ownedSeed: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
let seedOutput: Promise<string> | undefined;
let seedDiagnostics: Promise<string> | undefined;
async function bounded<T>(work: Promise<T>, milliseconds: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(`owned seed deadline: ${phase}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function cleanupSeed() {
  const child = ownedSeed;
  if (!child) return;
  // A failed reader must not short-circuit the original exit/other pipe barrier.
  const completion = Promise.allSettled([child.exited, seedOutput, seedDiagnostics]);
  const failures: unknown[] = [];
  let settled: Awaited<typeof completion> | undefined;
  if (child.exitCode === null) {
    try {
      child.stdin.write('exit\n');
      child.stdin.end();
    } catch (error) {
      failures.push(error);
      child.kill('SIGTERM');
    }
  }
  try {
    settled = await bounded(completion, 300, 'requested original seed exit');
  } catch (original) {
    failures.push(original);
    if (child.exitCode === null) child.kill('SIGTERM');
    try {
      settled = await bounded(completion, 300, 'original seed SIGTERM');
    } catch (cleanup) {
      failures.push(cleanup);
      if (child.exitCode === null) child.kill('SIGKILL');
      try {
        settled = await bounded(completion, 300, 'original seed SIGKILL');
      } catch (last) {
        failures.push(last);
      }
    }
  }
  // Preserve all original reader failures only after the three producers settle,
  // or preserve the bounded unconfirmed cleanup errors when no barrier was reached.
  for (const result of settled ?? [])
    if (result.status === 'rejected') failures.push(result.reason);
  if (failures.length)
    throw new AggregateError(failures, 'original seed cleanup failed', { cause: failures[0] });
}
let exiting = false;
const exitOwned = (code: number) => {
  if (exiting) return;
  exiting = true;
  void cleanupSeed().then(
    () => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
};
process.once('SIGTERM', () => exitOwned(143));
process.stdin.setEncoding('utf8');
let exitInput = '';
process.stdin.on('data', (chunk: string) => {
  exitInput += chunk;
  if (exitInput === 'exit\n') exitOwned(0);
  else if (!'exit\n'.startsWith(exitInput)) exitOwned(2);
});
process.stdin.once('end', () => exitOwned(0));
const root = process.argv[2]!;
const mode = process.argv[3]!;
const profile = selectProfile({ dataRoot: root, profile: 'test' });
privateDirectory(profile.profilePath);
const ledger = join(root, 'ledger');
const fileBody = '原恢复资源 中🙂e\u0301\r\n原第二行';
if (mode !== 'seed-run') writeFileSync(join(root, 'original.txt'), fileBody, { mode: 0o600 });
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const permissions = { authorize: async () => ({ allowed: true, revision: 'original' }) };
async function until(condition: () => Promise<boolean>, phase: string) {
  const deadline = Date.now() + 5000;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw Error(`original recovery deadline: ${phase}`);
    await Bun.sleep(1);
  }
}
type Store = Awaited<ReturnType<typeof openSqliteStore>>;
async function snapshot(store: Store, sessionIds: string[], commandIds: string[]) {
  const expectedStoreId = (await store.getMetadata()).storeId;
  return {
    metadata: await store.getMetadata(),
    sessions: await Promise.all(
      sessionIds.map(async (id) => ({
        id,
        view: await store.getView(id),
        messages: await store.listMessages(id, { limit: 200 }),
        interactions: await store.listInteractions({
          expectedStoreId,
          sessionId: id,
          origin: 'all',
          limit: 100,
        }),
      })),
    ),
    commands: await Promise.all(commandIds.map((id) => store.getCommand(id))),
  };
}
export type RecoverySnapshot = Awaited<ReturnType<typeof snapshot>>;
export interface RecoveryReceipt {
  pid: number;
  mode: string;
  seedExit: { code: number; stdout: string; stderr: string } | null;
  before: RecoverySnapshot;
  after: RecoverySnapshot;
  recovery: Awaited<ReturnType<Store['getCommand']>>;
  owner: Awaited<ReturnType<Store['getSession']>>;
  foreignOwner: null;
  resolvers: number;
  attempts: number;
  modelCalls: number;
  starts: number;
  queries: number;
  ledger: string;
  sdkError: { code: unknown } | null;
  exactReceiver: boolean;
  typed: boolean;
  originalCode: string | null;
  originalCleanup: boolean;
  exactFiles: boolean;
  fileBody: string;
  fileContent: string;
  sameClose: boolean;
  error: { code: unknown } | null;
  runtimeError: { code: unknown } | null;
  lifecycle: { state: string };
}
let starts = 0,
  queries = 0;
const jobExtension: Extension = {
  id: 'fixture.ledger',
  version: '1',
  apiMajor: 1,
  jobs: [
    {
      id: 'ledger.job',
      version: '1',
      description: 'original actual ledger effect',
      inputSchema: { type: 'object', additionalProperties: false },
      recovery: { version: '1', configuration: { ledger } },
      async start(_input, context) {
        starts++;
        writeFileSync(
          ledger,
          JSON.stringify({ operation: context.executionId, outcome: 'succeeded' }),
          { mode: 0o600 },
        );
        return { reference: { operation: context.executionId } };
      },
      async *observe() {
        yield {
          type: 'terminal',
          result: { outcome: 'outcome_unknown', content: 'original_reply_lost' },
          supervision: 'ended',
        };
      },
      async cancel() {
        return { status: 'already_finished' };
      },
      async dispose() {},
      async reconcile() {
        queries++;
        throw Error('unexpected original adapter replay');
      },
    },
  ],
  tools: [
    {
      id: 'ledger.launch',
      version: '1',
      description: 'original Job launch',
      inputSchema: { type: 'object', additionalProperties: false },
      async execute(_input, context) {
        const reference = await context.operations.ensure({
          key: 'once',
          cancellation: 'detached',
          request: { kind: 'job', definitionId: 'ledger.job', definitionVersion: '1', input: {} },
        });
        return { outcome: 'succeeded', content: reference.executionId! };
      },
    },
  ],
};
const task = createTaskExtension({
  roles: [{ id: 'reader', configurationId: 'child', description: 'original role' }],
  afterTurn: { enabled: true },
});
const policy = { authorize: async () => ({ allowed: true, revision: 'original-report' }) };
async function seedRun() {
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const binding = resumeBinding({ ledger });
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    permissions: binding.permissions,
    resolveRunConfiguration: async () => binding,
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'original',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    expectedStoreId,
    commandId: 'create',
    subjectId: 'owner',
    sessionId: 's',
    workspaceId: 'w',
    title: 'Original',
  });
  await runtime.submitCommand({
    expectedStoreId,
    commandId: 'work',
    subjectId: 'owner',
    sessionId: 's',
    request: { kind: 'run.start', content: '原完整恢复请求 中🙂\r\n原第二行' },
  });
  await until(
    async () =>
      (await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' }))
        .interactions.length === 1,
    'pending original approval',
  );
  console.log(
    JSON.stringify({
      storeId: expectedStoreId,
      runId: (await runtime.getView('s')).runs.find((run) => run.isActive)!.id,
    }),
  );
}
if (mode === 'seed-run') {
  // Independently bound this exact warm process even if its owning parent dies.
  setTimeout(() => process.exit(124), 7000);
  await seedRun();
} else {
  let seed: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
  let store: Store | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let retained = false;
  let terminalFailure: unknown;
  try {
    let sessionId = 's',
      runId = '',
      executionId = '',
      resultRevision = '',
      reportId = '';
    let sessionIds = ['s'],
      commandIds = ['create', 'work'];
    let seedExit: RecoveryReceipt['seedExit'] = null;
    if (mode === 'run') {
      seed = Bun.spawn(
        [process.execPath, '--no-install', fileURLToPath(import.meta.url), root, 'seed-run'],
        { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      );
      ownedSeed = seed;
      seedDiagnostics = new Response(seed.stderr).text();
      void seedDiagnostics.catch(() => {});
      const reader = seed.stdout.getReader(),
        decoder = new TextDecoder('utf-8', { fatal: true });
      let readyResolve!: (value: { runId: string }) => void;
      let readyReject!: (error: unknown) => void;
      const ready = new Promise<{ runId: string }>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      void ready.catch(() => {});
      seedOutput = (async () => {
        let buffer = '',
          published = false;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) {
              buffer += decoder.decode();
              if (!published) throw Error('original seed missing ready receipt');
              return buffer;
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            if (buffer.length > 1048576) throw Error('original seed output too large');
            if (!published && buffer.includes('\n')) {
              const end = buffer.indexOf('\n');
              const record = JSON.parse(buffer.slice(0, end)) as { runId: string };
              buffer = buffer.slice(end + 1);
              published = true;
              readyResolve(record);
            }
          }
        } catch (error) {
          readyReject(error);
          throw error;
        } finally {
          reader.releaseLock();
        }
      })();
      void seedOutput.catch(() => {});
      runId = (await bounded(ready, 5000, 'original pending checkpoint')).runId;
      seed.stdin.write('exit\n');
      seed.stdin.end();
      const [code, stdout, stderr] = await bounded(
        Promise.all([seed.exited, seedOutput, seedDiagnostics]),
        1000,
        'explicit original warm exit and double EOF',
      );
      seedExit = { code, stdout, stderr };
      if (seedExit.code !== 0 || seedExit.stdout || seedExit.stderr)
        throw Error('original warm exit/EOF failed');
      if (readFileSync(ledger, 'utf8') !== 'model-decision\n')
        throw Error('original decision seed replayed');
    } else {
      const warmStore = await openSqliteStore(profile);
      const expectedStoreId = (await warmStore.getMetadata()).storeId;
      const pendingStore =
        mode === 'report'
          ? new Proxy(warmStore, {
              get(target, key) {
                if (key === 'applyJobReport')
                  return async () => {
                    throw new AgentError('report_recovery_required');
                  };
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            })
          : warmStore;
      if (mode === 'report') sessionId = 'root';
      const model = createFixedModel([
        [
          {
            type: 'tool_call',
            id: 'original-launch',
            name: mode === 'report' ? 'task' : 'ledger.launch',
            arguments:
              mode === 'report'
                ? JSON.stringify({
                    key: 'child',
                    role: 'reader',
                    resultDisposition: 'after_turn',
                    cancellation: 'detached',
                    input: { content: '原实际子结果 中🙂\r\n' },
                  })
                : '{}',
          },
          { ...finish, reason: 'tool_calls' },
        ],
        [{ type: 'text_delta', text: '原完整Parent 中🙂\r\n' }, finish],
      ]);
      const warm = createRuntime({
        store: pendingStore,
        artifacts: createArtifactStore({ profile, store: warmStore }),
        permissions,
        extensions: [mode === 'report' ? task : jobExtension],
        modelConcurrency: 2,
        ...(mode === 'report'
          ? {
              childConfigurations: [
                {
                  id: 'child',
                  version: '1',
                  model: createFixedModel([
                    [{ type: 'text_delta', text: '原完整Child 中🙂\r\n' }, finish],
                  ]),
                  modelId: 'child',
                  toolIds: [],
                  snapshot: { child: true },
                },
              ],
              resolveRunConfiguration: async () => ({
                model,
                modelId: 'fixed',
                snapshot: { sealed: 'original' },
                extensions: [],
                afterTurn: policy,
              }),
            }
          : { model, modelId: 'fixed' }),
      });
      await warm.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'original',
        rootUri: pathToFileURL(root).href,
      });
      await warm.createSession({
        expectedStoreId,
        commandId: 'create',
        subjectId: 'owner',
        sessionId,
        workspaceId: 'w',
        title: 'Original',
      });
      await warm.submitCommand({
        expectedStoreId,
        commandId: 'work',
        subjectId: 'owner',
        sessionId,
        request: { kind: 'run.start', content: '原完整恢复请求 中🙂\r\n原第二行' },
      });
      await warm.waitForCommand('work', { timeoutMs: 5000 });
      if (mode === 'report') {
        const carrier = (await warmStore.getView(sessionId)).executions.find(
          (value) => value.childSessionId,
        )!;
        await warm.waitForCommand(carrier.originCommandId, { timeoutMs: 5000 });
        const execution = (await warmStore.getExecution(carrier.id))!;
        executionId = execution.id;
        reportId = `report-${createHash('sha256')
          .update(JSON.stringify([expectedStoreId, execution.id, execution.resultRevision]))
          .digest('hex')}`;
        await warm.waitForCommand(reportId, { timeoutMs: 5000 });
        sessionIds = [sessionId, execution.childSessionId!];
        const childView = await warmStore.getView(execution.childSessionId!);
        commandIds = [
          ...new Set([
            ...commandIds,
            reportId,
            carrier.originCommandId,
            ...childView.runs.map((run) => run.originCommandId),
          ]),
        ];
        runId = (execution.afterTurn as { parentRunId: string }).parentRunId;
      } else {
        await until(
          async () =>
            (await warmStore.getView(sessionId)).executions.some(
              (value) => value.kind === 'job' && value.status === 'outcome_unknown',
            ) && !(await warmStore.getView(sessionId)).runs.some((value) => value.isActive),
          'original unknown Job',
        );
        const execution = (await warmStore.getView(sessionId)).executions.find(
          (value) => value.kind === 'job',
        )!;
        executionId = execution.id;
        resultRevision = execution.resultRevision;
        commandIds.push(execution.originCommandId);
      }
      await warm.close();
    }
    store = await openSqliteStore(profile);
    const before = await snapshot(store, sessionIds, commandIds);
    const model = createFixedModel([]);
    const realFiles = { ...filesModule };
    let originalFiles: filesModule.WorkspaceFiles | undefined;
    let attempts = 0,
      resolvers = 0;
    let preparationError: unknown;
    let exactReceiver = false;
    const cleanupFailure = Error('original recovery directory close rejected before native close');
    mock.module('@kite-ai/agent/files', () => ({
      ...realFiles,
      createWorkspaceFiles(options: Parameters<typeof realFiles.createWorkspaceFiles>[0]) {
        if (originalFiles) throw Error('unexpected recovery directory reopen');
        const files = realFiles.createWorkspaceFiles(options);
        originalFiles = files;
        files.close = async () => {
          attempts++;
          throw cleanupFailure;
        };
        return files;
      },
    }));
    const resolve = async (input: {
      workspace: { rootUri: string };
      session: { id: string };
      run?: { id: string };
      execution?: { id: string };
    }) => {
      resolvers++;
      exactReceiver =
        input.workspace.rootUri === pathToFileURL(root).href &&
        input.session.id === sessionId &&
        (mode === 'job' ? input.execution?.id === executionId : input.run?.id === runId);
      try {
        await createWorkspaceAssembly({
          workspaceRoot: fileURLToPath(input.workspace.rootUri),
          profile,
          toolIds: ['files.read'],
          selectedSkills: ['required-missing-skill'],
        });
        throw Error('required original missing Skill unexpectedly prepared');
      } catch (error) {
        preparationError = error;
        throw error;
      }
    };
    runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      instanceId: 'original-recovery-owner',
      model,
      modelId: 'fixed',
      permissions,
      ...(mode === 'job'
        ? {
            extensions: [jobExtension],
            authorizeJobReconcile: async () => ({ allowed: true, revision: 'explicit-original' }),
            resolveRecoveryJobConfiguration: resolve,
          }
        : {
            extensions: mode === 'report' ? [task] : [],
            resolveRecoveryRunConfiguration: resolve,
          }),
    });
    service = await startService({
      runtime,
      subjectId: 'owner',
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
      buildId: 'original-recovery',
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        apiMajor: 1,
        profile: service.bootstrap.profile,
        requiredCapabilities: [
          'commands',
          mode === 'run' ? 'run_resume' : mode === 'report' ? 'job_report_resume' : 'job_reconcile',
        ],
      },
    });
    await client.connect();
    const expectedStoreId = before.metadata.storeId;
    const request =
      mode === 'run'
        ? client.resumeRun(sessionId, {
            expectedStoreId,
            commandId: 'recover',
            kind: 'run.resume',
            runId,
          })
        : mode === 'report'
          ? client.resumeJobReport(sessionId, reportId, { expectedStoreId, commandId: 'recover' })
          : client.reconcileJob(sessionId, {
              expectedStoreId,
              commandId: 'recover',
              kind: 'job.reconcile',
              executionId,
              expectedResultRevision: resultRevision,
            });
    const sdkError = await request.then(
      () => null,
      (error: unknown) =>
        error instanceof Error ? { code: 'code' in error ? error.code : null } : null,
    );
    if (!sdkError) throw Error('original explicit recovery unexpectedly succeeded');
    const after = await snapshot(store, sessionIds, commandIds);
    const recovery = await store.getCommand('recover');
    const closing = service.close(),
      sameClose = service.close() === closing;
    const error = await closing.then(
      () => null,
      (value: unknown) => value,
    );
    const runtimeError = await runtime.close().then(
      () => null,
      (value: unknown) => value,
    );
    const foreignStore = await openSqliteStore(profile);
    let foreignOwner: Awaited<ReturnType<Store['acquireSessionOwner']>> = null;
    try {
      foreignOwner = await foreignStore.acquireSessionOwner(sessionId, 'foreign-recovery-owner');
    } finally {
      await foreignStore.close();
    }
    const owner = await store.getSession(sessionId);
    if (!originalFiles) throw Error('original actual recovery directory owner missing');
    const fileContent = (await originalFiles.read('original.txt')).content;
    const cause =
      preparationError instanceof ConfigurationPreparationCleanupError
        ? preparationError.cause
        : undefined;
    const describe = (value: unknown) =>
      value instanceof Error ? { code: 'code' in value ? value.code : null } : null;
    retained = true;
    console.log(
      JSON.stringify({
        pid: process.pid,
        mode,
        seedExit,
        before,
        after,
        recovery,
        owner,
        foreignOwner,
        resolvers,
        attempts,
        modelCalls: model.requests.length,
        starts,
        queries,
        ledger: mode === 'report' ? '' : readFileSync(ledger, 'utf8'),
        sdkError,
        exactReceiver,
        typed: preparationError instanceof ConfigurationPreparationCleanupError,
        originalCode: cause?.originalError instanceof AgentError ? cause.originalError.code : null,
        originalCleanup: cause?.cleanupError === cleanupFailure,
        exactFiles: cause?.resources && Object.values(cause.resources).includes(originalFiles),
        fileBody,
        fileContent,
        sameClose,
        error: describe(error),
        runtimeError: describe(runtimeError),
        lifecycle: runtime.getLifecycleState(),
      }),
    );
  } catch (error) {
    console.error(error);
    terminalFailure = error;
  } finally {
    client?.disposeNetwork();
    try {
      await cleanupSeed();
    } catch (error) {
      console.error(error);
      terminalFailure = terminalFailure
        ? new AggregateError([terminalFailure, error], 'recovery and original seed cleanup failed')
        : error;
    }
    if (service && !retained)
      await service.close().catch((error) => {
        console.error(error);
        terminalFailure = terminalFailure
          ? new AggregateError([terminalFailure, error], 'recovery and Service cleanup failed')
          : error;
      });
  }
  if (terminalFailure) process.exit(1);
}

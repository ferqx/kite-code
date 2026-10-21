import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { humanInputInterpretation } from '../../../src/storage/sqlite/human-work-control';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';
import { AgentError } from '../../../src/storage/types';
import { binding, permissions } from './human-input-processing-crash-fixture';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} satisfies ModelEvent;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error('processing_race_boundary_timeout');
    await Bun.sleep(5);
  }
}
for (const boundary of [
  'business',
  'cancelled',
  'selection_changed',
  'unsealed',
  'forged_decision',
  'missing_business',
] as const)
  test(`pending readonly preparation after a durable decision: ${boundary}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-processing-decision-race-')));
    const actual = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
    const storeId = (await actual.getMetadata()).storeId;
    const base = { expectedStoreId: storeId, sessionId: 's', subjectId: 'owner' };
    const registered = gate(),
      route = gate(),
      preparing = gate(),
      prepare = gate();
    const failures: string[] = [];
    const requests: ModelRequest[] = [];
    let verifying = false;
    let proof:
      | { humanInputCommandId: string; decisionCommandId: string; businessCommandId: string }
      | undefined;
    const store = new Proxy(actual, {
      get(target, key) {
        if (key === 'getCommand')
          return async (id: string) => {
            const command = await target.getCommand(id);
            if (!verifying || !proof || !command) return command;
            if (boundary === 'unsealed' && id === proof.humanInputCommandId)
              return { ...command, receipt: { ...(command.receipt as object), state: 'pending' } };
            if (boundary === 'forged_decision' && id === proof.decisionCommandId)
              return {
                ...command,
                request: { ...(command.request as object), inputDigest: 'forged' },
              };
            if (boundary === 'missing_business' && id === proof.businessCommandId) return null;
            return command;
          };
        if (key === 'registerHumanCommand')
          return async (input: Parameters<Store['registerHumanCommand']>[0]) => {
            const command = await target.registerHumanCommand(input);
            registered.release();
            await route.promise;
            return command;
          };
        if (key === 'beginHumanInputProcessing')
          return async (input: Parameters<Store['beginHumanInputProcessing']>[0]) => {
            preparing.release();
            await prepare.promise;
            try {
              return await target.beginHumanInputProcessing(input);
            } catch (error) {
              failures.push(error instanceof AgentError ? error.code : 'unexpected_error');
              verifying = true;
              throw error;
            }
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const runtime = createRuntime({
      store,
      permissions,
      modelId: 'fixture',
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          actions: [
            {
              id: 'wake',
              version: '1',
              description: 'A finite ordinary Action wakes the existing Session pump',
              inputSchema: { type: 'object' },
              async prepare(input) {
                return input;
              },
              async execute() {
                return { outcome: 'succeeded', content: 'Exact Action completed' };
              },
            },
          ],
        },
      ],
      model: {
        async *stream(request) {
          requests.push(structuredClone(request));
          yield { type: 'text_delta', text: 'Exact ordinary business completed' };
          yield finish;
        },
      },
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'fixture',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        ...base,
        commandId: 'create',
        workspaceId: 'w',
        title: 'race',
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'A',
        request: { kind: 'run.start', content: 'A' },
      });
      await runtime.waitForCommand('A', { timeoutMs: 1000 });
      await until(async () => (await actual.getView('s')).runs.every((run) => !run.isActive));
      const submitting = runtime.submitCommand({
        ...base,
        commandId: 'B',
        request: { kind: 'run.start', content: 'New task: Independent B' },
      });
      await registered.promise;
      await runtime.submitCommand({
        ...base,
        commandId: 'wake',
        request: {
          kind: 'extension.invoke',
          extensionId: 'fixture',
          actionId: 'wake',
          definitionVersion: '1',
          input: {},
        },
      });
      await preparing.promise;
      route.release();
      const accepted = await submitting;
      const receipt = accepted.receipt as {
        humanInputCommandId: string;
        decisionCommandId: string;
        businessCommandId: string;
      };
      proof = receipt;
      expect(accepted.status).toBe('accepted');
      expect((await actual.getCommand(receipt.humanInputCommandId))?.receipt).toMatchObject({
        state: 'decided',
        decisionCommandId: receipt.decisionCommandId,
        businessCommandId: receipt.businessCommandId,
      });
      expect(await actual.getCommand(receipt.decisionCommandId)).toMatchObject({
        kind: 'human.input.decision',
        status: 'applied',
      });
      expect(await actual.getCommand(receipt.businessCommandId)).toMatchObject({
        status: 'accepted',
        receipt: { outcome: 'human_business_queued' },
      });
      if (boundary === 'cancelled')
        await actual.cancelCommand({ ...base, commandId: 'cancel', targetCommandId: 'B' });
      if (boundary === 'selection_changed') {
        await actual.selectContext({
          ...base,
          commandId: 'rewind',
          expectedContextSelectionId: (await actual.getSession('s'))!.contextSelectionId,
          boundary: null,
        });
        await actual.acceptCommand({
          ...base,
          commandId: 'after-rewind',
          request: {
            kind: 'extension.invoke',
            extensionId: 'fixture',
            actionId: 'wake',
            definitionVersion: '1',
            input: {},
          },
        });
      }
      prepare.release();
      if (boundary !== 'business') {
        const witness = boundary === 'selection_changed' ? 'after-rewind' : 'wake';
        await until(async () => 'dispatchFailure' in (await runtime.getCommand(witness))!);
        expect(await runtime.getCommand(witness)).toMatchObject({
          status: 'accepted',
          dispatchFailure: { code: 'input_processing_unavailable' },
        });
        expect(failures).toEqual(['input_processing_unavailable']);
        expect(requests).toHaveLength(1);
        expect((await actual.getView('s')).runs).toHaveLength(1);
        expect((await actual.getView('s')).runs.every((run) => !run.isActive)).toBe(true);
        return;
      }
      const applied = await runtime.waitForCommand('B', { timeoutMs: 1000 });
      await until(async () => (await actual.getView('s')).runs.every((run) => !run.isActive));
      expect(failures).toEqual(['input_processing_unavailable']);
      expect(applied.status).toBe('applied');
      const run = await actual.getRun((applied.receipt as { runId: string }).runId);
      expect(run).toMatchObject({
        originCommandId: receipt.businessCommandId,
        rootWorkCommandId: 'B',
        status: 'completed',
      });
      expect(requests).toHaveLength(2);
      expect(
        requests[1]!.messages.filter((message) => message.role === 'user').at(-1)?.content,
      ).toBe('New task: Independent B');
      expect(
        requests.every((request) =>
          request.messages.every(
            (message) => !message.content.includes('Original input identity:'),
          ),
        ),
      ).toBe(true);
      expect((await actual.getView('s')).runs).toHaveLength(2);
      expect('dispatchFailure' in (await runtime.getCommand('B'))!).toBe(false);
      expect((await runtime.waitForCommand('wake', { timeoutMs: 1000 })).status).toBe('applied');
    } finally {
      route.release();
      prepare.release();
      await runtime.close();
      await actual.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
test('idle progress interpretation rechecks current human selection after independent B is selected during its readonly Model', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-processing-race-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const storeId = (await store.getMetadata()).storeId,
    base = { expectedStoreId: storeId, sessionId: 's', subjectId: 'owner' };
  const entered = gate(),
    release = gate();
  const interpretations: ModelRequest[] = [];
  let businessB = 0;
  const model: ModelAdapter = {
    async *stream(request) {
      const instructions = request.messages.filter((m) =>
        m.content.includes('Original input identity:'),
      );
      if (instructions.length) {
        interpretations.push(structuredClone(request));
        expect(request.tools).toHaveLength(0);
        if (interpretations.length > 3) throw Error('repeated_stale_processing');
        if (interpretations.length === 1) {
          entered.release();
          await release.promise;
        }
        const instruction = instructions.at(-1)!;
        const identity = JSON.parse(
          instruction.content
            .split('\n')
            .find((line) => line.startsWith('Original input identity: '))!
            .slice('Original input identity: '.length),
        );
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            ...identity,
            relation: 'same_work',
            purpose: 'progress',
            target_root_work_command_id: 'A',
            selection_effect: 'keep',
            answer: 'A progress only; B stays selected.',
            clarification: null,
          }),
        };
        yield finish;
        return;
      }
      if (
        request.messages.filter((m) => m.role === 'user').at(-1)?.content ===
        '新任务：Independent B'
      )
        businessB++;
      yield { type: 'text_delta', text: 'Exact ordinary business completed' };
      yield finish;
    },
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixture',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'fixture',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'race' });
    await runtime.submitCommand({
      ...base,
      commandId: 'A',
      request: { kind: 'run.start', content: 'A' },
    });
    await runtime.waitForCommand('A');
    const progress = await runtime.submitCommand({
      ...base,
      commandId: 'progress',
      request: { kind: 'run.start', content: '请问 A 的进度怎样？' },
    });
    await entered.promise;
    const original = await store.readHumanWorkState(base);
    const processing = (await store.getView('s')).runs.find((run) => run.isActive)!;
    await runtime.submitCommand({
      ...base,
      commandId: 'B',
      request: { kind: 'run.start', content: '新任务：Independent B' },
    });
    const changed = await store.readHumanWorkState(base);
    expect(changed.selectedWork?.rootWorkCommandId).toBe('B');
    expect(changed.controlRevision).not.toBe(original.controlRevision);
    expect(businessB).toBe(0);
    expect(interpretations).toHaveLength(1);
    release.release();
    const observed = await runtime.waitForCommand('progress', { timeoutMs: 5000 });
    await runtime.waitForCommand('B', { timeoutMs: 5000 });
    await until(async () => (await store.getView('s')).runs.every((run) => !run.isActive));
    expect(observed.status).toBe('applied');
    expect(businessB).toBe(1);
    expect((await store.readHumanWorkState(base)).selectedWork?.rootWorkCommandId).toBe('B');
    expect(interpretations.length).toBeLessThanOrEqual(2);
    if (interpretations.length === 2) {
      const current = interpretations[1]!.messages.filter((m) =>
        m.content.includes('Original input identity:'),
      );
      expect(current).toHaveLength(1);
      expect(current[0]!.content).toContain(
        'Verified current selected work: {"rootWorkCommandId":"B"',
      );
      expect(current[0]!.content).toContain(
        `Verified human control revision: ${changed.controlRevision}`,
      );
    }
    expect((await store.getRun(processing.id))?.configuration).toEqual(processing.configuration);
    const rawId = (progress.receipt as { humanInputCommandId: string }).humanInputCommandId;
    expect((await store.getCommand(rawId))?.receipt).toMatchObject({ state: 'decided' });
    expect(
      (await store.listExecutions('s')).filter((execution) => execution.kind === 'tool'),
    ).toHaveLength(0);
  } finally {
    release.release();
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const window of ['progress', 'progress-race'] as const)
  test(`cold ${window}: original processing and refreshed interpretation both recover with their exact successful Model facts`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-processing-cold-race-')));
    writeFileSync(join(root, 'ledger'), '');
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./human-input-processing-crash-fixture.ts', import.meta.url)),
        root,
        window,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined,
      runtime: ReturnType<typeof createRuntime> | undefined;
    try {
      const reader = child.stdout.getReader();
      let output = '';
      try {
        while (!output.includes('\n')) {
          const next = await reader.read();
          if (next.done) throw Error('cold_race_child_exit');
          output += new TextDecoder().decode(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      const ready = JSON.parse(output.split('\n')[0]!) as {
        storeId: string;
        rawId: string;
        runId: string;
        generation: string;
        processingId: string;
      };
      child.kill('SIGKILL');
      expect(await child.exited).toBe(137);
      expect(child.signalCode).toBe('SIGKILL');
      expect(await new Response(child.stderr).text()).toBe('');
      const profile = { dataRoot: join(root, 'data'), profile: 'test' };
      store = await openSqliteStore(profile);
      const rawBefore = (await store.getCommand(ready.rawId))!;
      const runBefore = (await store.getRun(ready.runId))!;
      const modelBefore = (await store.listExecutions('s'))
        .reverse()
        .find((e) => e.runId === ready.runId && e.kind === 'model')!;
      expect(modelBefore.status).toBe('succeeded');
      const originalBinding = binding(root, true, 'progress');
      runtime = createRuntime({
        store,
        permissions,
        artifacts: createArtifactStore({ profile, store }),
        resolveRunConfiguration: async ({ command }) => {
          expect((command.request as { content: string }).content).toBe('新任务：Independent B');
          return binding(root, true);
        },
        resolveRecoveryRunConfiguration: async () => originalBinding,
      });
      const base = { expectedStoreId: ready.storeId, sessionId: 's', subjectId: 'owner' };
      if (window === 'progress')
        await runtime.submitCommand({
          ...base,
          commandId: 'B',
          request: { kind: 'run.start', content: '新任务：Independent B' },
        });
      expect((await store.readHumanWorkState(base)).selectedWork?.rootWorkCommandId).toBe('B');
      expect(
        readFileSync(join(root, 'ledger'), 'utf8')
          .split('\n')
          .filter((line) => line.startsWith('interpret:')),
      ).toHaveLength(window === 'progress' ? 1 : 2);
      if (window === 'progress')
        await until(async () => {
          const command = await runtime!.getCommand('B');
          return !!command && 'dispatchFailure' in command;
        });
      const session = (await store.getSession('s'))!;
      await runtime.resumeRun({
        ...base,
        commandId: 'resume',
        runId: ready.runId,
        expectedOwnerGeneration: session.ownerGeneration,
      });
      await runtime.waitForCommand('input', { timeoutMs: 5000 });
      await runtime.waitForCommand('B', { timeoutMs: 5000 });
      const currentStore = store;
      await until(async () => (await currentStore.getView('s')).runs.every((run) => !run.isActive));
      expect((await store.getRun(ready.runId))?.configuration).toEqual(runBefore.configuration);
      expect((await store.getRun(ready.runId))?.status).toBe('completed');
      expect(await store.getExecution(modelBefore.id)).toEqual(modelBefore);
      expect((await store.getCommand(ready.rawId))?.request).toEqual(rawBefore.request);
      expect((await store.getCommand(ready.rawId))?.receipt).toMatchObject({
        state: 'decided',
        processingCommandId: ready.processingId,
      });
      expect((await store.readHumanWorkState(base)).selectedWork?.rootWorkCommandId).toBe('B');
      const interpretations = (await store.listExecutions('s')).filter(
        (e) => e.runId === ready.runId && e.kind === 'model',
      );
      expect(interpretations).toHaveLength(2);
      expect(interpretations.every((e) => e.status === 'succeeded')).toBe(true);
      const ledger = readFileSync(join(root, 'ledger'), 'utf8').split('\n');
      expect(ledger.filter((line) => line.startsWith('interpret:'))).toHaveLength(2);
      expect(ledger.filter((line) => line.startsWith('effect:'))).toHaveLength(2);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      await runtime?.close();
      await store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

test('exact Continue sealed after pending interpretation preparation refreshes before dispatch', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-continue-interpretation-race-')));
  const actual = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const storeId = (await actual.getMetadata()).storeId;
  const base = { expectedStoreId: storeId, sessionId: 's', subjectId: 'owner' };
  const firstEntered = gate(),
    firstRelease = gate(),
    registered = gate(),
    route = gate(),
    prepared = gate(),
    dispatch = gate();
  let staleId: string | undefined;
  const requests: ModelRequest[] = [];
  const store = new Proxy(actual, {
    get(target, key) {
      if (key === 'registerHumanCommand')
        return async (input: Parameters<Store['registerHumanCommand']>[0]) => {
          const command = await target.registerHumanCommand(input);
          registered.release();
          await route.promise;
          return command;
        };
      if (key === 'markDispatching')
        return async (input: Parameters<Store['markDispatching']>[0]) => {
          const execution = await target.getExecution(input.executionId);
          if (
            !staleId &&
            execution?.kind === 'model' &&
            requests.length === 1 &&
            execution.input &&
            typeof execution.input === 'object' &&
            !Array.isArray(execution.input) &&
            Array.isArray(execution.input.messages) &&
            execution.input.messages.some(
              (message) =>
                message &&
                typeof message === 'object' &&
                !Array.isArray(message) &&
                typeof message.content === 'string' &&
                message.content.includes('Original input identity:'),
            )
          ) {
            staleId = execution.id;
            prepared.release();
            await dispatch.promise;
          }
          return target.markDispatching(input);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const runtime = createRuntime({
    store,
    permissions,
    modelId: 'exact-original',
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.unused',
            version: '1',
            description: 'Ordinary business capability',
            inputSchema: { type: 'object' },
            async execute() {
              throw Error('unused business tool must not run');
            },
          },
        ],
      },
    ],
    model: {
      async *stream(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          firstEntered.release();
          await firstRelease.promise;
        }
        yield {
          type: 'text_delta',
          text: 'Ordinary work completed at its actual safe checkpoint.',
        };
        yield finish;
      },
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'fixture',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'race' });
    await runtime.submitCommand({
      ...base,
      commandId: 'A',
      request: { kind: 'run.start', content: 'A' },
    });
    await firstEntered.promise;
    const originalRun = (await actual.getView('s')).runs[0]!;
    const submitting = runtime.submitCommand({
      ...base,
      commandId: 'continue-A',
      request: {
        kind: 'run.start',
        content: 'Continue A.\nFinish the ordinary work with its actual facts.',
      },
    });
    await registered.promise;
    firstRelease.release();
    await prepared.promise;
    expect((await actual.getExecution(staleId!))?.status).toBe('planned');
    route.release();
    const accepted = await submitting;
    const receipt = accepted.receipt as {
      humanInputCommandId: string;
      decisionCommandId: string;
      businessCommandId: string;
    };
    const rawBefore = (await actual.getCommand(receipt.humanInputCommandId))!;
    const decisionBefore = (await actual.getCommand(receipt.decisionCommandId))!;
    expect(rawBefore.receipt).toMatchObject({
      state: 'decided',
      decisionCommandId: receipt.decisionCommandId,
    });
    expect(decisionBefore.request).toMatchObject({
      proposal: {
        relation: 'same_work',
        purpose: 'continue',
        targetRootWorkCommandId: 'A',
        selectionEffect: 'select_work',
        basis: { kind: 'explicit_text' },
      },
    });
    expect(requests).toHaveLength(1);
    const database = new Database(join(root, 'data', 'test', 'core.db'), { readonly: true });
    try {
      const db = new SqliteOperations(database, false);
      const execution = db.row('SELECT * FROM execution WHERE id=?', staleId!)!;
      const source = JSON.parse(String(execution.decision_source_json));
      for (const invalid of [
        { ...execution, session_id: 'foreign-session' },
        { ...execution, origin_store_id: 'foreign-store' },
        {
          ...execution,
          decision_source_json: JSON.stringify({
            ...source,
            humanInputInterpretation: { ...source.humanInputInterpretation, inputDigest: 'wrong' },
          }),
        },
        {
          ...execution,
          decision_source_json: JSON.stringify({
            ...source,
            humanInputInterpretation: {
              ...source.humanInputInterpretation,
              inputCommandId: 'missing',
            },
          }),
        },
        { ...execution, decision_source_json: JSON.stringify({ ...source, toolBindings: [{}] }) },
      ])
        expect(() => humanInputInterpretation(db, invalid)).toThrow('input_proposal_unverifiable');
      for (const invalid of [
        'missing_decision',
        'forged_decision',
        'unsealed_input',
        'foreign_subject',
        'foreign_public',
      ] as const) {
        const invalidDb = new Proxy(db, {
          get(target, key) {
            if (key === 'row')
              return (
                sql: string,
                ...args: Parameters<SqliteOperations['row']> extends [string, ...infer Rest]
                  ? Rest
                  : never
              ) => {
                const row = target.row(sql, ...args);
                if (invalid === 'foreign_subject' && row?.id === execution.origin_command_id)
                  return { ...row, subject_id: 'foreign-subject' };
                if (invalid === 'foreign_public' && row?.id === 'continue-A')
                  return {
                    ...row,
                    receipt_json: JSON.stringify({
                      ...JSON.parse(String(row.receipt_json)),
                      decisionCommandId: 'foreign-decision',
                    }),
                  };
                if (args[0] === receipt.decisionCommandId) {
                  if (invalid === 'missing_decision') return null;
                  if (invalid === 'forged_decision' && row)
                    return {
                      ...row,
                      request_json: JSON.stringify({
                        ...JSON.parse(String(row.request_json)),
                        inputDigest: 'wrong',
                      }),
                    };
                }
                if (invalid === 'unsealed_input' && row?.id === receipt.humanInputCommandId)
                  return {
                    ...row,
                    receipt_json: JSON.stringify({
                      ...JSON.parse(String(row.receipt_json)),
                      decisionCommandId: null,
                    }),
                  };
                return row;
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        expect(() => humanInputInterpretation(invalidDb, execution)).toThrow(
          'input_proposal_unverifiable',
        );
      }
      expect(() => humanInputInterpretation(db, execution)).toThrow('context_refresh_required');
    } finally {
      database.close();
    }
    dispatch.release();
    await until(async () => !(await actual.getRun(originalRun.id))!.isActive);
    expect((await actual.getRun(originalRun.id))?.status).toBe('completed');
    await runtime.waitForCommand('continue-A', { timeoutMs: 1000 });
    await until(
      async () =>
        (await actual.getView('s')).runs.length === 2 &&
        (await actual.getView('s')).runs.every((run) => !run.isActive),
    );
    const evidence = new Database(join(root, 'data', 'test', 'core.db'), { readonly: true });
    try {
      expect(evidence.query('SELECT dispatched FROM execution WHERE id=?').get(staleId!)).toEqual({
        dispatched: 0,
      });
    } finally {
      evidence.close();
    }
    expect((await actual.getExecution(staleId!))?.result).toMatchObject({
      code: 'context_refresh_required',
      incomplete: true,
    });
    expect(requests).toHaveLength(3);
    expect(
      requests.every(
        (request) =>
          request.tools.length === 1 &&
          request.messages.every(
            (message) => !message.content.includes('Original input identity:'),
          ),
      ),
    ).toBe(true);
    expect((await actual.getCommand(receipt.humanInputCommandId))?.request).toEqual(
      rawBefore.request,
    );
    expect(await actual.getCommand(receipt.decisionCommandId)).toEqual(decisionBefore);
    expect((await actual.readHumanWorkState(base)).selectedWork?.rootWorkCommandId).toBe('A');
    const view = await actual.getView('s');
    expect(
      view.runs.every(
        (run) =>
          run.status === 'completed' &&
          run.rootWorkCommandId === 'A' &&
          run.configuration &&
          JSON.stringify(run.configuration) === JSON.stringify(originalRun.configuration),
      ),
    ).toBe(true);
    expect(view.executions.filter((row) => row.kind === 'tool')).toHaveLength(0);
    expect((await actual.getCommand(receipt.businessCommandId))?.status).toBe('applied');
  } finally {
    firstRelease.release();
    route.release();
    dispatch.release();
    await runtime.close();
    await actual.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const closing of ['completed', 'cancelled', 'provider_claimed', 'preflight_claimed'] as const)
  test(`sealed exact pause closes its independent readonly processing Run: ${closing}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-readonly-pause-race-')));
    const actual = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
    const expectedStoreId = (await actual.getMetadata()).storeId;
    const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    const registered = gate(),
      prepared = gate(),
      decision = gate();
    let originalHeld = false,
      modelHeld = false;
    let rawId: string | undefined, processingRunId: string | undefined;
    const requests: ModelRequest[] = [];
    let wakeCalls = 0,
      wakeDuringProcessing = false;
    const store = new Proxy(actual, {
      get(target, key) {
        if (key === 'finishRun')
          return async (input: Parameters<Store['finishRun']>[0]) => {
            if (
              input.runId === processingRunId &&
              input.status === 'completed' &&
              closing === 'cancelled'
            ) {
              const processing = (await target.getRun(input.runId))!;
              await target.cancelCommand({
                ...base,
                commandId: 'cancel-processing-before-finish',
                targetCommandId: processing.originCommandId,
              });
            }
            const result = await target.finishRun(input);
            if (!originalHeld && result.originCommandId === 'A') {
              originalHeld = true;
              await registered.promise;
            }
            return result;
          };
        if (key === 'registerHumanCommand')
          return async (input: Parameters<Store['registerHumanCommand']>[0]) => {
            const result = await target.registerHumanCommand(input);
            if (input.commandId === 'pause-A') {
              rawId = (result.receipt as { humanInputCommandId: string }).humanInputCommandId;
              registered.release();
              await prepared.promise;
            }
            return result;
          };
        if (key === 'decideHumanInput')
          return async (input: Parameters<Store['decideHumanInput']>[0]) => {
            const result = await target.decideHumanInput(input);
            if (input.inputCommandId === rawId) decision.release();
            return result;
          };
        if (key === 'planExecution')
          return async (input: Parameters<Store['planExecution']>[0]) => {
            const result = await target.planExecution(input);
            if (
              !modelHeld &&
              input.kind === 'model' &&
              rawId &&
              (input.decisionSource as { humanInputInterpretation?: { inputCommandId: string } })
                .humanInputInterpretation?.inputCommandId === rawId
            ) {
              modelHeld = true;
              processingRunId = result.runId!;
              if (closing !== 'provider_claimed') {
                prepared.release();
                await decision.promise;
              }
            }
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const runtime = createRuntime({
      store,
      permissions: {
        ...permissions,
        async authorize(request) {
          const execution = await actual.getExecution(request.executionId);
          if (
            closing === 'preflight_claimed' &&
            request.kind === 'model' &&
            execution?.runId === processingRunId
          )
            throw new AgentError('input_processing_decided');
          return permissions.authorize();
        },
      },
      modelId: 'original-model',
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          actions: [
            {
              id: 'wake',
              version: '1',
              description: 'Finite ordinary Action wakes the root pump',
              inputSchema: { type: 'object' },
              async prepare(input) {
                return input;
              },
              async execute() {
                wakeCalls++;
                wakeDuringProcessing = (await actual.getView('s')).runs.some(
                  (run) => run.id === processingRunId && run.isActive,
                );
                return {
                  outcome: 'succeeded',
                  content: 'Ordinary wake completed outside input processing',
                };
              },
            },
          ],
        },
      ],
      model: {
        async *stream(request) {
          requests.push(structuredClone(request));
          if (
            request.messages.some((message) => message.content.includes('Original input identity:'))
          ) {
            if (closing === 'provider_claimed') {
              prepared.release();
              await decision.promise;
              throw new AgentError('input_processing_decided');
            }
            throw Error('sealed pause must never reach Provider');
          }
          yield { type: 'text_delta', text: 'Ordinary A completed.' };
          yield finish;
        },
      },
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'fixture',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        ...base,
        commandId: 'create',
        workspaceId: 'w',
        title: 'race',
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'A',
        request: { kind: 'run.start', content: 'A' },
      });
      await runtime.waitForCommand('A', { timeoutMs: 1000 });
      const original = (await actual.getView('s')).runs[0]!;
      const submitting = runtime.submitCommand({
        ...base,
        commandId: 'pause-A',
        request: { kind: 'run.start', content: 'Pause A.' },
      });
      await registered.promise;
      await runtime.submitCommand({
        ...base,
        commandId: 'wake',
        request: {
          kind: 'extension.invoke',
          extensionId: 'fixture',
          actionId: 'wake',
          definitionVersion: '1',
          input: {},
        },
      });
      await prepared.promise;
      const paused = await submitting;
      const receipt = paused.receipt as { decisionCommandId: string };
      const rawBefore = (await actual.getCommand(rawId!))!;
      const decisionBefore = (await actual.getCommand(receipt.decisionCommandId))!;
      expect(decisionBefore.request).toMatchObject({
        proposal: {
          relation: 'same_work',
          purpose: 'pause',
          targetRootWorkCommandId: 'A',
          basis: { kind: 'explicit_text' },
        },
      });
      await until(async () => {
        const run = await actual.getRun(processingRunId!);
        const models = (await actual.listExecutions('s')).filter(
          (execution) => execution.runId === processingRunId && execution.kind === 'model',
        );
        return Boolean(run && (!run.isActive || models.length >= 2));
      });
      const settled = (await actual.getRun(processingRunId!))!;
      expect(settled.status).toBe(
        closing === 'completed' || closing === 'cancelled' ? closing : 'failed',
      );
      expect(settled.isActive).toBe(false);
      expect(requests).toHaveLength(closing === 'provider_claimed' ? 2 : 1);
      const processingModels = (await actual.listExecutions('s')).filter(
        (execution) => execution.runId === processingRunId,
      );
      expect(processingModels).toHaveLength(1);
      expect(processingModels[0]).toMatchObject({
        kind: 'model',
        status: 'failed',
        result: { code: 'input_processing_decided', incomplete: true },
      });
      expect((processingModels[0]!.input as { tools: unknown[] }).tools).toHaveLength(0);
      const dispatchProof = (processingModels[0]!.result as { dispatchCommitted?: boolean })
        .dispatchCommitted;
      expect(dispatchProof).toBe(closing.endsWith('_claimed') ? undefined : false);
      const database = new Database(join(root, 'data', 'test', 'core.db'), { readonly: true });
      try {
        expect(
          database
            .query('SELECT dispatched FROM execution WHERE id=?')
            .get(processingModels[0]!.id),
        ).toEqual({ dispatched: closing === 'provider_claimed' ? 1 : 0 });
      } finally {
        database.close();
      }
      expect((await actual.getCommand(rawId!))?.request).toEqual(rawBefore.request);
      expect(await actual.getCommand(receipt.decisionCommandId)).toEqual(decisionBefore);
      if (closing !== 'completed') {
        expect((await actual.getRun(original.id))?.status).toBe('completed');
        expect((await actual.getView('s')).runs.every((run) => !run.isActive)).toBe(true);
        return;
      }
      await runtime.submitCommand({
        ...base,
        commandId: 'continue-A',
        request: { kind: 'run.start', content: 'Continue A.' },
      });
      expect((await runtime.waitForCommand('continue-A', { timeoutMs: 1000 })).status).toBe(
        'applied',
      );
      await until(async () => (await actual.getView('s')).runs.every((run) => !run.isActive));
      expect(requests).toHaveLength(2);
      expect((await actual.readHumanWorkState(base)).selectedWork?.rootWorkCommandId).toBe('A');
      const aRuns = (await actual.getView('s')).runs.filter((run) => run.rootWorkCommandId === 'A');
      expect(aRuns).toHaveLength(2);
      expect(
        aRuns.every(
          (run) =>
            run.status === 'completed' &&
            JSON.stringify(run.configuration) === JSON.stringify(original.configuration),
        ),
      ).toBe(true);
      expect((await actual.getRun(processingRunId!))?.configuration).toEqual(settled.configuration);
      expect((await runtime.waitForCommand('wake', { timeoutMs: 1000 })).status).toBe('applied');
      expect(wakeCalls).toBe(1);
      expect(wakeDuringProcessing).toBe(false);
    } finally {
      registered.release();
      prepared.release();
      decision.release();
      await runtime.close();
      await actual.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

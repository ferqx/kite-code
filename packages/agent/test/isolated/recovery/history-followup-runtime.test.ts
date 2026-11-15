import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactStore } from '../../../src/artifacts';
import { artifactPath } from '../../../src/artifacts-files';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { AgentError } from '../../../src/storage/types';
import { historyBinding } from './history-followup-fixture';

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error('history_followup_deadline');
    await Bun.sleep(5);
  }
}

async function forceChild(
  child: Pick<ReturnType<typeof Bun.spawn>, 'pid' | 'exitCode' | 'kill' | 'exited' | 'signalCode'>,
) {
  assert.equal(child.exitCode, null, 'original held child must be alive');
  process.kill(child.pid, 0);
  if (process.platform === 'win32') {
    const dispatched = Bun.spawnSync(['taskkill.exe', '/pid', String(child.pid), '/f'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(dispatched.exitCode, 0, 'native termination of original child failed');
  } else child.kill('SIGKILL');
  const code = await child.exited;
  if (process.platform !== 'win32') assert.equal(child.signalCode, 'SIGKILL');
  else assert.notEqual(code, 0);
  assert.throws(
    () => process.kill(child.pid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
  );
}

for (const scenario of [
  'no planned Tools',
  'one planned Tool',
  'explicit recovery',
  'inline bad arguments',
  'sealed bad arguments and explicit recovery',
  'denial before stop',
  'stop before denial',
] as const) {
  test(`SIGKILL after durable user stop with ${scenario} pairs the first same-session SDK request`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kite-stopped-history-'));
    const profile = { dataRoot: join(directory, 'data'), profile: 'owned' };
    const malformed = scenario.includes('bad arguments');
    const approval = scenario === 'denial before stop' || scenario === 'stop before denial';
    const mixed = malformed || approval;
    const sealed = scenario === 'no planned Tools' || scenario.startsWith('sealed');
    const ids = mixed ? ['z-first', 'm-done', 'a-unplanned'] : ['original-one', 'original-two'];
    const stopped = '用户停止了上一轮，此工具未执行';
    const denied =
      'The user denied this request. It was not executed. Do not resubmit it or bypass the refusal.';
    const bodies: {
      messages: {
        role: string;
        tool_call_id?: string;
        tool_calls?: { id: string }[];
        content?: string;
      }[];
    }[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        bodies.push((await request.json()) as (typeof bodies)[number]);
        const followup = bodies.length > 1;
        const fragment = followup
          ? { content: 'Follow-up saw both original receipts.' }
          : {
              tool_calls: ids.map((id, index) => ({
                index,
                id,
                type: 'function',
                function: {
                  name: 'fixture.effect',
                  arguments:
                    malformed && id === 'z-first'
                      ? '{'
                      : JSON.stringify({
                          value: sealed && id !== 'm-done' ? '原始参数'.repeat(16_000) : id,
                        }),
                },
              })),
            };
        const chunk = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          `${chunk(fragment, null)}${chunk({}, followup ? 'stop' : 'tool_calls')}data: [DONE]\n\n`,
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        );
      },
    });
    const baseURL = `${server.url.href}v1`;
    const mode = malformed
      ? 'stop-bad-arguments'
      : scenario === 'denial before stop'
        ? 'deny-then-stop'
        : scenario === 'stop before denial'
          ? 'stop-then-deny'
          : scenario === 'one planned Tool'
            ? 'stop-mixed'
            : 'stop-before-planning';
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./history-followup-crash-child.ts', import.meta.url)),
        directory,
        baseURL,
        mode,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    let store: Store | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    try {
      await until(() => existsSync(join(directory, 'ready.json')));
      const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as {
        expectedStoreId: string;
        expectedOwnerGeneration: string;
        runId: string;
        stopApplied: boolean;
      };
      expect(ready.stopApplied).toBe(true);
      await forceChild(child);
      store = await openSqliteStore(profile);
      const identity = {
        sessionId: 's',
        subjectId: 'owner',
        expectedStoreId: ready.expectedStoreId,
      };
      expect(await store.getCommand('stop')).toMatchObject({ status: 'applied' });
      if (approval)
        expect(await store.getCommand('deny')).toMatchObject({
          status: 'applied',
          receipt: { outcome: 'answer_saved', cancelled: scenario === 'stop before denial' },
        });
      expect(await store.getRun(ready.runId)).toMatchObject({ isActive: true });
      const before = (await store.listExecutions('s')).filter((item) => item.kind === 'tool');
      expect(before.map((item) => item.callId).sort()).toEqual(
        mixed ? ['m-done', 'z-first'] : scenario === 'one planned Tool' ? ['original-one'] : [],
      );
      if (mixed) {
        expect(before.find((item) => item.callId === 'z-first')).toMatchObject({
          status: 'planned',
          authorization: { dispatched: false },
          ...(malformed ? { input: null } : {}),
        });
        expect(before.find((item) => item.callId === 'm-done')).toMatchObject({
          status: 'succeeded',
          authorization: { dispatched: true },
        });
        expect(
          (await store.listMessages('s'))
            .filter((item) => item.role === 'tool')
            .map((item) => item.toolCallId),
        ).toEqual(['m-done']);
      }
      const assistant = (await store.listMessages('s')).find((item) => item.role === 'assistant');
      expect(assistant?.modelOutput?.toolCallCount ?? assistant?.toolCalls?.length).toBe(
        ids.length,
      );
      if (sealed) expect(assistant?.modelOutput?.complete).toBe(true);
      else expect(assistant?.toolCalls?.map((item) => item.id)).toEqual(ids);
      expect(bodies).toHaveLength(1);
      runtime = createRuntime({
        store,
        artifacts: createArtifactStore({ profile, store }),
        ...historyBinding(directory, baseURL),
      });
      if (malformed) {
        const original = await runtime.readModelOutput({
          ...identity,
          executionId: assistant!.sourceIds![0]!,
        });
        expect(original.output.toolCalls.map(({ id }) => id)).toEqual(ids);
        expect(original.output.toolCalls[0]?.arguments).toBe('{');
      }
      if (scenario === 'explicit recovery' || (sealed && malformed))
        await runtime.recoverSession({
          ...identity,
          decision: 'interrupt',
          commandId: 'recover',
          expectedOwnerGeneration: ready.expectedOwnerGeneration,
        });
      const input = {
        ...identity,
        commandId: 'next',
        request: { kind: 'run.start' as const, content: 'Continue with the saved results' },
      };
      await runtime.submitCommand(input);
      const next = await runtime.waitForCommand('next', { timeoutMs: 5000 });
      expect(await store.getRun((next.receipt as { runId: string }).runId)).toMatchObject({
        status: 'completed',
      });
      expect(bodies).toHaveLength(2);
      expect(
        bodies[1]!.messages.flatMap((item) => item.tool_calls?.map((call) => call.id) ?? []),
      ).toEqual(ids);
      const outputs = bodies[1]!.messages.filter((item) => item.role === 'tool');
      expect(outputs.map((item) => [item.tool_call_id, item.content])).toEqual(
        ids.map((id) => [
          id,
          id === 'm-done'
            ? 'followup-effect-once'
            : id === 'z-first' && scenario === 'denial before stop'
              ? denied
              : stopped,
        ]),
      );
      if (scenario === 'denial before stop')
        expect(
          await store.getExecution(before.find((item) => item.callId === 'z-first')!.id),
        ).toMatchObject({
          status: 'failed',
          result: { content: 'approval_denied', details: { code: 'approval_denied' } },
        });
      expect(bodies[1]!.messages.at(-1)?.content).toBe('Continue with the saved results');
      await runtime.cancelCommand({ ...identity, commandId: 'stop', targetCommandId: 'work' });
      await runtime.submitCommand(input);
      expect((await store.listMessages('s')).filter((item) => item.role === 'tool')).toHaveLength(
        ids.length,
      );
      expect(bodies).toHaveLength(2);
      if (mixed) expect(readFileSync(join(directory, 'effects'), 'utf8')).toBe('m-done\n');
      else expect(existsSync(join(directory, 'effects'))).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) await forceChild(child);
      if (runtime) await runtime.close();
      else await store?.close();
      server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
}

for (const mode of [
  'inline',
  'sealed',
  'reconciled',
  'direct',
  'direct_sealed',
  'direct_retry',
  'direct_retry_sealed',
  'direct_auto',
  'direct_auto_sealed',
  'direct_auto_followup',
  'direct_auto_followup_sealed',
  'direct_auto_retry',
  'direct_auto_retry_sealed',
  'direct_auto_hot',
  'direct_auto_handoff',
  'direct_auto_lost_receipt',
  'direct_auto_steer',
  'direct_auto_steer_sealed',
  'direct_auto_steer_followup',
] as const)
  test(`actual SIGKILL ${mode} Model output interrupt preserves original call history for same Session SDK followup`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kite-history-followup-'));
    const bodies: {
      messages: {
        role: string;
        tool_call_id?: string;
        content: string;
        tool_calls?: { id: string; function: { arguments: string } }[];
      }[];
    }[] = [];
    const original = mode.endsWith('sealed') ? '原始大正文'.repeat(16000) : 'original';
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as (typeof bodies)[number];
        bodies.push(body);
        const finished = body.messages.at(-1)?.role === 'tool';
        const delta = finished
          ? { content: 'SAME_SESSION_DONE' }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: bodies.length === 1 ? 'original-call' : 'followup-call',
                  type: 'function',
                  function: {
                    name: 'fixture.effect',
                    arguments: JSON.stringify({
                      value: bodies.length === 1 ? original : 'followup',
                    }),
                  },
                },
              ],
            };
        const chunk = (delta: unknown, reason: string | null) =>
          `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
        return new Response(
          chunk(delta, null) + chunk({}, finished ? 'stop' : 'tool_calls') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const baseURL = `${server.url.href}v1`;
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./history-followup-crash-child.ts', import.meta.url)),
        directory,
        baseURL,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const forceOriginalChild = () => forceChild(child);
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    try {
      await until(() => existsSync(join(directory, 'ready.json')));
      const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8'));
      const profile = { dataRoot: join(directory, 'data'), profile: 'owned' };
      if (mode === 'direct_auto_hot') {
        const hotStore = await openSqliteStore(profile);
        const hot = createRuntime({ store: hotStore, ...historyBinding(directory, baseURL) });
        try {
          const before = await hotStore.getSession('s');
          const active = (await hot.getView('s')).runs.find((run) => run.isActive)!;
          const steered = await hot.submitCommand({
            expectedStoreId: ready.expectedStoreId,
            commandId: 'hot-steer',
            sessionId: 's',
            subjectId: 'owner',
            request: {
              kind: 'input.steer',
              content: 'Keep steering only the original live task',
              targetRunId: active.id,
              contextSelectionId: before!.contextSelectionId,
            },
          });
          expect(steered.status).toBe('accepted');
          expect((await hotStore.getRun(active.id))!.isActive).toBe(true);
          await hot.submitCommand({
            expectedStoreId: ready.expectedStoreId,
            commandId: 'next',
            sessionId: 's',
            subjectId: 'owner',
            request: { kind: 'run.start', content: 'New task: New explicit input' },
          });
          expect((await hotStore.getSession('s'))!.ownerGeneration).toBe(before!.ownerGeneration);
          expect((await hotStore.getExecution(ready.executionId))!.status).toBe('planned');
          const cursor = (await hotStore.getMetadata()).lastChangeCursor;
          expect((await hot.getView('s')).runs.some((run) => run.isActive)).toBe(true);
          await hot.getView('s');
          expect((await hotStore.getMetadata()).lastChangeCursor).toBe(cursor);
          expect(bodies).toHaveLength(1);
        } finally {
          await hot.close();
        }
      }
      await forceOriginalChild();
      store = await openSqliteStore(profile);
      const input = {
        ...ready,
        commandId: 'interrupt',
        sessionId: 's',
        subjectId: 'owner',
        decision: 'interrupt' as const,
      };
      delete input.executionId;
      if (mode.startsWith('direct_retry'))
        await store.acceptCommand({
          expectedStoreId: ready.expectedStoreId,
          commandId: 'next',
          sessionId: 's',
          subjectId: 'owner',
          request: { kind: 'run.start', content: 'New task: New explicit input' },
        });
      if (mode === 'reconciled' || (mode.startsWith('direct') && !mode.startsWith('direct_auto'))) {
        const result = await store.reconcileSession({ ...input, commandId: 'observe' });
        input.expectedOwnerGeneration = result.report!.generation;
        expect(result.report!.cancelledExecutionIds).toEqual([ready.executionId]);
        expect((await store.getExecution(ready.executionId))?.status).toBe('cancelled');
        expect((await store.listMessages('s')).some((message) => message.role === 'tool')).toBe(
          false,
        );
      }
      const histories = await store.readRecoveryToolHistory(input);
      expect(histories).toHaveLength(1);
      expect(histories[0]!.modelOutput !== null).toBe(mode.endsWith('sealed'));
      let reconciliations = 0;
      const observedStore = new Proxy(store, {
        get(target, key) {
          if (key === 'reconcileSession')
            return async (input: Parameters<Store['reconcileSession']>[0]) => {
              reconciliations++;
              if (mode === 'direct_auto_handoff' && reconciliations === 1)
                throw new AgentError('owner_changed');
              const result = await target.reconcileSession(input);
              if (mode === 'direct_auto_lost_receipt' && reconciliations === 1)
                throw new Error('original_reconciliation_response_lost');
              return result;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const artifacts = createArtifactStore({ profile, store });
      runtime = createRuntime({
        store: observedStore,
        artifacts,
        ...historyBinding(directory, baseURL),
      });
      if (mode.startsWith('direct')) {
        const request = mode.includes('followup')
          ? {
              kind: 'input.follow_up' as const,
              content: 'New task: New explicit input',
              afterRunId: histories[0]!.runId,
              contextSelectionId: (await store.getSession('s'))!.contextSelectionId,
            }
          : { kind: 'run.start' as const, content: 'New task: New explicit input' };
        const nextInput = {
          expectedStoreId: ready.expectedStoreId,
          commandId: 'next',
          sessionId: 's',
          subjectId: 'owner',
          request,
        };
        // No explicit reconciliation, client lifecycle call or manual recovery is
        // involved in the automatic cases, including an already durable input.
        if (mode.startsWith('direct_auto_retry')) await store.acceptCommand(nextInput);
        const beforeConflict = (await store.getMetadata()).lastChangeCursor;
        const conflict = await runtime
          .submitCommand({ ...nextInput, commandId: 'work' })
          .catch((error) => error);
        expect(conflict.code).toBe('command_conflict');
        expect((await store.getMetadata()).lastChangeCursor).toBe(beforeConflict);
        if (mode === 'direct_auto_followup') {
          for (const invalid of [
            { ...nextInput, request: { ...request, afterRunId: 'not-the-original-run' } },
            { ...nextInput, request: { ...request, contextSelectionId: 'not-selected' } },
            { ...nextInput, subjectId: 'not-the-creator' },
          ]) {
            const error = await runtime.submitCommand(invalid).catch((error) => error);
            expect(error).toBeInstanceOf(AgentError);
            expect((await store.getMetadata()).lastChangeCursor).toBe(beforeConflict);
            expect((await store.getExecution(ready.executionId))!.status).toBe('planned');
          }
        }
        if (mode === 'direct_auto_lost_receipt') {
          const lost = await runtime.submitCommand(nextInput).catch((error) => error);
          expect(lost.message).toBe('original_reconciliation_response_lost');
          expect(await store.getCommand('next')).toBeNull();
        }
        if (mode.startsWith('direct_auto_steer')) {
          const originalRun = histories[0]!.runId;
          const stopped = await runtime
            .submitCommand({
              expectedStoreId: ready.expectedStoreId,
              commandId: 'stale-steer',
              sessionId: 's',
              subjectId: 'owner',
              request: {
                kind: 'input.steer',
                content: 'A steer made from the old client snapshot',
                targetRunId: originalRun,
                contextSelectionId: (await store.getSession('s'))!.contextSelectionId,
              },
            })
            .catch((error) => error);
          expect(stopped.code).toBe('input_target_stopped');
          expect(await store.getCommand('stale-steer')).toBeNull();
          expect(await store.getRun(originalRun)).toMatchObject({
            isActive: false,
            status: 'interrupted',
          });
          expect((await store.getExecution(ready.executionId))!.status).toBe('cancelled');
          expect((await store.listMessages('s')).some((message) => message.role === 'tool')).toBe(
            false,
          );
          expect(bodies).toHaveLength(1);
        }
        await runtime.submitCommand(nextInput);
        if (mode === 'direct_auto_handoff' || mode === 'direct_auto_lost_receipt')
          expect(reconciliations).toBe(2);
        await until(async () => {
          const saved = await runtime!.getCommand('next');
          if (saved?.status !== 'applied') return false;
          const runId = (saved.receipt as { runId: string }).runId;
          const run = await store!.getRun(runId);
          return !!run && !run.isActive;
        });
        const command = (await runtime.getCommand('next'))!;
        const run = await store.getRun((command.receipt as { runId: string }).runId);

        expect(run?.status).toBe('completed');
        expect((await store.getExecution(ready.executionId))?.status).toBe('cancelled');
        expect(readFileSync(join(directory, 'effects'), 'utf8')).toBe('followup\n');
        expect(
          (await store.listMessages('s')).filter(
            (message) => message.role === 'tool' && message.sourceIds?.includes(ready.executionId),
          ),
        ).toHaveLength(1);
        const cursor = (await store.getMetadata()).lastChangeCursor;
        const providerCount = bodies.length;
        expect(await runtime.submitCommand(nextInput)).toEqual(command);
        expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
        expect(bodies).toHaveLength(providerCount);
        const resumeError = await store
          .verifyRunResume({
            ...input,
            commandId: 'too-late',
            runId: histories[0]!.runId,
            expectedOwnerGeneration: (await store.getSession('s'))!.ownerGeneration,
          })
          .catch((error) => error);
        expect(resumeError.code).toBe('run_not_active');
        for (const body of bodies.slice(1)) {
          const returned = new Set(
            body.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id),
          );
          expect(
            body.messages.flatMap((m) => m.tool_calls ?? []).every((call) => returned.has(call.id)),
          ).toBe(true);
        }
        return;
      }
      let fullReads = 0;
      const read = runtime.readModelOutput.bind(runtime);
      runtime.readModelOutput = async (...args) => {
        fullReads++;
        return read(...args);
      };
      if (mode.endsWith('sealed')) {
        const hash = histories[0]!.modelOutput!.head.hash;
        const path = artifactPath(join(profile.dataRoot, profile.profile), hash);
        const diskBytes = process.platform === 'win32' ? undefined : readFileSync(path);
        const readReference = artifacts.readReference;
        const cursor = (await store.getMetadata()).lastChangeCursor;
        try {
          if (diskBytes) {
            chmodSync(path, 0o600);
            const broken = Buffer.from(diskBytes);
            broken[0] = broken[0]! ^ 1;
            writeFileSync(path, broken);
            chmodSync(path, 0o400);
          } else {
            // Windows protects the sealed blob's ACL. Inject a wrong read in this fixture.
            artifacts.readReference = async (input) => {
              const bytes = await readReference.call(artifacts, input);
              if (input.reference.hash !== hash) return bytes;
              const broken = Buffer.from(bytes);
              broken[0] = broken[0]! ^ 1;
              return broken;
            };
          }
          let error: unknown;
          try {
            await runtime.recoverSession(input);
          } catch (caught) {
            error = caught;
          }
          expect(error).toBeDefined();
          if (!diskBytes) expect(error).toMatchObject({ code: 'model_body_invalid' });
          expect(await store.getCommand('interrupt')).toBeNull();
          expect((await store.getExecution(ready.executionId))?.status).toBe('planned');
          expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
          expect((await store.listMessages('s')).some((message) => message.role === 'tool')).toBe(
            false,
          );
        } finally {
          if (diskBytes) {
            chmodSync(path, 0o600);
            writeFileSync(path, diskBytes);
            chmodSync(path, 0o400);
          } else artifacts.readReference = readReference;
        }
      }
      // Caller-supplied proof is discarded. Only Runtime's full original reader produces it.
      const report = await runtime.recoverSession({
        ...input,
        toolHistoryProofs: [{ executionId: 'foreign', bindingDigest: 'fake' }],
      });
      expect(report.cancelledExecutionIds).toEqual([ready.executionId]);
      expect(report.unknownExecutionIds).toEqual([]);
      const cursor = (await store.getMetadata()).lastChangeCursor;
      const reads = fullReads;
      expect(await runtime.recoverSession(input)).toEqual(report);
      expect(fullReads).toBe(reads);
      expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(bodies).toHaveLength(1);
      await runtime.submitCommand({
        expectedStoreId: ready.expectedStoreId,
        commandId: 'next',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'New task: New explicit input' },
      });
      await until(async () => {
        const saved = await runtime!.getCommand('next');
        if (saved?.status !== 'applied') return false;
        const runId = (saved.receipt as { runId: string }).runId;
        return (await store!.getRun(runId))?.status === 'completed';
      });
      const next = (await runtime.getCommand('next'))!;
      const receipt = next.receipt as { runId: string; businessCommandId: string };
      const business = next;
      expect(business?.receipt).toMatchObject({ runId: receipt.runId });
      expect(await store.getRun(receipt.runId)).toMatchObject({
        originCommandId: business!.id,
        rootWorkCommandId: 'next',
      });
      expect(bodies).toHaveLength(3);
      const oldCall = bodies[1]!.messages.find((message) => message.role === 'assistant')!;
      expect(JSON.parse(oldCall.tool_calls![0]!.function.arguments)).toEqual({ value: original });
      expect(bodies[1]!.messages.find((message) => message.role === 'tool')).toMatchObject({
        tool_call_id: 'original-call',
      });
      expect(bodies[1]!.messages.find((message) => message.role === 'tool')!.content).toContain(
        'recovery_cancelled_unstarted',
      );
      expect(readFileSync(join(directory, 'effects'), 'utf8')).toBe('followup\n');
      expect((await store.getExecution(ready.executionId))?.status).toBe('cancelled');
    } finally {
      if (child.exitCode === null && child.signalCode === null) await forceOriginalChild();
      else await child.exited;
      if (runtime) await runtime.close();
      else await store?.close();
      server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20000);

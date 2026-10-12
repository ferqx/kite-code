import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createProfileBackup } from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';

async function within<T>(work: Promise<T>, milliseconds: number, phase: string): Promise<T> {
  if (milliseconds <= 0) {
    void work.catch(() => {});
    throw Error(`owned fixture deadline: ${phase}`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(`owned fixture deadline: ${phase}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Store = Awaited<ReturnType<typeof openSqliteStore>>;
interface Receipt {
  pid: number;
  input: string;
  parserOutput: { title: string; content: string };
  originalThread: unknown;
  parserInputs: number;
  terminationAttempts: number;
  modelCalls: number;
  sameClose: boolean;
  metadata: Awaited<ReturnType<Store['getMetadata']>>;
  storedView: Awaited<ReturnType<Store['getView']>>;
  command: Awaited<ReturnType<Store['getCommand']>>;
  messages: Awaited<ReturnType<Store['listMessages']>>;
  execution: Awaited<ReturnType<Store['getExecution']>>;
  lifecycle: { state: string };
  runtimeError: { code: string; message: string } | null;
  error: { code: string; message: string } | null;
}

// Real default parser and formal Service Run assembly. Only the owned fixture
// child's JavaScript terminate method fails; this does not qualify native API failure.
test('default Service retains a real web parser cleanup failure until explicit owned process exit, then cold original data remains', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-web-cleanup-ownership-')));
  const profile = selectProfile({ dataRoot: root, profile: 'test' });
  const started = Date.now(),
    deadline = started + 3200,
    cleanupDeadline = started + 4800;
  const bounded = <T>(work: Promise<T>, phase: string) =>
    within(work, deadline - Date.now(), phase);
  const cleanupBounded = <T>(work: Promise<T>, milliseconds: number, phase: string) =>
    within(work, Math.min(milliseconds, cleanupDeadline - Date.now()), phase);
  let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cold: Store | undefined;
  let coldRuntime: ReturnType<typeof createRuntime> | undefined;
  let coldOpening: Promise<Store> | undefined;
  let draining = false;
  const failures: unknown[] = [];
  try {
    child = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        fileURLToPath(new URL('../fixtures/web-fetch-cleanup-ownership-child.ts', import.meta.url)),
        root,
      ],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    );
    const diagnostics = new Response(child.stderr).text();
    void diagnostics.catch(() => {});
    reader = child.stdout.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    while (!buffer.includes('\n')) {
      const chunk = await bounded(reader.read(), 'retained parser receipt');
      if (chunk.done)
        throw Error(
          `owned child exited before receipt: ${await bounded(diagnostics, 'early diagnostics')}`,
        );
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 1048576) throw Error('owned fixture receipt too large');
    }
    const lineEnd = buffer.indexOf('\n');
    const report = JSON.parse(buffer.slice(0, lineEnd)) as Receipt;
    const outputReader = reader;
    const remainingOutput = (async () => {
      let tail = buffer.slice(lineEnd + 1);
      try {
        for (;;) {
          const chunk = await outputReader.read();
          if (chunk.done) return tail + decoder.decode();
          tail += decoder.decode(chunk.value, { stream: true });
          if (tail.length > 1048576) throw Error('owned fixture tail too large');
        }
      } finally {
        outputReader.releaseLock();
        if (reader === outputReader) reader = undefined;
      }
    })();
    void remainingOutput.catch(() => {});
    expect(report.pid).toBe(child.pid);
    expect(child.exitCode).toBeNull();
    expect(report.command).toMatchObject({ id: 'work', status: 'applied' });
    expect(report.parserOutput.title).toBe('Original resource');
    expect(report.parserOutput.content).toContain('ORIGINAL\\_ARTICLE\\_TAIL');
    expect(report.parserOutput.content).toContain('中🙂');
    expect(report.parserInputs).toBe(1);
    expect(report.terminationAttempts).toBe(1);
    if (process.platform === 'darwin')
      expect(report.originalThread).toMatchObject({ platform: 'darwin', pid: child.pid });
    else expect(report.originalThread).toBeNull();
    expect(report.execution).toMatchObject({
      kind: 'tool',
      originCommandId: 'work',
      status: 'outcome_unknown',
      result: { outcome: 'outcome_unknown', content: 'worker_exit_unconfirmed' },
    });
    expect(
      report.messages.some(
        (message) => message.role === 'user' && message.content === report.input,
      ),
    ).toBe(true);
    expect(report.modelCalls).toBe(1);
    expect(report.sameClose).toBe(true);
    expect(report.error).toMatchObject({ code: 'shutdown_cleanup_unconfirmed' });
    expect(report.runtimeError).toMatchObject({ code: 'shutdown_cleanup_unconfirmed' });
    expect(report.lifecycle.state).toBe('drain_failed');
    await expect(
      bounded(
        createProfileBackup({ profile, destinationRoot: join(root, 'blocked-backup') }),
        'live maintenance',
      ),
    ).rejects.toMatchObject({ code: 'owner_busy' });
    expect(child.exitCode).toBeNull();
    child.stdin.write('exit\n');
    child.stdin.end();
    const [exit, stderr, stdout] = await bounded(
      Promise.all([child.exited, diagnostics, remainingOutput]),
      'explicit process exit and double EOF',
    );
    expect(exit).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toBe('');
    const backup = await bounded(
      createProfileBackup({ profile, destinationRoot: join(root, 'backup') }),
      'released maintenance',
    );
    expect(backup.manifest.source.storeId).toBe(report.metadata.storeId);
    coldOpening = openSqliteStore({ dataRoot: root, profile: 'test', mode: 'readonly' }).then(
      (store) => {
        cold = store;
        if (draining) void store.close().catch((error) => failures.push(error));
        return store;
      },
    );
    void coldOpening.catch(() => {});
    cold = await bounded(coldOpening, 'cold Store');
    expect(await bounded(cold.getMetadata(), 'cold metadata')).toEqual(report.metadata);
    expect(await bounded(cold.getView('s'), 'cold view')).toEqual(report.storedView);
    expect(await bounded(cold.getCommand('work'), 'cold Command')).toEqual(report.command);
    expect(await bounded(cold.getExecution(report.execution!.id), 'cold Execution')).toEqual(
      report.execution,
    );
    expect(await bounded(cold.listMessages('s', { limit: 200 }), 'cold messages')).toEqual(
      report.messages,
    );
    const coldModel = createFixedModel([]);
    coldRuntime = createRuntime({
      store: cold,
      model: coldModel,
      modelId: 'cold',
      permissions: {
        async authorize() {
          return { allowed: false, revision: 'cold' };
        },
      },
    });
    expect(await bounded(coldRuntime.getView('s'), 'cold Runtime')).toEqual(report.storedView);
    expect(coldModel.requests).toHaveLength(0);
  } catch (error) {
    failures.push(error);
  } finally {
    draining = true;
    if (child && child.exitCode === null) {
      try {
        child.stdin.write('exit\n');
        child.stdin.end();
      } catch {
        child.kill('SIGTERM');
      }
      try {
        await cleanupBounded(child.exited, 200, 'requested cleanup exit');
      } catch {
        child.kill('SIGTERM');
        try {
          await cleanupBounded(child.exited, 300, 'own SIGTERM cleanup');
        } catch {
          child.kill('SIGKILL');
          try {
            await cleanupBounded(child.exited, 300, 'own SIGKILL cleanup');
          } catch (error) {
            failures.push(error);
          }
        }
      }
    }
    try {
      if (reader) await cleanupBounded(reader.cancel(), 100, 'reader cleanup');
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        reader?.releaseLock();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      if (coldOpening) await cleanupBounded(coldOpening, 300, 'cold opening cleanup');
    } catch (error) {
      failures.push(error);
    }
    try {
      await cleanupBounded(Promise.resolve(coldRuntime?.close()), 300, 'cold Runtime cleanup');
    } catch (error) {
      failures.push(error);
    }
    try {
      await cleanupBounded(Promise.resolve(cold?.close()), 300, 'cold Store cleanup');
    } catch (error) {
      failures.push(error);
    }
    if (!failures.length) rmSync(root, { recursive: true, force: true });
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, `web cleanup ownership failed:${root}`);
});

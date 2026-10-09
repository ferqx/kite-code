import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime, type ModelOutputSnapshot } from '@kite-ai/agent';
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

// One actual failed strict-close handoff, not a physical Worker thread exit qualification.
test('unconfirmed Service Store close retains original ownership until its process exits and cold reads preserve completed work', async () => {
  const root = mkdtempSync('/private/tmp/kite-store-close-ownership-');
  const profile = selectProfile({ dataRoot: root, profile: 'test' });
  let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
  let cold: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let coldRuntime: ReturnType<typeof createRuntime> | undefined;
  const failures: unknown[] = [];
  const started = Date.now();
  const deadline = started + 3200;
  const cleanupDeadline = started + 4800;
  let draining = false;
  let coldOpening: Promise<Awaited<ReturnType<typeof openSqliteStore>>> | undefined;
  const cleanupBounded = <T>(work: Promise<T>, milliseconds: number, phase: string) =>
    within(work, Math.min(milliseconds, cleanupDeadline - Date.now()), phase);
  const bounded = <T>(work: Promise<T>, phase: string) =>
    within(work, deadline - Date.now(), phase);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    child = Bun.spawn(
      [
        process.execPath,
        new URL('../fixtures/store-close-ownership-child.ts', import.meta.url).pathname,
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
      const chunk = await bounded(reader.read(), 'original receipt');
      if (chunk.done)
        throw Error(
          `owned child exited before original receipt: ${await bounded(diagnostics, 'diagnostics')}`,
        );
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 1048576) throw Error('owned fixture receipt too large');
    }
    reader.releaseLock();
    reader = undefined;
    const report = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as {
      pid: number;
      body: string;
      modelOutput: ModelOutputSnapshot;
      view: Awaited<
        ReturnType<ReturnType<typeof import('@kite-ai/client').createClient>['getView']>
      >;
      storedView: Awaited<ReturnType<Awaited<ReturnType<typeof openSqliteStore>>['getView']>>;
      metadata: Awaited<ReturnType<Awaited<ReturnType<typeof openSqliteStore>>['getMetadata']>>;
      command: { id: string; status: string };
      modelCalls: number;
      sameClose: boolean;
      error: { code: string; message: string };
      lifecycle: { state: string };
    };
    expect(report.pid).toBe(child.pid);
    expect(child.exitCode).toBeNull();
    expect(report.command).toMatchObject({ id: 'work', status: 'applied' });
    expect(report.view.runs[0]?.status).toBe('completed');
    expect(report.modelOutput.output).toMatchObject({ complete: true, content: report.body });
    expect(report.modelCalls).toBe(1);
    expect(report.sameClose).toBe(true);
    expect(report.error).toEqual({
      code: 'fixture_strict_close_failed',
      message: 'original strict close failed before native close',
    });
    expect(report.lifecycle.state).toBe('drain_failed');
    const blocked = await bounded(
      createProfileBackup({ profile, destinationRoot: join(root, 'blocked-backup') }),
      'live maintenance',
    ).catch((error: unknown) => error);
    expect(blocked).toMatchObject({ code: 'owner_busy' });
    expect(child.exitCode).toBeNull();
    child.stdin.write('exit\n');
    child.stdin.end();
    expect(await bounded(child.exited, 'original exit')).toBe(0);
    expect(await bounded(diagnostics, 'original stderr')).toBe('');
    const backup = await bounded(
      createProfileBackup({ profile, destinationRoot: join(root, 'backup') }),
      'cold backup',
    );
    expect(backup.manifest.source.storeId).toBe(report.metadata.storeId);
    coldOpening = openSqliteStore({ dataRoot: root, profile: 'test', mode: 'readonly' }).then(
      (store) => {
        cold = store;
        // A timed-out open still owns the returned Store and must close it.
        if (draining) void Promise.resolve(store.close()).catch((error) => failures.push(error));
        return store;
      },
    );
    void coldOpening.catch(() => {});
    cold = await bounded(coldOpening, 'cold Store open');
    expect(await bounded(cold.getMetadata(), 'cold metadata')).toEqual(report.metadata);
    expect(await bounded(cold.getView('s'), 'cold View')).toEqual(report.storedView);
    const coldModel = createFixedModel([]);
    coldRuntime = createRuntime({
      store: cold,
      model: coldModel,
      modelId: 'fixed',
      permissions: {
        async authorize() {
          return { allowed: false, revision: 'cold' };
        },
      },
    });
    expect(
      await bounded(
        coldRuntime.readModelOutput({
          sessionId: 's',
          executionId: report.modelOutput.executionId,
          expectedStoreId: report.metadata.storeId,
          subjectId: 'local-user',
        }),
        'cold model output',
      ),
    ).toEqual(report.modelOutput);
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
        await cleanupBounded(child.exited, 200, 'exit request cleanup');
      } catch {
        child.kill('SIGTERM');
        try {
          await cleanupBounded(child.exited, 300, 'original SIGTERM cleanup');
        } catch {
          child.kill('SIGKILL');
          try {
            await cleanupBounded(child.exited, 300, 'original SIGKILL cleanup');
          } catch (error) {
            failures.push(error);
          }
        }
      }
    }
    try {
      if (reader) await cleanupBounded(reader.cancel(), 100, 'original reader cleanup');
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
      if (coldOpening) await cleanupBounded(coldOpening, 300, 'cold open cleanup');
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
  if (failures.length) throw new AggregateError(failures, 'original close ownership failed');
});

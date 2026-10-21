import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { launchPairedService } from '../../src/paired';

const entrypoint = join(import.meta.dir, '../fixtures/paired-shutdown-child.ts');
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw Error('paired_shutdown_boundary_timeout');
    await Bun.sleep(10);
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const mode of ['eof', 'SIGINT', 'SIGTERM'] as const)
  test.skipIf(mode !== 'eof' && process.platform === 'win32')(
    `real paired ${mode} drains original multi-Agent waits beyond the former forced-exit deadline`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'kite-paired-shutdown-'));
      const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
      const host = {
        entered: join(root, 'entered'),
        cancelled: join(root, 'cancelled'),
        release: join(root, 'release'),
        terminal: join(root, 'terminal'),
        models: join(root, 'models'),
      };
      let service: Awaited<ReturnType<typeof launchPairedService>> | undefined;
      let observer: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
      let closing: Promise<void> | undefined;
      try {
        service = await launchPairedService({
          entrypoint,
          profile,
          instanceId: `shutdown-${mode}`,
          buildId: 'fixture-shutdown',
          apiMajor: 1,
          requiredCapabilities: ['commands', 'events'],
          hostConfiguration: host,
        });
        const client = service.client;
        const expectedStoreId = client.serverInfo!.storeId!;
        await client.createWorkspace({
          expectedStoreId,
          id: 'w',
          name: 'owned shutdown',
          rootUri: pathToFileURL(root).href,
        });
        await client.createSession({
          expectedStoreId,
          sessionId: 'parent',
          commandId: 'create',
          workspaceId: 'w',
          title: 'original parent',
        });
        await client.startRun('parent', {
          expectedStoreId,
          commandId: 'work',
          kind: 'run.start',
          content: 'Delegate original work and wait.',
        });
        observer = await openSqliteStore({ ...profile, mode: 'readonly' });
        const sessions = ['parent'];
        await until(async () => {
          if (!existsSync(host.entered)) return false;
          const parent = await observer!.getView('parent');
          const child = parent.executions.find((e) => e.childSessionId !== null);
          if (!child?.childSessionId) return false;
          const worker = await observer!.getView(child.childSessionId);
          const leaf = worker.executions.find((e) => e.childSessionId !== null);
          if (!leaf?.childSessionId) return false;
          if (
            !parent.executions.some(
              (e) => e.definitionId === 'task.events' && e.status === 'dispatching',
            ) ||
            !worker.executions.some(
              (e) => e.definitionId === 'task.events' && e.status === 'dispatching',
            )
          )
            return false;
          sessions.splice(1, sessions.length, child.childSessionId, leaf.childSessionId);
          return true;
        });
        expect(sessions).toHaveLength(3);
        const originalCalls = readFileSync(host.models, 'utf8');
        let exited = false;
        let closeSettled = false;
        void service.exited.then(() => {
          exited = true;
        });
        const started = Date.now();
        if (mode === 'eof') {
          closing = service.close();
          void closing.then(
            () => {
              closeSettled = true;
            },
            () => {
              closeSettled = true;
            },
          );
        } else process.kill(service.pid, mode);
        await until(() => existsSync(host.cancelled));
        // A repeated stop request must not bypass the original resource drain.
        if (mode !== 'eof') process.kill(service.pid, mode);
        await Bun.sleep(Math.max(0, 5500 - (Date.now() - started)));
        expect(exited).toBe(false);
        expect(alive(service.pid)).toBe(true);
        expect(closeSettled).toBe(false);
        expect(existsSync(host.terminal)).toBe(false);
        const pendingLeaf = await observer.getView(sessions[2]!);
        expect(pendingLeaf.runs.some((run) => run.isActive)).toBe(true);
        writeFileSync(host.release, 'confirm original cleanup');
        expect(await service.exited).toBe(0);
        await (closing ?? service.close());
        expect(alive(service.pid)).toBe(false);
        expect(existsSync(host.terminal)).toBe(true);
        await observer.close();
        observer = await openSqliteStore({ ...profile, mode: 'readonly' });
        expect((await observer.getMetadata()).storeId).toBe(expectedStoreId);
        for (const sessionId of sessions) {
          const view = await observer.getView(sessionId);
          expect(view.runs).toHaveLength(1);
          expect(view.runs[0]).toMatchObject({ status: 'cancelled', isActive: false });
          expect(
            view.executions.filter((e) => ['planned', 'dispatching', 'running'].includes(e.status)),
          ).toEqual([]);
        }
        expect(readFileSync(host.models, 'utf8')).toBe(originalCalls);
      } finally {
        writeFileSync(host.release, 'fixture failure cleanup');
        await observer?.close();
        if (service && alive(service.pid)) {
          // This handle belongs only to this test; failure cleanup is not normal-exit evidence.
          process.kill(service.pid, 'SIGKILL');
          await service.exited;
        }
        await closing?.catch(() => {});
        await service?.close().catch(() => {});
        rmSync(root, { recursive: true, force: true });
      }
    },
    45000,
  );

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  test.skipIf(process.platform === 'win32')(
    `incomplete startup ${signal} exits without parent EOF or creating a Profile`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'kite-paired-incomplete-'));
      const ready = join(root, 'ready');
      const dataRoot = join(root, 'data');
      const child = Bun.spawn([process.execPath, entrypoint], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          KITE_SHUTDOWN_FIXTURE_READY: ready,
        },
      });
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      try {
        child.stdin.write(`{"profile":{"dataRoot":${JSON.stringify(dataRoot)}`);
        await child.stdin.flush();
        await until(() => existsSync(ready));
        process.kill(child.pid, signal);
        await until(() => child.exitCode !== null, 3000);
        expect(await child.exited).toBe(0);
        expect(alive(child.pid)).toBe(false);
        expect(existsSync(dataRoot)).toBe(false);
        expect(await stdout).toBe('');
        expect(await stderr).toBe('');
      } finally {
        if (alive(child.pid)) {
          child.kill('SIGKILL');
          await child.exited;
        }
        child.stdin.end();
        await Promise.allSettled([stdout, stderr]);
        rmSync(root, { recursive: true, force: true });
      }
    },
    15000,
  );

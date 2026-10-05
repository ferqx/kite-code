import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Execution } from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';

const posixTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;
const entrypoint = join(import.meta.dir, '../../fixtures/shell-service/entry.ts');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function groupAlive(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until<T>(
  read: () => T | Promise<T>,
  valid: (value: T) => boolean,
  timeout = 7000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await read();
    if (valid(value)) return value;
    if (Date.now() >= deadline) throw new Error('shell_service_deadline');
    await Bun.sleep(10);
  }
}
async function setup(serial = false) {
  const root = mkdtempSync(join(tmpdir(), 'kite-shell-service-'));
  const cwd = join(root, 'workspace');
  mkdirSync(cwd);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'fixture' });
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, '../../../packages/agent/src/platform/process/shell-supervisor.ts'),
    ],
    outdir: join(root, 'assets'),
    naming: 'shell-supervisor.js',
    target: 'bun',
  });
  expect(built.success).toBe(true);
  const ledger = join(root, 'starts');
  const children: Awaited<ReturnType<typeof launchPairedService>>[] = [];
  const launch = async (instanceId: string) => {
    const child = await launchPairedService({
      entrypoint,
      profile,
      instanceId,
      buildId: 'shell-service-fixture',
      apiMajor: 1,
      requiredCapabilities: ['commands', 'extensions_actions'],
      hostConfiguration: { cwd, helper: built.outputs[0]!.path, ledger, graceMs: 1000, serial },
      shutdownTimeoutMs: 7000,
    });
    children.push(child);
    return child;
  };
  try {
    const a = await launch('owner-a');
    const storeId = a.bootstrap.storeId!;
    await a.client.createWorkspace({
      id: 'workspace',
      rootUri: `file://${cwd}`,
      name: 'fixture',
      expectedStoreId: storeId,
    });
    for (const sessionId of ['s', 'other'])
      await a.client.createSession({
        expectedStoreId: storeId,
        commandId: `create-${sessionId}`,
        sessionId,
        workspaceId: 'workspace',
        title: sessionId,
      });
    const invoke = (child: typeof a, commandId: string, command: string, sessionId = 's') =>
      child.client.invokeExtension(sessionId, {
        expectedStoreId: storeId,
        commandId,
        kind: 'extension.invoke',
        extensionId: 'fixture.shell',
        actionId: 'fixture.shell-launch',
        definitionVersion: '1',
        input: { key: commandId, command },
      });
    const job = async (child: typeof a, commandId: string, _sessionId = 's') => {
      const id = await until(
        async () => {
          const command = await child.client.getCommand(commandId);
          const actionId = (command.receipt as { executionId?: string } | null)?.executionId;
          if (!actionId) return undefined;
          const action = await child.client.getExecution(actionId);
          return (action.result as { details?: { executionId?: string } } | null)?.details
            ?.executionId;
        },
        (value) => !!value,
      );
      return child.client.getExecution(id!);
    };
    const terminal = (child: typeof a, execution: Execution) =>
      until(
        () => child.client.getExecution(execution.id),
        (value) => ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(value.status),
      );
    return {
      root,
      cwd,
      profile,
      ledger,
      a,
      storeId,
      launch,
      invoke,
      job,
      terminal,
      async close() {
        await Promise.allSettled(children.map((child) => child.close()));
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await Promise.allSettled(children.map((child) => child.close()));
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

posixTest(
  'real paired Services share owner and Workspace resource; precise cancel receipt precedes confirmed Shell group stop',
  async () => {
    const f = await setup(true);
    const unrelated = Bun.spawn(['/bin/sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
    let group: number | undefined;
    try {
      const b = await f.launch('owner-b');
      const pidFile = join(f.root, 'descendant');
      await f.invoke(f.a, 'first', `trap '' TERM; sleep 30 & echo $! > ${quote(pidFile)}; wait`);
      const first = await f.job(f.a, 'first');
      await until(
        () => f.a.client.getExecution(first.id),
        (execution) => execution.status === 'running',
      );
      // Handle reference is persisted in storage; public result is not a live-handle API.
      const store = await openSqliteStore({
        dataRoot: f.profile.dataRoot,
        profile: f.profile.profile,
      });
      try {
        group = ((await store.getExecution(first.id))!.reference as { processGroupId: number })
          .processGroupId;
      } finally {
        await store.close();
      }
      await until(() => existsSync(pidFile), Boolean);
      const descendant = Number(readFileSync(pidFile, 'utf8'));
      expect(alive(descendant)).toBe(true);
      // Direct extension actions admit detached Jobs and return without a Run.
      // The live Job holds the Workspace resource, not a foreground Session Run.
      const firstCommand = await until(
        () => f.a.client.getCommand('first'),
        (command) => command.status === 'applied',
      );
      const firstActionId = (firstCommand.receipt as { executionId: string }).executionId;
      expect(await f.a.client.getExecution(firstActionId)).toMatchObject({
        status: 'succeeded',
        runId: null,
      });
      expect((await f.a.client.getView('s')).runs).toHaveLength(0);
      expect((await f.a.client.getExecution(first.id)).status).toBe('running');
      const queued = await f.invoke(b, 'same-session', 'printf peer-session');
      expect(queued.status).toBe('accepted');
      const sameSessionJob = await f.job(b, 'same-session');
      await f.invoke(b, 'resource-wait', 'printf peer-resource', 'other');
      const waiting = await f.job(b, 'resource-wait', 'other');
      await Bun.sleep(80);
      expect(
        (
          await until(
            () => b.client.getCommand('same-session'),
            (command) => command.status === 'applied',
          )
        ).status,
      ).toBe('applied');
      expect((await b.client.getExecution(sameSessionJob.id)).status).toBe('planned');
      expect((await b.client.getExecution(waiting.id)).status).toBe('planned');
      expect(readFileSync(f.ledger, 'utf8').trim().split('\n')).toHaveLength(1);
      const receipt = await b.client.cancelExecution('s', {
        expectedStoreId: f.storeId,
        commandId: 'cancel-first',
        kind: 'execution.cancel',
        executionId: first.id,
      });
      expect(receipt.kind).toBe('execution.cancel');
      expect(groupAlive(group!)).toBe(true);
      expect((await b.client.getExecution(first.id)).status).toBe('running');
      expect(await f.terminal(b, first)).toMatchObject({
        status: 'cancelled',
        result: { outcome: 'cancelled', details: { groupStopped: true, forced: true } },
      });
      await until(() => !alive(descendant) && !groupAlive(group!), Boolean);
      expect(alive(descendant)).toBe(false);
      expect(groupAlive(group!)).toBe(false);
      expect(alive(unrelated.pid)).toBe(true);
      expect((await f.terminal(b, waiting)).status).toBe('succeeded');
      expect((await f.terminal(b, sameSessionJob)).status).toBe('succeeded');
      const starts = readFileSync(f.ledger, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).executionId);
      expect(new Set(starts).size).toBe(3);
      expect(starts).toHaveLength(3);
    } finally {
      if (group && groupAlive(group))
        try {
          process.kill(-group, 'SIGKILL');
        } catch {}
      unrelated.kill();
      await unrelated.exited;
      await f.close();
    }
  },
  20000,
);

posixTest(
  'real Core persists bounded Shell output and explicit gaps through Client GET',
  async () => {
    const f = await setup();
    try {
      await f.invoke(f.a, 'output', "dd if=/dev/zero bs=32768 count=80 2>/dev/null | tr '\\000' x");
      const execution = await f.job(f.a, 'output');
      expect((await f.terminal(f.a, execution)).status).toBe('succeeded');
      const page = await f.a.client.listExecutionOutput(execution.id, { limit: 200 });
      expect(BigInt(page.highWaterSeq)).toBeGreaterThan(0n);
      expect(page.items.some((item) => item.droppedBytes !== '0')).toBe(true);
      expect(
        page.items
          .filter((item) => item.droppedBytes === '0')
          .every((item) => Buffer.byteLength(item.content) <= 32768),
      ).toBe(true);
      expect(
        page.items.reduce((bytes, item) => bytes + Buffer.byteLength(item.content), 0),
      ).toBeLessThanOrEqual(1048576);
      const gap = page.items.find((item) => item.droppedBytes !== '0')!;
      expect(BigInt(gap.droppedBytes!)).toBeGreaterThan(0n);
      expect(f.a.client.lastAppliedCursor).toBeUndefined();
    } finally {
      await f.close();
    }
  },
  15000,
);

for (const exit of ['eof', 'sigkill'] as const)
  posixTest(
    `actual paired Service ${exit} cleans Shell root/descendants; reopening preserves durable facts without restart`,
    async () => {
      const f = await setup();
      const unrelated = Bun.spawn(['/bin/sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
      let group: number | undefined;
      let readerStore: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
      try {
        const pidFile = join(f.root, 'descendant');
        const command = `sleep 30 & echo $! > ${quote(pidFile)}; wait`;
        await f.invoke(f.a, 'orphan-job', command);
        const execution = await f.job(f.a, 'orphan-job');
        await until(
          () => f.a.client.getExecution(execution.id),
          (value) => value.status === 'running',
        );
        await until(() => existsSync(pidFile), Boolean);
        const descendant = Number(readFileSync(pidFile, 'utf8'));
        const store = await openSqliteStore({
          dataRoot: f.profile.dataRoot,
          profile: f.profile.profile,
        });
        readerStore = store;
        // Recovery is a host operation bound to the original Session creator, not a guessed default subject.
        const creator = (await store.getCommand('create-s'))!;
        const recoverySubject = creator.subjectId;
        expect(creator.sessionId).toBe('s');
        const persisted = (await store.getExecution(execution.id))!;
        const reference = persisted.reference as {
          processGroupId: number;
          supervisorPid: number;
        };
        group = reference.processGroupId;
        expect(alive(descendant)).toBe(true);
        if (exit === 'eof') await f.a.close();
        else {
          process.kill(f.a.pid, 'SIGKILL');
          await f.a.exited;
        }
        await until(
          () => !alive(descendant) && !groupAlive(group!) && !alive(reference.supervisorPid),
          Boolean,
        );
        expect(groupAlive(group!)).toBe(false);
        expect(alive(descendant)).toBe(false);
        expect(alive(unrelated.pid)).toBe(true);
        if (exit === 'sigkill') {
          const before = (await store.getExecution(execution.id))!;
          expect(before.status).toBe('running');
          const report = await store.recoverSession({
            expectedStoreId: f.storeId,
            commandId: 'recover',
            sessionId: 's',
            subjectId: recoverySubject,
            expectedOwnerGeneration: before.ownerGeneration,
            decision: 'interrupt',
          });
          expect(report.unknownExecutionIds).toContain(execution.id);
        }
        expect((await store.getExecution(execution.id))!.status).toBe(
          exit === 'eof' ? 'cancelled' : 'outcome_unknown',
        );
        await store.close();
        readerStore = undefined;
        const resumed = await f.launch('reopened');
        expect((await resumed.client.getExecution(execution.id)).status).toBe(
          exit === 'eof' ? 'cancelled' : 'outcome_unknown',
        );
        await f.invoke(resumed, 'orphan-job', command);
        await Bun.sleep(100);
        expect(readFileSync(f.ledger, 'utf8').trim().split('\n')).toHaveLength(1);
        expect(groupAlive(group!)).toBe(false);
      } finally {
        await readerStore?.close();
        if (group && groupAlive(group))
          try {
            process.kill(-group, 'SIGKILL');
          } catch {}
        unrelated.kill();
        await unrelated.exited;
        await f.close();
      }
    },
    20000,
  );

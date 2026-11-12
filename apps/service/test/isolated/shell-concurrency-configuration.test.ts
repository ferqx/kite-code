import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter } from '@kite-ai/ai';
import { retainWindowsOwnedProcessObservation } from '../../../../packages/agent/src/platform/process/windows-owned-child';
import { windowsShellFixture } from '../../../../packages/agent/test/fixtures/windows-shell-runtime';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

test.skipIf(process.platform !== 'win32')(
  'Windows Sessions isolate concurrent Shell state/output/stop, queue process slots and share only authorized workspace files',
  async () => {
    const root = temporaryDirectory('kite-service-shell-concurrency-');
    const workspace = join(root, 'workspace'),
      other = join(root, 'other');
    const control = join(root, 'control'),
      stateRoot = join(root, 'state');
    for (const path of [workspace, other, control, stateRoot]) mkdirSync(path);
    for (const name of ['sub-a', 'sub-b']) mkdirSync(join(workspace, name));
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'concurrency' });
    privateDirectory(profile.profilePath);
    const user = join(profile.profilePath, 'config.jsonc');
    writeFileSync(
      user,
      JSON.stringify({
        modelId: 'fixed',
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'unused',
            baseURL: 'http://127.0.0.1:9/v1',
          },
        ],
      }),
    );
    const assets = await windowsShellFixture();
    const host = createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: user,
      ordinaryHostTools: true,
      localCodex: false,
      credentialBackend: createTemporaryCredentialBackend(),
      shell: {
        platform: 'win32',
        configurationId: 'native-concurrency-test',
        env: { SystemRoot: process.env.SystemRoot!, Path: '' },
        supervisorPath: assets.runner,
        bunExecutable: process.execPath,
        shellExecutable: assets.shell,
        windows: {
          fullShellExecutable: assets.fullShell,
          stateRoot,
        },
        host: {
          controlBase: control,
          protectedRoots: [profile.dataRoot, control],
          readonlyAssets: [],
          runtimeReadOnlyRoots: [],
        },
      },
    });
    const store = await openSqliteStore(profile),
      expectedStoreId = (await store.getMetadata()).storeId;
    const commands = {
      a: 'set -e; export KITE_SHELL_CONCURRENCY_PROBE=a; umask 077; cd sub-a; printf "A-READY\\nA-TEMP:%s\\n" "$TMPDIR"; printf from-a > ../shared.txt; printf ready > ../a.ready; sleep 60 & wait; printf forbidden > ../a-after',
      b: 'set -e; test -z "$KITE_SHELL_CONCURRENCY_PROBE"; export KITE_SHELL_CONCURRENCY_PROBE=b; cd sub-b; printf "B-READY\\nB-TEMP:%s\\n" "$TMPDIR"; printf ready > ../b.ready; until test -f ../allow-b-write; do sleep 0.05; done; printf from-b > ../shared.txt; printf ready > ../b-overwrote; until test -f ../release-b; do sleep 0.05; done; printf B-DONE; printf done > ../b-result',
      c: 'set -e; test -z "$KITE_SHELL_CONCURRENCY_PROBE"; printf "C-READY\\nC-TEMP:%s\\n" "$TMPDIR"; printf c-workspace > c-result; printf c-full > ../c-external; printf C-DONE',
    };
    let fresh = false;
    const workspaceSerialLocks = createWorkspaceSerialLocks(profile);
    host.bindWorkspaceSerialLocks?.(workspaceSerialLocks);
    const runtime = createRuntime({
      ...host,
      store,
      permissions: host.permissions!,
      workspaceSerialLocks,
      processConcurrency: 2,
      artifacts: createArtifactStore({ profile, store }),
      async resolveRunConfiguration(input) {
        const configuration = await host.resolveRunConfiguration!(input);
        const key = fresh && input.session.id === 'b' ? 'fresh' : 'work';
        const command =
          key === 'fresh'
            ? 'set -e; test -z "$KITE_SHELL_CONCURRENCY_PROBE"; printf fresh > fresh-result; printf FRESH-DONE'
            : commands[input.session.id as keyof typeof commands];
        let step = 0;
        const model: ModelAdapter = {
          async *stream() {
            if (step++ === 0) {
              yield {
                type: 'tool_call',
                id: crypto.randomUUID(),
                name: 'shell_execute',
                arguments: JSON.stringify({ command }),
              };
              yield {
                type: 'finish',
                reason: 'tool_calls',
                usage: { inputTokens: 1, outputTokens: 1 },
              };
            } else
              yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
          },
        };
        return { ...configuration, model };
      },
    });
    host.permissionManagement?.(runtime);
    const identity = (sessionId: string) => ({ expectedStoreId, sessionId, subjectId: 'owner' });
    const until = async <T>(read: () => Promise<T | undefined>): Promise<T> => {
      const deadline = Date.now() + 20000;
      for (;;) {
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw Error('shell_concurrency_deadline');
        await Bun.sleep(10);
      }
    };
    const latest = async (sessionId: string) =>
      (await store.listExecutions(sessionId))
        .filter((row) => row.definitionId === 'shell.command')
        .at(-1);
    const output = async (id: string) =>
      (await store.listExecutionOutput({ executionId: id, afterSeq: '0', limit: 200 })).items
        .filter((row) => row.stream === 'stdout')
        .map((row) => row.content)
        .join('');
    const submit = (sessionId: string, commandId = `start-${sessionId}`) =>
      runtime.submitCommand({
        ...identity(sessionId),
        commandId,
        request: { kind: 'run.start', content: 'Run the isolated Shell concurrency fixture.' },
      });
    let bOwner: ReturnType<typeof retainWindowsOwnedProcessObservation> | undefined;
    try {
      for (const [id, path] of [
        ['w', workspace],
        ['other', other],
      ])
        await runtime.createWorkspace({
          expectedStoreId,
          id: id!,
          name: id!,
          rootUri: pathToFileURL(path!).href,
        });
      for (const sessionId of ['a', 'b', 'c']) {
        const workspaceId = sessionId === 'c' ? 'other' : 'w';
        await runtime.createSession({
          ...identity(sessionId),
          workspaceId,
          commandId: `create-${sessionId}`,
          title: sessionId,
        });
        await initializeLivePermissionFixture({
          runtime,
          profile,
          ...identity(sessionId),
          workspaceId,
          mode: sessionId === 'c' ? 'full' : 'accept_edits',
          trusted: true,
        });
      }
      await Promise.all([submit('a'), submit('b')]);
      const ready = async (sessionId: 'a' | 'b') =>
        until(async () => {
          const row = await latest(sessionId);
          return row?.status === 'running' &&
            existsSync(join(workspace, `${sessionId}.ready`)) &&
            new RegExp(`^${sessionId.toUpperCase()}-TEMP:.+\\n`, 'm').test(await output(row.id))
            ? row
            : undefined;
        });
      const [a, b] = await Promise.all([ready('a'), ready('b')]);
      expect(a.id).not.toBe(b.id);
      const aRef = a.reference as { supervisorPid: number },
        bRef = b.reference as { supervisorPid: number };
      expect(aRef.supervisorPid).not.toBe(bRef.supervisorPid);
      bOwner = retainWindowsOwnedProcessObservation(bRef.supervisorPid);
      expect(bOwner.inspect()).toBe('alive');
      const aOutput = await output(a.id),
        bOutput = await output(b.id);
      expect(aOutput).toContain('A-READY');
      expect(aOutput).not.toContain('B-READY');
      expect(bOutput).toContain('B-READY');
      expect(bOutput).not.toContain('A-READY');
      const aTemp = /^A-TEMP:(.+)$/m.exec(aOutput)![1],
        bTemp = /^B-TEMP:(.+)$/m.exec(bOutput)![1];
      expect(aTemp).not.toBe(bTemp);
      // Separate process state does not isolate the shared Workspace's bytes.
      expect(readFileSync(join(workspace, 'shared.txt'), 'utf8')).toBe('from-a');
      writeFileSync(join(workspace, 'allow-b-write'), 'release');
      await until(async () => (existsSync(join(workspace, 'b-overwrote')) ? true : undefined));
      expect(readFileSync(join(workspace, 'shared.txt'), 'utf8')).toBe('from-b');
      expect((await store.getExecution(a.id))?.status).toBe('running');
      await submit('c');
      const queued = await until(async () => {
        const row = await latest('c');
        return row?.status === 'planned' ? row : undefined;
      });
      expect(existsSync(join(other, 'c-result'))).toBe(false);
      await runtime.cancelExecution({
        ...identity('a'),
        commandId: 'cancel-a-only',
        executionId: a.id,
      });
      const cancelled = await until(async () => {
        const row = await store.getExecution(a.id);
        return row?.status === 'cancelled' ? row : undefined;
      });
      expect(cancelled.result).toMatchObject({
        details: { cleanupConfirmed: true, processTreeStopped: true },
      });
      expect(existsSync(join(workspace, 'a-after'))).toBe(false);
      const c = await until(async () => {
        const row = await store.getExecution(queued.id);
        return row?.status === 'succeeded' ? row : undefined;
      });
      expect(bOwner.inspect()).toBe('alive');
      expect((await store.getExecution(b.id))?.status).toBe('running');
      expect(readFileSync(join(other, 'c-result'), 'utf8')).toBe('c-workspace');
      expect(readFileSync(join(root, 'c-external'), 'utf8')).toBe('c-full');
      expect(existsSync(join(workspace, 'c-result'))).toBe(false);
      const cOutput = await output(c.id),
        cTemp = /^C-TEMP:(.+)$/m.exec(cOutput)![1];
      expect(cOutput).toContain('C-DONE');
      expect(cOutput).not.toContain('B-READY');
      expect([aTemp, bTemp]).not.toContain(cTemp);
      writeFileSync(join(workspace, 'release-b'), 'release');
      await until(async () => {
        const row = await store.getExecution(b.id);
        return row?.status === 'succeeded' ? row : undefined;
      });
      await until(async () =>
        (await store.getView('b')).runs.every((run) => !run.isActive) ? true : undefined,
      );
      expect(bOwner.inspect()).toBe('dead');
      fresh = true;
      await submit('b', 'fresh-b');
      const clean = await until(async () => {
        const row = await latest('b');
        return row?.id !== b.id && row?.status === 'succeeded' ? row : undefined;
      });
      expect(await output(clean.id)).toBe('FRESH-DONE');
      expect(readFileSync(join(workspace, 'fresh-result'), 'utf8')).toBe('fresh');
      expect(existsSync(join(workspace, 'sub-b', 'fresh-result'))).toBe(false);
      const bComplete = (await store.getExecution(b.id))!;
      for (const row of [cancelled, bComplete, c, clean])
        expect(row.result).toMatchObject({
          details: {
            cleanupConfirmed: true,
            ownedProcesses: { closed: true, closeUnknown: false },
          },
        });
      const bFinal = await output(b.id);
      expect(bFinal).toContain('B-DONE');
      expect(bFinal).not.toContain('C-DONE');
      expect(readdirSync(control)).toEqual([]);
    } finally {
      writeFileSync(join(workspace, 'release-b'), 'release');
      await runtime.close();
      await store.close();
      await workspaceSerialLocks.close();
      bOwner?.close();
      removeTemporaryDirectory(root);
    }
  },
  60000,
);

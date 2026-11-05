import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as promises from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter } from '@kite-ai/ai';

const root = process.argv[2]!;
const original = { ...promises };
let armed = false,
  reading = false,
  closed = false;
let resume!: () => void;
const held = new Promise<void>((resolve) => {
  resume = resolve;
});
mock.module('node:fs/promises', () => ({
  ...original,
  async open(...args: Parameters<typeof original.open>) {
    const handle = await original.open(...args);
    if (
      !armed ||
      reading ||
      !String(args[0]).replaceAll('\\', '/').endsWith('/usr/bin/msys-2.0.dll')
    )
      return handle;
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'read')
          return async (...input: Parameters<typeof handle.read>) => {
            const result = await target.read(...input);
            if (!reading) {
              reading = true;
              await held;
            }
            return result;
          };
        if (key === 'close')
          return async () => {
            await target.close();
            closed = true;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  },
}));

const { createRuntime } = await import('@kite-ai/agent');
const { createArtifactStore } = await import('@kite-ai/agent/artifacts');
const { createTemporaryCredentialBackend } = await import('@kite-ai/agent/config');
const { selectProfile } = await import('@kite-ai/agent/profile');
const { createWorkspaceSerialLocks } = await import('@kite-ai/agent/resources');
const { openSqliteStore } = await import('@kite-ai/agent/sqlite');
const { privateDirectory } = await import('../../../../tests/fixtures/test-filesystem');
const { windowsShellFixture } = await import(
  '../../../../packages/agent/test/fixtures/windows-shell-runtime'
);
const { createDefaultProcessConfiguration } = await import('../../src/configuration');
const { initializeLivePermissionFixture } = await import('./live-permission-fixture');
const workspace = join(root, 'workspace'),
  control = join(root, 'control'),
  stateRoot = join(root, 'state');
for (const path of [workspace, control, stateRoot]) mkdirSync(path);
const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'verification' });
privateDirectory(profile.profilePath);
const config = join(profile.profilePath, 'config.jsonc');
writeFileSync(
  config,
  JSON.stringify({
    modelId: 'fixed',
    models: [
      { id: 'fixed', provider: 'compatible', model: 'unused', baseURL: 'http://127.0.0.1:9/v1' },
    ],
  }),
);
const assets = await windowsShellFixture();
const host = createDefaultProcessConfiguration({
  profile,
  userConfigurationPath: config,
  ordinaryHostTools: true,
  localCodex: false,
  credentialBackend: createTemporaryCredentialBackend(),
  shell: {
    platform: 'win32',
    configurationId: 'verification-scheduling-test',
    env: { SystemRoot: process.env.SystemRoot!, Path: '' },
    supervisorPath: assets.runner,
    bunExecutable: process.execPath,
    shellExecutable: assets.shell,
    windows: { coreutilsPath: assets.coreutils, fullShellExecutable: assets.fullShell, stateRoot },
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
const commands: Record<string, string> = {
  a: 'printf ready > a-ready; sleep 60 & wait; printf forbidden > a-after',
  b: 'printf forbidden > b-effect',
  c: 'printf c-finished > c-effect',
};
const locks = createWorkspaceSerialLocks(profile);
host.bindWorkspaceSerialLocks?.(locks);
const runtime = createRuntime({
  ...host,
  store,
  permissions: host.permissions!,
  workspaceSerialLocks: locks,
  processConcurrency: 2,
  artifacts: createArtifactStore({ profile, store }),
  async resolveRunConfiguration(input) {
    const configuration = await host.resolveRunConfiguration!(input);
    let step = 0;
    const model: ModelAdapter = {
      async *stream() {
        if (step++ === 0) {
          yield {
            type: 'tool_call',
            id: crypto.randomUUID(),
            name: 'shell_execute',
            arguments: JSON.stringify({ command: commands[input.session.id] }),
          };
          yield {
            type: 'finish',
            reason: 'tool_calls',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        } else yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    return { ...configuration, model };
  },
});
host.permissionManagement?.(runtime);
const identity = (sessionId: string) => ({ expectedStoreId, sessionId, subjectId: 'owner' });
const until = async <T>(read: () => Promise<T | undefined>): Promise<T> => {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw Error('verification_scheduling_deadline');
    await Bun.sleep(5);
  }
};
const job = async (id: string) =>
  (await store.listExecutions(id)).find((row) => row.definitionId === 'shell.command');
const submit = (id: string) =>
  runtime.submitCommand({
    ...identity(id),
    commandId: `start-${id}`,
    request: { kind: 'run.start', content: 'Execute the isolated verification fixture.' },
  });
try {
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'isolated',
    rootUri: pathToFileURL(workspace).href,
  });
  for (const id of ['a', 'b', 'c']) {
    await runtime.createSession({
      ...identity(id),
      workspaceId: 'w',
      commandId: `create-${id}`,
      title: id,
    });
    await initializeLivePermissionFixture({
      runtime,
      profile,
      ...identity(id),
      workspaceId: 'w',
      mode: 'accept_edits',
      trusted: true,
    });
  }
  await submit('a');
  const a = await until(async () => {
    const row = await job('a');
    return row?.status === 'running' && existsSync(join(workspace, 'a-ready')) ? row : undefined;
  });
  armed = true;
  await submit('b');
  await until(async () => (reading ? true : undefined));
  const b = (await job('b'))!;
  assert.equal(b.status, 'dispatching');
  assert.equal(b.reference, null);
  assert.equal(existsSync(join(workspace, 'b-effect')), false);
  // B's real file read is held. A's original native Job can still stop.
  await runtime.cancelExecution({ ...identity('a'), commandId: 'cancel-a', executionId: a.id });
  const aStopped = await until(async () => {
    const row = await store.getExecution(a.id);
    return row?.status === 'cancelled' ? row : undefined;
  });
  assert.equal(
    (aStopped.result as { details: { cleanupConfirmed: boolean } }).details.cleanupConfirmed,
    true,
  );
  assert.equal(closed, false);
  assert.equal(existsSync(join(workspace, 'a-after')), false);
  // A released its process slot; C must finish before B's read is released too.
  await submit('c');
  await until(async () => {
    const row = await job('c');
    return row?.status === 'succeeded' ? row : undefined;
  });
  assert.equal(readFileSync(join(workspace, 'c-effect'), 'utf8'), 'c-finished');
  assert.equal(closed, false);
  const cancelB = runtime.cancelExecution({
    ...identity('b'),
    commandId: 'cancel-b',
    executionId: b.id,
  });
  await until(async () => {
    const row = await store.getExecution(b.id);
    return row && row.cancelRequestedAt !== null ? true : undefined;
  });
  assert.equal((await store.getExecution(b.id))?.status, 'dispatching');
  assert.equal(closed, false);
  resume();
  await cancelB;
  const bStopped = await until(async () => {
    const row = await store.getExecution(b.id);
    return row?.status === 'cancelled' ? row : undefined;
  });
  assert.equal(closed, true);
  assert.equal(bStopped.reference, null);
  assert.equal(existsSync(join(workspace, 'b-effect')), false);
  assert.deepEqual(readdirSync(control), []);
  console.log('cross_session_verification_scheduling_passed');
} finally {
  resume();
  await runtime.close();
  await store.close();
  await locks.close();
}

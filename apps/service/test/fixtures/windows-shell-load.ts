import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as io from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter } from '@kite-ai/ai';
import { mock } from '#kite-test';

/** Explicit isolated Windows load measurement; never a production diagnostic entry. */
if (process.platform !== 'win32') throw Error('windows_shell_load_requires_windows');
const mode = process.argv[2] ?? 'default';
if (!['default', '32'].includes(mode)) throw Error('windows_shell_load_mode_invalid');
const slots = mode === 'default' ? 4 : 32;
const original = { ...io };
let tracking = false,
  peakFiles = 0,
  peakScratch = 0,
  opened = 0;
const files = new Map<Awaited<ReturnType<typeof io.open>>, Buffer | undefined>();
mock.module('node:fs/promises', () => ({
  ...original,
  async open(...args: Parameters<typeof original.open>) {
    const handle = await original.open(...args);
    const path = String(args[0]).replaceAll('\\', '/');
    const asset =
      path.includes('/git-bash-runtime/runtime/') ||
      path.includes('/platform/process/windows-shell/') ||
      path.endsWith('.wasm') ||
      path.endsWith('/rg.exe') ||
      path === process.execPath.replaceAll('\\', '/');
    if (!tracking || !asset) return handle;
    opened++;
    files.set(handle, undefined);
    peakFiles = Math.max(peakFiles, files.size);
    assert.ok(files.size <= 8, 'all Sessions share eight verification FDs');
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'read')
          return async (buffer: Buffer, ...values: [number, number, number | null]) => {
            assert.ok(buffer.length <= 1048576);
            const prior = files.get(target);
            if (prior) assert.equal(buffer, prior, 'each original FD reuses its private buffer');
            files.set(target, buffer);
            peakScratch = Math.max(
              peakScratch,
              [...files.values()].reduce((sum, value) => sum + (value?.length ?? 0), 0),
            );
            return await target.read(buffer, ...values);
          };
        if (key === 'close')
          return async () => {
            await target.close();
            files.delete(target);
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
const { retainWindowsOwnedProcessObservation } = await import(
  '../../../../packages/agent/src/platform/process/windows-owned-child'
);
const { windowsShellFixture } = await import(
  '../../../../packages/agent/test/fixtures/windows-shell-runtime'
);
const { privateDirectory, temporaryDirectory, removeTemporaryDirectory } = await import(
  '../../../../tests/fixtures/test-filesystem'
);
const { createDefaultProcessConfiguration } = await import('../../src/configuration');
const { initializeLivePermissionFixture } = await import('./live-permission-fixture');
const root = temporaryDirectory('kite-windows-shell-load-');
const workspace = join(root, 'workspace'),
  control = join(root, 'control'),
  stateRoot = join(root, 'state');
for (const path of [workspace, control, stateRoot]) mkdirSync(path);
const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'load' });
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
    configurationId: 'windows-shell-load',
    env: { SystemRoot: process.env.SystemRoot!, Path: '' },
    supervisorPath: assets.runner,
    runtimeExecutable: process.execPath,
    shellExecutable: assets.shell,
    windows: { fullShellExecutable: assets.fullShell, stateRoot },
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
const locks = createWorkspaceSerialLocks(profile);
host.bindWorkspaceSerialLocks?.(locks);
const runtime = createRuntime({
  ...host,
  store,
  permissions: host.permissions!,
  workspaceSerialLocks: locks,
  ...(mode === 'default' ? {} : { processConcurrency: slots }),
  artifacts: createArtifactStore({ profile, store }),
  async resolveRunConfiguration(input) {
    const configuration = await host.resolveRunConfiguration!(input);
    const id = input.session.id;
    const command = `set -e; test -z "$KITE_LOAD_STATE"; export KITE_LOAD_STATE=${id}; printf 'READY:${id}:%s\\n' "$TMPDIR"; printf ready > ready-${id}; until test -f release-all; do sleep 0.2; done; printf 'DONE:${id}\\n'; printf done > done-${id}`;
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
        } else yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    return { ...configuration, model };
  },
});
host.permissionManagement?.(runtime);
const sessions = Array.from({ length: 32 }, (_, i) => `load-${String(i).padStart(2, '0')}`);
const identity = (sessionId: string) => ({ expectedStoreId, subjectId: 'owner', sessionId });
const rows = async () =>
  (
    await store.listBackgroundExecutions({
      expectedStoreId,
      subjectId: 'owner',
      workspaceId: 'w',
      limit: 200,
    })
  ).items
    .filter((item) => item.execution.definitionId === 'shell.command')
    .map(({ execution }) => ({
      id: execution.id,
      session_id: execution.sessionId,
      state: execution.status,
    }));
const until = async <T>(read: () => T | undefined | Promise<T | undefined>, label: string) => {
  const deadline = Date.now() + 90000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw Error(`windows_shell_load_deadline:${label}`);
    await sleepTimer(25);
  }
};
const events: { phase: string; ms: number; data?: unknown }[] = [];
let started = performance.now(),
  previous = started,
  peakRunning = 0,
  peakAdmitted = 0,
  peakRss = 0;
const heartbeats: number[] = [];
const stalls: { ms: number; at: number; phase: string }[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
let snapshotTimer: ReturnType<typeof setInterval> | undefined;
let polling: Promise<void> | undefined;
const mark = (phase: string, data?: unknown) => {
  events.push({ phase, ms: performance.now() - started, data });
  console.log(JSON.stringify(events.at(-1)));
};
const retained: ReturnType<typeof retainWindowsOwnedProcessObservation>[] = [];
let confirmed = false;
try {
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'isolated-load',
    rootUri: pathToFileURL(workspace).href,
  });
  for (const id of sessions) {
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
  tracking = true;
  started = performance.now();
  previous = started;
  timer = setInterval(() => {
    const now = performance.now();
    heartbeats.push(now - previous);
    if (now - previous > 100)
      stalls.push({ ms: now - previous, at: now - started, phase: events.at(-1)!.phase });
    previous = now;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 10);
  snapshotTimer = setInterval(() => {
    polling ??= rows()
      .then((snapshot) => {
        peakRunning = Math.max(
          peakRunning,
          snapshot.filter((row) => row.state === 'running').length,
        );
        peakAdmitted = Math.max(
          peakAdmitted,
          snapshot.filter((row) => ['dispatching', 'running'].includes(row.state)).length,
        );
      })
      .finally(() => {
        polling = undefined;
      });
  }, 50);
  mark('submit_32_sessions', { slots });
  await Promise.all(
    sessions.map((id) =>
      runtime.submitCommand({
        ...identity(id),
        commandId: `start-${id}`,
        request: { kind: 'run.start', content: 'Run the isolated Windows Shell load fixture.' },
      }),
    ),
  );
  const initial = await until(async () => {
    const all = await rows();
    const active = all.filter((row) => row.state === 'running');
    if (all.some((row) => ['failed', 'outcome_unknown'].includes(row.state)))
      throw Error(`windows_shell_load_failed:${JSON.stringify(all)}`);
    return all.length === 32 &&
      active.length === slots &&
      active.every((row) => existsSync(join(workspace, `ready-${row.session_id}`)))
      ? all
      : undefined;
  }, 'all_admitted_or_queued');
  const running = initial.filter((row) => row.state === 'running'),
    queued = initial.filter((row) => row.state === 'planned');
  assert.equal(queued.length, 32 - slots);
  for (const row of running) {
    const reference = (await store.getExecution(row.id))!.reference as { supervisorPid: number };
    const observation = retainWindowsOwnedProcessObservation(reference.supervisorPid);
    retained.push(observation);
    assert.equal(observation.inspect(), 'alive');
  }
  mark('held_running_and_queued', { running: running.length, queued: queued.length });
  const cancelled = new Set<string>();
  const victims = mode === 'default' ? queued.slice(-8) : running.slice(-8);
  const cancelAt = performance.now();
  await Promise.all(
    victims.map(async (row) => {
      await runtime.cancelExecution({
        ...identity(row.session_id),
        commandId: `cancel-${row.session_id}`,
        executionId: row.id,
      });
      cancelled.add(row.id);
    }),
  );
  await until(async () => {
    const all = await rows();
    return victims.every(
      (row) => all.find((current) => current.id === row.id)?.state === 'cancelled',
    )
      ? true
      : undefined;
  }, 'cancelled_subset');
  const subsetCancelMs = performance.now() - cancelAt;
  if (mode === 'default') {
    for (const row of victims) {
      assert.equal(existsSync(join(workspace, `ready-${row.session_id}`)), false);
      assert.equal((await store.getExecution(row.id))?.reference, null);
    }
    for (const owner of retained) assert.equal(owner.inspect(), 'alive');
    const victim = running[0]!,
      at = performance.now();
    await runtime.cancelExecution({
      ...identity(victim.session_id),
      commandId: 'stop-running',
      executionId: victim.id,
    });
    cancelled.add(victim.id);
    await until(
      async () =>
        (await rows()).some(
          (row) =>
            row.state === 'running' &&
            !running.some((original) => original.id === row.id) &&
            existsSync(join(workspace, `ready-${row.session_id}`)),
        )
          ? true
          : undefined,
      'replacement_uses_released_slot',
    );
    assert.equal(retained[0]!.inspect(), 'dead');
    for (const owner of retained.slice(1)) assert.equal(owner.inspect(), 'alive');
    mark('running_cancel_and_replacement', { totalMs: performance.now() - at });
  } else {
    for (const owner of retained.slice(-8)) assert.equal(owner.inspect(), 'dead');
    for (const owner of retained.slice(0, 24)) assert.equal(owner.inspect(), 'alive');
  }
  mark('cancelled_subset', { count: victims.length, ms: subsetCancelMs });
  writeFileSync(join(workspace, 'release-all'), 'release');
  const terminal = await until(async () => {
    const all = await rows();
    if (all.some((row) => ['failed', 'outcome_unknown'].includes(row.state)))
      throw Error(`windows_shell_load_failed:${JSON.stringify(all)}`);
    return all.length === 32 && all.every((row) => ['succeeded', 'cancelled'].includes(row.state))
      ? all
      : undefined;
  }, 'all_terminal');
  const temps = new Set<string>();
  for (const row of terminal) {
    assert.equal(row.state, cancelled.has(row.id) ? 'cancelled' : 'succeeded');
    const output = (
      await store.listExecutionOutput({ executionId: row.id, afterSeq: '0', limit: 200 })
    ).items;
    assert.ok(output.every((chunk) => chunk.droppedBytes === '0'));
    const text = output
      .filter((chunk) => chunk.stream === 'stdout')
      .map((chunk) => chunk.content)
      .join('');
    const actual = (await store.getExecution(row.id))!;
    if (actual.reference) {
      const temp = new RegExp(`^READY:${row.session_id}:(.+)$`, 'm').exec(text)?.[1];
      assert.ok(temp);
      assert.equal(temps.has(temp), false);
      temps.add(temp);
      const result = actual.result as {
        details: {
          cleanupConfirmed: boolean;
          ownedProcesses: { closed: boolean; closeUnknown: boolean };
        };
      };
      assert.equal(result.details.cleanupConfirmed, true);
      assert.equal(result.details.ownedProcesses.closed, true);
      assert.equal(result.details.ownedProcesses.closeUnknown, false);
    }
    if (cancelled.has(row.id))
      assert.equal(existsSync(join(workspace, `done-${row.session_id}`)), false);
    else {
      assert.equal(readFileSync(join(workspace, `done-${row.session_id}`), 'utf8'), 'done');
      assert.equal(text.split('DONE:').length, 2);
      assert.ok(text.includes(`DONE:${row.session_id}`));
    }
  }
  await until(async () => {
    const views = await Promise.all(sessions.map((id) => store.getView(id)));
    return views.every((view) => view.runs.every((run) => !run.isActive)) ? true : undefined;
  }, 'all_runs_settled');
  if (snapshotTimer) clearInterval(snapshotTimer);
  await polling;
  await runtime.close();
  assert.equal(files.size, 0);
  assert.deepEqual(readdirSync(control), []);
  for (const owner of retained) assert.equal(owner.inspect(), 'dead');
  assert.ok(peakAdmitted <= slots);
  assert.ok(peakRunning <= slots);
  assert.equal(peakRunning, slots);
  assert.equal(peakFiles, 8);
  assert.ok(peakScratch <= 8 * 1048576);
  mark('all_closed', {
    succeeded: terminal.filter((row) => row.state === 'succeeded').length,
    cancelled: cancelled.size,
  });
  const percentile = (p: number) =>
    [...heartbeats].sort((a, b) => a - b)[
      Math.min(heartbeats.length - 1, Math.floor(heartbeats.length * p))
    ] ?? 0;
  const result = {
    environment: { platform: process.platform, arch: process.arch, node: process.versions.node },
    observer:
      'asynchronous Core background directory; no synchronous SQLite on the measured thread',
    slots,
    submitted: 32,
    peakRunning,
    peakAdmitted,
    peakFiles,
    peakScratch,
    opened,
    peakServiceRssBytes: peakRss,
    heartbeat: { maxMs: Math.max(...heartbeats), p95Ms: percentile(0.95), p99Ms: percentile(0.99) },
    stalls,
    events,
  };
  const artifact = resolve(
    import.meta.dirname,
    '../../../../.cache',
    `windows-shell-load-${mode}-${crypto.randomUUID()}`,
  );
  privateDirectory(artifact);
  writeFileSync(join(artifact, 'RESULT.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ artifact, ...result }, null, 2));
  confirmed = true;
} finally {
  writeFileSync(join(workspace, 'release-all'), 'release');
  await runtime.close();
  if (timer) clearInterval(timer);
  if (snapshotTimer) clearInterval(snapshotTimer);
  await polling;
  await store.close();
  await locks.close();
  for (const owner of retained) owner.close();
  if (confirmed) removeTemporaryDirectory(root);
  else console.error(`Unconfirmed load fixture retained at ${root}`);
}

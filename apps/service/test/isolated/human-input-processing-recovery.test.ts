import { expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import {
  binding,
  permissions,
} from '../../../../packages/agent/test/isolated/recovery/human-input-processing-crash-fixture';
import { createDefaultProcessConfiguration } from '../../src/configuration';

async function readyLine(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let value = '';
  try {
    while (!value.includes('\n')) {
      const next = await reader.read();
      if (next.done) throw Error('service_processing_child_exit');
      value += new TextDecoder().decode(next.value);
    }
    return JSON.parse(value.split('\n')[0]!);
  } finally {
    reader.releaseLock();
  }
}
test('Service restores the exact original private processing snapshot after SIGKILL despite a changed current model configuration', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-service-processing-kill-')));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  chmodSync(profile.dataRoot, 0o700);
  chmodSync(profile.profilePath, 0o700);
  writeFileSync(join(root, 'ledger'), '');
  const path = join(profile.profilePath, 'config.jsonc');
  const config = {
    modelId: 'original-A',
    models: [
      {
        id: 'original-A',
        provider: 'compatible',
        model: 'original-A',
        baseURL: 'http://127.0.0.1:1/v1',
      },
      { id: 'B', provider: 'compatible', model: 'current-B', baseURL: 'http://127.0.0.1:1/v1' },
    ],
    tools: [],
  };
  writeFileSync(path, JSON.stringify(config));
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('../fixtures/human-input-processing-crash-child.ts', import.meta.url)),
      root,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined,
    runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    let ready: { storeId: string; runId: string; generation: string };
    try {
      ready = await readyLine(child.stdout);
    } catch (error) {
      throw Error(`${error}: ${await new Response(child.stderr).text()}`);
    }
    child.kill('SIGKILL');
    expect(await child.exited).toBe(137);
    expect(child.signalCode).toBe('SIGKILL');
    expect(await new Response(child.stderr).text()).toBe('');
    const before = readFileSync(join(root, 'ledger'), 'utf8');
    // The configured default now names B; original A still resolves only by its sealed digest.
    writeFileSync(path, JSON.stringify({ ...config, modelId: 'B' }));
    store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    const host = createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: path,
      permissions,
    });
    let recoveries = 0;
    runtime = createRuntime({
      ...host,
      store,
      permissions: host.permissions!,
      resolveRunConfiguration: async () => {
        throw Error('current_B_resolver_forbidden');
      },
      resolveRecoveryRunConfiguration: async (input) => {
        recoveries++;
        const recovered = await host.resolveRecoveryRunConfiguration!(input);
        expect(recovered.modelId).toBe('original-A');
        return { ...recovered, model: binding(root).model };
      },
    });
    host.permissionManagement?.(runtime);
    const run = await store.getRun(ready.runId);
    const cursor = (await store.getMetadata()).lastChangeCursor;
    await runtime.getView('s');
    expect(recoveries).toBe(0);
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(readFileSync(join(root, 'ledger'), 'utf8')).toBe(before);
    await runtime.resumeRun({
      expectedStoreId: ready.storeId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'resume',
      runId: ready.runId,
      expectedOwnerGeneration: ready.generation,
    });
    await runtime.waitForCommand('input', { timeoutMs: 5000 });
    expect((await store.getRun(ready.runId))?.configuration).toEqual(run?.configuration);
    expect((await store.getRun(ready.runId))?.status).toBe('completed');
    const lines = readFileSync(join(root, 'ledger'), 'utf8').trim().split('\n');
    expect(lines.filter((line) => line.startsWith('interpret:'))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('business:'))).toHaveLength(2);
    expect(recoveries).toBe(2);
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

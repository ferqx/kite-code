import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

// The seed uses the real Service assembly and pauses only after SQLite has settled
// the review, before its original business gate can dispatch the private snapshot.
async function openFixture(root: string, pause: boolean) {
  const profile = selectProfile({ dataRoot: join(root, 'profiles'), profile: 'test' });
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  const observed = new Proxy(store, {
    get(target, property) {
      if (!pause || property !== 'getAuthorizationCheck') return Reflect.get(target, property);
      return async (input: Parameters<typeof store.getAuthorizationCheck>[0]) => {
        const result = await store.getAuthorizationCheck(input);
        const target = await store.getExecution(input.targetExecutionId);
        const check = await store.getExecution(result.checkExecutionId);
        if (!check || !['succeeded', 'failed'].includes(check.status)) return result;
        if (
          target?.definitionId !== 'files.read' ||
          target.status !== 'planned' ||
          target.authorization?.dispatched !== false
        )
          throw Error('private_read_recovery_boundary_invalid');
        console.log(
          JSON.stringify({
            storeId,
            runId: target.runId,
            targetId: target.id,
            checkId: check.id,
            decision: result.decision,
          }),
        );
        await new Promise<void>(() => {});
        return result;
      };
    },
  });
  const host = createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: join(profile.profilePath, 'config.jsonc'),
    localCodex: false,
    credentialBackend: createTemporaryCredentialBackend(),
  });
  const artifacts = createArtifactStore({ profile, store });
  const locks = createWorkspaceSerialLocks(profile);
  host.bindWorkspaceSerialLocks?.(locks);
  const runtime = createRuntime({
    ...host,
    store: observed,
    artifacts,
    workspaceSerialLocks: locks,
    permissions: host.permissions!,
  });
  host.permissionManagement?.(runtime);
  return {
    profile,
    store,
    storeId,
    runtime,
    async close() {
      await runtime.close();
      await locks.close();
      await artifacts.close();
      await store.close();
    },
  };
}

async function seed(root: string) {
  const f = await openFixture(root, true);
  await f.runtime.createWorkspace({
    expectedStoreId: f.storeId,
    id: 'w',
    name: 'Owned recovery workspace',
    rootUri: pathToFileURL(join(root, 'workspace')).href,
  });
  await f.runtime.createSession({
    expectedStoreId: f.storeId,
    sessionId: 's',
    commandId: 'create',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'Private read recovery',
  });
  await initializeLivePermissionFixture({
    runtime: f.runtime,
    profile: f.profile,
    expectedStoreId: f.storeId,
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    mode: 'auto',
    trusted: true,
  });
  await f.runtime.submitCommand({
    expectedStoreId: f.storeId,
    sessionId: 's',
    commandId: 'work',
    subjectId: 'owner',
    request: { kind: 'run.start', content: 'Inspect the one explicitly requested external file.' },
  });
  await new Promise<void>(() => {});
}

async function firstLine(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let text = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) throw Error('private_read_recovery_child_exited');
      text += new TextDecoder().decode(next.value);
      if (text.includes('\n')) return text.split('\n')[0]!;
    }
  } finally {
    reader.releaseLock();
  }
}

for (const scenario of ['approve_once', 'ask_user', 'unavailable', 'corrupt-check'] as const)
  test(`cold Service loses a private external read snapshot and fails closed: ${scenario}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-private-read-recovery-')));
    const profile = selectProfile({ dataRoot: join(root, 'profiles'), profile: 'test' });
    mkdirSync(join(root, 'workspace'));
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    const targetPath = join(root, 'external.txt');
    const original = 'COLD_PRIVATE_ORIGINAL_947';
    const replacement = 'COLD_PRIVATE_REPLACEMENT_947';
    writeFileSync(targetPath, original);
    const requests: unknown[] = [];
    let business = 0;
    let reviews = 0;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { tools?: unknown[] };
        requests.push(body);
        const review = !body.tools?.length;
        if (review) reviews++;
        if (review && scenario === 'unavailable')
          return new Response('controlled review failure', { status: 503 });
        const call = !review && business++ === 0;
        const delta = review
          ? {
              content: JSON.stringify({
                decision: scenario === 'ask_user' ? 'ask_user' : 'approve_once',
                reason: 'Controlled cold review',
              }),
            }
          : call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: 'cold-read',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: JSON.stringify({ path: targetPath }),
                    },
                  },
                ],
              }
            : { content: 'Recovery finished without repeating the read.' };
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'cold', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          `${frame(delta, null)}${frame({}, call ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'fixed',
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `${provider.url.href}v1`,
          },
        ],
        tools: [{ id: 'files.read' }],
      }),
    );
    const imports = [
      ['createRuntime', '../../../../packages/agent/src/index.ts'],
      ['createArtifactStore', '../../../../packages/agent/src/artifacts.ts'],
      ['createTemporaryCredentialBackend', '../../../../packages/agent/src/config/index.ts'],
      ['selectProfile', '../../../../packages/agent/src/profile.ts'],
      ['createWorkspaceSerialLocks', '../../../../packages/agent/src/resources.ts'],
      ['openSqliteStore', '../../../../packages/agent/src/sqlite.ts'],
      ['createDefaultProcessConfiguration', '../../src/configuration.ts'],
      ['initializeLivePermissionFixture', '../fixtures/live-permission-fixture.ts'],
    ];
    const script = join(root, 'seed.ts');
    writeFileSync(
      script,
      `import {join} from 'node:path';import {pathToFileURL} from 'node:url';${imports
        .map(
          ([name, path]) =>
            `import {${name}} from ${JSON.stringify(fileURLToPath(new URL(path!, import.meta.url)))};`,
        )
        .join(
          '',
        )}const openFixture=${openFixture.toString()};await (${seed.toString()})(${JSON.stringify(root)});`,
    );
    const child = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
    let f: Awaited<ReturnType<typeof openFixture>> | undefined;
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const assertPrivate = () => {
      expect(JSON.stringify(requests)).not.toContain(original);
      expect(JSON.stringify(requests)).not.toContain(replacement);
      const db = new Database(profile.databasePath, { readonly: true });
      try {
        const bytes = db.serialize();
        expect(bytes.includes(Buffer.from(original))).toBe(false);
        expect(bytes.includes(Buffer.from(replacement))).toBe(false);
      } finally {
        db.close();
      }
      const blobs = join(profile.profilePath, 'blobs');
      if (existsSync(blobs))
        for (const entry of readdirSync(blobs, { recursive: true })) {
          const path = join(blobs, String(entry));
          if (!statSync(path).isFile()) continue;
          const bytes = readFileSync(path);
          expect(bytes.includes(Buffer.from(original))).toBe(false);
          expect(bytes.includes(Buffer.from(replacement))).toBe(false);
        }
    };
    try {
      const ready = JSON.parse(
        await Promise.race([
          firstLine(child.stdout),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error('private_read_recovery_seed_timeout')), 10000);
          }),
        ]),
      ) as {
        storeId: string;
        runId: string;
        targetId: string;
        checkId: string;
        decision: 'approve_once' | 'ask_user' | 'unavailable';
      };
      clearTimeout(timer);
      child.kill('SIGKILL');
      expect(await child.exited).toBe(137);
      expect(child.signalCode).toBe('SIGKILL');
      expect(ready.decision).toBe(scenario === 'corrupt-check' ? 'approve_once' : scenario);
      assertPrivate();
      writeFileSync(targetPath, replacement);
      f = await openFixture(root, false);
      const before = await f.runtime.getExecution(ready.targetId);
      expect(before?.status).toBe('planned');
      expect(before?.authorization?.dispatched).toBe(false);
      expect(before?.authorization?.check?.decision).toBe(ready.decision);
      if (scenario === 'corrupt-check') {
        // Fault injection affects only this owned fixture's settled check. Its
        // absent public observation must not let a corrupt cold owner dispatch.
        const db = new Database(profile.databasePath);
        db.query('UPDATE execution SET owner_generation=999 WHERE id=?').run(ready.checkId);
        db.close();
        expect(
          (await f.runtime.getExecution(ready.targetId))?.authorization?.check,
        ).toBeUndefined();
      }
      service = await startService({
        runtime: f.runtime,
        profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'fixture' },
        subjectId: 'owner',
        buildId: 'private-read-recovery',
      });
      const response = await fetch(`${service.endpoint}/v1/sessions/s/commands`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${service.bootstrap.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'run.resume',
          expectedStoreId: ready.storeId,
          commandId: 'resume',
          runId: ready.runId,
        }),
      });
      const receipt = await response.json();
      if (scenario === 'corrupt-check') {
        expect(response.status).toBe(503);
        expect(receipt).toMatchObject({
          code: 'authorization_check_unverifiable',
          retryable: false,
        });
        expect((await f.runtime.getExecution(ready.targetId))?.ownerGeneration).toBe(
          before?.ownerGeneration,
        );
      } else {
        expect(response.status).toBe(202);
        const deadline = Date.now() + 10000;
        while ((await f.runtime.getExecution(ready.targetId))?.status === 'planned') {
          if (Date.now() > deadline) throw Error('private_read_recovery_resume_timeout');
          await Bun.sleep(5);
        }
        const read = await f.runtime.getExecution(ready.targetId);
        expect(read?.status).toBe('failed');
        expect(JSON.stringify(read?.result)).toContain('file_preparation_unavailable');
        while (
          (await f.runtime.getView('s')).runs.find((run) => run.id === ready.runId)?.isActive
        ) {
          if (Date.now() > deadline) throw Error('private_read_recovery_completion_timeout');
          await Bun.sleep(5);
        }
      }
      expect((await f.runtime.getExecution(ready.targetId))?.authorization?.dispatched).toBe(false);
      expect(
        (await f.store.listExecutions('s')).filter((row) => row.definitionId === 'files.read'),
      ).toHaveLength(1);
      expect(reviews).toBe(1);
      assertPrivate();
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      const stderr = await new Response(child.stderr).text();
      if (stderr) console.error('private-read-recovery-child', stderr);
      await service?.close();
      await f?.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

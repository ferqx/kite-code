import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { launchPairedService } from '../../src/paired';

test('paired Core Tool publishes immutable scoped bytes, authenticated downloads do not change the live Run or cursor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-http-artifacts-'));
  const profile = selectProfile({ dataRoot: root, profile: 'test' });
  const handle = await launchPairedService({
    entrypoint: join(import.meta.dir, '../fixtures/artifact-child.ts'),
    profile,
    instanceId: 'artifacts',
    buildId: 'artifacts-test',
    apiMajor: 1,
    requiredCapabilities: ['commands', 'history'],
  });
  const storeId = handle.bootstrap.storeId!;
  const store = await openSqliteStore({ dataRoot: root, profile: 'test', mode: 'readonly' });
  try {
    await handle.client.createWorkspace({
      id: 'workspace',
      rootUri: 'file:///disposable',
      name: 'Artifact test',
      expectedStoreId: storeId,
    });
    for (const id of ['session', 'other'])
      await handle.client.createSession({
        commandId: `create-${id}`,
        sessionId: id,
        workspaceId: 'workspace',
        title: id,
        expectedStoreId: storeId,
      });
    await handle.client.startRun('session', {
      commandId: 'publish',
      kind: 'run.start',
      content: 'Harmless publish',
      expectedStoreId: storeId,
    });
    const deadline = Date.now() + 5000;
    let view = await handle.client.getView('session');
    while (
      !view.executions.some(
        (execution) => execution.kind === 'tool' && execution.status === 'succeeded',
      )
    ) {
      if (Date.now() > deadline) throw new Error('artifact_publish_deadline');
      await Bun.sleep(5);
      view = await handle.client.getView('session');
    }
    const tool = view.executions.find((execution) => execution.kind === 'tool')!;
    const result = tool.result as {
      artifactRefs: {
        id: string;
        mediaType: string;
        size: string;
        scope: { kind: 'execution'; id: string };
      }[];
    };
    const ref = result.artifactRefs[0]!;
    expect(ref.scope).toEqual({ kind: 'execution', id: tool.id });
    expect(view.runs[0]!.isActive).toBe(true);
    while (true) {
      let requests = 0;
      try {
        requests = readFileSync(join(profile.profilePath, 'model-ledger'), 'utf8')
          .trim()
          .split('\n').length;
      } catch {
        /* Wait for the explicit model-entry fact. */
      }
      if (requests === 2) break;
      if (Date.now() > deadline) throw new Error('artifact_model_barrier_deadline');
      await Bun.sleep(5);
    }
    const before = (await store.getMetadata()).lastChangeCursor;
    const applied = handle.client.lastAppliedCursor;
    const download = await handle.client.readArtifact('session', {
      expectedStoreId: storeId,
      refId: ref.id,
      scope: ref.scope,
    });
    expect(Array.from(download.content)).toEqual([0, 1, 2, 255, 65, 66]);
    expect(download.reference.size).toBe('6');
    expect(download.reference.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await handle.client.readArtifact('session', {
        expectedStoreId: storeId,
        refId: ref.id,
        scope: ref.scope,
      }),
    ).toEqual(download);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      handle.client.readArtifact(
        'session',
        { expectedStoreId: storeId, refId: ref.id, scope: ref.scope },
        { signal: aborted.signal },
      ),
    ).rejects.toBeDefined();
    const url = (session: string, query: Record<string, string>) =>
      `${handle.bootstrap.endpoint}/v1/sessions/${session}/artifacts/${ref.id}?${new URLSearchParams(query)}`;
    const get = (session: string, query: Record<string, string>) =>
      fetch(url(session, query), {
        headers: { authorization: `Bearer ${handle.bootstrap.token}` },
      });
    const valid = { storeId, scopeKind: 'execution', scopeId: tool.id };
    expect((await get('session', { ...valid, storeId: 'wrong-store' })).status).toBe(409);
    expect((await get('other', valid)).status).toBe(403);
    expect((await get('session', { ...valid, scopeId: 'missing' })).status).toBe(403);
    expect(
      (await get('session', { ...valid, scopeKind: 'session', scopeId: 'session' })).status,
    ).toBe(404);
    expect(
      (await get('session', { ...valid, path: '/private/secret', hash: download.reference.hash }))
        .status,
    ).toBe(400);
    expect((await fetch(url('session', valid))).status).toBe(401);
    expect((await store.getMetadata()).lastChangeCursor).toBe(before);
    expect(handle.client.lastAppliedCursor).toEqual(applied);
    expect((await handle.client.getView('session')).runs[0]!.isActive).toBe(true);
    expect(readFileSync(join(profile.profilePath, 'tool-ledger'), 'utf8')).toBe('publish\n');
    await handle.client.cancelCommand('session', {
      commandId: 'stop',
      targetCommandId: 'publish',
      kind: 'command.cancel',
      expectedStoreId: storeId,
    });
  } finally {
    await store.close();
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a real in-flight artifact GET abort remains local and another HTTP subject has no read authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-artifact-abort-'));
  const profile = selectProfile({ dataRoot: root, profile: 'test' });
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  const { createRuntime } = await import('@kite-ai/agent');
  const { createArtifactStore } = await import('@kite-ai/agent/artifacts');
  const { createClient } = await import('@kite-ai/client');
  const { startService } = await import('../../src/index');
  let releaseRead!: () => void;
  let enteredRead!: () => void;
  const readBarrier = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const readEntered = new Promise<void>((resolve) => {
    enteredRead = resolve;
  });
  let enteredModel!: () => void;
  const modelEntered = new Promise<void>((resolve) => {
    enteredModel = resolve;
  });
  let models = 0;
  const artifacts = createArtifactStore({ profile, store });
  const runtime = createRuntime({
    store,
    modelId: 'local',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
    model: {
      async *stream(_request, { signal }) {
        models++;
        enteredModel();
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        signal.throwIfAborted();
      },
    },
    artifacts: {
      publish: (input) => artifacts.publish(input),
      async read(input) {
        enteredRead();
        await readBarrier;
        return artifacts.read(input);
      },
      close: () => artifacts.close(),
    },
  });
  const host = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const service = await startService({ runtime, profile: host, buildId: 'abort' });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { profile: host, apiMajor: 1, requiredCapabilities: ['commands'] },
  });
  await client.connect();
  const storeId = service.bootstrap.storeId!;
  const peerStore = await openSqliteStore({ dataRoot: root, profile: 'test' });
  const peerArtifacts = createArtifactStore({ profile, store: peerStore });
  const peerRuntime = createRuntime({
    store: peerStore,
    artifacts: peerArtifacts,
    permissions: {
      async authorize() {
        return { allowed: false, revision: 'none' };
      },
    },
  });
  const peer = await startService({
    runtime: peerRuntime,
    profile: host,
    buildId: 'other',
    subjectId: 'intruder',
  });
  try {
    await client.createWorkspace({
      id: 'workspace',
      name: 'Abort',
      rootUri: 'file:///disposable',
      expectedStoreId: storeId,
    });
    await client.createSession({
      sessionId: 'session',
      workspaceId: 'workspace',
      commandId: 'create',
      title: 'Abort',
      expectedStoreId: storeId,
    });
    const scope = { kind: 'session' as const, id: 'session' };
    const ref = await artifacts.publish({
      expectedStoreId: storeId,
      refId: 'ref',
      sessionId: 'session',
      subjectId: 'local-user',
      scope,
      content: Uint8Array.from([65]),
      mediaType: 'text/plain',
    });
    await client.startRun('session', {
      commandId: 'run',
      kind: 'run.start',
      content: 'Harmless controlled wait',
      expectedStoreId: storeId,
    });
    await modelEntered;
    const before = (await store.getMetadata()).lastChangeCursor;
    const controller = new AbortController();
    const request = client.readArtifact(
      'session',
      { expectedStoreId: storeId, refId: ref.id, scope },
      { signal: controller.signal },
    );
    const rejection = request.catch((error) => error);
    await readEntered;
    controller.abort();
    expect((await rejection).name).toBe('AbortError');
    expect((await store.getView('session')).runs[0]!.isActive).toBe(true);
    expect(models).toBe(1);
    expect((await store.getMetadata()).lastChangeCursor).toBe(before);
    const denied = await fetch(
      `${peer.endpoint}/v1/sessions/session/artifacts/ref?${new URLSearchParams({ storeId, scopeKind: 'session', scopeId: 'session' })}`,
      { headers: { authorization: `Bearer ${peer.bootstrap.token}` } },
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe('artifact_scope_denied');
    releaseRead();
    await client.cancelCommand('session', {
      commandId: 'stop',
      targetCommandId: 'run',
      kind: 'command.cancel',
      expectedStoreId: storeId,
    });
  } finally {
    releaseRead();
    client.disposeNetwork();
    await peer.close();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

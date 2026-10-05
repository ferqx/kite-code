import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Store } from '@kite-ai/agent/storage';
import { launchPairedService } from '../../src/paired';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean, limit = 10000) {
  const deadline = Date.now() + limit;
  for (;;) {
    const value = await read();
    if (matches(value)) return value;
    if (Date.now() > deadline) throw Error('default_file_checkpoint_deadline');
    await Bun.sleep(5);
  }
}
function stamp(path: string) {
  const value = statSync(path, { bigint: true });
  return {
    size: value.size.toString(),
    inode: value.ino.toString(),
    mtime: value.mtimeNs.toString(),
    hash: hash(readFileSync(path)),
  };
}
type ProviderBody = {
  messages: { role: string; content: string }[];
  tools: { function: { name: string; parameters: unknown } }[];
};

test('Native fixed checkpoint GETs preserve two-Fork aliases, original media scope and cold zero-effect observations', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-file-checkpoint-browser-'))),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const ownedHome = join(root, 'home');
  mkdirSync(ownedHome);
  const original = Buffer.from(`\uFEFF${'完整原始字节 α\r\n'.repeat(8000)}`),
    originalPath = join(workspace, 'original.txt');
  writeFileSync(originalPath, original);
  const agents =
    'ORIGINAL_CHECKPOINT_AGENT_SOURCE\nUse only the explicitly selected ordinary Files tools.';
  writeFileSync(join(workspace, 'AGENTS.md'), agents);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const requests: ProviderBody[] = [],
    steps = new Map<string, number>();
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const body = (await request.json()) as ProviderBody;
      requests.push(body);
      const user = body.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
      const key = user.includes('SECOND_ACTUAL_RUN') ? 'second' : 'first',
        step = steps.get(key) ?? 0;
      steps.set(key, step + 1);
      let call: { name: string; input: Json } | null = null;
      if (step === 0) call = { name: 'files.read', input: { path: 'original.txt', limit: 10000 } };
      else if (step === 1) {
        const read = body.messages.filter((message) => message.role === 'tool').at(-1);
        if (!read) throw Error('actual_file_read_baseline_missing');
        const actual = JSON.parse(read.content) as { path: string; baseline: Json };
        expect(actual.path).toBe('original.txt');
        call = {
          name: 'files.write',
          input: {
            path: 'original.txt',
            base: actual.baseline,
            content: `${key} actual modified UTF8\r\n`,
          },
        };
      } else if (step === 2)
        call = {
          name: 'files.write',
          input: {
            path: `${key}-created.txt`,
            base: null,
            content: `${key} actual created bytes\r\n`,
          },
        };
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: `files-${requests.length}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        frame(
          call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${requests.length}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  },
                ],
              }
            : { content: `${key} complete` },
          null,
        ) +
          frame({}, call ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'fixed',
      models: [
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
      ],
      tools: [
        { id: 'files.read', definitionVersion: '3' },
        { id: 'files.write', definitionVersion: '2' },
      ],
    }),
  );
  const launch = (id: string) =>
    launchPairedService({
      entrypoint: join(import.meta.dir, '../../src/main.ts'),
      spawnChild: (command, { env }) =>
        Bun.spawn([...command], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...env, HOME: ownedHome },
        }),
      profile,
      instanceId: id,
      buildId: 'default-checkpoint-main',
      apiMajor: 1,
      requiredCapabilities: [
        'file_recovery',
        'extension_queries',
        'extensions_actions',
        'model_inputs',
        'interactions',
      ],
    });
  let child: Awaited<ReturnType<typeof launch>> | undefined, reader: Store | undefined;
  try {
    child = await launch('live');
    const client = child.client,
      storeId = child.bootstrap.storeId!;
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: pathToFileURL(workspace).href,
      name: 'Owned Files',
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Actual checkpoint',
    });
    const mode = await client.getPermissionMode('s', { storeId });
    expect(
      (
        await client.setPermissionMode('s', {
          expectedStoreId: storeId,
          commandId: 'mode',
          mode: 'full',
          ifRevision: mode.revision,
          makeDefault: false,
          ifDefaultRevision: mode.defaultRevision,
        })
      ).state,
    ).toBe('applied');
    const trust = await client.getWorkspaceTrust('w', { storeId });
    expect(
      (
        await client.setWorkspaceTrust('w', {
          expectedStoreId: storeId,
          commandId: 'trust',
          trusted: true,
          canonicalIdentity: trust.canonicalIdentity,
          externalReadScopeDigest: trust.externalReadScopeDigest,
          ifRevision: trust.revision,
        })
      ).state,
    ).toBe('applied');
    for (const [commandId, content] of [
      ['first', 'FIRST_ACTUAL_RUN: read then update original and create first file'],
      ['second', 'SECOND_ACTUAL_RUN: read then update original and create second file'],
    ] as const) {
      await client.startRun('s', {
        expectedStoreId: storeId,
        commandId,
        kind: 'run.start',
        content,
      });
      const command = await until(
        () => client.getCommand(commandId),
        (value) => value.status === 'applied',
      );
      const runId = (command.receipt as { runId: string }).runId;
      const run = await until(
        () => client.getRun(runId),
        (value) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(value.status),
      );
      if (run.status !== 'completed')
        console.error(
          'actual_default_files_run_failure',
          JSON.stringify({ command, run, view: await client.getView('s') }),
        );
      expect(run.status).toBe('completed');
    }

    expect(child.bootstrap.capabilities).toContain('file_recovery');
    expect(requests).toHaveLength(8);
    reader = await openSqliteStore({
      dataRoot: profile.dataRoot,
      profile: profile.profile,
      mode: 'readonly',
    });
    const page = await client.listFileCheckpoints('s');
    expect(page.payload.items).toHaveLength(2);
    const commandA = await client.getCommand('first'),
      runA = (commandA.receipt as { runId: string }).runId;
    const point = page.payload.items.find(
      (item) => item.checkpoint.boundary.runId === runA,
    )!.checkpoint;
    const detail = await client.getFileCheckpoint('s', point.id),
      originalBoundary = await client.getFileCheckpointRecoveryBoundary('s', point.id);
    expect(originalBoundary.checkpoint).toEqual(point);
    expect(originalBoundary.boundary).toBeNull();
    expect(originalBoundary.trigger).toEqual({
      messageId: point.boundary.triggerMessageId,
      seq: point.boundary.triggerSeq,
    });
    const first = await client.forkSession('s', {
      expectedStoreId: storeId,
      commandId: 'fork-one',
      expectedContextSelectionId: (await client.getView('s')).session.contextSelectionId,
      newSessionId: 'fork-one',
      title: 'First branch',
    });
    const second = await client.forkSession('fork-one', {
      expectedStoreId: storeId,
      commandId: 'fork-two',
      expectedContextSelectionId: first.selection.id,
      newSessionId: 'fork-two',
      title: 'Second branch',
    });
    const pointB = page.payload.items.find((item) => item.checkpoint.id !== point.id)!.checkpoint;
    const originalB = await client.getFileCheckpointRecoveryBoundary('s', pointB.id);
    const mappedB = await client.getFileCheckpointRecoveryBoundary('fork-two', pointB.id);
    expect(mappedB.checkpoint).toEqual(pointB);
    expect(mappedB.boundary).not.toBeNull();
    expect(mappedB.boundary!.messageId).not.toBe(originalB.boundary!.messageId);
    expect(mappedB.trigger.messageId).not.toBe(originalB.trigger.messageId);
    const mapped = await client.getFileCheckpointRecoveryBoundary('fork-two', point.id);
    expect(mapped).toMatchObject({
      storeId,
      sessionId: 'fork-two',
      workspaceId: 'w',
      contextSelectionId: second.selection.id,
      checkpoint: point,
      boundary: null,
    });
    expect(mapped.trigger.messageId).not.toBe(originalBoundary.trigger.messageId);
    const selected = await client.getContext('fork-two', {
      storeId,
      messageLimit: 200,
      sourceLimit: 100,
      byteLimit: 8 * 1024 * 1024,
    });
    expect(selected.messages.find((message) => message.id === mapped.trigger.messageId)?.seq).toBe(
      mapped.trigger.seq,
    );
    expect(
      selected.messages.find((message) => message.id === mappedB.boundary!.messageId)?.seq,
    ).toBe(mappedB.boundary!.seq);
    expect(selected.messages.find((message) => message.id === mappedB.trigger.messageId)?.seq).toBe(
      mappedB.trigger.seq,
    );
    // Owned external-editor fault probe: selected boundary is not code eligibility.
    writeFileSync(originalPath, 'OWNED_EXTERNAL_POSTIMAGE_DRIFT');
    expect(await client.getFileCheckpointRecoveryBoundary('fork-two', point.id)).toEqual(mapped);
    expect(
      (await client.getFileCheckpoint('fork-two', point.id)).payload.files.find(
        (file) => file.path === 'original.txt',
      )?.status,
    ).toBe('conflict');
    const post = stamp(originalPath),
      cursor = (await reader.getMetadata()).lastChangeCursor,
      view = await reader.getView('fork-two');
    expect(
      (await client.listFileCheckpoints('fork-two')).payload.items.find(
        (item) => item.checkpoint.id === point.id,
      )?.checkpoint,
    ).toEqual(point);
    expect((await client.getFileCheckpoint('fork-two', point.id)).payload.checkpoint).toEqual(
      point,
    );
    expect(
      (await client.getFileRestoreStatus('fork-two', point.id, 'not-submitted')).payload,
    ).toEqual({ journal: null, execution: null });
    const media = detail.payload.files.find((file) => file.path === 'original.txt')!.preimage!;
    let mediaCode: string | undefined;
    try {
      await client.readArtifact(
        'fork-two',
        { expectedStoreId: storeId, refId: media.id, scope: media.scope },
        { expectedReference: { size: media.size, mediaType: media.mediaType } },
      );
    } catch (error) {
      mediaCode = (error as { code?: string }).code;
    }
    expect(mediaCode).toBe('artifact_scope_denied');
    for (const suffix of [
      '?limit=1&limit=2',
      '?queryId=files.checkpoint.detail',
      '?limit=0',
      `/${point.id}?version=2`,
      `/${point.id}/recovery-boundary?subjectId=other`,
      '/bad',
    ]) {
      const response = await fetch(
        `${child.bootstrap.endpoint}/v1/sessions/fork-two/file-checkpoints${suffix}`,
        { headers: { authorization: `Bearer ${child.bootstrap.token}` } },
      );
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      await response.body?.cancel();
    }
    const unauth = await fetch(`${child.bootstrap.endpoint}/v1/sessions/fork-two/file-checkpoints`);
    expect(unauth.status).toBe(401);
    await unauth.body?.cancel();
    expect(await reader.getView('fork-two')).toEqual(view);
    expect((await reader.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(stamp(originalPath)).toEqual(post);
    expect(requests).toHaveLength(8);
    const last = selected.messages.at(-1)!;
    const retained = await client.rewind('fork-two', {
      expectedStoreId: storeId,
      commandId: 'retained',
      expectedContextSelectionId: second.selection.id,
      boundary: { messageId: last.id, seq: last.seq },
    });
    expect(
      (await client.getFileCheckpointRecoveryBoundary('fork-two', point.id)).contextSelectionId,
    ).toBe(retained.selection.id);
    await client.rewind('fork-two', {
      expectedStoreId: storeId,
      commandId: 'excluded',
      expectedContextSelectionId: retained.selection.id,
      boundary: null,
    });
    const excludedView = await reader.getView('fork-two'),
      excludedCursor = (await reader.getMetadata()).lastChangeCursor;
    let excludedCode: string | undefined;
    try {
      await client.getFileCheckpointRecoveryBoundary('fork-two', point.id);
    } catch (error) {
      excludedCode = (error as { code?: string }).code;
    }
    expect(excludedCode).toBe('checkpoint_branch_not_selected');
    expect(await reader.getView('fork-two')).toEqual(excludedView);
    expect((await reader.getMetadata()).lastChangeCursor).toBe(excludedCursor);
    await reader.close();
    reader = undefined;
    await child.close();
    expect(await child.exited).toBe(0);
    child = undefined;
    const foreignWriter = await openSqliteStore({
      dataRoot: profile.dataRoot,
      profile: profile.profile,
    });
    let coldCursor: string;
    try {
      await foreignWriter.createSession({
        expectedStoreId: storeId,
        subjectId: 'foreign-user',
        commandId: 'create-foreign',
        sessionId: 'foreign',
        workspaceId: 'w',
        title: 'Foreign actual creator',
      });
      coldCursor = (await foreignWriter.getMetadata()).lastChangeCursor;
    } finally {
      await foreignWriter.close();
    }
    child = await launch('cold');
    reader = await openSqliteStore({
      dataRoot: profile.dataRoot,
      profile: profile.profile,
      mode: 'readonly',
    });
    expect(await child.client.getFileCheckpointRecoveryBoundary('s', point.id)).toEqual(
      originalBoundary,
    );
    expect(
      (await child.client.getFileRestoreStatus('fork-two', point.id, 'not-submitted')).payload,
    ).toEqual({ journal: null, execution: null });
    let foreignCode: string | undefined;
    try {
      await child.client.listFileCheckpoints('foreign');
    } catch (error) {
      foreignCode = (error as { code?: string }).code;
    }
    expect(foreignCode).toBe('execution_group_scope_denied');
    expect((await reader.getMetadata()).lastChangeCursor).toBe(coldCursor!);
    expect(stamp(originalPath)).toEqual(post);
    expect(requests).toHaveLength(8);
  } finally {
    await reader?.close();
    await child?.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

for (const variant of ['missing', 'future'] as const)
  test(`Native file_recovery cannot be injected for ${variant} real Query registration`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-file-catalogue-')));
    const store = await openSqliteStore({ dataRoot: root, profile: 'owned' });
    const { createRuntime } = await import('@kite-ai/agent');
    const { createClient } = await import('@kite-ai/client');
    const { startService } = await import('../../src');
    let queries = 0,
      models = 0;
    const ids = [
      'files.checkpoints',
      'files.checkpoint.detail',
      'files.checkpoint.restore-status',
      ...(variant === 'future' ? ['files.checkpoint.recovery-boundary'] : []),
    ];
    const runtime = createRuntime({
      store,
      permissions: {
        async authorize() {
          return { allowed: false, revision: 'deny-all' };
        },
      },
      model: {
        stream() {
          models++;
          throw Error('unexpected_model');
        },
      },
      extensions: [
        {
          id: 'builtin.files',
          version: '1',
          apiMajor: 1,
          queries: ids.map((id) => ({
            id,
            version: id === 'files.checkpoint.recovery-boundary' ? '2' : '1',
            description: 'Actual catalogue admission negative, never a simulated Files result',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'array' },
            async execute() {
              queries++;
              return [];
            },
          })),
        },
      ],
    });
    const profile = { dataRoot: root, name: 'owned', accessKey: 'owned' };
    const service = await startService({
      runtime,
      profile,
      capabilities: ['file_recovery', 'extension_queries'],
      subjectId: 'owner',
      instanceId: variant,
      buildId: 'fixture',
    });
    const client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: { profile, apiMajor: 1, requiredCapabilities: [] },
    });
    try {
      await client.connect();
      expect(client.serverInfo!.capabilities).not.toContain('file_recovery');
      const cursor = (await store.getMetadata()).lastChangeCursor;
      let refused: string | undefined;
      try {
        await client.listFileCheckpoints('s');
      } catch (error) {
        refused = (error as { code?: string }).code;
      }
      expect(refused).toBe('capability_unavailable');
      const response = await fetch(`${service.endpoint}/v1/sessions/s/file-checkpoints`, {
        headers: { authorization: `Bearer ${service.bootstrap.token}` },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'capability_unavailable' });
      expect(queries).toBe(0);
      expect(models).toBe(0);
      expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    } finally {
      client.disposeNetwork();
      await service.close();
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);

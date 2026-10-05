import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ArtifactRef, Json } from '@kite-ai/agent/extensions';
import type {
  FileCheckpoint,
  FileCheckpointPreview,
  FileCheckpointRecord,
} from '@kite-ai/agent/files';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Store } from '@kite-ai/agent/storage';
import { createBrowserClient } from '@kite-ai/client/browser';
import { startDevelopmentWeb } from '../../src/development-web';
import {
  FileCheckpointDetailSchema,
  FileRestoreStatusSchema,
} from '../../src/http/schema/file-checkpoints';
import { launchPairedService } from '../../src/paired';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function canonical(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
    .join(',')}}`;
}
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

test('Cookie Browser reads actual default checkpoints, keyset preview and original restore status with no execution or byte effects', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-file-checkpoint-browser-'))),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
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
      profile,
      instanceId: id,
      buildId: 'default-checkpoint-main',
      apiMajor: 1,
      requiredCapabilities: [
        'extension_queries',
        'extensions_actions',
        'model_inputs',
        'interactions',
      ],
    });
  let child: Awaited<ReturnType<typeof launch>> | undefined, reader: Store | undefined;
  let gateway: ReturnType<typeof startDevelopmentWeb> | undefined;
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
    const actualView = await client.getView('s');
    const mutations = actualView.executions.filter(
      (execution) => execution.definitionId === 'files.write',
    );
    if (mutations.some((execution) => execution.status !== 'succeeded')) {
      const diagnostic = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      try {
        const facts = [];
        for (const mutation of mutations) {
          const tool = await diagnostic.getExecution(mutation.id);
          const source = tool?.decisionSource as { kind?: string; modelExecutionId?: string };
          const model = source?.modelExecutionId
            ? await diagnostic.getExecution(source.modelExecutionId)
            : null;
          const run = tool?.runId ? await diagnostic.getRun(tool.runId) : null;
          const command = run ? await diagnostic.getCommand(run.originCommandId) : null;
          facts.push({
            tool,
            model: model
              ? {
                  id: model.id,
                  kind: model.kind,
                  status: model.status,
                  sessionId: model.sessionId,
                  runId: model.runId,
                  originCommandId: model.originCommandId,
                  originStoreId: model.originStoreId,
                  contextSelectionId: model.contextSelectionId,
                }
              : null,
            run: run
              ? {
                  id: run.id,
                  isActive: run.isActive,
                  originCommandId: run.originCommandId,
                  rootWorkCommandId: run.rootWorkCommandId,
                  sessionId: run.sessionId,
                }
              : null,
            command: command
              ? {
                  id: command.id,
                  sessionId: command.sessionId,
                  originStoreId: command.originStoreId,
                }
              : null,
          });
        }
        console.error('actual_default_files_mutation_failure', JSON.stringify(facts));
      } finally {
        await diagnostic.close();
      }
    }
    expect(mutations).toHaveLength(4);
    expect(mutations.every((execution) => execution.status === 'succeeded')).toBe(true);
    expect(requests).toHaveLength(8);
    expect(steps.get('first')).toBe(4);
    expect(steps.get('second')).toBe(4);
    for (const request of requests)
      expect(request.tools.map((tool) => tool.function.name).sort()).toEqual([
        'files.read',
        'files.write',
      ]);
    expect(readFileSync(originalPath, 'utf8')).toBe('second actual modified UTF8\r\n');
    expect(existsSync(join(workspace, 'first-created.txt'))).toBe(true);
    expect(existsSync(join(workspace, 'second-created.txt'))).toBe(true);
    reader = await openSqliteStore({
      dataRoot: profile.dataRoot,
      profile: profile.profile,
      mode: 'readonly',
    });
    const firstCommand = await client.getCommand('first'),
      firstRunId = (firstCommand.receipt as { runId: string }).runId;
    const points = await client.queryExtension('s', 'builtin.files', 'files.checkpoints', {});
    const listed = (
      points[0]!.payload as unknown as { items: { checkpoint: FileCheckpoint; revision: string }[] }
    ).items;
    expect(listed).toHaveLength(2);
    const point = listed.find((item) => item.checkpoint.boundary.runId === firstRunId)!.checkpoint;
    expect(point.boundary).toMatchObject({
      storeId,
      sessionId: 's',
      workspaceId: 'w',
      runId: firstRunId,
      messageId: null,
      messageSeq: '0',
    });
    const details = await client.queryExtension('s', 'builtin.files', 'files.checkpoint.detail', {
        pointId: point.id,
      }),
      preview = details[0]!.payload as unknown as FileCheckpointPreview;
    expect(preview.files.map((file) => [file.path, file.status]).sort()).toEqual([
      ['first-created.txt', 'remove'],
      ['original.txt', 'restore'],
      ['second-created.txt', 'remove'],
    ]);
    const records = await reader.listExtensionRecords({
      sessionId: 's',
      extensionId: 'builtin.files',
      limit: 200,
    });
    const originalRecord = records.find(
      (record) =>
        record.contentType === 'builtin.files.checkpoint.file' &&
        (record.value as unknown as FileCheckpointRecord).checkpointId === point.id &&
        (record.value as unknown as FileCheckpointRecord).path === 'original.txt',
    )!;
    const captured = originalRecord.value as unknown as FileCheckpointRecord;
    expect(originalRecord.originStoreId).toBe(storeId);
    expect(captured.state).toBe('captured');
    expect(captured.first!.baseline!.hash).toBe(hash(original));
    expect(captured.first!.baseline!.size).toBe(original.length);
    expect(captured.first!.source.definitionVersion).toBe('2');
    const source = captured.first!.source,
      tool = await reader.getExecution(source.executionId),
      model = await client.getModelInput('s', source.modelExecutionId);
    expect(tool).toMatchObject({
      kind: 'tool',
      status: 'succeeded',
      definitionId: 'files.write',
      definitionVersion: '2',
      originStoreId: storeId,
      sessionId: 's',
      runId: firstRunId,
    });
    expect(source.inputDigest).toBe(hash(canonical(tool!.input)));
    expect(source.attempt).toBe(tool!.attempt);
    expect(source.modelExecutionId).toBe(
      (tool!.decisionSource as { modelExecutionId: string }).modelExecutionId,
    );
    expect(model.confirmation).toBe('succeeded');
    expect(model.bodyHash).toBe(source.modelInputHash);
    expect(Number(model.bodyBytes)).toBeGreaterThan(65536);
    expect(model.request.messages.some((message) => message.content === agents)).toBe(true);
    expect(
      model.request.messages.some(
        (message) => message.role === 'user' && message.content.startsWith('FIRST_ACTUAL_RUN'),
      ),
    ).toBe(true);
    const actualRun = await reader.getRun(firstRunId);
    expect(point.boundary.contextSelectionId).toBe(actualRun!.contextSelectionId);
    const immutablePoint = records.find(
      (record) =>
        record.contentType === 'builtin.files.checkpoint' &&
        (record.value as unknown as FileCheckpoint).id === point.id,
    )!;
    expect(immutablePoint.originStoreId).toBe(storeId);
    expect(immutablePoint.value as unknown as FileCheckpoint).toEqual(point);
    expect(
      model.request.messages.some(
        (message) => message.role === 'user' && message.content.startsWith('SECOND_ACTUAL_RUN'),
      ),
    ).toBe(false);
    const currentUsers = (await reader.getView('s')).messages.filter(
      (message) => message.role === 'user',
    );
    expect(currentUsers.at(-1)!.content.startsWith('SECOND_ACTUAL_RUN')).toBe(true);
    expect(
      currentUsers
        .find((message) => message.id === point.boundary.triggerMessageId)!
        .content.startsWith('FIRST_ACTUAL_RUN'),
    ).toBe(true);
    expect(JSON.stringify(actualRun!.configuration)).toContain('builtin.files');
    expect(JSON.stringify(actualRun!.configuration)).toContain('files.write');
    const preimage = preview.files.find((file) => file.path === 'original.txt')!
      .preimage as ArtifactRef;
    expect(preimage.scope).toEqual({ kind: 'execution', id: source.executionId });
    const body = await client.readArtifact(
      's',
      { expectedStoreId: storeId, refId: preimage.id, scope: preimage.scope! },
      { expectedReference: { size: preimage.size, mediaType: preimage.mediaType } },
    );
    expect(Buffer.from(body.content)).toEqual(original);
    gateway = startDevelopmentWeb({ admittedClient: client });
    const pageResponse = await fetch(gateway.endpoint);
    const cookie = pageResponse.headers.get('set-cookie')!.split(';')[0]!;
    await pageResponse.body?.cancel();
    const browser = createBrowserClient({
      origin: gateway.endpoint,
      pageIdentity: gateway.pageIdentity,
      fetch: Object.assign(
        (url: URL | RequestInfo, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          expect(headers.has('authorization')).toBe(false);
          headers.set('cookie', cookie);
          return fetch(url, { ...init, headers });
        },
        { preconnect: fetch.preconnect },
      ),
    });
    expect((await browser.connect()).capabilities).toContain('file_checkpoints');
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create-other-browser-scope',
      sessionId: 'other',
      workspaceId: 'w',
      title: 'Independent current scope',
    });
    const beforeRead = await reader.getView('s'),
      beforeCursor = (await reader.getMetadata()).lastChangeCursor,
      beforeBytes = stamp(originalPath);
    const first = await browser.listFileCheckpoints('s', { limit: 1, afterKey: undefined });
    expect(first).toMatchObject({ storeId, sessionId: 's', workspaceId: 'w' });
    expect(first.payload.items).toHaveLength(1);
    expect(first.payload.nextAfterKey).not.toBeNull();
    const second = await browser.listFileCheckpoints('s', {
      limit: 1,
      afterKey: first.payload.nextAfterKey!,
    });
    expect(second.payload.items).toHaveLength(1);
    expect(second.payload.nextAfterKey).not.toBeNull();
    const end = await browser.listFileCheckpoints('s', {
      limit: 1,
      afterKey: second.payload.nextAfterKey!,
    });
    expect(end.payload).toEqual({ items: [], nextAfterKey: null });
    expect(
      [...first.payload.items, ...second.payload.items].map((item) => item.checkpoint),
    ).toEqual(listed.map((item) => item.checkpoint));
    const actualDetail = await browser.getFileCheckpoint('s', point.id);
    expect(actualDetail.payload).toEqual(
      FileCheckpointDetailSchema.parse({
        storeId,
        sessionId: 's',
        workspaceId: 'w',
        payload: preview,
      }).payload,
    );
    expect(actualDetail.payload.checkpoint.boundary).toEqual(point.boundary);
    expect((await browser.listFileCheckpoints('other')).payload.items).toEqual([]);
    let foreignCode: string | undefined;
    try {
      await browser.getFileCheckpoint('other', point.id);
    } catch (error) {
      foreignCode =
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : undefined;
    }
    expect(foreignCode).toBe('checkpoint_not_found');
    expect(await browser.getFileRestoreStatus('s', point.id, 'never-started')).toEqual({
      storeId,
      sessionId: 's',
      workspaceId: 'w',
      payload: { journal: null, execution: null },
    });
    const direct = (suffix: string, init: RequestInit = {}) =>
      fetch(`${gateway!.endpoint}/browser/v1/sessions/s/file-checkpoints${suffix}`, {
        ...init,
        headers: { cookie, 'x-kite-web-identity': gateway!.pageIdentity, ...init.headers },
      });
    for (const suffix of [
      '?queryId=files.checkpoints',
      '?input={}',
      '?limit=1&limit=2',
      '?afterKey=bad',
      `/${point.id}?action=restore`,
      `/${point.id}/restores/id?version=2`,
      '/invalid',
    ]) {
      const response = await direct(suffix);
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      await response.body?.cancel();
    }
    expect((await direct('', { method: 'POST' })).status).toBe(405);
    expect((await direct('', { headers: { authorization: 'Bearer NEVER_NATIVE' } })).status).toBe(
      403,
    );
    const unauth = await fetch(`${gateway.endpoint}/browser/v1/sessions/s/file-checkpoints`, {
      headers: { 'x-kite-web-identity': gateway.pageIdentity },
    });
    expect(unauth.status).toBe(401);
    await unauth.body?.cancel();
    const controller = new AbortController();
    controller.abort();
    let cancelled = false;
    try {
      await browser.getFileCheckpoint('s', point.id, { signal: controller.signal });
    } catch {
      cancelled = true;
    }
    expect(cancelled).toBe(true);
    writeFileSync(originalPath, 'actual external postimage drift');
    const conflict = await browser.getFileCheckpoint('s', point.id);
    expect(conflict.payload.files.find((file) => file.path === 'original.txt')?.status).toBe(
      'conflict',
    );
    writeFileSync(originalPath, 'second actual modified UTF8\r\n');
    const heldPath = join(workspace, 'owned-held-original');
    renameSync(originalPath, heldPath);
    symlinkSync(join(profile.profilePath, 'config.jsonc'), originalPath);
    try {
      const protectedPreview = await browser.getFileCheckpoint('s', point.id);
      const protectedFile = protectedPreview.payload.files.find(
        (file) => file.path === 'original.txt',
      );
      expect(protectedFile?.status).toBe('conflict');
      expect(protectedFile?.reason).not.toBeNull();
      expect(JSON.stringify(protectedPreview)).not.toContain(provider.url.href);
    } finally {
      unlinkSync(originalPath);
      renameSync(heldPath, originalPath);
    }

    expect(stamp(originalPath).hash).toBe(beforeBytes.hash);
    expect((await reader.getMetadata()).lastChangeCursor).toBe(beforeCursor);
    expect(await reader.getView('s')).toEqual(beforeRead);
    expect(requests).toHaveLength(8);
    expect(JSON.stringify(actualDetail)).not.toContain('ORIGINAL_CHECKPOINT_AGENT_SOURCE');
    expect(JSON.stringify(actualDetail)).not.toContain('完整原始字节');
    const input = {
      expectedStoreId: storeId,
      commandId: 'restore-original',
      kind: 'extension.invoke' as const,
      extensionId: 'builtin.files',
      actionId: 'files.checkpoint.restore',
      definitionVersion: '1',
      input: { checkpointId: point.id, restoreId: 'explicit-first' },
    };
    const beforeRestore = stamp(originalPath);
    await client.invokeExtension('s', input);
    const cards = await until(
      () => client.listInteractions('s', { storeId, state: 'pending', limit: 100 }),
      (value) =>
        value.interactions.some(
          (card) => card.definitionId === 'builtin.files/files.checkpoint.restore',
        ),
    );
    const card = cards.interactions.find(
      (card) => card.definitionId === 'builtin.files/files.checkpoint.restore',
    )!;
    expect(card.definitionVersion).toBe('1');
    expect(card.kind).toBe('approval');
    expect(card.runId).toBeNull();
    expect(stamp(originalPath)).toEqual(beforeRestore);
    expect(existsSync(join(workspace, 'first-created.txt'))).toBe(true);
    const carrier = await reader.getExecution(card.executionId!);
    expect(carrier).toMatchObject({
      kind: 'job',
      runId: null,
      definitionId: 'builtin.files/files.checkpoint.restore',
      status: 'planned',
    });
    await client.answerInteraction('s', card.id, {
      expectedStoreId: storeId,
      commandId: 'approve-restore',
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    const restored = await until(
      () => client.getExecution(card.executionId!),
      (value) => ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(value.status),
    );
    if (restored.status !== 'succeeded')
      console.error('actual_default_restore_failure', JSON.stringify(restored));
    expect(restored.status).toBe('succeeded');
    expect(readFileSync(originalPath)).toEqual(original);
    expect(existsSync(join(workspace, 'first-created.txt'))).toBe(false);
    expect(existsSync(join(workspace, 'second-created.txt'))).toBe(false);
    expect(requests).toHaveLength(8);
    const status = await client.queryExtension(
      's',
      'builtin.files',
      'files.checkpoint.restore-status',
      { checkpointId: point.id, restoreId: 'explicit-first' },
    );
    expect(status[0]!.payload).toMatchObject({
      journal: { phase: 'restored' },
      execution: { id: card.executionId, status: 'succeeded' },
    });
    const statusBefore = await reader.getView('s'),
      statusCursor = (await reader.getMetadata()).lastChangeCursor;
    const observedStatus = await browser.getFileRestoreStatus('s', point.id, 'explicit-first');
    expect(observedStatus.payload).toEqual(
      FileRestoreStatusSchema.parse({
        storeId,
        sessionId: 's',
        workspaceId: 'w',
        payload: status[0]!.payload,
      }).payload,
    );
    expect(observedStatus.payload.journal && 'rootWorkSeq' in observedStatus.payload.journal).toBe(
      true,
    );
    expect(observedStatus.payload.execution).toEqual({
      id: card.executionId!,
      status: 'succeeded',
      resultRevision: restored.resultRevision,
    });
    expect(await reader.getView('s')).toEqual(statusBefore);
    expect((await reader.getMetadata()).lastChangeCursor).toBe(statusCursor);
    await gateway.close();
    gateway = undefined;
    const command = await client.getCommand(input.commandId),
      afterRestore = stamp(originalPath);
    expect(await client.invokeExtension('s', input)).toEqual(command);
    expect(await client.getCommand(input.commandId)).toEqual(command);
    expect(stamp(originalPath)).toEqual(afterRestore);
    expect(
      (await client.listInteractions('s', { storeId, state: 'pending', limit: 100 })).interactions,
    ).toEqual([]);
    const metadata = await reader.getMetadata();
    const allBefore = await reader.getView('s');
    await reader.close();
    reader = undefined;
    await child.close();
    expect(await child.exited).toBe(0);
    child = undefined;
    child = await launch('cold');
    expect(child.bootstrap.storeId).toBe(storeId);
    reader = await openSqliteStore({
      dataRoot: profile.dataRoot,
      profile: profile.profile,
      mode: 'readonly',
    });
    expect(
      await child.client.queryExtension('s', 'builtin.files', 'files.checkpoint.restore-status', {
        checkpointId: point.id,
        restoreId: 'explicit-first',
      }),
    ).toEqual(status);
    expect(
      await child.client.queryExtension('s', 'builtin.files', 'files.checkpoints', {}),
    ).toEqual(points);
    expect(await child.client.getCommand(input.commandId)).toEqual(command);
    expect((await child.client.getModelInput('s', source.modelExecutionId)).request).toEqual(
      model.request,
    );
    const coldBody = await child.client.readArtifact(
      's',
      { expectedStoreId: storeId, refId: preimage.id, scope: preimage.scope! },
      { expectedReference: { size: preimage.size, mediaType: preimage.mediaType } },
    );
    expect(Buffer.from(coldBody.content)).toEqual(original);
    gateway = startDevelopmentWeb({ admittedClient: child.client });
    const coldPage = await fetch(gateway.endpoint),
      coldCookie = coldPage.headers.get('set-cookie')!.split(';')[0]!;
    await coldPage.body?.cancel();
    const coldBrowser = createBrowserClient({
      origin: gateway.endpoint,
      pageIdentity: gateway.pageIdentity,
      fetch: Object.assign(
        (url: URL | RequestInfo, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          headers.set('cookie', coldCookie);
          return fetch(url, { ...init, headers });
        },
        { preconnect: fetch.preconnect },
      ),
    });
    await coldBrowser.connect();
    expect(
      (await coldBrowser.getFileRestoreStatus('s', point.id, 'explicit-first')).payload,
    ).toEqual(observedStatus.payload);
    expect(
      (await coldBrowser.listFileCheckpoints('s')).payload.items.map((item) => item.checkpoint),
    ).toEqual(listed.map((item) => item.checkpoint));
    expect(stamp(originalPath)).toEqual(afterRestore);
    expect((await reader.getMetadata()).lastChangeCursor).toBe(metadata.lastChangeCursor);
    expect(await reader.getView('s')).toEqual(allBefore);
    expect(requests).toHaveLength(8);
    const currentSession = (await child.client.getView('s')).session;
    const unselected = await child.client.rewind('s', {
      expectedStoreId: storeId,
      commandId: 'owned-browser-unselect',
      expectedContextSelectionId: currentSession.contextSelectionId,
      boundary: null,
    });
    expect(unselected.selection.sessionId).toBe('s');
    const unavailableBefore = await reader.getView('s'),
      unavailableCursor = (await reader.getMetadata()).lastChangeCursor,
      unavailableBytes = stamp(originalPath);
    const unavailable = await coldBrowser.getFileCheckpoint('s', point.id);
    expect(unavailable.payload.files.length).toBeGreaterThan(0);
    expect(
      unavailable.payload.files.every(
        (file) => file.status === 'unavailable' && file.reason !== null,
      ),
    ).toBe(true);
    expect(await reader.getView('s')).toEqual(unavailableBefore);
    expect((await reader.getMetadata()).lastChangeCursor).toBe(unavailableCursor);
    expect(stamp(originalPath)).toEqual(unavailableBytes);
    expect(requests).toHaveLength(8);
  } finally {
    await gateway?.close();
    await reader?.close();
    await child?.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

// Future query registration is real public catalogue metadata, not a simulated Files success.
test('Cookie capability refuses future or incomplete Files Query registrations before any query execution', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-browser-checkpoint-catalogue-')));
  const store = await openSqliteStore({ dataRoot: root, profile: 'owned' });
  let queries = 0,
    models = 0;
  const { createRuntime } = await import('@kite-ai/agent');
  const { createClient } = await import('@kite-ai/client');
  const { startService } = await import('../../src');
  const runtime = createRuntime({
    store,
    permissions: {
      async authorize() {
        return { allowed: false, revision: 'deny-all-execution' };
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
        queries: [
          'files.checkpoints',
          'files.checkpoint.detail',
          'files.checkpoint.restore-status',
        ].map((id) => ({
          id,
          version: id === 'files.checkpoint.detail' ? '2' : '1',
          description: 'Actual future catalogue registration',
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
  const profile = { dataRoot: root, name: 'owned', accessKey: 'owned-test' };
  const service = await startService({
    runtime,
    profile,
    subjectId: 'owner',
    instanceId: 'future',
    buildId: 'fixture',
  });
  let gateway: ReturnType<typeof startDevelopmentWeb> | undefined;
  try {
    const client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        profile,
        instanceId: 'future',
        buildId: 'fixture',
        apiMajor: 1,
        requiredCapabilities: ['extension_queries'],
      },
    });
    await client.connect();
    gateway = startDevelopmentWeb({ admittedClient: client });
    const page = await fetch(gateway.endpoint),
      cookie = page.headers.get('set-cookie')!.split(';')[0]!;
    await page.body?.cancel();
    const headers = { cookie, 'x-kite-web-identity': gateway.pageIdentity };
    const cursor = (await store.getMetadata()).lastChangeCursor;
    const info = await fetch(`${gateway.endpoint}/browser/v1/server`, { headers });
    const body = (await info.json()) as { capabilities: string[] };
    expect(body.capabilities).not.toContain('file_checkpoints');
    const response = await fetch(`${gateway.endpoint}/browser/v1/sessions/s/file-checkpoints`, {
      headers,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'capability_unavailable' });
    expect(queries).toBe(0);
    expect(models).toBe(0);
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await gateway?.close();
    await service.close();
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

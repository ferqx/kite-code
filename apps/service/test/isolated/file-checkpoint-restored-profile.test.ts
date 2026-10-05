import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
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
import type { ArtifactRef, Json } from '@kite-ai/agent/extensions';
import type {
  FileCheckpoint,
  FileCheckpointPreview,
  FileCheckpointRecord,
} from '@kite-ai/agent/files';
import {
  createProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Store } from '@kite-ai/agent/storage';
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

test('default Files original capture survives public offline restore to a new profile and Store; current restore asks independently without replaying original work', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-file-checkpoint-restored-profile-'))),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const ownedHome = join(root, 'home');
  mkdirSync(ownedHome, { mode: 0o700 });
  const original = Buffer.from(`\uFEFF${'完整原始字节 α\r\n'.repeat(8000)}`),
    originalPath = join(workspace, 'original.txt');
  writeFileSync(originalPath, original);
  const agents =
    'ORIGINAL_CHECKPOINT_AGENT_SOURCE\nUse only the explicitly selected ordinary Files tools.';
  writeFileSync(join(workspace, 'AGENTS.md'), agents);
  const profileA = selectProfile({ dataRoot: join(root, 'data-a'), profile: 'owned' });
  const profileB = selectProfile({ dataRoot: join(root, 'data-b'), profile: 'owned' });
  let profile = profileA;
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
    { mode: 0o600 },
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
    if (client.serverInfo?.dataAvailability !== 'available')
      console.error(
        'restored_profile_initial_service_unavailable',
        JSON.stringify(client.serverInfo),
      );
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
    const mutations = (await client.getView('s')).executions.filter(
      (execution) => execution.definitionId === 'files.write',
    );
    expect(mutations).toHaveLength(2);
    expect(mutations.every((execution) => execution.status === 'succeeded')).toBe(true);
    expect(requests).toHaveLength(4);
    reader = await openSqliteStore({
      dataRoot: profile.dataRoot,
      profile: profile.profile,
      mode: 'readonly',
    });
    const pointsA = await client.queryExtension('s', 'builtin.files', 'files.checkpoints', {});
    const point = (pointsA[0]!.payload as unknown as { items: { checkpoint: FileCheckpoint }[] })
      .items[0]!.checkpoint;
    const recordsA = await reader.listExtensionRecords({
      sessionId: 's',
      extensionId: 'builtin.files',
      limit: 200,
    });
    const originalRecord = recordsA.find(
      (record) =>
        record.contentType === 'builtin.files.checkpoint.file' &&
        (record.value as unknown as FileCheckpointRecord).path === 'original.txt',
    )!;
    const captured = originalRecord.value as unknown as FileCheckpointRecord;
    const source = captured.first!.source;
    const modelA = await client.getModelInput('s', source.modelExecutionId);
    const previewA = (
      await client.queryExtension('s', 'builtin.files', 'files.checkpoint.detail', {
        pointId: point.id,
      })
    )[0]!.payload as unknown as FileCheckpointPreview;
    const ref = previewA.files.find((file) => file.path === 'original.txt')!
      .preimage as ArtifactRef;
    expect(
      (
        await client.readArtifact('s', {
          expectedStoreId: storeId,
          refId: ref.id,
          scope: ref.scope!,
        })
      ).reference.storeId,
    ).toBe(storeId);
    expect(point.boundary.storeId).toBe(storeId);
    expect(modelA.bodyHash).toBe(source.modelInputHash);
    expect(Number(modelA.bodyBytes)).toBeGreaterThan(65536);
    expect(captured.first!.baseline!.hash).toBe(hash(original));
    const originalCommand = await reader.getCommand('first');
    const originalTool = await reader.getExecution(source.executionId);
    expect(source.inputDigest).toBe(hash(canonical(originalTool!.input)));
    await reader.close();
    reader = undefined;
    await child.close();
    expect(await child.exited).toBe(0);
    child = undefined;
    const backup = await createProfileBackup({
      profile: profileA,
      destinationRoot: join(root, 'backups'),
    });
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    const target = await openSqliteStore({
      dataRoot: profileB.dataRoot,
      profile: profileB.profile,
    });
    const targetStoreId = (await target.getMetadata()).storeId;
    await target.close();
    const restoredProfile = await restoreProfileBackup({
      profile: profileB,
      expectedStoreId: targetStoreId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restoredProfile.outcome).toBe('restored');
    expect(restoredProfile.storeId).not.toBe(storeId);
    expect(restoredProfile.storeId).not.toBe(targetStoreId);
    profile = profileB;
    child = await launch('restored-b');
    const current = child.client,
      storeB = child.bootstrap.storeId!;
    expect(storeB).toBe(restoredProfile.storeId);
    reader = await openSqliteStore({
      dataRoot: profile.dataRoot,
      profile: profile.profile,
      mode: 'readonly',
    });
    expect(await reader.getCommand('first')).toEqual(originalCommand);
    expect(await reader.getExecution(source.executionId)).toEqual(originalTool);
    expect((await current.getModelInput('s', source.modelExecutionId)).request).toEqual(
      modelA.request,
    );
    expect(await current.queryExtension('s', 'builtin.files', 'files.checkpoints', {})).toEqual(
      pointsA,
    );
    const mediaB = await current.readArtifact(
      's',
      { expectedStoreId: storeB, refId: ref.id, scope: ref.scope! },
      { expectedReference: { size: ref.size, mediaType: ref.mediaType } },
    );
    expect(Buffer.from(mediaB.content)).toEqual(original);
    expect(mediaB.reference).toMatchObject({
      storeId,
      scope: ref.scope,
      hash: hash(original),
      size: String(original.length),
    });
    const recordsB = await reader.listExtensionRecords({
      sessionId: 's',
      extensionId: 'builtin.files',
      limit: 200,
    });
    expect(recordsB).toEqual(recordsA);
    const detail = await current.queryExtension('s', 'builtin.files', 'files.checkpoint.detail', {
      pointId: point.id,
    });
    const previewB = detail[0]!.payload as unknown as FileCheckpointPreview;
    if (previewB.files.some((file) => file.status === 'unavailable' || file.status === 'conflict'))
      console.error(
        'restored_default_checkpoint_continuity_failure',
        JSON.stringify({
          storeA: storeId,
          storeB,
          point,
          originalRecord,
          source,
          originalCommand,
          originalTool,
          modelHash: modelA.bodyHash,
          originalRef: ref,
          previewA,
          previewB,
          restoredProfile,
        }),
      );
    expect(previewB).toEqual(previewA);
    // A different actual Session cannot consume A's original media or checkpoint just because it shares the Workspace.
    await current.createSession({
      expectedStoreId: storeB,
      commandId: 'create-foreign',
      sessionId: 'foreign',
      workspaceId: 'w',
      title: 'Independent Session',
    });
    const denied = async (work: Promise<unknown>) => {
      let caught: unknown;
      try {
        await work;
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      return (caught as { code?: string }).code ?? (caught as Error).message;
    };
    expect(
      await denied(
        current.readArtifact('foreign', {
          expectedStoreId: storeB,
          refId: ref.id,
          scope: ref.scope!,
        }),
      ),
    ).toBe('artifact_scope_denied');
    expect(
      await denied(
        current.queryExtension('foreign', 'builtin.files', 'files.checkpoint.detail', {
          pointId: point.id,
        }),
      ),
    ).toBe('checkpoint_not_found');
    expect(requests).toHaveLength(4);
    const postimage = readFileSync(originalPath);
    writeFileSync(originalPath, 'ACTUAL_EXTERNAL_POSTIMAGE_DRIFT');
    const driftStamp = stamp(originalPath);
    const driftPreview = (
      await current.queryExtension('s', 'builtin.files', 'files.checkpoint.detail', {
        pointId: point.id,
      })
    )[0]!.payload as unknown as FileCheckpointPreview;
    expect(driftPreview.files.find((file) => file.path === 'original.txt')).toMatchObject({
      status: 'conflict',
      reason: 'checkpoint_postimage_conflict',
    });
    await current.invokeExtension('s', {
      expectedStoreId: storeB,
      commandId: 'restore-drift',
      kind: 'extension.invoke',
      extensionId: 'builtin.files',
      actionId: 'files.checkpoint.restore',
      definitionVersion: '1',
      input: { checkpointId: point.id, restoreId: 'drift-must-not-write' },
    });
    const refused = await until(
      () => current.getCommand('restore-drift'),
      (value) => value.status !== 'accepted',
    );
    console.info('restored_checkpoint_postimage_refusal', JSON.stringify(refused));
    expect(refused.status).toBe('rejected');
    expect(refused.receipt).toEqual({ reason: 'checkpoint_restore_conflict' });
    expect(
      (await reader.listExecutions('s')).filter(
        (execution) => execution.originCommandId === 'restore-drift',
      ),
    ).toEqual([]);
    expect(stamp(originalPath)).toEqual(driftStamp);
    expect(existsSync(join(workspace, 'first-created.txt'))).toBe(true);
    expect(
      (await current.listInteractions('s', { storeId: storeB, state: 'pending', limit: 100 }))
        .interactions,
    ).toEqual([]);
    expect(
      (
        await current.queryExtension('s', 'builtin.files', 'files.checkpoint.restore-status', {
          checkpointId: point.id,
          restoreId: 'drift-must-not-write',
        })
      )[0]!.payload,
    ).toMatchObject({ journal: null });
    expect(requests).toHaveLength(4);
    // This restores only the test-owned external editor's bytes; checkpoint restoration still requires its independent Action.
    writeFileSync(originalPath, postimage);
    expect(
      (
        await current.queryExtension('s', 'builtin.files', 'files.checkpoint.detail', {
          pointId: point.id,
        })
      )[0]!.payload,
    ).toEqual(previewA as unknown as Json);
    // Current B control decisions use B's own CAS; restored A approvals are not copied into a new grant.
    const modeB = await current.getPermissionMode('s', { storeId: storeB });
    expect(
      (
        await current.setPermissionMode('s', {
          expectedStoreId: storeB,
          commandId: 'mode-b',
          mode: 'full',
          ifRevision: modeB.revision,
          makeDefault: false,
          ifDefaultRevision: modeB.defaultRevision,
        })
      ).state,
    ).toBe('applied');
    const trustB = await current.getWorkspaceTrust('w', { storeId: storeB });
    expect(
      (
        await current.setWorkspaceTrust('w', {
          expectedStoreId: storeB,
          commandId: 'trust-b',
          trusted: true,
          canonicalIdentity: trustB.canonicalIdentity,
          externalReadScopeDigest: trustB.externalReadScopeDigest,
          ifRevision: trustB.revision,
        })
      ).state,
    ).toBe('applied');
    await current.startRun('s', {
      expectedStoreId: storeB,
      commandId: 'second-in-b',
      kind: 'run.start',
      content: 'SECOND_ACTUAL_RUN: read actual A postimage then update and create in B',
    });
    const newCommand = await until(
      () => current.getCommand('second-in-b'),
      (value) => value.status === 'applied',
    );
    const runBId = (newCommand.receipt as { runId: string }).runId;
    const newRun = await until(
      () => current.getRun(runBId),
      (value) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(value.status),
    );
    expect(newRun.status).toBe('completed');
    const actualBMutations = (await reader.listExecutions('s')).filter(
      (execution) =>
        execution.originCommandId === 'second-in-b' && execution.definitionId === 'files.write',
    );
    if (actualBMutations.some((execution) => execution.status !== 'succeeded'))
      console.error(
        'restored_checkpoint_new_b_write_failure',
        JSON.stringify({ newCommand, newRun, actualBMutations }),
      );
    expect(actualBMutations).toHaveLength(2);
    expect(
      actualBMutations.every(
        (execution) => execution.status === 'succeeded' && execution.originStoreId === storeB,
      ),
    ).toBe(true);
    expect((await reader.getCommand('second-in-b'))!.originStoreId).toBe(storeB);
    expect((await reader.getRun(runBId))!.originStoreId).toBe(storeB);
    expect(requests).toHaveLength(8);
    const mixedPoints = await current.queryExtension('s', 'builtin.files', 'files.checkpoints', {});
    const mixedItems = (
      mixedPoints[0]!.payload as unknown as { items: { checkpoint: FileCheckpoint }[] }
    ).items;
    expect(mixedItems).toHaveLength(2);
    expect(mixedItems.find((item) => item.checkpoint.id === point.id)!.checkpoint).toEqual(point);
    const pointB = mixedItems.find((item) => item.checkpoint.boundary.runId === runBId)!.checkpoint;
    expect(pointB.boundary.storeId).toBe(storeB);
    const mixedRecords = await reader.listExtensionRecords({
      sessionId: 's',
      extensionId: 'builtin.files',
      limit: 200,
    });
    const newOriginalRecord = mixedRecords.find(
      (record) =>
        record.contentType === 'builtin.files.checkpoint.file' &&
        (record.value as unknown as FileCheckpointRecord).checkpointId === pointB.id &&
        (record.value as unknown as FileCheckpointRecord).path === 'original.txt',
    )!;
    const capturedB = newOriginalRecord.value as unknown as FileCheckpointRecord;
    expect(newOriginalRecord.originStoreId).toBe(storeB);
    expect(capturedB.first!.baseline).toEqual(captured.last!.baseline);
    const toolB = await reader.getExecution(capturedB.first!.source.executionId);
    expect(toolB!.originStoreId).toBe(storeB);
    const modelB = await reader.getExecution(capturedB.first!.source.modelExecutionId);
    expect(modelB!.originStoreId).toBe(storeB);
    expect((await current.getModelInput('s', modelB!.id)).bodyHash).toBe(
      capturedB.first!.source.modelInputHash,
    );
    expect((await reader.getExecution(source.executionId))!.originStoreId).toBe(storeId);
    const mixedPreview = (
      await current.queryExtension('s', 'builtin.files', 'files.checkpoint.detail', {
        pointId: point.id,
      })
    )[0]!.payload as unknown as FileCheckpointPreview;
    if (
      mixedPreview.files.some((file) => file.status === 'conflict' || file.status === 'unavailable')
    )
      console.error(
        'restored_checkpoint_mixed_chain_failure',
        JSON.stringify({
          storeA: storeId,
          storeB,
          point,
          pointB,
          capturedA: captured,
          capturedB,
          mixedPreview,
        }),
      );
    expect(mixedPreview.files.map((file) => [file.path, file.status]).sort()).toEqual([
      ['first-created.txt', 'remove'],
      ['original.txt', 'restore'],
      ['second-created.txt', 'remove'],
    ]);
    expect(mixedPreview.files.find((file) => file.path === 'original.txt')!.preimage).toEqual(ref);
    const input = {
      expectedStoreId: storeB,
      commandId: 'restore-in-b',
      kind: 'extension.invoke' as const,
      extensionId: 'builtin.files',
      actionId: 'files.checkpoint.restore',
      definitionVersion: '1',
      input: { checkpointId: point.id, restoreId: 'b-explicit' },
    };
    const before = stamp(originalPath);
    await current.invokeExtension('s', input);
    const cards = await until(
      () => current.listInteractions('s', { storeId: storeB, state: 'pending', limit: 100 }),
      (value) =>
        value.interactions.some(
          (card) => card.definitionId === 'builtin.files/files.checkpoint.restore',
        ),
    );
    const card = cards.interactions.find(
      (card) => card.definitionId === 'builtin.files/files.checkpoint.restore',
    )!;
    expect(card.kind).toBe('approval');
    expect(card.runId).toBeNull();
    expect(stamp(originalPath)).toEqual(before);
    expect(await reader.getExecution(card.executionId!)).toMatchObject({
      originStoreId: storeB,
      kind: 'job',
      runId: null,
      status: 'planned',
    });
    await current.answerInteraction('s', card.id, {
      expectedStoreId: storeB,
      commandId: 'approve-b',
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    const restored = await until(
      () => current.getExecution(card.executionId!),
      (value) => ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(value.status),
    );
    expect(restored.status).toBe('succeeded');
    expect(readFileSync(originalPath)).toEqual(original);
    expect(existsSync(join(workspace, 'first-created.txt'))).toBe(false);
    expect(existsSync(join(workspace, 'second-created.txt'))).toBe(false);
    expect(await reader.getExecution(source.executionId)).toEqual(originalTool);
    expect(requests).toHaveLength(8);
    const receipt = await current.getCommand(input.commandId),
      after = stamp(originalPath),
      cursor = (await reader.getMetadata()).lastChangeCursor;
    expect(receipt.originStoreId).toBe(storeB);
    const answered = (
      await current.listInteractions('s', { storeId: storeB, state: 'answered', limit: 100 })
    ).interactions;
    expect(
      answered
        .filter((item) => item.definitionId === 'builtin.files/files.checkpoint.restore')
        .map((item) => item.id),
    ).toEqual([card.id]);
    const status = await current.queryExtension(
      's',
      'builtin.files',
      'files.checkpoint.restore-status',
      { checkpointId: point.id, restoreId: 'b-explicit' },
    );
    expect(status[0]!.payload).toMatchObject({
      journal: { phase: 'restored' },
      execution: { id: card.executionId, status: 'succeeded' },
    });
    await reader.close();
    reader = undefined;
    await child.close();
    expect(await child.exited).toBe(0);
    child = undefined;
    child = await launch('cold-b');
    expect(await child.client.getCommand(input.commandId)).toEqual(receipt);
    expect(await child.client.invokeExtension('s', input)).toEqual(receipt);
    expect(
      await child.client.queryExtension('s', 'builtin.files', 'files.checkpoint.restore-status', {
        checkpointId: point.id,
        restoreId: 'b-explicit',
      }),
    ).toEqual(status);
    expect((await child.client.getModelInput('s', source.modelExecutionId)).request).toEqual(
      modelA.request,
    );
    expect(stamp(originalPath)).toEqual(after);
    expect(requests).toHaveLength(8);
    reader = await openSqliteStore({
      dataRoot: profile.dataRoot,
      profile: profile.profile,
      mode: 'readonly',
    });
    expect((await reader.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await reader?.close();
    await child?.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

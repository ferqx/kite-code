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

for (const scenario of ['fork', 'combined', 'selector'] as const) {
  const combined = scenario === 'combined';
  test(scenario === 'selector'
    ? 'default same-Session selector retains consumed Model proof and rejects an excluded trigger without effects'
    : combined
      ? 'default code leg then Fork preserves actual new inode and restores earlier A through current independent Ask'
      : 'default session-only two Forks preserve unselected B receipts, sealed original head and exact aliases for early A restore', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-file-checkpoint-fork-'))),
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
        const user =
          body.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
        const key = user.includes('SECOND_ACTUAL_RUN') ? 'second' : 'first',
          step = steps.get(key) ?? 0;
        steps.set(key, step + 1);
        let call: { name: string; input: Json } | null = null;
        if (step === 0)
          call = { name: 'files.read', input: { path: 'original.txt', limit: 10000 } };
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
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `${provider.url.href}v1`,
          },
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
        points[0]!.payload as unknown as {
          items: { checkpoint: FileCheckpoint; revision: string }[];
        }
      ).items;
      expect(listed).toHaveLength(2);
      const point = listed.find(
        (item) => item.checkpoint.boundary.runId === firstRunId,
      )!.checkpoint;
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

      const secondCommand = await client.getCommand('second');
      const secondRunId = (secondCommand.receipt as { runId: string }).runId;
      const secondPoint = listed.find(
        (item) => item.checkpoint.boundary.runId === secondRunId,
      )?.checkpoint;
      expect(secondPoint).toBeDefined();
      if (!secondPoint?.boundary.messageId) throw Error('actual_second_boundary_missing');
      const beforeB = (await reader.getView('s')).messages.find(
        (message) => message.id === secondPoint.boundary.messageId,
      );
      expect(beforeB).toMatchObject({
        role: 'assistant',
        status: 'complete',
        content: 'first complete',
        seq: secondPoint.boundary.messageSeq,
        runId: firstRunId,
      });
      expect(BigInt(secondPoint.boundary.messageSeq)).toBeGreaterThan(
        BigInt(point.boundary.triggerSeq),
      );
      expect(BigInt(secondPoint.boundary.messageSeq)).toBeLessThan(
        BigInt(secondPoint.boundary.triggerSeq),
      );
      const bPhysical = stamp(originalPath);
      let restoreSequence = 0;
      async function restore(sessionId: string, checkpointId: string, restoreId: string) {
        restoreSequence++;
        const commandId = `restore-${restoreSequence}`;
        const before = stamp(originalPath);
        const pending = await child!.client.invokeExtension(sessionId, {
          expectedStoreId: storeId,
          commandId,
          kind: 'extension.invoke',
          extensionId: 'builtin.files',
          actionId: 'files.checkpoint.restore',
          definitionVersion: '1',
          input: { checkpointId, restoreId },
        });
        expect(pending.originStoreId).toBe(storeId);
        const cards = await until(
          () =>
            child!.client.listInteractions(sessionId, { storeId, state: 'pending', limit: 100 }),
          (page) =>
            page.interactions.some(
              (card) => card.definitionId === 'builtin.files/files.checkpoint.restore',
            ),
        );
        const card = cards.interactions.find(
          (card) => card.definitionId === 'builtin.files/files.checkpoint.restore',
        );
        if (!card?.executionId) throw Error('actual_independent_restore_card_missing');
        expect(card.sessionId).toBe(sessionId);
        expect(card.runId).toBeNull();
        expect(card.kind).toBe('approval');
        expect(stamp(originalPath)).toEqual(before);
        expect(requests).toHaveLength(8);
        const planned = await child!.client.getExecution(card.executionId);
        expect(planned).toMatchObject({
          kind: 'job',
          sessionId,
          runId: null,
          originStoreId: storeId,
          status: 'planned',
          definitionId: 'builtin.files/files.checkpoint.restore',
          definitionVersion: '1',
        });
        expect((await reader!.getExecution(planned.id))?.originCommandId).toBe(commandId);
        await child!.client.answerInteraction(sessionId, card.id, {
          expectedStoreId: storeId,
          commandId: `approve-${restoreSequence}`,
          expectedRevision: card.revision,
          answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
        });
        const execution = await until(
          () => child!.client.getExecution(card.executionId!),
          (value) => ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(value.status),
        );
        if (execution.status !== 'succeeded')
          console.error(
            'fork_restore_actual_failure',
            JSON.stringify({
              sessionId,
              checkpointId,
              commandId,
              execution,
              view: await child!.client.getView(sessionId),
            }),
          );
        expect(execution.status).toBe('succeeded');
        const status = await child!.client.queryExtension(
          sessionId,
          'builtin.files',
          'files.checkpoint.restore-status',
          { checkpointId, restoreId },
        );
        expect(status[0]?.payload).toMatchObject({
          journal: { checkpointId, id: restoreId, phase: 'restored' },
          execution: { id: execution.id, status: 'succeeded' },
        });
        return {
          sessionId,
          checkpointId,
          restoreId,
          commandId,
          command: await child!.client.getCommand(commandId),
          execution,
          status,
        };
      }

      if (scenario === 'selector') {
        const allSelected = await client.getContext('s', {
          storeId,
          messageLimit: 200,
          sourceLimit: 100,
          byteLimit: 8 * 1024 * 1024,
        });
        const last = allSelected.messages.at(-1);
        if (!last) throw Error('actual_selected_boundary_missing');
        const retained = await client.rewind('s', {
          expectedStoreId: storeId,
          commandId: 'selector-keep-all',
          expectedContextSelectionId: allSelected.selection.id,
          boundary: { messageId: last.id, seq: last.seq },
        });
        expect(retained.command.status).toBe('applied');
        expect(retained.selection.id).not.toBe(allSelected.selection.id);
        expect(retained.selection.id).not.toBe(point.boundary.contextSelectionId);
        const afterSelect = await client.getContext('s', {
          storeId,
          messageLimit: 200,
          sourceLimit: 100,
          byteLimit: 8 * 1024 * 1024,
        });
        expect(afterSelect.messages).toEqual(allSelected.messages);
        const actualPreview = await client.queryExtension(
          's',
          'builtin.files',
          'files.checkpoint.detail',
          { pointId: point.id },
        );
        expect(actualPreview[0]?.payload).toEqual(details[0]!.payload);
        const originalBefore = stamp(originalPath);
        const selectorRestore = await restore('s', point.id, 'selector-keep-all-restore');
        expect(readFileSync(originalPath)).toEqual(original);
        expect(stamp(originalPath).inode).not.toBe(originalBefore.inode);
        expect(existsSync(join(workspace, 'first-created.txt'))).toBe(false);
        expect(existsSync(join(workspace, 'second-created.txt'))).toBe(false);
        expect(requests).toHaveLength(8);
        const excluded = await client.rewind('s', {
          expectedStoreId: storeId,
          commandId: 'selector-exclude-trigger',
          expectedContextSelectionId: (await client.getView('s')).session.contextSelectionId,
          boundary: null,
        });
        expect(excluded.command.status).toBe('applied');
        expect(excluded.selection.id).not.toBe(retained.selection.id);
        const observationBefore = await reader!.getView('s'),
          cursorBefore = (await reader!.getMetadata()).lastChangeCursor,
          bytesBefore = stamp(originalPath);
        const excludedPreview = await client.queryExtension(
          's',
          'builtin.files',
          'files.checkpoint.detail',
          { pointId: point.id },
        );
        const absent = excludedPreview[0]?.payload as unknown as FileCheckpointPreview;
        expect(absent.checkpoint).toEqual(point);
        expect(absent.files.length).toBeGreaterThan(0);
        expect(
          absent.files.every(
            (file) =>
              file.status === 'unavailable' && file.reason === 'checkpoint_branch_not_selected',
          ),
        ).toBe(true);
        expect(await reader!.getView('s')).toEqual(observationBefore);
        expect((await reader!.getMetadata()).lastChangeCursor).toBe(cursorBefore);
        expect(stamp(originalPath)).toEqual(bytesBefore);
        expect(requests).toHaveLength(8);
        await client.invokeExtension('s', {
          expectedStoreId: storeId,
          commandId: 'selector-excluded-restore',
          kind: 'extension.invoke',
          extensionId: 'builtin.files',
          actionId: 'files.checkpoint.restore',
          definitionVersion: '1',
          input: { checkpointId: point.id, restoreId: 'selector-excluded-no-effect' },
        });
        const refusal = await until(
          () => client.getCommand('selector-excluded-restore'),
          (command) => command.status !== 'accepted',
        );
        expect(refusal.status).toBe('rejected');
        expect(refusal.receipt).toMatchObject({ reason: 'checkpoint_branch_not_selected' });
        expect(
          (await reader!.listExecutions('s')).some(
            (execution) => execution.originCommandId === 'selector-excluded-restore',
          ),
        ).toBe(false);
        expect(stamp(originalPath)).toEqual(bytesBefore);
        expect(requests).toHaveLength(8);
        const coldCursor = (await reader!.getMetadata()).lastChangeCursor,
          coldView = await reader!.getView('s');
        await reader!.close();
        reader = undefined;
        await child!.close();
        expect(await child!.exited).toBe(0);
        child = undefined;
        child = await launch('cold-same-session-selector');
        reader = await openSqliteStore({
          dataRoot: profile.dataRoot,
          profile: profile.profile,
          mode: 'readonly',
        });
        expect(
          await child.client.queryExtension(
            's',
            'builtin.files',
            'files.checkpoint.restore-status',
            { checkpointId: point.id, restoreId: selectorRestore.restoreId },
          ),
        ).toEqual(selectorRestore.status);
        expect(await child.client.getCommand(selectorRestore.commandId)).toEqual(
          selectorRestore.command,
        );
        expect(
          await child.client.queryExtension('s', 'builtin.files', 'files.checkpoint.detail', {
            pointId: point.id,
          }),
        ).toEqual(excludedPreview);
        expect(await reader.getView('s')).toEqual(coldView);
        expect((await reader.getMetadata()).lastChangeCursor).toBe(coldCursor);
        expect(stamp(originalPath)).toEqual(bytesBefore);
        expect(requests).toHaveLength(8);
        return;
      }
      let middleRestore: Awaited<ReturnType<typeof restore>> | undefined;
      if (combined) {
        middleRestore = await restore('s', secondPoint.id, 'code-leg-before-fork');
        expect(readFileSync(originalPath, 'utf8')).toBe('first actual modified UTF8\r\n');
        expect(statSync(originalPath, { bigint: true }).ino.toString()).not.toBe(bPhysical.inode);
        expect(existsSync(join(workspace, 'first-created.txt'))).toBe(true);
        expect(existsSync(join(workspace, 'second-created.txt'))).toBe(false);
      }
      const forkInput = {
        expectedStoreId: storeId,
        commandId: 'fork-first',
        expectedContextSelectionId: (await client.getView('s')).session.contextSelectionId,
        boundary: {
          messageId: secondPoint.boundary.messageId,
          seq: secondPoint.boundary.messageSeq,
        },
        newSessionId: 'fork-one',
        title: 'Original A only',
      };
      const firstFork = await client.forkSession('s', forkInput);
      expect(firstFork.command.status).toBe('applied');
      expect(firstFork.omittedExtensionState).toBe(
        firstFork.namespaceReport?.some((entry) => entry.omitted > 0) ?? false,
      );
      expect(
        firstFork.namespaceReport?.find(
          (item) => item.extensionId === 'builtin.files' && item.mode === 'rebuild',
        )?.mode,
      ).toBe('rebuild');
      const selectedFirst = await client.getContext('fork-one', {
        storeId,
        messageLimit: 200,
        sourceLimit: 100,
        byteLimit: 8 * 1024 * 1024,
      });
      expect(
        selectedFirst.messages.some((message) => message.content.startsWith('FIRST_ACTUAL_RUN')),
      ).toBe(true);
      expect(
        selectedFirst.messages.some((message) => message.content.startsWith('SECOND_ACTUAL_RUN')),
      ).toBe(false);
      if (!combined) expect(stamp(originalPath)).toEqual(bPhysical);
      const originalBNotSelected = await client.queryExtension(
        'fork-one',
        'builtin.files',
        'files.checkpoint.detail',
        { pointId: secondPoint.id },
      );
      const bPreview = originalBNotSelected[0]?.payload as unknown as FileCheckpointPreview;
      expect(bPreview.files.length).toBeGreaterThan(0);
      expect(
        bPreview.files.every(
          (file) =>
            file.status === 'unavailable' && file.reason === 'checkpoint_branch_not_selected',
        ),
      ).toBe(true);
      const beforeUnselected = stamp(originalPath);
      await client.invokeExtension('fork-one', {
        expectedStoreId: storeId,
        commandId: 'unselected-b-restore',
        kind: 'extension.invoke',
        extensionId: 'builtin.files',
        actionId: 'files.checkpoint.restore',
        definitionVersion: '1',
        input: { checkpointId: secondPoint.id, restoreId: 'unselected-b-no-grant' },
      });
      const refusedB = await until(
        () => client.getCommand('unselected-b-restore'),
        (command) => command.status !== 'accepted',
      );
      expect(refusedB.status).toBe('rejected');
      expect(refusedB.receipt).toMatchObject({ reason: 'checkpoint_branch_not_selected' });
      expect(
        (await reader!.listExecutions('fork-one')).some(
          (execution) => execution.originCommandId === 'unselected-b-restore',
        ),
      ).toBe(false);
      expect(stamp(originalPath)).toEqual(beforeUnselected);
      expect(requests).toHaveLength(8);
      let mediaRefusal: string | undefined;
      try {
        await client.readArtifact(
          'fork-one',
          { expectedStoreId: storeId, refId: preimage.id, scope: preimage.scope! },
          { expectedReference: { size: preimage.size, mediaType: preimage.mediaType } },
        );
      } catch (error) {
        mediaRefusal =
          error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code
            : undefined;
      }
      expect(mediaRefusal).toBe('artifact_scope_denied');
      const firstPreview = await client.queryExtension(
        'fork-one',
        'builtin.files',
        'files.checkpoint.detail',
        { pointId: point.id },
      );
      expect(
        (firstPreview[0]?.payload as unknown as FileCheckpointPreview).files.find(
          (file) => file.path === 'original.txt',
        )?.status,
      ).toBe('restore');
      let restoreSession = 'fork-one';
      let secondFork: Awaited<ReturnType<typeof client.forkSession>> | undefined;
      if (!combined) {
        secondFork = await client.forkSession('fork-one', {
          expectedStoreId: storeId,
          commandId: 'fork-second',
          expectedContextSelectionId: firstFork.selection.id,
          newSessionId: 'fork-two',
          title: 'Two exact aliases',
        });
        expect(secondFork.command.status).toBe('applied');
        expect(secondFork.omittedExtensionState).toBe(
          secondFork.namespaceReport?.some((entry) => entry.omitted > 0) ?? false,
        );
        restoreSession = 'fork-two';
        const repeated = await client.queryExtension(
          restoreSession,
          'builtin.files',
          'files.checkpoints',
          {},
        );
        expect(
          (
            repeated[0]?.payload as unknown as { items: { checkpoint: FileCheckpoint }[] }
          ).items.map((item) => item.checkpoint),
        ).toEqual(listed.map((item) => item.checkpoint));
        expect(
          (await client.getContext(restoreSession, { storeId })).messages.some((message) =>
            message.content.startsWith('SECOND_ACTUAL_RUN'),
          ),
        ).toBe(false);
        // Public Store host-fault probe changes only original readonly metadata after both seals.
        await reader.close();
        reader = undefined;
        await child.close();
        expect(await child.exited).toBe(0);
        child = undefined;
        const writer = await openSqliteStore({
          dataRoot: profile.dataRoot,
          profile: profile.profile,
        });
        try {
          const old = await writer.getExtensionRecord({
            sessionId: 's',
            extensionId: 'builtin.files',
            key: `checkpoint/${secondPoint.id}/head`,
          });
          if (!old?.value || typeof old.value !== 'object' || Array.isArray(old.value))
            throw Error('actual_parent_head_missing');
          const probeBefore = (await writer.getMetadata()).lastChangeCursor,
            probeBytes = stamp(originalPath);
          const originalCommand = await writer.getCommand('second');
          if (!originalCommand) throw Error('actual_parent_command_missing');
          const probeCommand = await writer.acceptCommand({
            expectedStoreId: storeId,
            commandId: 'owned-head-fault-probe',
            sessionId: 's',
            subjectId: originalCommand.subjectId,
            request: {
              kind: 'extension.invoke',
              extensionId: 'builtin.files',
              actionId: 'files.checkpoint.restore',
              definitionVersion: '1',
              input: { checkpointId: secondPoint.id, restoreId: 'host-probe-no-adapter' },
            },
          });
          expect(probeCommand.status).toBe('accepted');
          const owner = await writer.acquireSessionOwner('s', 'owned-readonly-head-drift');
          if (!owner) throw Error('actual_parent_owner_missing');
          try {
            const changed = await writer.writeExtensionRecord({
              expectedStoreId: storeId,
              owner,
              sessionId: 's',
              extensionId: 'builtin.files',
              originCommandId: probeCommand.id,
              write: {
                key: old.key,
                expectedRevision: old.revision,
                contentType: old.contentType,
                contentVersion: old.contentVersion,
                value: { ...old.value, state: 'unknown' },
              },
            });
            expect(changed.revision).not.toBe(old.revision);
            expect(changed.originStoreId).toBe(old.originStoreId);
            expect(BigInt((await writer.getMetadata()).lastChangeCursor)).toBeGreaterThan(
              BigInt(probeBefore),
            );
            expect(stamp(originalPath)).toEqual(probeBytes);
            expect(requests).toHaveLength(8);
            const rejected = await writer.rejectCommand({
              expectedStoreId: storeId,
              owner,
              commandId: probeCommand.id,
              reason: 'owned_host_record_fault_probe_only',
            });
            expect(rejected.status).toBe('rejected');
            expect(
              (await writer.listExecutions('s')).some(
                (execution) => execution.originCommandId === probeCommand.id,
              ),
            ).toBe(false);
          } finally {
            expect(await writer.releaseSessionOwner(owner)).toBe(true);
          }
        } finally {
          await writer.close();
        }
        child = await launch('sealed-source-head-drift');
        reader = await openSqliteStore({
          dataRoot: profile.dataRoot,
          profile: profile.profile,
          mode: 'readonly',
        });
        const afterDrift = await child.client.queryExtension(
          'fork-two',
          'builtin.files',
          'files.checkpoint.detail',
          { pointId: point.id },
        );
        expect(afterDrift).toEqual(firstPreview);
      }
      const finalRestore = await restore(restoreSession, point.id, 'early-a-in-current-fork');
      expect(readFileSync(originalPath)).toEqual(original);
      expect(existsSync(join(workspace, 'first-created.txt'))).toBe(false);
      expect(existsSync(join(workspace, 'second-created.txt'))).toBe(false);
      expect(requests).toHaveLength(8);
      expect(finalRestore.execution.sessionId).toBe(restoreSession);
      expect(finalRestore.execution.id).not.toBe(middleRestore?.execution.id);
      expect(finalRestore.execution.runId).toBeNull();
      expect(await child!.client.getCommand('fork-first')).toEqual(firstFork.command);
      if (secondFork)
        expect(await child!.client.getCommand('fork-second')).toEqual(secondFork.command);
      const metadataBefore = await reader!.getMetadata(),
        viewBefore = await reader!.getView(restoreSession),
        bytesBefore = stamp(originalPath);
      await reader!.close();
      reader = undefined;
      await child!.close();
      expect(await child!.exited).toBe(0);
      child = undefined;
      child = await launch('cold-current-fork');
      reader = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      expect(
        await child.client.queryExtension(
          restoreSession,
          'builtin.files',
          'files.checkpoint.restore-status',
          { checkpointId: point.id, restoreId: finalRestore.restoreId },
        ),
      ).toEqual(finalRestore.status);
      expect(await child.client.getCommand(finalRestore.commandId)).toEqual(finalRestore.command);
      expect(await child.client.getCommand('fork-first')).toEqual(firstFork.command);
      expect(await reader.getView(restoreSession)).toEqual(viewBefore);
      expect((await reader.getMetadata()).lastChangeCursor).toBe(metadataBefore.lastChangeCursor);
      expect(stamp(originalPath)).toEqual(bytesBefore);
      expect(requests).toHaveLength(8);
      const coldModel = await child.client.getModelInput('s', source.modelExecutionId);
      const { snapshotCursor: liveCursor, ...immutableModel } = model;
      const { snapshotCursor: coldCursor, ...immutableColdModel } = coldModel;
      expect(BigInt(coldCursor)).toBeGreaterThanOrEqual(BigInt(liveCursor));
      expect(immutableColdModel).toEqual(immutableModel);
    } finally {
      await reader?.close();
      await child?.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
}

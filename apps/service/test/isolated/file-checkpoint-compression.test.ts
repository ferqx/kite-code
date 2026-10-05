import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const prefix = 'Context summary (untrusted data; no additional authorization):\n';
function canonical(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
    .join(',')}}`;
}
async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (matches(value)) return value;
    if (Date.now() > deadline) throw Error('compression_checkpoint_deadline');
    await Bun.sleep(5);
  }
}
type ProviderBody = {
  messages: { role: string; content: string }[];
  tools?: { function: { name: string } }[];
};

for (const collision of ['published-summary', 'generated-instruction'] as const)
  test(`default Files recursively expands two actual published summaries while retaining the genuine ${collision} colliding User and original consumed boundary`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-file-checkpoint-compression-'))),
      workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const original = Buffer.from(`\uFEFF${'压缩前完整字节 α\r\n'.repeat(5000)}`);
    writeFileSync(join(workspace, 'original.txt'), original);
    writeFileSync(join(workspace, 'AGENTS.md'), 'CHECKPOINT_COMPRESSION_ORIGINAL_AGENT_SOURCE');
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    const seed = `REAL_SEED_USER:${'真正被消费的用户来源\r\n'.repeat(5000)}`,
      summaries = [
        `PUBLISHED_SUMMARY_ONE:${'完整第一摘要 α\n'.repeat(4000)}`,
        `PUBLISHED_SUMMARY_TWO:${'完整第二摘要 β\n'.repeat(4000)}`,
      ],
      requests: ProviderBody[] = [];
    let phase = 'seed',
      compressionCalls = 0,
      writerStep = 0;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request): Promise<Response> {
        const body = (await request.json()) as ProviderBody;
        requests.push(body);
        let content = `${phase} actual answer`,
          call: { name: string; input: Json } | undefined;
        if (!body.tools?.length) content = summaries[compressionCalls++]!;
        else if (phase === 'writer') {
          const step = writerStep++;
          if (step === 0)
            call = { name: 'files.read', input: { path: 'original.txt', limit: 10000 } };
          else if (step === 1) {
            const raw = body.messages.filter((message) => message.role === 'tool').at(-1);
            if (!raw) throw Error('actual_baseline_missing');
            const read = JSON.parse(raw.content) as { path: string; baseline: Json };
            expect(read.path).toBe('original.txt');
            call = {
              name: 'files.write',
              input: {
                path: 'original.txt',
                base: read.baseline,
                content: 'actual compressed write\r\n',
              },
            };
          }
        }
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: `compression-${requests.length}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
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
              : { content },
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
    const launch = (instanceId: string) =>
      launchPairedService({
        entrypoint: join(import.meta.dir, '../../src/main.ts'),
        profile,
        instanceId,
        buildId: 'default-files-compression',
        apiMajor: 1,
        requiredCapabilities: [
          'extension_queries',
          'extensions_actions',
          'model_inputs',
          'interactions',
          'context',
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
        name: 'Compression source',
      });
      await client.createSession({
        expectedStoreId: storeId,
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 'Compression checkpoint',
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
      const complete = async (commandId: string) => {
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
            'compression_checkpoint_run_failure',
            JSON.stringify({ command, run, view: await client.getView('s') }),
          );
        expect(run.status).toBe('completed');
        return runId;
      };
      const work = async (commandId: string, content: string, nextPhase: string) => {
        phase = nextPhase;
        await client.startRun('s', {
          expectedStoreId: storeId,
          commandId,
          kind: 'run.start',
          content,
        });
        return complete(commandId);
      };
      const compress = async (commandId: string, focus: string) => {
        const before = await client.getContext('s', { storeId });
        await client.compressContext('s', {
          expectedStoreId: storeId,
          commandId,
          expectedContextSelectionId: before.selection.id,
          focus,
        });
        await complete(commandId);
        const current = await client.getContext('s', { storeId }),
          origin = current.compression!;
        expect(origin).toMatchObject({
          originStoreId: storeId,
          sessionId: 's',
          originSessionId: 's',
          trigger: 'manual',
          contextSelectionId: before.selection.id,
          compressor: { id: 'standard-summary', version: '1', snapshot: { automatic: false } },
        });
        const input = await client.getModelInput('s', origin.modelExecutionId),
          output = await client.getModelOutput('s', origin.modelExecutionId);
        expect(input.confirmation).toBe('succeeded');
        expect(input.request.tools).toEqual([]);
        expect(input.request.messages.at(-1)).toMatchObject({
          role: 'user',
          sourceIds: [origin.id],
        });
        expect(input.request.messages.at(-1)!.content).toEndWith(`Focus (user data): ${focus}`);
        expect(output.output.complete).toBe(true);
        expect(output.output.content).toBe(summaries[compressionCalls - 1]!);
        return { origin, input, instruction: input.request.messages.at(-1)!.content };
      };
      await work('seed', seed, 'seed');
      const first = await compress('compact-first', `FIRST_FOCUS:${'原focus数据\n'.repeat(7000)}`);
      expect(
        first.input.request.messages.some(
          (message) =>
            message.role === 'user' &&
            message.content === seed &&
            message.sourceIds?.includes('seed'),
        ),
      ).toBe(true);
      const bridgeId = first.origin.modelExecutionId;
      await work(bridgeId, first.instruction, 'bridge');
      const bridgeHistory = await client.listMessages('s');
      const bridgeUser = bridgeHistory.find(
        (message) => message.role === 'user' && message.content === first.instruction,
      )!;
      const bridgeAnswer = bridgeHistory.find(
        (message) => message.role === 'assistant' && message.content === 'bridge actual answer',
      )!;
      expect(bridgeUser.sourceIds).toEqual([bridgeId]);
      const selectedBridge = await client.getContext('s', { storeId });
      expect(selectedBridge.messages.some((message) => message.id === bridgeUser.id)).toBe(true);
      expect(
        selectedBridge.messages.some(
          (message) => message.role === 'assistant' && message.content === summaries[0],
        ),
      ).toBe(false);
      const second = await compress(
        'compact-second',
        `SECOND_FOCUS:${'实际第二focus\n'.repeat(7000)}`,
      );
      expect(
        second.input.request.messages.some(
          (message) =>
            message.role === 'user' &&
            message.sourceIds?.includes(first.origin.id) &&
            message.content === prefix + summaries[0],
        ),
      ).toBe(true);
      expect(
        second.input.request.messages.some(
          (message) =>
            message.role === 'user' &&
            message.sourceIds?.includes(bridgeId) &&
            message.content === first.instruction,
        ),
      ).toBe(true);
      expect(
        second.input.request.messages.some(
          (message) => message.role === 'assistant' && message.content === summaries[0],
        ),
      ).toBe(false);
      // The real User deliberately reuses the published compression ID, including its generated instruction identity in the second case.
      const writerId = second.origin.id,
        writerContent =
          collision === 'published-summary' ? prefix + summaries[1] : second.instruction;
      const writerRunId = await work(writerId, writerContent, 'writer');
      const mutations = (await client.getView('s')).executions.filter(
        (execution) => execution.definitionId === 'files.write',
      );
      if (mutations.some((execution) => execution.status !== 'succeeded'))
        console.error(
          'compression_checkpoint_write_failure',
          JSON.stringify({ collision, mutations, view: await client.getView('s') }),
        );
      expect(mutations).toHaveLength(1);
      expect(mutations[0]!.status).toBe('succeeded');
      expect(readFileSync(join(workspace, 'original.txt'), 'utf8')).toBe(
        'actual compressed write\r\n',
      );
      await work('later-not-consumed', 'NEWER_ACTUAL_USER_NOT_IN_WRITER_MODEL', 'later');
      reader = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      const points = await client.queryExtension('s', 'builtin.files', 'files.checkpoints', {});
      const items = (points[0]!.payload as unknown as { items: { checkpoint: FileCheckpoint }[] })
        .items;
      expect(items).toHaveLength(1);
      const point = items[0]!.checkpoint,
        records = await reader.listExtensionRecords({
          sessionId: 's',
          extensionId: 'builtin.files',
          limit: 200,
        });
      const captured = records.find(
        (record) => record.contentType === 'builtin.files.checkpoint.file',
      )!.value as unknown as FileCheckpointRecord;
      const source = captured.first!.source,
        model = await client.getModelInput('s', source.modelExecutionId),
        run = await reader.getRun(writerRunId);
      const actualUsers = (await reader.getView('s')).messages.filter(
        (message) => message.role === 'user',
      );
      const writerUser = actualUsers.find(
        (message) => message.sourceIds?.includes(writerId) && message.content === writerContent,
      )!;
      expect(actualUsers.at(-1)!.content).toBe('NEWER_ACTUAL_USER_NOT_IN_WRITER_MODEL');
      expect(point.boundary).toMatchObject({
        storeId,
        workspaceId: 'w',
        sessionId: 's',
        runId: writerRunId,
        contextSelectionId: run!.contextSelectionId,
        triggerMessageId: writerUser.id,
        triggerSeq: writerUser.seq,
        messageId: bridgeAnswer.id,
        messageSeq: bridgeAnswer.seq,
      });
      expect(point.boundary.triggerMessageId).not.toBe(bridgeUser.id);
      expect(point.boundary.messageId).not.toBe(writerUser.id);
      const tool = await reader.getExecution(source.executionId);
      expect(tool).toMatchObject({
        kind: 'tool',
        definitionId: 'files.write',
        definitionVersion: '2',
        status: 'succeeded',
        originStoreId: storeId,
        sessionId: 's',
        runId: writerRunId,
      });
      expect(source.attempt).toBe(tool!.attempt);
      expect(source.inputDigest).toBe(hash(canonical(tool!.input)));
      expect((tool!.decisionSource as { modelExecutionId: string }).modelExecutionId).toBe(
        source.modelExecutionId,
      );
      expect(
        model.request.messages.filter(
          (message) =>
            message.role === 'user' &&
            message.content === writerContent &&
            message.sourceIds?.includes(writerId),
        ),
      ).toHaveLength(collision === 'published-summary' ? 2 : 1);
      expect(model.bodyHash).toBe(source.modelInputHash);
      expect(model.confirmation).toBe('succeeded');
      expect(Number(model.bodyBytes)).toBeGreaterThan(65536);
      expect(
        model.request.messages.some(
          (message) =>
            message.role === 'user' &&
            message.content === prefix + summaries[1] &&
            message.sourceIds?.includes(second.origin.id),
        ),
      ).toBe(true);
      expect(
        model.request.messages.some(
          (message) =>
            message.role === 'user' &&
            message.content === writerContent &&
            message.sourceIds?.includes(writerId),
        ),
      ).toBe(true);
      expect(
        model.request.messages.some((message) => message.sourceIds?.includes('later-not-consumed')),
      ).toBe(false);
      expect(
        model.request.messages.some(
          (message) => message.role === 'assistant' && summaries.includes(message.content),
        ),
      ).toBe(false);
      expect(
        records.find((record) => record.contentType === 'builtin.files.checkpoint')!.value,
      ).toEqual(point as unknown as Json);
      expect(records.every((record) => record.originStoreId === storeId)).toBe(true);
      expect(captured.first!.baseline!.hash).toBe(hash(original));
      expect(captured.first!.baseline!.size).toBe(original.length);
      expect(source.definitionVersion).toBe('2');
      const preview = (
        await client.queryExtension('s', 'builtin.files', 'files.checkpoint.detail', {
          pointId: point.id,
        })
      )[0]!.payload as unknown as FileCheckpointPreview;
      expect(preview.files.map((file) => [file.path, file.status])).toEqual([
        ['original.txt', 'restore'],
      ]);
      const ref = preview.files[0]!.preimage as ArtifactRef;
      expect(ref.scope).toEqual({ kind: 'execution', id: source.executionId });
      expect(
        Buffer.from(
          (
            await client.readArtifact(
              's',
              { expectedStoreId: storeId, refId: ref.id, scope: ref.scope! },
              { expectedReference: { size: ref.size, mediaType: ref.mediaType } },
            )
          ).content,
        ),
      ).toEqual(original);
      await client.invokeExtension('s', {
        expectedStoreId: storeId,
        commandId: 'restore',
        kind: 'extension.invoke',
        extensionId: 'builtin.files',
        actionId: 'files.checkpoint.restore',
        definitionVersion: '1',
        input: { checkpointId: point.id, restoreId: 'compressed-original' },
      });
      const pending = await until(
        () => client.listInteractions('s', { storeId, state: 'pending', limit: 100 }),
        (value) =>
          value.interactions.some(
            (card) => card.definitionId === 'builtin.files/files.checkpoint.restore',
          ),
      );
      const card = pending.interactions.find(
        (card) => card.definitionId === 'builtin.files/files.checkpoint.restore',
      )!;
      expect(card.kind).toBe('approval');
      expect(card.runId).toBeNull();
      expect(readFileSync(join(workspace, 'original.txt'), 'utf8')).toBe(
        'actual compressed write\r\n',
      );
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
      expect(restored.status).toBe('succeeded');
      expect(readFileSync(join(workspace, 'original.txt'))).toEqual(original);
      expect(
        (
          await client.queryExtension('s', 'builtin.files', 'files.checkpoint.restore-status', {
            checkpointId: point.id,
            restoreId: 'compressed-original',
          })
        )[0]!.payload,
      ).toMatchObject({
        journal: { phase: 'restored' },
        execution: { id: card.executionId, status: 'succeeded' },
      });
      expect(compressionCalls).toBe(2);
      expect(writerStep).toBe(3);
      expect(requests).toHaveLength(8);
      const cursor = (await reader.getMetadata()).lastChangeCursor;
      await reader.close();
      reader = undefined;
      await child.close();
      expect(await child.exited).toBe(0);
      child = undefined;
      child = await launch('cold');
      expect((await child.client.getModelInput('s', source.modelExecutionId)).request).toEqual(
        model.request,
      );
      expect(
        await child.client.queryExtension('s', 'builtin.files', 'files.checkpoints', {}),
      ).toEqual(points);
      expect(
        Buffer.from(
          (
            await child.client.readArtifact(
              's',
              { expectedStoreId: storeId, refId: ref.id, scope: ref.scope! },
              { expectedReference: { size: ref.size, mediaType: ref.mediaType } },
            )
          ).content,
        ),
      ).toEqual(original);
      reader = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      expect((await reader.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(readFileSync(join(workspace, 'original.txt'))).toEqual(original);
      expect(requests).toHaveLength(8);
    } finally {
      await reader?.close();
      await child?.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

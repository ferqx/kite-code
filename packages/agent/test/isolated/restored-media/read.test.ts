import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import type { ArtifactRef, Extension } from '../../../src/extensions';
import { createProfileBackup, restoreProfileBackup } from '../../../src/maintenance';
import { selectProfile } from '../../../src/platform/profile';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function rejected(work: Promise<unknown>) {
  try {
    await work;
    return '';
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
}
test('actual restore reads original full bodies and media, exports history and starts new work from original Fork and compression without replay', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-restored-media-'));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const old = (await store.getMetadata()).storeId;
  const scope = { expectedStoreId: old, sessionId: 's', subjectId: 'owner' };
  const input = 'original input EXACT INPUT TAIL';
  const output = `original output ${'o'.repeat(17 * 1024 * 1024)} EXACT OUTPUT TAIL`;
  const body = `tool full body ${'b'.repeat(17 * 1024 * 1024)} EXACT TOOL TAIL`;
  const summary = 'actual original compression summary';
  const deltas: ModelEvent[] = [];
  for (let offset = 0; offset < output.length; offset += 32768)
    deltas.push({ type: 'text_delta', text: output.slice(offset, offset + 32768) });
  deltas.push(
    { type: 'tool_call', id: 'publish', name: 'fixture.publish', arguments: '{}' },
    { ...finish, reason: 'tool_calls' },
  );
  const model = createFixedModel([
    deltas,
    [finish],
    [{ type: 'text_delta', text: summary }, finish],
  ]);
  let effects = 0;
  let ref: ArtifactRef | undefined;
  const extensions: Extension[] = [
    {
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'fixture.publish',
          version: '1',
          description: 'temporary actual media',
          inputSchema: { type: 'object' },
          async execute(_input: unknown, context) {
            effects++;
            ref = await context.artifacts!.publish({
              key: 'body',
              content: Buffer.from(body),
              mediaType: 'text/plain; charset=utf-8',
            });
            return {
              outcome: 'succeeded' as const,
              content: 'body retained',
              artifactRefs: [ref!],
              modelContent: {
                kind: 'artifact' as const,
                reference: ref!,
                encoding: 'utf-8' as const,
              },
            };
          },
        },
      ],
    },
  ];
  const compressor = {
    id: 'fixture.compressor',
    version: '1',
    async prepare() {
      return {
        instructions: 'summarize actual original history',
        snapshot: { algorithm: 'fixture' },
      };
    },
  };
  const permissions = {
    async authorize() {
      return { allowed: true, revision: 'fixture' };
    },
  };
  let runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model,
    extensions,
    compressor,
    permissions,
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: old,
      id: 'w',
      name: 'temporary',
      rootUri: `file://${root}`,
    });
    await runtime.createSession({
      ...scope,
      commandId: 'create',
      workspaceId: 'w',
      title: 'old history',
    });
    await runtime.submitCommand({
      ...scope,
      commandId: 'original',
      request: { kind: 'run.start', content: input },
    });
    const settled = await runtime.waitForCommand('original', { timeoutMs: 40000 });
    expect((await runtime.getRun((settled.receipt as { runId: string }).runId))?.status).toBe(
      'completed',
    );
    expect(effects).toBe(1);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]!.messages.some((m) => m.content.includes(body))).toBe(true);
    const inputs = (await runtime.listModelInputs(scope)).items;
    const source = inputs[0]!.executionId;
    const inputSource = inputs[1]!.executionId;
    const savedInput = await runtime.readModelInput({ ...scope, executionId: inputSource });
    expect(JSON.stringify(savedInput.request).length).toBeGreaterThan(17 * 1024 * 1024);
    const savedOutput = await runtime.readModelOutput({ ...scope, executionId: source });
    expect(savedOutput.output.content).toBe(output);
    const originalRef = (
      await runtime.readArtifact({ ...scope, refId: ref!.id, scope: ref!.scope! })
    ).reference;
    const selection = (await store.getSession('s'))!.contextSelectionId;
    await runtime.forkSession({
      expectedStoreId: old,
      subjectId: 'owner',
      sourceSessionId: 's',
      newSessionId: 'uncompressed',
      commandId: 'fork-old',
      title: 'full original',
      expectedContextSelectionId: selection,
    });
    await runtime.compressContext({
      ...scope,
      commandId: 'compact',
      expectedContextSelectionId: selection,
    });
    await runtime.waitForCommand('compact', { timeoutMs: 40000 });
    const compression = (await store.getSelectedContext({ expectedStoreId: old, sessionId: 's' }))
      .compression!;
    expect(compression).toBeDefined();
    await runtime.close();
    const backup = await createProfileBackup({ profile, destinationRoot: join(root, 'backup') });
    const restored = await restoreProfileBackup({
      profile,
      expectedStoreId: old,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(old);
    const current = restored.storeId;
    const coldStore = await openSqliteStore({ ...profile, mode: 'readonly' });
    const coldModel = createFixedModel([]);
    const cold = createRuntime({
      store: coldStore,
      artifacts: createArtifactStore({ profile, store: coldStore }),
      model: coldModel,
      permissions: {
        async authorize() {
          throw new Error('readonly must not authorize');
        },
      },
    });
    try {
      expect(
        (
          await cold.readModelInput({
            ...scope,
            expectedStoreId: current,
            executionId: inputSource,
          })
        ).request,
      ).toEqual(savedInput.request);
      expect(
        (await cold.readModelOutput({ ...scope, expectedStoreId: current, executionId: source }))
          .output,
      ).toEqual(savedOutput.output);
      expect(
        (
          await cold.readArtifact({
            ...scope,
            expectedStoreId: current,
            refId: ref!.id,
            scope: ref!.scope!,
          })
        ).reference,
      ).toEqual(originalRef);
      expect(coldModel.requests).toHaveLength(0);
      expect(effects).toBe(1);
    } finally {
      await cold.close();
    }
    const nextStore = await openSqliteStore(profile);
    const nextModel = createFixedModel([[finish], [finish]]);
    runtime = createRuntime({
      store: nextStore,
      artifacts: createArtifactStore({ profile, store: nextStore }),
      model: nextModel,
      extensions,
      compressor,
      permissions,
    });
    const read = { ...scope, expectedStoreId: current };
    expect(nextModel.requests).toHaveLength(0);
    expect(effects).toBe(1);
    expect((await runtime.readModelInput({ ...read, executionId: inputSource })).request).toEqual(
      savedInput.request,
    );
    expect((await runtime.readModelOutput({ ...read, executionId: source })).output).toEqual(
      savedOutput.output,
    );
    const media = await runtime.readArtifact({ ...read, refId: ref!.id, scope: ref!.scope! });
    expect(media.reference).toEqual(originalRef);
    expect(media.reference.storeId).toBe(old);
    expect(Buffer.from(media.content).toString()).toBe(body);
    const directory = await runtime.listSessionDirectory({
      expectedStoreId: current,
      subjectId: 'owner',
    });
    expect(directory.items.map((s) => s.session.id)).toContain('s');
    expect(directory.items.map((s) => s.session.id)).toContain('uncompressed');
    const manifest = await nextStore.beginSessionExport(read);
    expect(manifest.storeId).toBe(current);
    const refs = await nextStore.readSessionExportPage({
      ...read,
      manifest,
      section: 'artifact_refs',
      limit: 100,
    });
    expect(
      refs.records.some((r) => (r.record as Record<string, unknown>).origin_store_id === old),
    ).toBe(true);
    expect((await nextStore.verifySessionExport({ ...read, manifest })).verified).toBe(true);
    expect(
      (await nextStore.getCompressionOrigin({ ...read, compressionId: compression.id }))
        .originStoreId,
    ).toBe(old);
    expect(nextModel.requests).toHaveLength(0);
    expect(effects).toBe(1);
    expect(await rejected(runtime.readModelOutput({ ...scope, executionId: source }))).toBe(
      'store_identity_mismatch',
    );
    expect(
      await rejected(
        runtime.readModelOutput({ ...read, subjectId: 'foreign', executionId: source }),
      ),
    ).toBe('model_input_scope_denied');
    expect(
      await rejected(
        runtime.readArtifact({ ...read, refId: ref!.id, scope: { kind: 'session', id: 's' } }),
      ),
    ).toBeTruthy();
    const artifact = createArtifactStore({ profile, store: nextStore });
    expect(
      await rejected(
        artifact.publish({
          ...read,
          refId: ref!.id,
          scope: ref!.scope!,
          content: Buffer.from(body),
          mediaType: originalRef.mediaType,
        }),
      ),
    ).toBe('artifact_scope_denied');
    await artifact.close();
    const physical = new Database(selectProfile(profile).databasePath);
    const execution = physical
      .query('SELECT origin_command_id FROM execution WHERE id=?')
      .get(source) as { origin_command_id: string };
    physical.run("UPDATE command SET origin_store_id='spliced' WHERE id=?", [
      execution.origin_command_id,
    ]);
    expect(await rejected(runtime.readModelInput({ ...read, executionId: source }))).toBe(
      'model_input_scope_denied',
    );
    physical.run('UPDATE command SET origin_store_id=? WHERE id=?', [
      old,
      execution.origin_command_id,
    ]);
    physical.close();
    const fullSelection = (await nextStore.getSession('uncompressed'))!.contextSelectionId;
    await runtime.forkSession({
      expectedStoreId: current,
      subjectId: 'owner',
      sourceSessionId: 'uncompressed',
      newSessionId: 'new-copy',
      commandId: 'new-fork',
      title: 'new current Fork',
      expectedContextSelectionId: fullSelection,
    });
    expect(nextModel.requests).toHaveLength(0);
    await runtime.submitCommand({
      ...read,
      sessionId: 'new-copy',
      commandId: 'new-full',
      request: { kind: 'run.start', content: 'explicit new work from old full history' },
    });
    const fullSettled = await runtime.waitForCommand('new-full', { timeoutMs: 40000 });
    expect((await runtime.getRun((fullSettled.receipt as { runId: string }).runId))?.status).toBe(
      'completed',
    );
    expect(nextModel.requests).toHaveLength(1);
    expect(
      nextModel.requests[0]!.messages.some(
        (m) => m.content === output && m.sourceIds?.includes(source),
      ),
    ).toBe(true);
    expect(nextModel.requests[0]!.messages.some((m) => m.content.includes(body))).toBe(true);
    expect(nextModel.requests[0]!.messages.some((m) => m.content === input)).toBe(true);
    await runtime.submitCommand({
      ...read,
      commandId: 'new-summary',
      request: { kind: 'run.start', content: 'explicit new work from original compressed root' },
    });
    const summarySettled = await runtime.waitForCommand('new-summary', { timeoutMs: 40000 });
    expect(
      (await runtime.getRun((summarySettled.receipt as { runId: string }).runId))?.status,
    ).toBe('completed');
    expect(nextModel.requests).toHaveLength(2);
    expect(nextModel.requests[1]!.messages.some((m) => m.content.includes(summary))).toBe(true);
    expect(nextModel.requests[1]!.messages.some((m) => m.content === output)).toBe(false);
    expect(effects).toBe(1);
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);

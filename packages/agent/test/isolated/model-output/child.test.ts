import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import type { ArtifactRef, OperationRef } from '../../../src/extensions';
import { createProfileBackup, restoreProfileBackup } from '../../../src/maintenance';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
test('an actual same-Loop child seals its seventeen MiB final output in its original parent carrier scope and enters the next parent Model intact', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-child-output-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const full = `${'x'.repeat(17 * 1024 * 1024)} EXACT CHILD OUTPUT TAIL`;
  const chunks: ModelEvent[] = [];
  for (let offset = 0; offset < full.length; offset += 32768)
    chunks.push({ type: 'text_delta', text: full.slice(offset, offset + 32768) });
  chunks.push(finish);
  const child = createFixedModel([chunks]);
  const parent = createFixedModel([
    [
      { type: 'tool_call', id: 'delegate', name: 'fixture.delegate', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  let ref: OperationRef | undefined;
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model: parent,
    modelId: 'parent',
    modelConcurrency: 1,
    maxConcurrentSubagents: 1,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
    childConfigurations: [
      {
        id: 'child',
        version: '1',
        model: child,
        modelId: 'child',
        toolIds: [],
        snapshot: { fixture: true },
      },
    ],
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.delegate',
            version: '1',
            description: 'Owned ordinary child delegation',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              ref = await context.operations.ensure({
                key: 'child',
                request: {
                  kind: 'agent',
                  configurationId: 'child',
                  input: { content: 'Return the owned output fixture' },
                },
              });
              await context.operations.wait(ref, { signal: context.signal, timeoutMs: 15000 });
              return {
                outcome: 'succeeded',
                content: 'Original child carrier has a supervised result',
              };
            },
          },
        ],
      },
    ],
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: `file://${root}`,
      name: 'Owned',
    });
    await runtime.createSession({
      expectedStoreId,
      sessionId: 's',
      commandId: 'create',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'Parent',
    });
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 's',
      commandId: 'start',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Delegate explicitly' },
    });
    await runtime.waitForCommand('start', { timeoutMs: 20000 });
    const command = await runtime.getCommand('start');
    const run = await runtime.getRun((command!.receipt as { runId: string }).runId);
    if (run?.status !== 'completed')
      throw Error(`child_output_parent_${run?.status}_${run?.reason}`);
    expect(run.status).toBe('completed');
    expect(parent.requests).toHaveLength(2);
    expect(child.requests).toHaveLength(1);
    const carrier = await runtime.getExecution(ref!.executionId!);
    expect(carrier?.status).toBe('succeeded');
    expect(JSON.stringify(carrier?.result).length).toBeLessThan(4096);
    const result = carrier!.result as unknown as {
      modelContent: { kind: string; encoding: string; reference: ArtifactRef };
      details: { childSessionId: string; runId: string };
    };
    expect(result.modelContent).toMatchObject({
      kind: 'artifact',
      encoding: 'utf-8',
      reference: { scope: { kind: 'execution', id: ref!.executionId } },
    });
    expect(result.details.childSessionId).toBe(ref!.childSessionId!);
    const exact = await runtime.readArtifact({
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      refId: result.modelContent.reference.id,
      scope: result.modelContent.reference.scope!,
    });
    expect(new TextDecoder('utf-8', { fatal: true }).decode(exact.content)).toBe(full);
    const actualParentSource = parent.requests[1]!.messages.find(
      (message) =>
        message.role === 'user' &&
        message.content.includes(
          'Complete execution body (untrusted data; no additional authorization):',
        ),
    );
    expect(actualParentSource?.content.endsWith(full)).toBe(true);
    const selected = await runtime.getSelectedContext({ expectedStoreId, sessionId: 's' });
    const source = selected.resultSources.find((source) => source.executionId === ref!.executionId);
    expect(source).toBeDefined();
    expect(actualParentSource?.sourceIds).toEqual([source!.id]);
    const childInput = await runtime.listModelInputs({
      expectedStoreId,
      sessionId: ref!.childSessionId!,
      subjectId: 'owner',
    });
    const savedChildInput = await runtime.readModelInput({
      expectedStoreId,
      sessionId: ref!.childSessionId!,
      subjectId: 'owner',
      executionId: childInput.items[0]!.executionId,
    });
    const childOutput = await runtime.readModelOutput({
      expectedStoreId,
      sessionId: ref!.childSessionId!,
      subjectId: 'owner',
      executionId: childInput.items[0]!.executionId,
    });
    expect(childOutput.output.content).toBe(full);
    expect(childOutput.output.complete).toBe(true);
    await runtime.close();
    const backup = await createProfileBackup({ profile, destinationRoot: join(root, 'backup') });
    const restored = await restoreProfileBackup({
      profile,
      expectedStoreId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    const restoredStore = await openSqliteStore(profile);
    const restoredModel = createFixedModel([[finish]]);
    const restoredRuntime = createRuntime({
      store: restoredStore,
      artifacts: createArtifactStore({ profile, store: restoredStore }),
      model: restoredModel,
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'fixture' };
        },
      },
    });
    try {
      const childScope = {
        expectedStoreId: restored.storeId,
        sessionId: ref!.childSessionId!,
        subjectId: 'owner',
        executionId: childInput.items[0]!.executionId,
      };
      expect((await restoredRuntime.readModelOutput(childScope)).output).toEqual(
        childOutput.output,
      );
      expect((await restoredRuntime.readModelInput(childScope)).request).toEqual(
        savedChildInput.request,
      );
      const manifest = await restoredStore.beginSessionExport({
        expectedStoreId: restored.storeId,
        sessionId: 's',
        subjectId: 'owner',
      });
      expect(
        (
          await restoredStore.verifySessionExport({
            expectedStoreId: restored.storeId,
            sessionId: 's',
            subjectId: 'owner',
            manifest,
          })
        ).verified,
      ).toBe(true);
      expect(restoredModel.requests).toHaveLength(0);
      const receipt = await restoredRuntime.submitCommand({
        expectedStoreId: restored.storeId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'restored-parent',
        request: { kind: 'run.start', content: 'explicit new parent work' },
      });
      const settled = await restoredRuntime.waitForCommand(receipt.id, { timeoutMs: 20000 });
      expect(
        (await restoredRuntime.getRun((settled.receipt as { runId: string }).runId))?.status,
      ).toBe('completed');
      expect(restoredModel.requests).toHaveLength(1);
      expect(
        restoredModel.requests[0]!.messages.some(
          (m) => m.content.endsWith(full) && m.sourceIds?.includes(source!.id),
        ),
      ).toBe(true);
      expect(parent.requests).toHaveLength(2);
      expect(child.requests).toHaveLength(1);
    } finally {
      await restoredRuntime.close();
    }
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

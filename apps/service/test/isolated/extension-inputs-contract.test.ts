import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime, type RuntimeOptions } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Json } from '@kite-ai/agent/storage';
import { createFixedModel } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';

test('actual HTTP forwards independent original start/followup intents and publishes only actual Runtime support', async () => {
  const root = mkdtempSync('/private/tmp/kite-http-extension-inputs-');
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({ expectedStoreId, id: 'w', rootUri: 'file:///fixture', name: 'w' });
  await store.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    subjectId: 'user',
    workspaceId: 'w',
    title: 's',
  });
  const model = createFixedModel(
    Array.from({ length: 4 }, () => [
      {
        type: 'finish' as const,
        reason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]),
  );
  const intents: unknown[] = [];
  const options: RuntimeOptions = {
    store,
    model,
    supportsExtensionInputs: true,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    resolveRunConfiguration: async ({ command }) => {
      const request = command.request as { extensionInputs?: Json[] };
      intents.push(request.extensionInputs);
      return {
        model,
        modelId: 'fixed',
        snapshot: { extensionInputs: request.extensionInputs ?? null },
      };
    },
  };
  const runtime = createRuntime(options);
  options.resolveRunConfiguration = undefined;
  options.supportsExtensionInputs = false;
  const profile = { dataRoot: join(root, 'data'), name: 'new', accessKey: 'owned' };
  const service = await startService({
    runtime,
    profile,
    buildId: 'owned',
    subjectId: 'user',
    capabilities: ['commands', 'inputs'],
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { profile, apiMajor: 1, requiredCapabilities: ['run_extension_inputs'] },
  });
  try {
    expect(runtime.supportsExtensionInputs).toBe(true);
    expect((await client.connect()).capabilities).toContain('run_extension_inputs');
    await client.startRun('s', {
      expectedStoreId,
      commandId: 'start',
      kind: 'run.start',
      content: 'text',
      extensionInputs: [
        { extensionId: 'b', definitionVersion: '1', input: { text: 'first' } },
        { extensionId: 'a', definitionVersion: '2', input: null },
        { extensionId: 'b', definitionVersion: '1', input: { text: 'first' } },
      ],
    });
    const started = await runtime.waitForCommand('start');
    const runId = (started.receipt as { runId: string }).runId;
    const contextSelectionId = (await store.getSession('s'))!.contextSelectionId;
    await client.followUp('s', {
      expectedStoreId,
      commandId: 'empty',
      kind: 'input.follow_up',
      content: 'text',
      afterRunId: runId,
      contextSelectionId,
      extensionInputs: [],
    });
    const empty = await runtime.waitForCommand('empty');
    const next = (empty.receipt as { runId: string }).runId;
    await client.followUp('s', {
      expectedStoreId,
      commandId: 'omitted',
      kind: 'input.follow_up',
      content: 'text',
      afterRunId: next,
      contextSelectionId,
    });
    await runtime.waitForCommand('omitted');
    expect((await store.getCommand('start'))!.request).toMatchObject({
      extensionInputs: [
        { extensionId: 'b', definitionVersion: '1', input: { text: 'first' } },
        { extensionId: 'a', definitionVersion: '2', input: null },
        { extensionId: 'b', definitionVersion: '1', input: { text: 'first' } },
      ],
    });
    expect((await store.getCommand('empty'))!.request).toMatchObject({ extensionInputs: [] });
    expect(
      Object.hasOwn((await store.getCommand('omitted'))!.request as object, 'extensionInputs'),
    ).toBe(false);
    expect(intents).toEqual([
      [
        { extensionId: 'b', definitionVersion: '1', input: { text: 'first' } },
        { extensionId: 'a', definitionVersion: '2', input: null },
        { extensionId: 'b', definitionVersion: '1', input: { text: 'first' } },
      ],
      [],
      undefined,
    ]);
    const conflict = await client
      .followUp('s', {
        expectedStoreId,
        commandId: 'empty',
        kind: 'input.follow_up',
        content: 'text',
        afterRunId: runId,
        contextSelectionId,
      })
      .catch((error: unknown) => error);
    expect((conflict as { code?: string }).code).toBe('command_conflict');
    expect(model.requests).toHaveLength(3);
  } finally {
    client.disposeNetwork();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('custom Service capability cannot advertise extension input support for unsupported fixed Runtime', async () => {
  const root = mkdtempSync('/private/tmp/kite-http-extension-inputs-unsupported-');
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const runtime = createRuntime({
    store,
    model: createFixedModel([]),
    permissions: {
      async authorize() {
        return { allowed: false, revision: '1' };
      },
    },
  });
  const service = await startService({
    runtime,
    profile: { dataRoot: join(root, 'data'), name: 'new', accessKey: 'owned' },
    buildId: 'owned',
    capabilities: ['commands', 'run_extension_inputs'],
  });
  try {
    expect(service.bootstrap.capabilities).toEqual([
      'commands',
      'job_report_resume',
      'job_reconcile',
      'run_resume',
      'session_recovery',
    ]);
    expect(service.bootstrap.capabilities).not.toContain('run_extension_inputs');
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

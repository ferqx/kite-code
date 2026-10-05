import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime, type RuntimeOptions } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';

test('actual HTTP forwards independent original start/followup selections and publishes only actual Runtime support', async () => {
  const root = mkdtempSync('/private/tmp/kite-http-skills-');
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
  const selections: unknown[] = [];
  const options: RuntimeOptions = {
    store,
    model,
    supportsSelectedSkills: true,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    resolveRunConfiguration: async ({ command }) => {
      const request = command.request as { selectedSkills?: string[] };
      selections.push(request.selectedSkills);
      return {
        model,
        modelId: 'fixed',
        snapshot: { selectedSkills: request.selectedSkills ?? null },
      };
    },
  };
  const runtime = createRuntime(options);
  options.resolveRunConfiguration = undefined;
  options.supportsSelectedSkills = false;
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
    expected: { profile, apiMajor: 1, requiredCapabilities: ['run_skill_selection'] },
  });
  try {
    expect(runtime.supportsSelectedSkills).toBe(true);
    expect((await client.connect()).capabilities).toContain('run_skill_selection');
    await client.startRun('s', {
      expectedStoreId,
      commandId: 'start',
      kind: 'run.start',
      content: 'text',
      selectedSkills: ['b', 'a', 'b'],
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
      selectedSkills: [],
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
      selectedSkills: ['b', 'a', 'b'],
    });
    expect((await store.getCommand('empty'))!.request).toMatchObject({ selectedSkills: [] });
    expect(
      Object.hasOwn((await store.getCommand('omitted'))!.request as object, 'selectedSkills'),
    ).toBe(false);
    expect(selections).toEqual([['b', 'a', 'b'], [], undefined]);
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

test('custom Service capability cannot advertise selection for unsupported fixed Runtime', async () => {
  const root = mkdtempSync('/private/tmp/kite-http-skills-unsupported-');
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
    capabilities: ['commands', 'run_skill_selection'],
  });
  try {
    expect(service.bootstrap.capabilities).toEqual([
      'commands',
      'job_report_resume',
      'job_reconcile',
      'run_resume',
      'session_recovery',
    ]);
    expect(service.bootstrap.capabilities).not.toContain('run_skill_selection');
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

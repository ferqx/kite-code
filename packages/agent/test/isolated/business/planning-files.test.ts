import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createPlanFiles,
  createPlanningValidation,
  planningExtensionId,
} from '../../../src/business/planning';
import type { Json } from '../../../src/extensions';
import { selectProfile } from '../../../src/platform/profile';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-plan-file-reuse-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const planning = createPlanningValidation(
    {},
    createPlanFiles(selectProfile(profile).profilePath),
  );
  const runtime = createRuntime({
    store,
    extensions: [planning.extension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'authorized-test-host' };
      },
    },
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'test',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    ...base,
    commandId: 'create',
    workspaceId: 'w',
    title: 'planning',
  });
  let sequence = 0;
  async function invoke(actionId: string, input: Json, commandId = `action-${++sequence}`) {
    await runtime.submitCommand({
      ...base,
      commandId,
      request: {
        kind: 'extension.invoke',
        extensionId: planningExtensionId,
        actionId,
        definitionVersion: '1',
        input,
      },
    });
    const command = await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
    const receipt = command.receipt as Record<string, Json>;
    return (await store.getExecution(String(receipt.executionId)))!;
  }
  return {
    store,
    invoke,
    async write(planId: string, expectedVersion: number | null, body: string, commandId?: string) {
      return invoke(
        'planning.write',
        { planId, expectedVersion, title: planId, body, steps: [{ id: 'one', title: 'One step' }] },
        commandId,
      );
    },
    record(key: string) {
      return store.getExtensionRecord({ sessionId: 's', extensionId: planningExtensionId, key });
    },
    async path(key: string) {
      const plan = (await store.getExtensionRecord({
        sessionId: 's',
        extensionId: planningExtensionId,
        key,
      }))!.value as Record<string, Json>;
      return join(
        selectProfile(profile).profilePath,
        String((plan.file as Record<string, Json>).path),
      );
    },
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a registered Plan file stays bound to its Session and Plan ID while restore keeps the original Store directory', () => {
  const files = createPlanFiles(join(tmpdir(), 'plan-scope-test'));
  const original = files.describe({
    storeId: 'original-store',
    sessionId: 's',
    planId: 'A',
    body: 'Original',
    previous: null,
  });
  expect(
    files.describe({
      storeId: 'restored-store',
      sessionId: 's',
      planId: 'A',
      body: 'Revised',
      previous: original,
    }).path,
  ).toBe(original.path);
  for (const [sessionId, planId] of [
    ['foreign', 'A'],
    ['s', 'foreign'],
  ])
    expect(() =>
      files.describe({
        storeId: 'original-store',
        sessionId: sessionId!,
        planId: planId!,
        body: 'Revised',
        previous: original,
      }),
    ).toThrow('plan_file_invalid');
});

test('Plan ID reuse reads the latest numeric version beyond one namespace page, preserves history and retries only the original command', async () => {
  const f = await fixture();
  try {
    for (let version = 1; version <= 11; version++)
      expect(
        (await f.write('Z', version === 1 ? null : version - 1, `Z version ${version}`)).status,
      ).toBe('succeeded');
    const original = await f.record('plan/Z/1');
    const latest = await f.record('plan/Z/11');
    const path = await f.path('plan/Z/11');
    for (let version = 12; version <= 211; version++)
      expect((await f.write('B', version - 1, `B version ${version}`)).status).toBe('succeeded');
    const reused = await f.write('Z', 211, 'Z reused after B', 'reuse-original');
    expect({ status: reused.status, result: reused.result }).toMatchObject({ status: 'succeeded' });
    expect((await f.record('plan.current'))!.value).toMatchObject({ planId: 'Z', version: 212 });
    expect(await f.path('plan/Z/212')).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe('Z reused after B');
    expect(await f.record('plan/Z/1')).toEqual(original);
    expect(await f.record('plan/Z/11')).toEqual(latest);
    const before = statSync(path);
    const count = (await f.store.listExecutions('s')).length;
    expect(await f.write('Z', 211, 'Z reused after B', 'reuse-original')).toEqual(reused);
    expect((await f.store.listExecutions('s')).length).toBe(count);
    expect((await f.write('Z', 211, 'Z reused after B')).status).toBe('failed');
    const after = statSync(path);
    expect({ ino: after.ino, size: after.size, mtimeMs: after.mtimeMs }).toEqual({
      ino: before.ino,
      size: before.size,
      mtimeMs: before.mtimeMs,
    });
    expect(
      (await f.store.listExecutions('s')).some((execution) => execution.kind === 'model'),
    ).toBe(false);
  } finally {
    await f.close();
  }
}, 30000);

test('an inactive Plan file changed externally is rejected before pending publication and keeps the current plan usable', async () => {
  const f = await fixture();
  try {
    expect((await f.write('A', null, 'Original A')).status).toBe('succeeded');
    const path = await f.path('plan/A/1');
    expect((await f.write('B', 1, 'Current B')).status).toBe('succeeded');
    const publication = await f.record('plan.file.publication');
    const current = await f.record('plan.current');
    writeFileSync(path, 'External A must survive');
    const refused = await f.write('A', 2, 'New A');
    expect(refused).toMatchObject({ status: 'failed', result: { content: 'plan_file_changed' } });
    expect(readFileSync(path, 'utf8')).toBe('External A must survive');
    expect(await f.record('plan.file.publication')).toEqual(publication);
    expect(await f.record('plan.current')).toEqual(current);
    expect(await f.record('plan/A/3')).toBeNull();
    expect((await f.write('C', 2, 'A different new plan')).status).toBe('succeeded');
  } finally {
    await f.close();
  }
});

for (const fault of ['document', 'committed', 'committed-drift'] as const)
  test(`reused Plan publication preserves unknown and resumes its exact original bytes after ${fault} failure`, async () => {
    const f = await fixture();
    const originalWrite = f.store.writeExtensionRecord.bind(f.store);
    let injected = 0;
    try {
      expect((await f.write('A', null, 'Original A')).status).toBe('succeeded');
      const path = await f.path('plan/A/1');
      const historical = await f.record('plan/A/1');
      expect((await f.write('B', 1, 'Current B')).status).toBe('succeeded');
      f.store.writeExtensionRecord = async (input) => {
        const value = input.write.value as Record<string, Json>;
        if (
          injected === 0 &&
          input.extensionId === planningExtensionId &&
          (fault === 'document'
            ? input.write.key === 'plan/A/3'
            : input.write.key === 'plan.file.publication' && value.state === 'committed')
        ) {
          injected++;
          expect(readFileSync(path, 'utf8')).toBe('Reused A');
          throw Error('injected_reused_plan_sql_failure');
        }
        return originalWrite(input);
      };
      const unknown = await f.write('A', 2, 'Reused A');
      expect(injected).toBe(1);
      expect(unknown.status).toBe('outcome_unknown');
      expect((await f.record('plan.file.publication'))!.value).toMatchObject({
        state: 'pending',
        key: 'plan/A/3',
      });
      f.store.writeExtensionRecord = originalWrite;
      if (fault === 'committed-drift') writeFileSync(path, 'External newer A');
      const before = statSync(path);
      const retried = await f.write('A', 2, 'Reused A');
      if (fault === 'committed-drift') {
        expect(retried).toMatchObject({
          status: 'failed',
          result: { content: 'plan_file_changed' },
        });
        expect(readFileSync(path, 'utf8')).toBe('External newer A');
        expect((await f.record('plan.file.publication'))!.value).toMatchObject({
          state: 'pending',
        });
      } else {
        expect(retried.status).toBe('succeeded');
        expect((await f.record('plan.current'))!.value).toMatchObject({ planId: 'A', version: 3 });
        expect((await f.record('plan.file.publication'))!.value).toMatchObject({
          state: 'committed',
        });
        expect(readFileSync(path, 'utf8')).toBe('Reused A');
      }
      const after = statSync(path);
      expect({ ino: after.ino, size: after.size, mtimeMs: after.mtimeMs }).toEqual({
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
      });
      expect(await f.record('plan/A/1')).toEqual(historical);
      expect(await f.store.getExecution(unknown.id)).toEqual(unknown);
    } finally {
      f.store.writeExtensionRecord = originalWrite;
      await f.close();
    }
  });

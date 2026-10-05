import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixedModel } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { openSqliteStore } from '../../../src/sqlite';
import type { CommandRequest } from '../../../src/storage/types';

async function reject(work: Promise<unknown>, code: string) {
  const error = await work.catch((error: unknown) => error);
  expect((error as { code?: string })?.code).toBe(code);
}

async function fixture() {
  const root = mkdtempSync('/private/tmp/kite-selected-skills-');
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile);
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
  return { root, profile, store, base: { expectedStoreId, sessionId: 's', subjectId: 'user' } };
}

test('selection arrays remain exact through digest, idempotency and cold reads for both Command kinds', async () => {
  const f = await fixture();
  let closed = false;
  try {
    const contextSelectionId = (await f.store.getSession('s'))!.contextSelectionId;
    for (const kind of ['run.start', 'input.follow_up'] as const) {
      const request: CommandRequest =
        kind === 'run.start'
          ? { kind, content: 'text', selectedSkills: ['b', 'a', 'b'] }
          : {
              kind,
              content: 'text',
              selectedSkills: ['b', 'a', 'b'],
              afterRunId: null,
              contextSelectionId,
            };
      const input = { ...f.base, commandId: kind, request };
      const original = await f.store.acceptCommand(input);
      expect((await f.store.acceptCommand(input)).requestDigest).toBe(original.requestDigest);
      expect(JSON.parse(JSON.stringify(original.request))).toEqual(
        JSON.parse(JSON.stringify(request)),
      );
      for (const selectedSkills of [[], ['a'], undefined]) {
        const changed = { ...request };
        if (selectedSkills === undefined) delete changed.selectedSkills;
        else changed.selectedSkills = selectedSkills;
        await reject(f.store.acceptCommand({ ...input, request: changed }), 'command_conflict');
      }
    }
    for (const kind of ['run.start', 'input.follow_up'] as const) {
      const request: CommandRequest =
        kind === 'run.start'
          ? { kind, content: 'empty', selectedSkills: [] }
          : { kind, content: 'empty', selectedSkills: [], afterRunId: null, contextSelectionId };
      const input = { ...f.base, commandId: `empty-${kind}`, request };
      await f.store.acceptCommand(input);
      const omitted = { ...request };
      delete omitted.selectedSkills;
      await reject(f.store.acceptCommand({ ...input, request: omitted }), 'command_conflict');
    }
    await f.store.close();
    closed = true;
    const cold = await openSqliteStore(f.profile);
    try {
      expect((await cold.getCommand('run.start'))!.request).toMatchObject({
        selectedSkills: ['b', 'a', 'b'],
      });
      expect((await cold.getCommand('input.follow_up'))!.request).toMatchObject({
        selectedSkills: ['b', 'a', 'b'],
      });
    } finally {
      await cold.close();
    }
  } finally {
    if (!closed) await f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('direct malformed selection and hidden start fields reject before durable acceptance', async () => {
  const f = await fixture();
  try {
    const contextSelectionId = (await f.store.getSession('s'))!.contextSelectionId;
    for (const kind of ['run.start', 'input.follow_up'] as const)
      for (const selectedSkills of [
        null,
        'a',
        [''],
        ['x'.repeat(129)],
        Array(257).fill('a'),
        [1],
      ]) {
        await reject(
          f.store.acceptCommand({
            ...f.base,
            commandId: crypto.randomUUID(),
            request: {
              kind,
              content: 'text',
              selectedSkills,
              ...(kind === 'input.follow_up' ? { afterRunId: null, contextSelectionId } : {}),
            } as CommandRequest,
          }),
          'invalid_input_request',
        );
      }
    await reject(
      f.store.acceptCommand({
        ...f.base,
        commandId: 'hidden',
        request: {
          kind: 'run.start',
          content: 'text',
          authority: true,
        } as unknown as CommandRequest,
      }),
      'invalid_input_request',
    );
    expect(await f.store.getCommand('hidden')).toBeNull();
  } finally {
    await f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('unsupported fixed and custom resolver persist a rejection without model or resolver effects', async () => {
  for (const custom of [false, true]) {
    const f = await fixture();
    let calls = 0;
    const model = createFixedModel([]);
    const runtime = createRuntime({
      store: f.store,
      model,
      permissions: {
        async authorize() {
          return { allowed: true, revision: '1' };
        },
      },
      ...(custom
        ? {
            resolveRunConfiguration: async () => {
              calls++;
              throw Error('must not resolve');
            },
          }
        : {}),
    });
    try {
      expect(runtime.supportsSelectedSkills).toBe(false);
      const contextSelectionId = (await f.store.getSession('s'))!.contextSelectionId;
      for (const kind of ['run.start', 'input.follow_up'] as const) {
        const input = {
          ...f.base,
          commandId: kind,
          request: {
            kind,
            content: 'text',
            selectedSkills: [],
            ...(kind === 'input.follow_up' ? { afterRunId: null, contextSelectionId } : {}),
          } as CommandRequest,
        };
        await runtime.submitCommand(input);
        const rejected = await runtime.waitForCommand(kind, { timeoutMs: 3000 });
        expect(rejected.status).toBe('rejected');
        expect(JSON.stringify(rejected.receipt)).toContain('selected_skills_unavailable');
        expect((await runtime.submitCommand(input)).requestDigest).toBe(rejected.requestDigest);
        expect(calls).toBe(0);
        expect(model.requests).toHaveLength(0);
      }
    } finally {
      await runtime.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

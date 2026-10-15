import { expect, test } from 'bun:test';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import type { AuthorizationRequest, ToolContext } from '../../../src/extensions';
import { createPermissionPolicy } from '../../../src/permissions';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage/types';
import { createPathFileTools } from '../../../src/tools/path-files';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-path-files-')));
  const home = join(root, 'home');
  const profile = join(root, 'profile');
  mkdirSync(home);
  mkdirSync(profile, { mode: 0o700 });
  const api = createPathFileTools({
    qualifiedPlatforms: [process.platform],
    protectedRoots: [profile],
  });
  const request = (id: string, input: Json): AuthorizationRequest =>
    ({
      kind: 'tool',
      definitionId: id,
      definitionVersion: '1',
      input,
      signal: new AbortController().signal,
    }) as AuthorizationRequest;
  const proof = async (id: string, input: Json) => {
    const capability = await api.describeRequest(request(id, input));
    return {
      revision: 'accepted-owned-dispatch',
      snapshot: {
        namespace: 'builtin.permissions',
        version: '1',
        data: { mode: 'accept_edits', workspaceTrust: true, capability },
      },
    };
  };
  const execute = async (id: string, input: Json, authorization?: unknown) =>
    api.tools
      .find((tool) => tool.id === id)!
      .execute(input, {
        signal: new AbortController().signal,
        dispatchAuthorization: authorization ?? (await proof(id, input)),
      } as unknown as ToolContext);
  return {
    root,
    home,
    profile,
    api,
    request,
    proof,
    execute,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
test('absolute file tools retain native complete text, exact CAS and external change scope', async () => {
  const f = fixture();
  try {
    const path = join(f.home, 'outside.txt');
    const written = await f.execute('files.write_path', {
      path,
      content: '\uFEFFline1\r\nline2\r\n',
      base: null,
    });
    expect(written.outcome).toBe('succeeded');
    expect(readFileSync(path, 'utf8')).toBe('\uFEFFline1\r\nline2\r\n');
    expect(written.details).toMatchObject({
      fileScope: 'external_path',
      workspaceCheckpoint: false,
      fileChange: { path },
    });
    const observed = JSON.parse((await f.execute('files.read_path', { path })).content);
    expect(observed.path).toBe(path);
    expect(observed.content).toBe('\uFEFFline1\r\nline2\r\n');
    const edit = {
      path,
      base: observed.baseline,
      find: 'line2',
      replace: 'changed',
      occurrences: 1,
    };
    expect((await f.execute('files.edit_path', edit)).outcome).toBe('succeeded');
    expect(readFileSync(path, 'utf8')).toBe('\uFEFFline1\r\nchanged\r\n');
    expect((await f.execute('files.edit_path', edit)).outcome).toBe('failed');
    expect(readFileSync(path, 'utf8')).toBe('\uFEFFline1\r\nchanged\r\n');
  } finally {
    f.close();
  }
});
test('scope proof binds original target and parent identity; private, symlink and unqualified paths cannot publish', async () => {
  const f = fixture();
  try {
    const input = { path: join(f.home, 'original'), content: 'exact', base: null };
    const original = await f.proof('files.write_path', input);
    expect(
      (await f.execute('files.write_path', { ...input, path: join(f.home, 'different') }, original))
        .outcome,
    ).toBe('failed');
    expect(existsSync(join(f.home, 'different'))).toBe(false);
    const selected = join(f.home, 'selected');
    writeFileSync(selected, 'old');
    const selectedInput = { path: selected };
    const selectedProof = await f.proof('files.read_path', selectedInput);
    renameSync(selected, `${selected}-old`);
    writeFileSync(selected, 'replacement');
    expect((await f.execute('files.read_path', selectedInput, selectedProof)).outcome).toBe(
      'failed',
    );
    expect(readFileSync(selected, 'utf8')).toBe('replacement');
    const moved = `${f.home}-moved`;
    renameSync(f.home, moved);
    mkdirSync(f.home);
    expect((await f.execute('files.write_path', input, original)).outcome).toBe('failed');
    expect(existsSync(input.path)).toBe(false);
    writeFileSync(join(f.profile, 'secret'), 'private');
    linkSync(join(f.profile, 'secret'), join(f.home, 'hardlinked'));
    expect((await f.execute('files.read_path', { path: join(f.home, 'hardlinked') })).outcome).toBe(
      'failed',
    );
    expect(readFileSync(join(f.profile, 'secret'), 'utf8')).toBe('private');
    expect(
      (await f.execute('files.read_path', { path: join(f.profile, 'secret') })).details,
    ).toMatchObject({ code: 'file_path_protected' });
    symlinkSync(
      f.profile,
      join(f.home, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(
      (await f.execute('files.read_path', { path: join(f.home, 'linked', 'secret') })).outcome,
    ).toBe('failed');
    const unavailable = createPathFileTools({ qualifiedPlatforms: [], protectedRoots: [] });
    expect(await unavailable.describeRequest(f.request('files.write_path', input))).toMatchObject({
      hardAllowed: false,
      denialReason: 'file_platform_unqualified',
    });
    expect(
      (
        await f.execute('files.write_path', {
          path:
            process.platform === 'win32'
              ? join(process.env.SystemRoot!, 'denied.txt')
              : '/usr/denied.txt',
          content: 'bad',
          base: null,
        })
      ).outcome,
    ).toBe('failed');
    const child = await f.proof('files.write_path', input);
    const childData = child.snapshot.data.capability!;
    const intersection = {
      revision: 'accepted',
      snapshot: {
        namespace: 'agent.permission-intersection',
        version: '1',
        data: {
          policies: [
            { scope: 'parent', revision: 'p', allowed: false, snapshot: child.snapshot },
            {
              scope: 'child',
              revision: 'c',
              allowed: true,
              snapshot: {
                ...child.snapshot,
                data: {
                  ...child.snapshot.data,
                  capability: { ...childData, revision: 'different' },
                },
              },
            },
          ],
        },
      },
    };
    expect((await f.execute('files.write_path', input, intersection)).outcome).toBe('failed');
    expect(existsSync(input.path)).toBe(false);
    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await f.api.tools
      .find((tool) => tool.id === 'files.write_path')!
      .execute(input, {
        signal: aborted.signal,
        dispatchAuthorization: await f.proof('files.write_path', input),
      } as unknown as ToolContext);
    expect(cancelled.outcome).toBe('cancelled');
    expect(existsSync(input.path)).toBe(false);
  } finally {
    f.close();
  }
});
test('three strategies classify external mutations and safe reads through the existing permission policy', async () => {
  const f = fixture();
  try {
    const input = { path: join(f.home, 'actual'), content: 'yes', base: null };
    for (const [mode, expected] of [
      ['accept_edits', 'approval_required'],
      ['auto', 'auto_review_required'],
      ['full', undefined],
    ] as const) {
      const policy = createPermissionPolicy({
        readPolicy: (request) => ({
          mode,
          workspaceTrust: true,
          revision: 'source',
          allowed: [
            {
              kind: request.kind,
              definitionId: request.definitionId,
              definitionVersion: request.definitionVersion,
            },
          ],
        }),
        describeCapability: f.api.describeRequest,
      });
      const result = await policy.authorize(f.request('files.write_path', input));
      expect(result.allowed).toBe(mode === 'full');
      if (expected) expect(result.reason).toBe(expected);
      expect(
        (await policy.authorize(f.request('files.read_path', { path: input.path }))).allowed,
      ).toBe(true);
    }
  } finally {
    f.close();
  }
});
test('real Runtime dispatch executes absolute files under actual policy proof and persists original execution facts', async () => {
  const f = fixture();
  const store = await openSqliteStore({ dataRoot: f.profile, profile: 'new' });
  const path = join(f.home, 'actual');
  const finish: Extract<ModelEvent, { type: 'finish' }> = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const runtime = createRuntime({
    store,
    modelId: 'fixed',
    model: createFixedModel([
      [
        {
          type: 'tool_call',
          id: 'write',
          name: 'files.write_path',
          arguments: JSON.stringify({ path, content: 'actual-runtime', base: null }),
        },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
      [
        {
          type: 'tool_call',
          id: 'read',
          name: 'files.read_path',
          arguments: JSON.stringify({ path }),
        },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
    ]),
    extensions: [{ id: 'builtin.files', version: '1', apiMajor: 1, tools: f.api.tools }],
    permissions: createPermissionPolicy({
      readPolicy: (request) => ({
        mode: 'full',
        workspaceTrust: true,
        revision: 'source',
        allowed: [
          {
            kind: request.kind,
            definitionId: request.definitionId,
            definitionVersion: request.definitionVersion,
          },
        ],
      }),
      describeCapability: async (request) =>
        request.kind === 'model'
          ? {
              kind: 'model',
              definitionId: request.definitionId,
              definitionVersion: request.definitionVersion,
              revision: 'fixed',
              effects: [],
              safeRead: false,
              hardAllowed: true,
            }
          : f.api.describeRequest(request),
    }),
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: `file://${f.root}`,
      name: 'actual',
    });
    await runtime.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'actual',
    });
    for (const commandId of ['write', 'read']) {
      await runtime.submitCommand({
        expectedStoreId,
        commandId,
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: commandId },
      });
      await runtime.waitForCommand(commandId);
    }
    expect(readFileSync(path, 'utf8')).toBe('actual-runtime');
    const executions = (await store.listExecutions('s')).filter((execution) =>
      execution.definitionId.startsWith('files.'),
    );
    expect(executions.map((execution) => execution.status)).toEqual(['succeeded', 'succeeded']);
    const read = executions.find((execution) => execution.definitionId === 'files.read_path')!;
    expect(JSON.parse((read.result as { content: string }).content)).toMatchObject({
      path,
      content: 'actual-runtime',
    });
  } finally {
    await runtime.close();
    f.close();
  }
});

test('protected root sets retain exact snapshot identity and actual denial across host entry ordering', async () => {
  const f = fixture();
  try {
    const runtime = join(f.root, 'runtime');
    mkdirSync(runtime);
    for (const root of [f.profile, runtime, f.home])
      writeFileSync(join(root, 'original'), 'original protected bytes');
    const build = (protectedRoots: string[]) =>
      createPathFileTools({ qualifiedPlatforms: [process.platform], protectedRoots });
    const a = build([f.profile, runtime]);
    const b = build([runtime, f.profile, runtime, f.profile]);
    const reduced = build([f.profile]);
    const expanded = build([runtime, f.home, f.profile]);
    expect(b.snapshot).toEqual(a.snapshot);
    expect(reduced.snapshot).not.toEqual(a.snapshot);
    expect(expanded.snapshot).not.toEqual(a.snapshot);
    const read = async (api: ReturnType<typeof build>, root: string) => {
      const input = { path: join(root, 'original') };
      const capability = await api.describeRequest(f.request('files.read_path', input));
      return api.tools
        .find((tool) => tool.id === 'files.read_path')!
        .execute(input, {
          signal: new AbortController().signal,
          dispatchAuthorization: {
            revision: 'actual-set-boundary',
            snapshot: {
              namespace: 'builtin.permissions',
              version: '1',
              data: { mode: 'full', workspaceTrust: true, capability },
            },
          },
        } as unknown as ToolContext);
    };
    for (const api of [a, b]) {
      for (const root of [f.profile, runtime])
        expect(await read(api, root)).toMatchObject({
          outcome: 'failed',
          content: 'file_path_protected',
        });
      expect(await read(api, f.home)).toMatchObject({ outcome: 'succeeded' });
    }
    expect(await read(reduced, f.profile)).toMatchObject({
      outcome: 'failed',
      content: 'file_path_protected',
    });
    expect(await read(reduced, runtime)).toMatchObject({ outcome: 'succeeded' });
    expect(await read(expanded, f.home)).toMatchObject({
      outcome: 'failed',
      content: 'file_path_protected',
    });
    for (const root of [f.profile, runtime, f.home])
      expect(readFileSync(join(root, 'original'), 'utf8')).toBe('original protected bytes');
    expect(() => build([f.profile, f.profile, 'relative'])).toThrow('file_boundary_invalid');
  } finally {
    f.close();
  }
});

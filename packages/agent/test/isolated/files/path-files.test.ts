import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import type { AuthorizationRequest, ToolContext } from '../../../src/extensions';
import { createPermissionPolicy } from '../../../src/permissions';
import { inspectPathFileTarget } from '../../../src/permissions/files-request';
import { privateDirectory } from '../../../src/platform/windows-path-security';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage/types';
import { createPathFileTools } from '../../../src/tools/path-files';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-path-files-')));
  const home = join(root, 'home');
  const profile = join(root, 'profile');
  mkdirSync(home);
  privateDirectory(profile);
  const api = createPathFileTools({
    qualifiedPlatforms: [process.platform],
    protectedRoots: [profile],
  });
  const request = (id: string, input: Json): AuthorizationRequest =>
    ({
      kind: 'tool',
      definitionId: id,
      definitionVersion: id === 'files.read_path' ? '2' : '1',
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
    const target = await inspectPathFileTarget(
      'files.read_path',
      { path },
      {
        qualifiedPlatforms: [process.platform],
        protectedRoots: [f.profile],
      },
    );
    expect(target.identity).toEqual({
      device: observed.baseline.device,
      inode: observed.baseline.inode,
    });
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

(process.platform === 'win32' ? test : test.skip)(
  'Windows external files accept ordinary casing and reject aliases before granting a dispatch scope',
  async () => {
    const f = fixture();
    try {
      const path = join(f.home, 'Exact.txt');
      writeFileSync(path, 'original');
      const variant = join(f.home.toUpperCase(), 'exact.txt');
      const read = await f.execute('files.read_path', { path: variant });
      expect(read.outcome).toBe('succeeded');
      expect(JSON.parse(read.content)).toMatchObject({ path: variant, content: 'original' });
      const created = join(f.home.toUpperCase(), 'NEW.txt');
      expect(
        await f.execute('files.write_path', { path: created, content: 'created', base: null }),
      ).toMatchObject({ outcome: 'succeeded' });
      expect(readFileSync(join(f.home, 'new.txt'), 'utf8')).toBe('created');
      writeFileSync(join(f.profile, 'secret'), 'private');
      expect(
        await f.execute('files.read_path', { path: join(f.profile.toUpperCase(), 'SECRET') }),
      ).toMatchObject({ outcome: 'failed', content: 'file_path_protected' });
      for (const invalid of [
        `${path}:stream`,
        `${path}.`,
        `${path} `,
        join(f.home, 'NUL'),
        join(f.home, 'CON.txt'),
        join(f.home, 'COM1'),
        `${path.slice(0, 2)}relative.txt`,
        `\\\\?\\${path}`,
        '\\\\localhost\\C$\\outside.txt',
      ]) {
        for (const [id, input] of [
          ['files.read_path', { path: invalid }],
          ['files.write_path', { path: invalid, content: 'bad', base: null }],
        ] as const) {
          expect(await f.api.describeRequest(f.request(id, input))).toMatchObject({
            hardAllowed: false,
            denialReason: 'file_path_invalid',
          });
          expect(await f.execute(id, input)).toMatchObject({
            outcome: 'failed',
            content: 'file_path_invalid',
          });
        }
      }
      expect(readFileSync(path, 'utf8')).toBe('original');
      expect(readFileSync(join(f.profile, 'secret'), 'utf8')).toBe('private');
    } finally {
      f.close();
    }
  },
);

for (const decision of ['full', 'approve', 'deny'] as const) {
  test(`real Runtime external files enforce ${decision} policy on the original absolute target`, async () => {
    const f = fixture();
    const profile = { dataRoot: f.profile, profile: 'new' };
    const store = await openSqliteStore(profile);
    const artifacts = createArtifactStore({ profile, store });
    const workspace = join(f.root, 'workspace');
    mkdirSync(workspace);
    const path = join(f.home, 'actual');
    const largePath = join(f.home, 'large.txt');
    const content = `\uFEFFstart\r\n${'完整 α\r\n'.repeat(120000)}end\r\n`;
    writeFileSync(largePath, content);
    expect(Buffer.byteLength(content)).toBeGreaterThan(1024 * 1024);
    const finish: Extract<ModelEvent, { type: 'finish' }> = {
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const model = createFixedModel([
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
        {
          type: 'tool_call',
          id: 'large',
          name: 'files.read_path',
          arguments: JSON.stringify({ path: largePath, limit: 120002 }),
        },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
    ]);
    const runtime = createRuntime({
      store,
      artifacts,
      modelId: 'fixed',
      model,
      extensions: [{ id: 'builtin.files.path', version: '1', apiMajor: 1, tools: f.api.tools }],
      permissions: createPermissionPolicy({
        readPolicy: (request) => ({
          mode: decision === 'full' ? 'full' : 'accept_edits',
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
        rootUri: pathToFileURL(workspace).href,
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
        if (commandId === 'write' && decision !== 'full') {
          const deadline = Date.now() + 5000;
          let card:
            | Awaited<ReturnType<typeof runtime.listInteractions>>['interactions'][number]
            | undefined;
          while (!card && Date.now() < deadline) {
            card = (
              await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' })
            ).interactions[0];
            if (!card) await Bun.sleep(10);
          }
          expect(card).toBeDefined();
          expect(existsSync(path)).toBe(false);
          expect(card!.request).toMatchObject({
            input: { path, content: 'actual-runtime', base: null },
          });
          await runtime.answerInteraction({
            expectedStoreId,
            commandId: `human-${decision}`,
            presentationSessionId: card!.presentationSessionId,
            interactionId: card!.id,
            expectedRevision: card!.revision,
            subjectId: 'owner',
            answer: { kind: 'approval', decision },
          });
        }
        await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
        if (decision === 'deny') {
          expect(existsSync(path)).toBe(false);
          const denied = (await store.listExecutions('s')).find(
            (row) => row.definitionId === 'files.write_path',
          )!;
          expect(denied.status).toBe('failed');
          expect(denied.result).toMatchObject({ content: 'approval_denied' });
          expect(model.requests).toHaveLength(1);
          return;
        }
      }
      expect(readFileSync(path, 'utf8')).toBe('actual-runtime');
      const executions = (await store.listExecutions('s')).filter((execution) =>
        execution.definitionId.startsWith('files.'),
      );
      expect(executions.map((execution) => execution.status)).toEqual([
        'succeeded',
        'succeeded',
        'succeeded',
      ]);
      const read = executions.find(
        (execution) =>
          execution.definitionId === 'files.read_path' &&
          execution.input &&
          (execution.input as { path?: string }).path === path,
      )!;
      expect(JSON.parse((read.result as { content: string }).content)).toMatchObject({
        path,
        content: 'actual-runtime',
      });
      const large = executions.find(
        (execution) => execution.definitionId === 'files.read_path' && execution.id !== read.id,
      )!;
      const result = large.result as {
        content: string;
        artifactRefs: { id: string; scope: { kind: 'execution'; id: string } }[];
      };
      expect(JSON.parse(result.content)).toMatchObject({
        path: largePath,
        inlineBody: false,
        baseline: { hash: createHash('sha256').update(content).digest('hex') },
        body: { complete: true },
      });
      expect(result.artifactRefs).toHaveLength(1);
      const ref = result.artifactRefs[0]!;
      expect(
        Buffer.from(
          await artifacts.read({
            expectedStoreId,
            refId: ref.id,
            sessionId: 's',
            subjectId: 'owner',
            scope: ref.scope,
          }),
        ).toString('utf8'),
      ).toBe(content);
      expect(
        model.requests
          .at(-1)!
          .messages.some((message) => message.role === 'tool' && message.content.endsWith(content)),
      ).toBe(true);
      expect(
        (await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' }))
          .interactions,
      ).toHaveLength(0);
    } finally {
      await runtime.close();
      await artifacts.close();
      f.close();
    }
  });
}

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

test('absolute read defaults to 200 lines with exact continuation, explicit ranges and complete baseline', async () => {
  const f = fixture();
  try {
    const path = join(f.home, 'paged.txt');
    const lines = Array.from(
      { length: 405 },
      (_, index) => `${index === 0 ? '\ufeff' : ''}line ${index + 1}\r\n`,
    );
    const text = lines.join('');
    writeFileSync(path, text);
    expect(f.api.tools.find((tool) => tool.id === 'files.read_path')!.version).toBe('2');
    expect(f.api.snapshot).toMatchObject({
      tools: f.api.tools.map(({ id, version }) => ({ id, definitionVersion: version })),
    });
    for (const id of ['files.write_path', 'files.edit_path'])
      expect(f.api.tools.find((tool) => tool.id === id)!.version).toBe('1');
    const page = async (range: Record<string, number>) => {
      const result = await f.execute('files.read_path', { path, ...range });
      expect(result.outcome).toBe('succeeded');
      return JSON.parse(result.content);
    };
    const first = await page({});
    expect(first.path).toBe(path);
    expect(first.content).toBe(lines.slice(0, 200).join(''));
    expect(first.selection).toEqual({ fromLine: 1, toLine: 200, totalLines: 405, nextOffset: 201 });
    expect(first.baseline.hash).toBe(createHash('sha256').update(text).digest('hex'));
    expect(first.baseline.size).toBe(Buffer.byteLength(text));
    const second = await page({ offset: first.selection.nextOffset });
    const last = await page({ offset: second.selection.nextOffset });
    expect(second.selection).toEqual({
      fromLine: 201,
      toLine: 400,
      totalLines: 405,
      nextOffset: 401,
    });
    expect(last.selection).toEqual({
      fromLine: 401,
      toLine: 405,
      totalLines: 405,
      nextOffset: null,
    });
    expect(first.content + second.content + last.content).toBe(text);
    for (const result of [second, last]) expect(result.baseline).toEqual(first.baseline);
    const explicit = await page({ offset: 2, limit: 300 });
    expect(explicit.content).toBe(lines.slice(1, 301).join(''));
    expect(explicit.selection).toEqual({
      fromLine: 2,
      toLine: 301,
      totalLines: 405,
      nextOffset: 302,
    });
    expect(explicit.baseline).toEqual(first.baseline);
  } finally {
    f.close();
  }
});

test('absolute read rejects stale definition versions in classification and dispatch proof', async () => {
  const f = fixture();
  try {
    const input = { path: join(f.home, 'version.txt') };
    writeFileSync(input.path, 'exact');
    const request = f.request('files.read_path', input);
    const current = await f.api.describeRequest(request);
    expect(current).toMatchObject({ definitionVersion: '2', hardAllowed: true });
    const stale = await f.api.describeRequest({ ...request, definitionVersion: '1' });
    expect(stale).toMatchObject({ hardAllowed: false, denialReason: 'file_input_invalid' });
    const proof = await f.proof('files.read_path', input);
    const staleProof = {
      ...proof,
      snapshot: {
        ...proof.snapshot,
        data: {
          ...proof.snapshot.data,
          capability: { ...current, definitionVersion: '1' },
        },
      },
    };
    expect(await f.execute('files.read_path', input, staleProof)).toMatchObject({
      outcome: 'failed',
      details: { code: 'file_dispatch_scope_changed' },
    });
  } finally {
    f.close();
  }
});

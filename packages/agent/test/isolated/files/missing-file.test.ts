import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '#kite-test';
import type { AuthorizationRequest, ToolContext } from '../../../src/extensions';
import {
  createFileTools,
  createWorkspaceFiles,
  withExternalFileReads,
  withFullAccessFiles,
} from '../../../src/files';
import { AgentError } from '../../../src/storage/types';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-file-missing-')));
  const workspace = join(root, 'workspace'),
    external = join(root, 'external'),
    protectedRoot = join(root, 'private');
  for (const path of [workspace, external, protectedRoot]) mkdirSync(path);
  const native = createWorkspaceFiles({
    root: workspace,
    protectedPaths: ['protected'],
    protectReads: true,
  });
  const tools = createFileTools(native);
  const reads = withExternalFileReads({
    tools,
    workspaceRoot: async () => workspace,
    protectedRoots: () => [protectedRoot],
  });
  const full = withFullAccessFiles({
    tools: reads.tools,
    workspaceRoot: async () => workspace,
    protectedRoots: () => [protectedRoot],
  });
  async function read(
    path: string,
    mode: 'full' | 'auto' | 'accept_edits' = 'full',
    extra: Partial<ToolContext> = {},
  ) {
    const tool = full.tools.find((value) => value.id === 'files.read')!;
    const request: AuthorizationRequest = {
      kind: 'tool',
      definitionId: tool.id,
      definitionVersion: tool.version,
      input: { path },
      executionId: 'read',
      sessionId: 's',
      runId: 'r',
      signal: new AbortController().signal,
    };
    const capability = await reads.describeRequest(request);
    return tool.execute({ path }, {
      executionId: 'read',
      runId: 'r',
      sessionId: 's',
      signal: request.signal,
      dispatchAuthorization: {
        revision: 'accepted',
        snapshot: {
          namespace: 'builtin.permissions',
          version: '1',
          data: { mode, workspaceTrust: true, capability },
        },
      },
      ...extra,
    } as unknown as ToolContext);
  }
  return {
    root,
    workspace,
    external,
    protectedRoot,
    native,
    tools,
    reads,
    full,
    read,
    async close() {
      await native.close();
      rmSync(root, { recursive: true });
    },
  };
}

test('ordinary workspace and external missing reads are explicit observations, distinct from an empty existing file', async () => {
  const f = fixture();
  try {
    for (const mode of ['full', 'auto', 'accept_edits'] as const) {
      for (const path of ['missing/deep.txt', join(f.external, 'missing', 'deep.txt')]) {
        const result = await f.read(path, mode);
        expect(result).toEqual({
          outcome: 'succeeded',
          content: `File does not exist: ${JSON.stringify(path)}.`,
          details: { path, exists: false },
        });
        expect(
          f.tools.find((tool) => tool.id === 'files.read')!.formatModelResult!({ result }),
        ).toBe(result.content);
        expect(
          f.tools.find((tool) => tool.id === 'files.read')!.formatModelResult!({
            result: { ...result, details: { path, exists: false, other: true } },
          }),
        ).toBeUndefined();
      }
    }
    writeFileSync(join(f.workspace, 'empty.txt'), '');
    const empty = await f.read('empty.txt');
    expect(empty.outcome).toBe('succeeded');
    const body = JSON.parse(empty.content);
    expect(body.content).toBe('');
    expect(body.baseline.size).toBe(0);
    expect(empty.details).toBeUndefined();
  } finally {
    await f.close();
  }
});

test('external missing preflight remains readable but protected missing paths and protected aliases do not', async () => {
  const f = fixture();
  try {
    const request = (path: string): AuthorizationRequest => ({
      kind: 'tool',
      definitionId: 'files.read',
      definitionVersion: '4',
      input: { path },
      executionId: 'read',
      runId: 'r',
      sessionId: 's',
      signal: new AbortController().signal,
    });
    expect(
      await f.reads.describeRequest(request(join(f.external, 'missing', 'file.txt'))),
    ).toMatchObject({ hardAllowed: true, safeRead: true, effects: ['read'] });
    const alias = join(f.root, 'private-alias');
    symlinkSync(f.protectedRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    for (const path of [join(f.protectedRoot, 'missing.txt'), join(alias, 'missing.txt')]) {
      expect(await f.reads.describeRequest(request(path))).toMatchObject({
        hardAllowed: false,
        denialReason: 'file_path_protected',
      });
      const result = await f.read(path, 'auto');
      expect(result.outcome).toBe('failed');
      expect(result.details).toMatchObject({ code: 'file_path_protected' });
    }
    const protectedWorkspace = await f.read('protected/missing.txt');
    expect(protectedWorkspace.outcome).toBe('failed');
    expect(protectedWorkspace.details).toMatchObject({ code: 'file_path_protected' });
    if (process.platform !== 'win32') {
      const dangling = join(f.external, 'dangling');
      symlinkSync(join(f.protectedRoot, 'absent-dir'), dangling);
      expect((await f.read(join(dangling, 'file.txt'), 'auto')).outcome).toBe('failed');
    }
  } finally {
    await f.close();
  }
});

test('private factories, invalid paths, cancellation and Artifact ENOENT retain failures instead of claiming a missing ordinary file', async () => {
  const f = fixture();
  try {
    const privateTools = createFileTools(f.native, { missingRead: 'error' });
    const context = {
      signal: new AbortController().signal,
      executionId: 'read',
      runId: 'r',
    } as ToolContext;
    const privateMissing = await privateTools
      .find((tool) => tool.id === 'files.read')!
      .execute({ path: 'private-reference.txt' }, context);
    expect(privateMissing.outcome).toBe('failed');
    expect(privateMissing.details).toEqual({ code: 'ENOENT' });
    expect((await f.read('../outside.txt')).outcome).toBe('failed');
    const controller = new AbortController();
    controller.abort();
    expect((await f.read('missing.txt', 'auto', { signal: controller.signal })).outcome).toBe(
      'cancelled',
    );
    const content = 'x'.repeat(1024 * 1024 + 1);
    writeFileSync(join(f.workspace, 'large.txt'), content);
    writeFileSync(join(f.external, 'large.txt'), content);
    for (const path of ['large.txt', join(f.external, 'large.txt')]) {
      const result = await f.read(path, 'full', {
        artifacts: {
          async publish() {
            throw new AgentError('ENOENT', 'owned Artifact store missing');
          },
        } as unknown as ToolContext['artifacts'],
      });
      expect(result.outcome).toBe('failed');
      expect(result.content).not.toStartWith('File does not exist:');
      expect(readFileSync(path === 'large.txt' ? join(f.workspace, path) : path, 'utf8')).toBe(
        content,
      );
    }
  } finally {
    await f.close();
  }
});

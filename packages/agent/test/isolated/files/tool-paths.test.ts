import { expect, test } from 'bun:test';
import {
  existsSync,
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
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import type { ToolContext } from '../../../src/extensions';
import { createFileTools, createWorkspaceFiles } from '../../../src/files';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage/types';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tool-paths-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const files = createWorkspaceFiles({
    root: workspace,
    protectedPaths: ['private'],
    protectReads: true,
  });
  const captured: string[] = [];
  const tools = createFileTools(files, {
    capture: {
      async before(input) {
        captured.push(input.path);
      },
      async after(_token, result) {
        captured.push(result.path);
      },
      async failed() {},
    },
  });
  return {
    root,
    workspace,
    files,
    captured,
    call: (name: string, input: Json) =>
      tools
        .find((tool) => tool.id === `files.${name}`)!
        .execute(input, {
          signal: new AbortController().signal,
          executionId: 'tool',
          runId: 'run',
        } as ToolContext),
    async close() {
      await files.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('all six Model file tools accept workspace absolute paths and keep relative results and checkpoint capture', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.workspace, 'nested'));
    const path = join(f.workspace, 'nested', 'Exact.txt');
    const write = await f.call('write', { path, content: 'original\n', base: null });
    expect(write.outcome).toBe('succeeded');
    const written = JSON.parse(write.content);
    expect(written.path).toBe('nested/Exact.txt');
    expect(f.captured).toEqual(['nested/Exact.txt', 'nested/Exact.txt']);
    const read = await f.call('read', { path });
    expect(read.outcome).toBe('succeeded');
    expect(JSON.parse(read.content).content).toBe('original\n');
    const edit = await f.call('edit', {
      path,
      base: written.baseline,
      find: 'original',
      replace: 'changed',
      occurrences: 1,
    });
    expect(edit.outcome).toBe('succeeded');
    expect(JSON.parse(edit.content).fileChange.path).toBe('nested/Exact.txt');
    expect(f.captured).toEqual(Array(4).fill('nested/Exact.txt'));
    expect(readFileSync(path, 'utf8')).toBe('changed\n');
    const listed = await f.call('list', { path: join(f.workspace, 'nested') });
    expect(listed.outcome).toBe('succeeded');
    expect(JSON.parse(listed.content).entries).toEqual([{ name: 'Exact.txt', kind: 'file' }]);
    const glob = await f.call('glob', { path: f.workspace, pattern: '**/*.txt' });
    expect(glob.outcome).toBe('succeeded');
    expect(JSON.parse(glob.content).paths).toEqual(['nested/Exact.txt']);
    const search = await f.call('search', { path: f.workspace, text: 'changed', mode: 'content' });
    expect(search.outcome).toBe('succeeded');
    expect(JSON.parse(search.content).matches).toEqual([
      { path: 'nested/Exact.txt', line: 1, content: 'changed' },
    ]);
    // Native and recovery primitives retain their original relative-only contract.
    await expect(f.files.read(path)).rejects.toMatchObject({ code: 'file_path_invalid' });
    await expect(f.files.readBytes(path, { maxBytes: 1024 })).rejects.toMatchObject({
      code: 'file_path_invalid',
    });
  } finally {
    await f.close();
  }
});

test('new writes create nested physical parents and keep create-only, capture and replacement boundaries', async () => {
  const f = fixture();
  try {
    for (const path of [
      'examples/agent_demo.py',
      join(f.workspace, 'deep', 'nested', 'file.txt'),
    ]) {
      const result = await f.call('write', { path, content: 'complete\r\n', base: null });
      expect(result.outcome).toBe('succeeded');
      const written = JSON.parse(result.content);
      expect(readFileSync(join(f.workspace, written.path), 'utf8')).toBe('complete\r\n');
      expect(written.fileChange.before).toBeNull();
      const conflict = await f.call('write', { path, content: 'overwrite', base: null });
      expect(conflict.outcome).toBe('failed');
      expect(conflict.details).toMatchObject({ code: 'file_baseline_conflict' });
      expect(readFileSync(join(f.workspace, written.path), 'utf8')).toBe('complete\r\n');
      const missing = await f.call('write', {
        path: 'missing/parent/file.txt',
        content: 'replacement',
        base: written.baseline,
      });
      expect(missing.outcome).toBe('failed');
      expect(missing.details).toMatchObject({ code: 'ENOENT' });
      expect(missing.content).toContain('required parent directory does not exist');
      expect(existsSync(join(f.workspace, 'missing'))).toBe(false);
      await expect(
        f.files.restore({
          path: 'restore/parent/file.txt',
          base: null,
          bytes: Buffer.from('restore'),
          maxBytes: 100,
        }),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(existsSync(join(f.workspace, 'restore'))).toBe(false);
    }
    expect(f.captured).toContain('examples/agent_demo.py');
  } finally {
    await f.close();
  }
});

test('parent creation rejects protected scopes, real file blockers, links and cancelled calls with actionable failures', async () => {
  const f = fixture();
  try {
    const protectedWrite = await f.call('write', {
      path: 'private/missing/file.txt',
      content: 'bad',
      base: null,
    });
    expect(protectedWrite.outcome).toBe('failed');
    expect(protectedWrite.details).toMatchObject({ code: 'file_path_protected' });
    expect(protectedWrite.content).toContain('Approval does not bypass');
    expect(existsSync(join(f.workspace, 'private'))).toBe(false);
    writeFileSync(join(f.workspace, 'blocker'), 'keep');
    const blocked = await f.call('write', {
      path: 'blocker/child/file.txt',
      content: 'bad',
      base: null,
    });
    expect(blocked.outcome).toBe('failed');
    expect(blocked.details).toMatchObject({ code: 'ENOTDIR', path: 'blocker/child/file.txt' });
    expect(blocked.content).toContain('do not repeat the same target unchanged');
    expect(blocked.content).toContain('Parent directory "blocker"');
    expect(readFileSync(join(f.workspace, 'blocker'), 'utf8')).toBe('keep');
    const outside = join(f.root, 'outside');
    mkdirSync(outside);
    symlinkSync(
      outside,
      join(f.workspace, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const escaped = await f.call('write', {
      path: 'escape/missing/file.txt',
      content: 'bad',
      base: null,
    });
    expect(escaped.outcome).toBe('failed');
    expect(existsSync(join(outside, 'missing'))).toBe(false);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await createFileTools(f.files)
      .find((tool) => tool.id === 'files.write')!
      .execute({ path: 'cancelled/nested/file.txt', content: 'bad', base: null }, {
        signal: controller.signal,
      } as ToolContext);
    expect(cancelled.outcome).toBe('cancelled');
    expect(existsSync(join(f.workspace, 'cancelled'))).toBe(false);
  } finally {
    await f.close();
  }
});

test('directory defaults, absolute roots and native Windows separators select the fixed workspace', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.workspace, 'local.txt'), 'local');
    const inputs: Json[] = [{ limit: 50 }, { path: '' }, { path: '.' }, { path: f.workspace }];
    for (const input of inputs) {
      const result = await f.call('list', input);
      expect(result.outcome).toBe('succeeded');
      expect(JSON.parse(result.content)).toEqual({
        entries: [{ name: 'local.txt', kind: 'file' }],
        next: null,
      });
    }
    if (process.platform === 'win32') {
      mkdirSync(join(f.workspace, 'nested'));
      writeFileSync(join(f.workspace, 'nested', 'file.txt'), 'native');
      for (const path of [
        'nested\\file.txt',
        join(f.workspace.toUpperCase(), 'nested', 'file.txt'),
        join(f.workspace, 'nested', 'file.txt').replaceAll('\\', '/'),
        join(f.workspace, 'nested', 'file.txt').replaceAll('\\', '\\\\'),
      ]) {
        const result = await f.call('read', { path });
        expect(result.outcome).toBe('succeeded');
        expect(JSON.parse(result.content).content).toBe('native');
      }
    }
  } finally {
    await f.close();
  }
});

test('approved Runtime writes persist the actual result and send actionable parent failures to the next Model without host retries', async () => {
  const f = fixture();
  const profile = { dataRoot: join(f.root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const artifacts = createArtifactStore({ profile, store });
  const finish: Extract<ModelEvent, { type: 'finish' }> = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const call = (id: string, path: string): ModelEvent[] => [
    {
      type: 'tool_call',
      id,
      name: 'write_file',
      arguments: JSON.stringify({ path, base: null, content: 'example' }),
    },
    { ...finish, reason: 'tool_calls' },
  ];
  const model = createFixedModel([
    call('new', 'examples/agent_demo.py'),
    call('blocked', 'examples/agent_demo.py/child.txt'),
    [finish],
  ]);
  const runtime = createRuntime({
    store,
    artifacts,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'approved' };
      },
    },
    extensions: [{ id: 'files', version: '1', apiMajor: 1, tools: createFileTools(f.files) }],
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'test',
      rootUri: pathToFileURL(f.workspace).href,
    });
    await runtime.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'test',
    });
    await runtime.submitCommand({
      expectedStoreId,
      commandId: 'run',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Create a workspace example' },
    });
    await runtime.waitForCommand('run');
    const writes = (await store.listExecutions('s')).filter(
      (execution) => execution.kind === 'tool',
    );
    expect(
      writes.map((execution) => [execution.callId, execution.definitionVersion, execution.status]),
    ).toEqual([
      ['new', '3', 'succeeded'],
      ['blocked', '3', 'failed'],
    ]);
    expect(writes.every((execution) => execution.authorization?.dispatched === true)).toBe(true);
    expect(readFileSync(join(f.workspace, 'examples/agent_demo.py'), 'utf8')).toBe('example');
    expect(model.requests).toHaveLength(3);
    const feedback = model.requests[2]!.messages.filter((message) => message.role === 'tool')
      .map((message) => message.content)
      .join('\n');
    expect(feedback).toContain('ENOTDIR');
    expect(feedback).toContain('Parent directory "examples/agent_demo.py"');
    expect(feedback).toContain('do not repeat the same target unchanged');
    expect(writes[1]!.result).toMatchObject({
      outcome: 'failed',
      details: { code: 'ENOTDIR', path: 'examples/agent_demo.py/child.txt' },
    });
  } finally {
    await runtime.close();
    await artifacts.close();
    await f.close();
  }
});

test('Tool path conversion rejects escapes before capture and preserves native path protections', async () => {
  const f = fixture();
  try {
    const sibling = `${f.workspace}-other`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'outside.txt'), 'outside');
    mkdirSync(join(f.workspace, 'private'));
    writeFileSync(join(f.workspace, 'private', 'secret.txt'), 'private');
    const paths = [
      join(sibling, 'outside.txt'),
      '../workspace-other/outside.txt',
      `${f.workspace}/../workspace/local.txt`,
      `${f.workspace}/nested/./file.txt`,
      `${f.workspace}/\0bad`,
      '\ud800',
      ...(process.platform === 'win32'
        ? [
            'C:relative.txt',
            '\\rooted.txt',
            '\\\\server\\share\\file.txt',
            `\\\\?\\${f.workspace}\\local.txt`,
            join(f.workspace, 'local.txt:stream'),
            join(f.workspace, 'local.txt.'),
            join(f.workspace, 'NUL'),
          ]
        : []),
    ];
    for (const path of paths) {
      const result = await f.call('write', { path, content: 'must not publish', base: null });
      expect(result.outcome).toBe('failed');
      expect(result.details).toMatchObject({ code: 'file_path_invalid', path });
      expect(result.content).toContain('Correct the path before another attempt');
    }
    // Invalid Windows components are refused by the original native engine, after capture.
    expect(f.captured.filter((path) => path.includes('..') || path.includes(sibling))).toEqual([]);
    const protectedRead = await f.call('read', {
      path: join(f.workspace, 'private', 'secret.txt'),
    });
    expect(protectedRead.outcome).toBe('failed');
    expect(protectedRead.details).toEqual({ code: 'file_path_protected' });
    expect(readFileSync(join(sibling, 'outside.txt'), 'utf8')).toBe('outside');
    expect(readFileSync(join(f.workspace, 'private', 'secret.txt'), 'utf8')).toBe('private');
  } finally {
    await f.close();
  }
});

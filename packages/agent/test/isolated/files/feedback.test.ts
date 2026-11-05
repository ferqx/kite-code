import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AuthorizationRequest, ToolContext, ToolResult } from '../../../src/extensions';
import {
  createFileTools,
  createWorkspaceFiles,
  withExternalFileReads,
  withFullAccessFiles,
} from '../../../src/files';
import type { Json } from '../../../src/storage/types';
import { toolFailurePresentation } from '../../../src/tool-failure-presentation';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-files-feedback-')));
  const workspace = join(root, 'workspace');
  const external = join(root, 'external');
  const protectedRoot = join(root, 'private');
  for (const path of [workspace, external, protectedRoot]) mkdirSync(path);
  const files = createWorkspaceFiles({
    root: workspace,
    protectedPaths: ['protected'],
    protectReads: true,
  });
  const tools = createFileTools(files);
  const context = {
    sessionId: 'session',
    runId: 'run',
    executionId: 'execution',
    signal: new AbortController().signal,
  } as ToolContext;
  return {
    root,
    workspace,
    external,
    protectedRoot,
    files,
    tools,
    context,
    call: (name: string, input: Json, ownContext = context) =>
      tools.find((tool) => tool.id === `files.${name}`)!.execute(input, ownContext),
    async close() {
      await files.close();
      rmSync(root, { recursive: true });
    },
  };
}
function presented(result: ToolResult) {
  const original = JSON.stringify(result);
  const text = toolFailurePresentation({ result: result as unknown as Record<string, Json> });
  expect(JSON.stringify(result)).toBe(original);
  return text!;
}
function noParentNotice(result: ToolResult) {
  expect(result.content).not.toContain('empty parent directories may remain');
}

test('invalid path, invalid arguments and protected targets fail before parent creation without inventing effects', async () => {
  const f = fixture();
  try {
    for (const [input, code] of [
      [{ path: 'invalid/../target.txt', content: 'bad', base: null }, 'file_path_invalid'],
      [{ path: 'missing/input.txt', base: null }, 'file_input_invalid'],
      [{ path: 'protected/deep/file.txt', content: 'bad', base: null }, 'file_path_protected'],
    ] as const) {
      const result = await f.call('write', input);
      expect(result.outcome).toBe('failed');
      expect(result.details).toMatchObject({ code, path: input.path });
      noParentNotice(result);
      expect(result.content).not.toContain('choose an authorized writable location');
    }
    const controller = new AbortController();
    controller.abort();
    const cancelled = await f.call(
      'write',
      { path: 'cancelled/deep/file.txt', content: 'bad', base: null },
      { ...f.context, signal: controller.signal },
    );
    expect(cancelled.outcome).toBe('cancelled');
    noParentNotice(cancelled);
    for (const path of ['invalid', 'target.txt', 'missing', 'protected', 'cancelled'])
      expect(existsSync(join(f.workspace, path))).toBe(false);
  } finally {
    await f.close();
  }
});

test('range and edit-argument errors explain the model parameter contract without changing raw receipts', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.workspace, 'source.txt'), 'original\n');
    const read = await f.call('read', { path: 'source.txt', offset: 0 });
    expect(read.outcome).toBe('failed');
    expect(read.details).toEqual({ code: 'file_read_range_invalid' });
    const rangeText = presented(read);
    expect(rangeText).toContain('start_line and max_lines must be positive safe integers');
    expect(rangeText).not.toContain('permission denied');
    const edit = await f.call('edit', {
      path: 'source.txt',
      base: null,
      find: 'original',
      replace: 'changed',
      occurrences: 1,
    });
    expect(edit.outcome).toBe('failed');
    expect(edit.details).toMatchObject({ code: 'file_input_invalid' });
    expect(edit.content).toContain('required fields');
    const baseline = JSON.parse((await f.call('read', { path: 'source.txt' })).content).baseline;
    const emptyText = await f.call('edit', {
      path: 'source.txt',
      base: baseline,
      find: '',
      replace: 'changed',
      occurrences: 1,
    });
    expect(emptyText.details).toMatchObject({ code: 'file_edit_invalid' });
    expect(emptyText.content).toContain('nonempty old_text');
    expect(emptyText.content).toContain('positive integer expected_matches');
    expect(readFileSync(join(f.workspace, 'source.txt'), 'utf8')).toBe('original\n');
  } finally {
    await f.close();
  }
});

test('edit match conflicts and complete-file baseline conflicts retain distinct recovery guidance', async () => {
  const f = fixture();
  try {
    const path = join(f.workspace, 'source.txt');
    writeFileSync(path, 'same\nsame\n');
    const baseline = JSON.parse((await f.call('read', { path: 'source.txt' })).content).baseline;
    const mismatch = await f.call('edit', {
      path: 'source.txt',
      base: baseline,
      find: 'same',
      replace: 'changed',
      occurrences: 1,
    });
    expect(mismatch.outcome).toBe('failed');
    expect(mismatch.details).toMatchObject({ code: 'file_edit_match_conflict' });
    expect(mismatch.content).toContain('This edit did not publish a change');
    expect(mismatch.content).toContain('do not broaden the requested replacement');
    expect(readFileSync(path, 'utf8')).toBe('same\nsame\n');
    noParentNotice(mismatch);
    writeFileSync(path, 'current\n');
    const conflict = await f.call('write', {
      path: 'source.txt',
      base: baseline,
      content: 'requested\n',
    });
    expect(conflict.details).toMatchObject({ code: 'file_baseline_conflict' });
    expect(conflict.content).toContain('does not report the current file content');
    noParentNotice(conflict);
    expect(readFileSync(path, 'utf8')).toBe('current\n');
  } finally {
    await f.close();
  }
});

test('supported Full external operations explain OS/path failure without imposing a workspace-only target', async () => {
  const f = fixture();
  try {
    const reads = withExternalFileReads({
      tools: f.tools,
      workspaceRoot: async () => f.workspace,
      protectedRoots: () => [f.protectedRoot],
    });
    const api = withFullAccessFiles({
      tools: reads.tools,
      workspaceRoot: async () => f.workspace,
      protectedRoots: () => [f.protectedRoot],
    });
    async function execute(id: string, input: Json) {
      const tool = api.tools.find((item) => item.id === id)!;
      const request: AuthorizationRequest = {
        kind: 'tool',
        definitionId: id,
        definitionVersion: tool.version,
        sessionId: 'session',
        runId: 'run',
        executionId: 'full-file',
        signal: f.context.signal,
        input,
      };
      const capability = (await api.describeRequest(request, { mode: 'full' })) ?? {
        kind: 'tool',
        definitionId: id,
        definitionVersion: tool.version,
        revision: 'accepted-external-read',
        hardAllowed: true,
      };
      return tool.execute(input, {
        ...f.context,
        dispatchAuthorization: {
          revision: 'accepted-full',
          snapshot: {
            namespace: 'builtin.permissions',
            version: '1',
            data: { mode: 'full', workspaceTrust: true, capability },
          },
        },
      } as unknown as ToolContext);
    }
    const originalPath = join(f.external, 'source.txt');
    writeFileSync(originalPath, 'original\n');
    const read = await execute('files.read', { path: originalPath });
    const baseline = JSON.parse(read.content).baseline;
    const missingPath = join(f.external, 'missing', 'target.txt');
    const missing = await execute('files.write', {
      path: missingPath,
      content: 'replacement',
      base: baseline,
    });
    expect(missing.outcome).toBe('failed');
    expect(missing.details).toMatchObject({ code: 'ENOENT', fileScope: 'external_path' });
    expect(missing.content).toContain('replacement and edit require an existing file');
    noParentNotice(missing);
    const invalid = await execute('files.read', { path: `${f.external}/./source.txt` });
    expect(invalid.details).toMatchObject({ code: 'file_path_invalid' });
    expect(invalid.content).toContain('declared scope and path syntax');
    expect(invalid.content).not.toContain('inside the authorized workspace');
    expect(invalid.content).not.toContain('outside the fixed workspace');
    expect(existsSync(join(f.external, 'missing'))).toBe(false);
    expect(readFileSync(originalPath, 'utf8')).toBe('original\n');
  } finally {
    await f.close();
  }
});

test('only actual parent-creation attempts report possible residue, and close unknown retains the original cause', () => {
  const binding = fileURLToPath(new URL('../../../src/files-native-binding.ts', import.meta.url));
  const entry = new URL('../../../src/files.ts', import.meta.url).href;
  const types = new URL('../../../src/storage/types.ts', import.meta.url).href;
  const child = Bun.spawnSync(
    [
      process.execPath,
      '--eval',
      `
      import {mock} from 'bun:test';
      import * as fs from 'node:fs';
      import {join} from 'node:path';
      import {tmpdir} from 'node:os';
      import {AgentError} from ${JSON.stringify(types)};
      import {createNativeWorkspaceFileIo} from ${JSON.stringify(pathToFileURL(binding).href)};
      const originalNative = createNativeWorkspaceFileIo;
      let scenario = '', creates = 0, failClose = false;
      mock.module(${JSON.stringify(binding)}, () => ({createNativeWorkspaceFileIo(...args) {
        const io = originalNative(...args);
        return {...io, openAt(parent, name, kind, strict) {
          if (kind === 'create-directory') {
            creates++;
            if (scenario === 'denied' || creates === 2) {
              failClose = scenario === 'unknown';
              throw new AgentError('EACCES', 'original parent access failure');
            }
          }
          return io.openAt(parent, name, kind, strict);
        }, closeHandle(id) {
          io.closeHandle(id);
          if (failClose) {failClose=false;throw new AgentError('file_close_unknown','original parent close failure');}
        }};
      }}));
      const {createWorkspaceFiles,createFileTools} = await import(${JSON.stringify(entry)});
      const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'kite-parent-feedback-')));
      const facts = [];
      try {
        for (scenario of ['denied','partial','unknown']) {
          creates=0;
          const workspace=join(root,scenario);fs.mkdirSync(workspace);
          const files=createWorkspaceFiles({root:workspace});
          try {
            const result=await createFileTools(files).find(t=>t.id==='files.write').execute(
              {path:'first/second/file.txt',content:'requested',base:null},
              {signal:new AbortController().signal,executionId:'native-file',runId:'run'});
            facts.push({scenario,result,parent:fs.existsSync(join(workspace,'first')),target:fs.existsSync(join(workspace,'first/second/file.txt'))});
          } finally {await files.close();}
        }
        console.log(JSON.stringify(facts));
      } finally {fs.rmSync(root,{recursive:true,force:true});}
      `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const [denied, partial, unknown] = JSON.parse(child.stdout.toString());
  expect(denied).toMatchObject({ parent: false, target: false });
  expect(denied.result.outcome).toBe('failed');
  expect(denied.result.details.code).toBe('EACCES');
  expect(denied.result.content).toContain('original parent access failure');
  expect(denied.result.content).not.toContain('empty parent directories may remain');
  expect(partial).toMatchObject({ parent: true, target: false });
  expect(partial.result.outcome).toBe('failed');
  expect(partial.result.details.code).toBe('EACCES');
  expect(partial.result.content).toContain('original parent access failure');
  expect(partial.result.content).toContain('empty parent directories may remain');
  expect(partial.result.content).toContain(
    'Tool approval does not override filesystem permissions',
  );
  expect(unknown).toMatchObject({ parent: true, target: false });
  expect(unknown.result.outcome).toBe('outcome_unknown');
  expect(unknown.result.details.code).toBe('file_publish_outcome_unknown');
  expect(unknown.result.content).toContain('original parent access failure');
  expect(unknown.result.content).toContain('original parent close failure');
  expect(unknown.result.content).toContain('Do not repeat the write');
});

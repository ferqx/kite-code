import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactRef, ToolContext, ToolResult } from '../../../src/extensions';
import { createFileTools, createWorkspaceFiles, type WorkspaceFiles } from '../../../src/files';
import { readModelExecutionId } from '../../../src/model-identifier';
import { formatFileReadResult } from '../../../src/tools/files/model-result';

const owners: WorkspaceFiles[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const files of owners.splice(0)) await files.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-model-result-')));
  roots.push(root);
  const files = createWorkspaceFiles({ root });
  owners.push(files);
  const tools = createFileTools(files);
  const context = {
    executionId: 'actual-execution',
    runId: 'actual-run',
    signal: new AbortController().signal,
  } as ToolContext;
  const execute = async (id: string, input: Record<string, unknown>, ownContext = context) => {
    const tool = tools.find((tool) => tool.id === id)!;
    return tool.execute(input as Parameters<typeof tool.execute>[0], ownContext);
  };
  return {
    files,
    tools,
    root,
    context,
    execute,
    put: (name: string, content: string | Buffer) => writeFileSync(join(root, name), content),
  };
}
function presentedBody(text: string) {
  return text.slice(
    text.indexOf(' UTF-8 bytes; starts on next line):\n') +
      ' UTF-8 bytes; starts on next line):\n'.length,
  );
}

test('read presentation preserves exact body and the complete baseline remains usable for a real edit', async () => {
  const f = fixture();
  const content = '\uFEFFquote "x" \\path\r\n```\nContent (fake header):\n雪😀e\u0301\n';
  f.put('a.txt', content);
  const result = await f.execute('files.read', { path: 'a.txt' });
  const original = JSON.stringify(result);
  const tool = f.tools.find((tool) => tool.id === 'files.read')!;
  expect(tool.model?.resultVersion).toBe('1');
  const text = tool.formatModelResult!({ result })!;
  expect(text).toContain('complete file');
  const executionReference = JSON.parse(text.match(/^execution_id: (.+)$/m)![1]!);
  expect(readModelExecutionId(executionReference)).toBe(f.context.executionId);
  expect(text).not.toContain('"observation"');
  expect(presentedBody(text)).toBe(content);
  const baseRef = JSON.parse(
    text
      .split('\n')
      .find((line) => line.startsWith('base_ref='))!
      .slice('base_ref='.length),
  );
  expect(baseRef).toBe(JSON.parse(result.content).base_ref);
  expect(text).not.toContain('baseline=');
  const baseline = JSON.parse(result.content).baseline;
  const edit = await f.execute('files.edit', {
    path: 'a.txt',
    base: baseline,
    find: 'quote "x"',
    replace: 'changed',
    occurrences: 1,
  });
  expect(edit.outcome).toBe('succeeded');
  expect((await f.files.read('a.txt')).content).toBe(content.replace('quote "x"', 'changed'));
  expect(JSON.stringify(result)).toBe(original);
  expect(formatFileReadResult({ result: { ...result, outcome: 'failed' } })).toBeUndefined();
  const raw = JSON.parse(result.content);
  expect(
    formatFileReadResult({
      result: {
        ...result,
        content: JSON.stringify({
          ...raw,
          observation: { ...raw.observation, newMaterialFact: true },
        }),
      },
    }),
  ).toBeUndefined();
});

test('read presentation omits missing or invalid execution identity without changing the body', async () => {
  const f = fixture();
  f.put('a.txt', 'original\n');
  const read = await f.execute('files.read', { path: 'a.txt' });
  for (const executionId of [undefined, null, 42, '', 'invalid\0id', 'a'.repeat(257), '\uD800']) {
    const result = {
      ...read,
      content: JSON.stringify({ ...JSON.parse(read.content), executionId }),
    };
    const presented = formatFileReadResult({ result })!;
    expect(presented).not.toMatch(/^execution_id:/m);
    expect(presentedBody(presented)).toBe('original\n');
  }
});

test('external read presentation preserves an available native baseline without granting write authority', async () => {
  const f = fixture();
  f.put('external.txt', 'original\n');
  const read = await f.execute('files.read', { path: 'external.txt' });
  const body = { ...JSON.parse(read.content), path: join(f.root, 'external.txt') };
  const result: ToolResult = {
    ...read,
    content: JSON.stringify(body),
    details: { fileScope: 'external_path', workspaceCheckpoint: false },
  };
  const original = JSON.stringify(result);
  const presented = formatFileReadResult({ result })!;
  const baseRef = JSON.parse(
    presented
      .split('\n')
      .find((line) => line.startsWith('base_ref='))!
      .slice('base_ref='.length),
  );
  expect(baseRef).toBe(body.base_ref);
  const baseline = body.baseline;
  expect(presented).toContain('The reference does not grant write permission');
  expect(presentedBody(presented)).toBe('original\n');
  const edit = await f.execute('files.edit', {
    path: body.path,
    base: baseline,
    find: 'original',
    replace: 'updated',
    occurrences: 1,
  });
  expect(edit.outcome).toBe('succeeded');
  expect((await f.files.read('external.txt')).content).toBe('updated\n');
  expect(JSON.stringify(result)).toBe(original);
  const { baseline: _baseline, ...legacy } = body;
  const oldResult = formatFileReadResult({
    result: { ...result, content: JSON.stringify(legacy) },
  })!;
  expect(oldResult).toContain('External read-only file; no edit baseline.');
  expect(oldResult).not.toContain('baseline=');
});

test('read presentation distinguishes a suffix/window, an empty file and an empty EOF selection', async () => {
  const f = fixture();
  f.put('a.txt', 'one\ntwo\nthree\n');
  f.put('empty.txt', '');
  const middle = formatFileReadResult({
    result: await f.execute('files.read', { path: 'a.txt', offset: 2, limit: 1 }),
  })!;
  expect(middle).toContain('lines=2-2/3; next_line=3; selected window only');
  expect(presentedBody(middle)).toBe('two\n');
  const suffix = formatFileReadResult({
    result: await f.execute('files.read', { path: 'a.txt', offset: 2 }),
  })!;
  expect(suffix).toContain('lines=2-3/3; next_line=null; selected window only');
  expect(presentedBody(suffix)).toBe('two\nthree\n');
  const empty = formatFileReadResult({
    result: await f.execute('files.read', { path: 'empty.txt' }),
  })!;
  expect(empty).toContain('from_line=1; lines=none/0; next_line=null; complete file');
  const eof = formatFileReadResult({
    result: await f.execute('files.read', { path: 'a.txt', offset: 999 }),
  })!;
  expect(eof).toContain('from_line=999; lines=none/3; next_line=null; selected window only');
  expect(presentedBody(eof)).toBe('');
});

test('read Artifact presentation requires the verified full body and never substitutes its bounded excerpt', async () => {
  const f = fixture();
  const content = `\uFEFF${'雪😀\\"\r\n'.repeat(100000)}TAIL_EXACT\n`;
  f.put('large.txt', content);
  let artifactBody = '';
  const reference: ArtifactRef = {
    id: 'body',
    mediaType: 'text/plain',
    size: String(Buffer.byteLength(content)),
    scope: { kind: 'execution', id: 'actual-execution' },
  };
  const context = {
    ...f.context,
    artifacts: {
      async publish(input: { content: Uint8Array }) {
        artifactBody = Buffer.from(input.content).toString('utf8');
        return reference;
      },
    },
  } as ToolContext;
  const result = await f.execute(
    'files.read',
    { path: 'large.txt', limit: Number.MAX_SAFE_INTEGER },
    context,
  );
  expect(result.outcome).toBe('succeeded');
  expect(result.modelContent).toBeDefined();
  expect(JSON.parse(result.content)).not.toHaveProperty('executionId');
  expect(JSON.parse(result.content)).not.toHaveProperty('runId');
  expect(formatFileReadResult({ result })).toBeUndefined();
  const text = formatFileReadResult({ result, body: artifactBody })!;
  expect(presentedBody(text)).toBe(content);
  expect(text.endsWith('TAIL_EXACT\n')).toBe(true);
  expect(text).not.toContain('"excerpt"');
  expect(
    formatFileReadResult({ result: { ...result, artifactRefs: [reference] }, body: artifactBody }),
  ).toBe(text);
  expect(
    formatFileReadResult({
      result: { ...result, artifactRefs: [{ ...reference, id: 'other' }] },
      body: artifactBody,
    }),
  ).toBeUndefined();
});

test('material result details and malformed or unknown read fields preserve the original receipt', async () => {
  const f = fixture();
  f.put('a.txt', 'needle\n');
  const read = await f.execute('files.read', { path: 'a.txt' });
  expect(
    formatFileReadResult({ result: { ...read, details: { warning: 'material' } } }),
  ).toBeUndefined();
  expect(
    formatFileReadResult({ result: { ...read, newFact: true } as ToolResult }),
  ).toBeUndefined();
  expect(
    formatFileReadResult({
      result: { ...read, artifactRefs: [{ id: 'unrelated', mediaType: 'text/plain', size: '1' }] },
    }),
  ).toBeUndefined();
  for (const content of [
    'not-json',
    JSON.stringify({ ...JSON.parse(read.content), feedback: 'A material caveat.' }),
    JSON.stringify({
      ...JSON.parse(read.content),
      observation: { ...JSON.parse(read.content).observation, newFact: true },
    }),
    JSON.stringify({ path: 'a.txt', content: 'needle\n' }),
    JSON.stringify({ ...JSON.parse(read.content), newMeaningfulField: 'unknown' }),
  ])
    expect(formatFileReadResult({ result: { ...read, content } })).toBeUndefined();
});

test('file presentation keeps original read receipt identity without exposing bookkeeping IDs to the model', async () => {
  const f = fixture();
  f.put('a.txt', 'needle\n');
  const result = await f.execute('files.read', { path: 'a.txt' });
  const raw = JSON.parse(result.content);
  expect(raw.executionId).toBe('actual-execution');
  expect(raw.runId).toBe('actual-run');
  const text = f.tools.find((tool) => tool.id === 'files.read')!.formatModelResult!({ result })!;
  expect(text).not.toContain('evidence_ref=');
  expect(text).not.toContain('actual-execution');
  expect(text).not.toContain('actual-run');
});

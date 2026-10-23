import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactRef, ToolContext, ToolResult } from '../../../src/extensions';
import { createFileTools, createWorkspaceFiles, type WorkspaceFiles } from '../../../src/files';
import {
  formatFileReadResult,
  formatFileSearchResult,
} from '../../../src/tools/files/model-result';

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
  expect(text).not.toContain('"observation"');
  expect(presentedBody(text)).toBe(content);
  const baseline = JSON.parse(
    text
      .split('\n')
      .find((line) => line.startsWith('baseline='))!
      .slice('baseline='.length),
  );
  expect(baseline).toEqual(JSON.parse(result.content).baseline);
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

test('read presentation distinguishes a suffix/window, an empty file and an empty EOF selection', async () => {
  const f = fixture();
  f.put('a', 'one\ntwo\nthree\n');
  f.put('empty', '');
  const middle = formatFileReadResult({
    result: await f.execute('files.read', { path: 'a', offset: 2, limit: 1 }),
  })!;
  expect(middle).toContain('lines=2-2/3; next_line=3; selected window only');
  expect(presentedBody(middle)).toBe('two\n');
  const suffix = formatFileReadResult({
    result: await f.execute('files.read', { path: 'a', offset: 2 }),
  })!;
  expect(suffix).toContain('lines=2-3/3; next_line=null; selected window only');
  expect(presentedBody(suffix)).toBe('two\nthree\n');
  const empty = formatFileReadResult({ result: await f.execute('files.read', { path: 'empty' }) })!;
  expect(empty).toContain('from_line=1; lines=none/0; next_line=null; complete file');
  const eof = formatFileReadResult({
    result: await f.execute('files.read', { path: 'a', offset: 999 }),
  })!;
  expect(eof).toContain('from_line=999; lines=none/3; next_line=null; selected window only');
  expect(presentedBody(eof)).toBe('');
});

test('search presentation retains every match/context, baseline, exact cursor and Unicode preview across pages', async () => {
  const f = fixture();
  f.put('a.ts', 'head\nneedle😀tail\nneedle second\nlast\n');
  const firstResult = await f.execute('files.search', {
    mode: 'content',
    text: 'needle',
    limit: 1,
    contextLines: 1,
    maxLineChars: 7,
  });
  const first = JSON.parse(firstResult.content);
  const unchanged = JSON.stringify(firstResult);
  const tool = f.tools.find((tool) => tool.id === 'files.search')!;
  expect(tool.model?.resultVersion).toBe('2');
  const text = tool.formatModelResult!({ result: firstResult })!;
  expect(text).toContain('limit=1; context_lines=1; max_line_chars=7');
  expect(text).toContain('Returned 1 matches');
  expect(text).toContain('later matches remain');
  expect(text).toContain(`next_cursor=${JSON.stringify(first.next)}`);
  expect(text).toContain('1 [context] head');
  expect(text).toContain('2 [match; truncated 6/12 UTF-16 chars] needle');
  expect(text).toContain('3 [context; truncated 7/13 UTF-16 chars] needle ');
  expect(text).toContain(`baseline=${JSON.stringify(first.files[0].baseline)}`);
  expect(text).not.toContain('"observation"');
  expect(text).not.toContain('"stats"');
  expect(JSON.stringify(firstResult)).toBe(unchanged);
  const second = formatFileSearchResult({
    result: await f.execute('files.search', {
      mode: 'content',
      text: 'needle',
      after: first.next,
      limit: 1,
      contextLines: 1,
    }),
  })!;
  expect(second).toContain('continuation page');
  expect(second).toContain('next_cursor=null');
  expect(second).toContain('3 [match] needle second');
  expect(second).toContain('2 [context] needle😀tail');
  expect(second).not.toContain('Complete search');
});

test('zero search exposes real ignore/binary/encoding gaps and conditional literal-query correction once', async () => {
  const f = fixture();
  mkdirSync(join(f.root, 'dist'));
  f.put('.gitignore', 'dist/\n');
  f.put('dist/a', 'hidden');
  f.put('b.bin', Buffer.from([0, 0, 0]));
  f.put('bad', Buffer.from([0xff]));
  f.put('a', 'unrelated');
  const result = await f.execute('files.search', { text: 'absent|other' });
  const original = JSON.stringify(result);
  const text = formatFileSearchResult({ result })!;
  expect(text).toContain('Returned 0 files');
  expect(text).toContain('some entries not inspected');
  expect(text).toContain('"ignored":1');
  expect(text).toContain('"binary":1');
  expect(text).toContain('"encoding":1');
  expect(text).toContain('directories count once');
  expect(text.match(/Pattern-like/g)).toHaveLength(1);
  expect(text.match(/No literal matches/g)).toHaveLength(1);
  expect(text).not.toContain('Complete search');
  expect(text.length).toBeLessThan(result.content.length);
  expect(JSON.stringify(result)).toBe(original);
  const explicit = formatFileSearchResult({
    result: await f.execute('files.search', { path: 'dist/a', text: 'hidden', mode: 'content' }),
  })!;
  expect(explicit).toContain('1 [match] hidden');
  expect(explicit).toContain('Complete search within selected scope and filters');
});

test('read Artifact presentation requires the verified full body and never substitutes its bounded excerpt', async () => {
  const f = fixture();
  const content = `\uFEFF${'雪😀\\"\r\n'.repeat(100000)}TAIL_EXACT\n`;
  f.put('large', content);
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
    { path: 'large', limit: Number.MAX_SAFE_INTEGER },
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
});

test('search Artifact uses its full JSON body and malformed/failed structures safely keep the original result', async () => {
  const f = fixture();
  f.put('a', 'needle\n');
  const result = await f.execute('files.search', { text: 'needle' });
  const artifactResult: ToolResult = {
    outcome: 'succeeded',
    content: JSON.stringify({
      kind: 'search',
      observation: JSON.parse(result.content).observation,
      body: { complete: true, encoding: 'utf-8', format: 'json', reference: { id: 'verified' } },
      inlineBody: false,
    }),
    modelContent: {
      kind: 'artifact',
      encoding: 'utf-8',
      reference: {
        id: 'verified',
        mediaType: 'application/json',
        size: String(Buffer.byteLength(result.content)),
        scope: { kind: 'execution', id: 'actual' },
      },
    },
  };
  expect(formatFileSearchResult({ result: artifactResult })).toBeUndefined();
  expect(formatFileSearchResult({ result: artifactResult, body: result.content })).toBe(
    formatFileSearchResult({ result }),
  );
  for (const bad of [
    { ...result, outcome: 'failed' as const },
    { ...result, content: 'not-json' },
    {
      ...result,
      content: JSON.stringify({
        ...JSON.parse(result.content),
        feedback: 'A new material caveat must remain visible.',
      }),
    },
    {
      ...result,
      content: JSON.stringify({
        ...JSON.parse(result.content),
        observation: { ...JSON.parse(result.content).observation, newFact: true },
      }),
    },
    { ...result, content: JSON.stringify({ matches: [], next: null }) },
    {
      ...result,
      content: JSON.stringify({ ...JSON.parse(result.content), newMeaningfulField: 'unknown' }),
    },
  ])
    expect(formatFileSearchResult({ result: bad })).toBeUndefined();
  expect(formatFileReadResult({ result })).toBeUndefined();
});

test('material result details and unknown search filters preserve the original receipt instead of simplifying it', async () => {
  const f = fixture();
  f.put('a', 'needle\n');
  const read = await f.execute('files.read', { path: 'a' });
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
  const search = await f.execute('files.search', { text: 'needle' });
  const body = JSON.parse(search.content);
  const newFilter = {
    ...search,
    content: JSON.stringify({
      ...body,
      scope: {
        ...body.scope,
        filters: { ...body.scope.filters, newExclusion: 'material restriction' },
      },
    }),
  };
  expect(formatFileSearchResult({ result: newFilter })).toBeUndefined();
  expect(
    formatFileSearchResult({ result: { ...search, details: { warning: 'material' } } }),
  ).toBeUndefined();
  const reference: ArtifactRef = {
    id: 'original',
    mediaType: 'application/json',
    size: String(Buffer.byteLength(search.content)),
  };
  const artifactResult: ToolResult = {
    outcome: 'succeeded',
    modelContent: { kind: 'artifact', encoding: 'utf-8', reference },
    artifactRefs: [reference],
    content: JSON.stringify({
      kind: 'search',
      inlineBody: false,
      body: { complete: true, encoding: 'utf-8', format: 'json', reference },
    }),
  };
  expect(formatFileSearchResult({ result: artifactResult, body: search.content })).toBeDefined();
  expect(
    formatFileSearchResult({
      result: { ...artifactResult, artifactRefs: [{ ...reference, id: 'other' }] },
      body: search.content,
    }),
  ).toBeUndefined();
});

test('large search presentation preserves complete Artifact content without adding model execution IDs', async () => {
  const f = fixture();
  f.put('large', `${'needle'.padEnd(8000, '雪')}\n`.repeat(100));
  let fullBody = '';
  const reference: ArtifactRef = {
    id: 'actual-search-body',
    mediaType: 'application/json',
    size: '0',
    scope: { kind: 'execution', id: 'actual-execution' },
  };
  const ownContext = {
    ...f.context,
    artifacts: {
      async publish(input: { content: Uint8Array }) {
        fullBody = Buffer.from(input.content).toString('utf8');
        return { ...reference, size: String(input.content.byteLength) };
      },
    },
  } as ToolContext;
  const result = await f.execute(
    'files.search',
    { path: 'large', text: 'needle', mode: 'content', maxLineChars: 10000, limit: 100 },
    ownContext,
  );
  expect(Buffer.byteLength(fullBody)).toBeGreaterThan(1024 * 1024);
  expect(JSON.parse(fullBody)).not.toHaveProperty('executionId');
  expect(JSON.parse(fullBody)).not.toHaveProperty('runId');
  expect(JSON.parse(result.content)).not.toHaveProperty('executionId');
  expect(JSON.parse(result.content)).not.toHaveProperty('runId');
  expect(result.modelContent).toBeDefined();
  expect(formatFileSearchResult({ result })).toBeUndefined();
  const text = formatFileSearchResult({ result, body: fullBody })!;
  expect(text).toContain('Returned 100 matches');
  expect(text.match(/\[match\]/g)).toHaveLength(100);
  expect(text.includes(`100 [match] ${'needle'.padEnd(8000, '雪')}`)).toBe(true);
  expect(JSON.parse(fullBody).files[0].baseline).toEqual((await f.files.read('large')).baseline);
});

test('file presentation keeps original read receipt identity without exposing bookkeeping IDs to the model', async () => {
  const f = fixture();
  f.put('a', 'needle\n');
  for (const id of ['files.read', 'files.search']) {
    const result = await f.execute(id, id === 'files.read' ? { path: 'a' } : { text: 'needle' });
    const raw = JSON.parse(result.content);
    if (id === 'files.read') {
      expect(raw.executionId).toBe('actual-execution');
      expect(raw.runId).toBe('actual-run');
    } else {
      expect(raw).not.toHaveProperty('executionId');
      expect(raw).not.toHaveProperty('runId');
    }
    const text = f.tools.find((tool) => tool.id === id)!.formatModelResult!({ result })!;
    expect(text).not.toContain('evidence_ref=');
    expect(text).not.toContain('actual-execution');
    expect(text).not.toContain('actual-run');
  }
});

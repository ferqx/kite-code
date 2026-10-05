import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { createFileTools, createWorkspaceFiles } from '../../../src/files';
import { openSqliteStore } from '../../../src/sqlite';

test('full read/write/edit and complete search retain content and hash beyond former file, match and line limits', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-full-file-')));
  const files = createWorkspaceFiles({ root });
  try {
    const content = `first needle\n${'中x'.repeat(3 * 1024 * 1024)}\nlast needle\n`;
    const written = await files.write({ path: 'large', content, base: null });
    expect(written.baseline.size).toBeGreaterThan(8 * 1024 * 1024);
    expect(written.baseline.hash).toBe(createHash('sha256').update(content).digest('hex'));
    expect((await files.read('large')).content).toBe(content);
    const page = await files.read('large', { offset: 3 });
    expect(page.content).toBe('last needle\n');
    expect(page.baseline).toEqual(written.baseline);
    const edited = await files.edit({
      path: 'large',
      base: written.baseline,
      find: content,
      replace: `${content}repaired\n`,
      occurrences: 1,
    });
    expect(readFileSync(join(root, 'large'), 'utf8')).toBe(`${content}repaired\n`);
    expect(edited.baseline.hash).toBe(
      createHash('sha256').update(`${content}repaired\n`).digest('hex'),
    );
    writeFileSync(join(root, 'matches'), 'needle\n'.repeat(2001));
    writeFileSync(join(root, 'long-line'), `needle${'x'.repeat(40000)}`);
    for (let i = 0; i < 260; i++) writeFileSync(join(root, `extra-${i}`), 'needle');
    const search = await files.search({ text: 'needle' });
    expect(search.matches).toHaveLength(2264);
    expect(search.next).toBeNull();
    expect(search.matches.find((value) => value.path === 'long-line')?.content).toHaveLength(40006);
    const first = await files.search({ text: 'needle', limit: 200 });
    const second = await files.search({ text: 'needle', limit: 200, after: first.next! });
    expect(first.matches).toHaveLength(200);
    expect(second.matches).toHaveLength(200);
    expect(
      new Set([...first.matches, ...second.matches].map((value) => `${value.path}\0${value.line}`))
        .size,
    ).toBe(400);
  } finally {
    await files.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('real UnifiedExecution writes from a scoped large Artifact, reads complete Artifact body, edits atomically, and denies zero file I/O', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-large-file-core-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const files = createWorkspaceFiles({ root: workspace });
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile);
  const artifacts = createArtifactStore({ profile, store });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'w',
    rootUri: `file://${workspace}`,
  });
  await store.createSession({
    expectedStoreId,
    sessionId: 's',
    commandId: 'create',
    workspaceId: 'w',
    title: 's',
    subjectId: 'owner',
  });
  const content = `start\n${'x'.repeat(9 * 1024 * 1024)}\nend\n`;
  const source = await artifacts.publish({
    expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    scope: { kind: 'session', id: 's' },
    refId: 'input-body',
    content: Buffer.from(content),
    mediaType: 'text/plain',
  });
  const publicSource = {
    id: source.id,
    mediaType: source.mediaType,
    size: source.size,
    scope: source.scope,
  };
  const finish: ModelEvent = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const call = (name: string, input: unknown): ModelEvent[] => [
    { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
    { ...finish, type: 'finish', reason: 'tool_calls' } as ModelEvent,
  ];
  let writes = 0;
  const wrapped = {
    ...files,
    async write(input: Parameters<typeof files.write>[0]) {
      writes++;
      return files.write(input);
    },
  };
  const responses = [
    call('files.write', { path: 'large', base: null, contentArtifact: publicSource }),
    [finish],
    call('files.read', { path: 'large' }),
    [finish],
    call('files.write', { path: 'denied', base: null, contentArtifact: publicSource }),
    [finish],
  ];
  const model = createFixedModel(responses);
  let deny = false;
  const runtime = createRuntime({
    store,
    artifacts,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize(request) {
        return { allowed: request.kind === 'model' || !deny, revision: 'p1' };
      },
    },
    extensions: [{ id: 'files', version: '2', apiMajor: 1, tools: createFileTools(wrapped) }],
  });
  const run = async (commandId: string) => {
    await runtime.submitCommand({
      expectedStoreId,
      commandId,
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: commandId },
    });
    await runtime.waitForCommand(commandId);
  };
  try {
    await run('write');
    expect(writes).toBe(1);
    expect(readFileSync(join(workspace, 'large'), 'utf8')).toBe(content);
    await run('read');
    const execution = (await store.listExecutions('s')).find(
      (value) => value.definitionId === 'files.read',
    )!;
    expect(execution.status).toBe('succeeded');
    expect(execution.definitionVersion).toBe('3');
    const result = execution.result as { content: string; artifactRefs: (typeof publicSource)[] };
    const summary = JSON.parse(result.content);
    expect(summary.inlineBody).toBe(false);
    expect(summary.baseline.hash).toBe(createHash('sha256').update(content).digest('hex'));
    expect(result.artifactRefs).toHaveLength(1);
    const reference = result.artifactRefs[0]!;
    expect(
      Buffer.from(
        await artifacts.read({
          expectedStoreId,
          refId: reference.id,
          sessionId: 's',
          subjectId: 'owner',
          scope: reference.scope!,
        }),
      ).toString('utf8'),
    ).toBe(content);
    expect(
      model.requests[3]?.messages.some(
        (message) =>
          message.role === 'tool' &&
          message.content.endsWith(content) &&
          message.content.includes(JSON.stringify(summary.baseline)),
      ),
    ).toBe(true);
    responses.splice(
      4,
      0,
      call('files.edit', {
        path: 'large',
        base: summary.baseline,
        find: 'end\n',
        replace: 'REPAIRED\n',
        occurrences: 1,
      }),
      [finish],
      call('files.search', { text: 'x' }),
      [finish],
    );
    await run('edit');
    const edited = (await store.listExecutions('s')).find(
      (value) => value.definitionId === 'files.edit',
    )!;
    expect(edited.status).toBe('succeeded');
    expect(edited.definitionVersion).toBe('2');
    expect(readFileSync(join(workspace, 'large'), 'utf8')).toBe(
      content.replace('end\n', 'REPAIRED\n'),
    );
    await run('search');
    const searched = (await store.listExecutions('s')).find(
      (value) => value.definitionId === 'files.search',
    )!;
    expect(searched.status).toBe('succeeded');
    const searchResult = searched.result as {
      content: string;
      artifactRefs: (typeof publicSource)[];
    };
    const searchRef = searchResult.artifactRefs[0]!;
    const searchBody = JSON.parse(
      Buffer.from(
        await artifacts.read({
          expectedStoreId,
          refId: searchRef.id,
          sessionId: 's',
          subjectId: 'owner',
          scope: searchRef.scope!,
        }),
      ).toString('utf8'),
    );
    expect(searchBody.matches).toHaveLength(1);
    expect(searchBody.matches[0].content).toHaveLength(9 * 1024 * 1024);
    expect(searchBody.next).toBeNull();
    deny = true;
    await run('denied');
    expect(writes).toBe(1);
  } finally {
    await runtime.close();
    await files.close();
    rmSync(root, { recursive: true, force: true });
  }
});

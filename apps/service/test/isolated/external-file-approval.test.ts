import { Database } from 'bun:sqlite';
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
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { readApprovalOptions } from '@kite-ai/client';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

test('a durable exact file grant covers a later batch after reopening; once stays separate', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-file-approval-')));
  const workspace = join(root, 'workspace');
  const external = join(root, 'external');
  mkdirSync(workspace);
  mkdirSync(external);
  const path = join(external, 'original.txt');
  const other = join(external, 'other.txt');
  type Call = { name: string; input: Record<string, string> };
  const edit = (old_string: string, new_string: string): Call => ({
    name: 'edit_file',
    input: { path, old_string, new_string },
  });
  const calls: Record<string, readonly Call[]> = {
    create: [{ name: 'write_file', input: { path, content: 'first\nmarker\n' } }],
    read: [{ name: 'read_file', input: { path } }],
    edit: [edit('first', 'second'), edit('marker', 'checked')],
    sibling: [{ name: 'write_file', input: { path: other, content: 'must not be written' } }],
    'second-session': [edit('second', 'wrong')],
    'read-after-clear': [{ name: 'read_file', input: { path } }],
    'after-clear': [edit('second', 'third'), edit('checked', 'once-marker')],
    'later-edit': [edit('third', 'wrong')],
  };
  let next = '';
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { tools?: unknown[] };
      const selected = body.tools?.length && next ? calls[next] : undefined;
      const delta = selected
        ? {
            tool_calls: selected.map(({ name, input }, index) => ({
              index,
              id: `file-${next}-${index}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(input) },
            })),
          }
        : { content: 'Done' };
      if (selected) next = '';
      const chunk = (value: unknown, reason: string | null) =>
        `data: ${JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          model: 'local',
          choices: [{ index: 0, delta: value, finish_reason: reason }],
        })}\n\n`;
      return new Response(
        `${chunk(delta, null)}${chunk({}, selected ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'fixture' });
  privateDirectory(profile.profilePath);
  const settings = join(profile.profilePath, 'config.jsonc');
  writeFileSync(
    settings,
    JSON.stringify({
      modelId: 'local',
      models: [
        { id: 'local', provider: 'compatible', model: 'local', baseURL: `${provider.url.href}v1` },
      ],
      tools: [
        { id: 'files.read', definitionVersion: '5' },
        { id: 'files.write', definitionVersion: '3' },
        { id: 'files.edit', definitionVersion: '2' },
      ],
    }),
  );
  let store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  let workspaceSerialLocks = createWorkspaceSerialLocks(profile);
  const openRuntime = () => {
    const host = createDefaultProcessConfiguration({ profile, userConfigurationPath: settings });
    const runtime = createRuntime({
      store,
      workspaceSerialLocks,
      extensions: host.extensions,
      permissions: host.permissions!,
      resolveRunConfiguration: host.resolveRunConfiguration,
    });
    host.permissionManagement?.(runtime);
    return runtime;
  };
  let runtime = openRuntime();
  const subjectId = 'owner';
  const workspaceId = 'w';
  const run = async (commandId: string, sessionId = 'a') => {
    next = commandId;
    await runtime.submitCommand({
      expectedStoreId,
      sessionId,
      subjectId,
      commandId,
      request: { kind: 'run.start', content: `Test step: ${commandId}` },
    });
  };
  async function pending(sessionId = 'a') {
    const deadline = Date.now() + 5000;
    do {
      const { interactions } = await store.listInteractions({
        expectedStoreId,
        sessionId,
        state: 'pending',
      });
      if (interactions[0]) return interactions[0];
      await Bun.sleep(10);
    } while (Date.now() < deadline);
    throw Error('file_approval_not_present');
  }
  const answer = (card: Awaited<ReturnType<typeof pending>>, optionId?: string) =>
    runtime.answerInteraction({
      expectedStoreId,
      subjectId,
      commandId: `answer-${card.id}`,
      presentationSessionId: card.presentationSessionId,
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: optionId
        ? { kind: 'approval', decision: 'approve', optionId }
        : { kind: 'approval', decision: 'deny' },
    });
  const settled = (commandId: string) => runtime.waitForCommand(commandId, { timeoutMs: 5000 });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: workspaceId,
      name: 'Fixture',
      rootUri: pathToFileURL(workspace).href,
    });
    for (const sessionId of ['a', 'b']) {
      await runtime.createSession({
        expectedStoreId,
        sessionId,
        subjectId,
        workspaceId,
        commandId: `create-${sessionId}`,
        title: sessionId,
      });
      await initializeLivePermissionFixture({
        runtime,
        profile,
        expectedStoreId,
        sessionId,
        subjectId,
        workspaceId,
        mode: 'accept_edits',
        trusted: true,
      });
    }
    await run('create');
    const create = await pending();
    expect(create.definitionId).toBe('files.write');
    expect(existsSync(path)).toBe(false);
    const scope = readApprovalOptions(create.request).find((option) => option.kind === 'scope');
    expect(scope?.presentation.label).toBe('允许后续编辑');
    await answer(create, scope!.optionId);
    await settled('create');
    expect((await runtime.getExecution(create.executionId))?.status).toBe('succeeded');
    expect(readFileSync(path, 'utf8')).toBe('first\nmarker\n');

    await run('read');
    const read = await pending();
    expect(read.definitionId).toBe('files.read');
    expect(readApprovalOptions(read.request).map(({ kind }) => kind)).toEqual(['once']);
    await answer(read, 'once');
    await settled('read');

    const owner = { expectedStoreId, subjectId, sessionId: 'a' };
    const saved = await store.listPermissionGrants(owner);
    expect(saved.items).toHaveLength(1);
    await runtime.close();
    await workspaceSerialLocks.close();
    await store.close();
    store = await openSqliteStore(profile);
    workspaceSerialLocks = createWorkspaceSerialLocks(profile);
    runtime = openRuntime();
    expect((await store.listPermissionGrants(owner)).items).toEqual(saved.items);

    const verifyBatch = async (originCommandId: string, grantId: string | null) => {
      const edits = (await store.listExecutions('a')).filter(
        (e) => e.definitionId === 'files.edit' && e.originCommandId === originCommandId,
      );
      expect(edits).toHaveLength(2);
      expect(edits.map(({ status }) => status)).toEqual(['succeeded', 'succeeded']);
      expect(new Set(edits.map(({ callId }) => callId)).size).toBe(2);
      const dispatched = edits.filter((edit) => edit.authorization?.dispatched);
      expect(dispatched).toHaveLength(1);
      const db = new Database(profile.databasePath, { readonly: true });
      try {
        const proof = db
          .query(
            'SELECT json_extract(dispatch_authorization_json, ?) AS grant FROM execution WHERE id=?',
          )
          .get('$.grant.grantId', dispatched[0]!.id) as { grant: string | null };
        expect(proof.grant).toBe(grantId);
        for (const edit of edits) {
          const receipt = db
            .query(
              "SELECT COUNT(*) AS n FROM message WHERE role='tool' AND json_extract(source_json, ?)=?",
            )
            .get('$.toolCallId', edit.callId) as { n: number };
          expect(receipt.n).toBe(1);
        }
      } finally {
        db.close();
      }
    };
    await run('edit');
    await settled('edit');
    await verifyBatch('edit', saved.items[0]!.grant.id);
    expect(readFileSync(path, 'utf8')).toBe('second\nchecked\n');

    await run('sibling');
    const sibling = await pending();
    expect(sibling.definitionId).toBe('files.write');
    await answer(sibling);
    await settled('sibling');
    expect(existsSync(other)).toBe(false);

    await run('second-session', 'b');
    const secondSession = await pending('b');
    expect(secondSession.definitionId).toBe('files.edit');
    await answer(secondSession);
    await settled('second-session');
    expect(readFileSync(path, 'utf8')).toBe('second\nchecked\n');

    const current = await store.listPermissionGrants(owner);
    await store.clearPermissionGrants({
      ...owner,
      commandId: 'clear-original-grant',
      ifRevision: current.revision,
    });
    await run('read-after-clear');
    await answer(await pending(), 'once');
    await settled('read-after-clear');
    await run('after-clear');
    const afterClear = await pending();
    expect(afterClear.definitionId).toBe('files.edit');
    expect(afterClear.request).toMatchObject({
      fileEditBatch: { members: [{ path }, { path }] },
    });
    expect(readApprovalOptions(afterClear.request).map(({ kind }) => kind)).toEqual(['once']);
    expect(readFileSync(path, 'utf8')).toBe('second\nchecked\n');
    await answer(afterClear, 'once');
    await settled('after-clear');
    await verifyBatch('after-clear', null);
    expect(readFileSync(path, 'utf8')).toBe('third\nonce-marker\n');
    expect((await store.listPermissionGrants(owner)).items).toHaveLength(0);

    await run('later-edit');
    const laterEdit = await pending();
    expect(laterEdit.definitionId).toBe('files.edit');
    expect(readFileSync(path, 'utf8')).toBe('third\nonce-marker\n');
    await answer(laterEdit);
    await settled('later-edit');
    expect(readFileSync(path, 'utf8')).toBe('third\nonce-marker\n');
  } finally {
    await runtime.close();
    await workspaceSerialLocks.close();
    await store.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

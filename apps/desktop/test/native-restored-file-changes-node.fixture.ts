import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createClient, type Message } from '@kite-ai/client';
import { NativeFileChanges } from '../electron/file-changes';
import type { NativeFileChangeScope } from '../src/file-changes-bridge';

const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const methods: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    methods.push(init?.method ?? (request instanceof Request ? request.method : 'GET'));
    return originalFetch(request, init);
  },
  { preconnect: originalFetch.preconnect },
);
const client = createClient({
  endpoint: input.bootstrap.endpoint,
  token: input.bootstrap.token,
  expected: {
    profile: input.bootstrap.profile,
    apiMajor: 1,
    requiredCapabilities: ['sessions', 'history', 'context'],
    instanceId: input.bootstrap.instanceId,
    buildId: input.bootstrap.buildId,
  },
});
const failures: { sessionId: string; method: string; code: string }[] = [];
const opened: { editor: string; path: string }[] = [];
const counts: { sessionId: string; changes: number; targets: number }[] = [];
try {
  await client.connect();
  assert.equal(client.serverInfo!.storeId, input.restoredStoreId);
  assert.notEqual(client.serverInfo!.storeId, input.originalStoreId);
  assert.deepEqual(await client.getRun(input.run.id), input.run);
  assert.deepEqual(await client.getCommand(input.command.id), input.command);
  for (const execution of input.executions)
    assert.deepEqual(await client.getExecution(execution.id), execution);
  const workspace = await client.getWorkspace('w');
  let scope: NativeFileChangeScope | undefined;
  const observed = new Map<string, Message>();
  const manager = new NativeFileChanges(
    client,
    () => scope,
    (id) => observed.get(id),
    (id) => (id === workspace.id ? workspace : undefined),
    input.protectedRoots,
  );
  const perform = async (editor: string, path: string) => {
    assert.equal(path, input.filePath);
    assert.equal(readFileSync(path, 'utf8'), input.currentContent);
    opened.push({ editor, path });
  };
  try {
    for (const [index, source] of input.sources.entries()) {
      manager.release();
      observed.clear();
      const view = await client.getView(source.sessionId);
      assert.equal(view.storeId, input.restoredStoreId);
      assert.equal(view.session.workspaceId, workspace.id);
      let afterSeq = '0';
      const messages: Message[] = [];
      for (;;) {
        const page = await client.listMessages(source.sessionId, {
          afterSeq,
          upperSeq: view.session.nextSeq,
          limit: 200,
        });
        for (const message of page) {
          assert.equal(message.sessionId, source.sessionId);
          assert.ok(BigInt(message.seq) > BigInt(afterSeq));
          assert.ok(BigInt(message.seq) <= BigInt(view.session.nextSeq));
          messages.push(message);
          observed.set(message.id, message);
          afterSeq = message.seq;
        }
        if (page.length < 200) break;
      }
      assert.deepEqual(messages, source.messages);
      scope = {
        generation: 1,
        viewSelection: index + 1,
        historyEpoch: 0,
        storeId: input.restoredStoreId,
        sessionId: source.sessionId,
        workspaceId: workspace.id,
      };
      const toolMessages = messages.filter((message) => message.role === 'tool');
      assert.equal(toolMessages.length, 5);
      const query = {
        messageIds: toolMessages.map((message) => message.id),
        viewSelection: scope.viewSelection,
        historyEpoch: scope.historyEpoch,
      };
      for (const includeRead of [false, true]) {
        const method = includeRead ? 'fileTargets.list' : 'fileChanges.list';
        try {
          const page = await manager.list({ ...query, readId: `${index}-${method}` }, includeRead);
          assert.equal(page.kind, includeRead ? 'fileTargets.page' : 'fileChanges.page');
          assert.deepEqual(page.scope, scope);
          assert.equal(page.entries.length, includeRead ? 5 : 2);
          assert.deepEqual(
            page.entries.map((entry) => entry.operation),
            includeRead ? ['read', 'write', 'read', 'edit', 'read'] : ['write', 'edit'],
          );
          for (const entry of page.entries) {
            assert.equal(entry.path, input.relativePath);
            assert.equal(entry.openable, true);
            const message = observed.get(entry.messageId)!;
            const execution = input.executions.find(
              (item: { id: string }) => item.id === message.sourceIds![0],
            );
            assert.ok(execution);
            if (entry.operation !== 'read') {
              const saved = execution.result.details.fileChange;
              assert.equal(entry.preview, 'available');
              const detail = await manager.detail(entry.changeId, `detail-${entry.changeId}`);
              assert.deepEqual(detail, {
                kind: 'fileChanges.detail',
                changeId: entry.changeId,
                text: saved.text,
                truncated: saved.truncated,
              });
              assert.ok(!detail.text!.includes(input.currentContent));
            }
            await manager.open(entry.changeId, includeRead ? 'vscode' : 'zed', perform);
          }
          const repeated = await manager.list(
            { ...query, readId: `${index}-${method}-again` },
            includeRead,
          );
          assert.deepEqual(repeated.entries, page.entries);
          if (includeRead)
            counts.push({ sessionId: source.sessionId, changes: 2, targets: page.entries.length });
        } catch (error) {
          failures.push({
            sessionId: source.sessionId,
            method,
            code: error instanceof Error ? error.message : String(error),
          });
        }
      }
      try {
        const answer = messages.filter((message) => message.role === 'assistant').at(-1)!;
        assert.ok(answer.content.includes(input.relativePath));
        await manager.openMessageFile(
          {
            messageId: answer.id,
            path: input.relativePath,
            editor: 'textedit',
            viewSelection: scope.viewSelection,
            historyEpoch: scope.historyEpoch,
          },
          perform,
        );
      } catch (error) {
        failures.push({
          sessionId: source.sessionId,
          method: 'messageFile.open',
          code: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (failures.length)
      console.error('restored_native_file_entries_rejected', JSON.stringify(failures));
    assert.deepEqual(failures, []);
    assert.equal(opened.length, 16);
    assert.ok(methods.length > 0);
    assert.ok(methods.every((method) => method === 'GET'));
    console.log(JSON.stringify({ qualified: true, counts, opened, methods }));
  } finally {
    manager.release();
  }
} finally {
  client.disposeNetwork();
  globalThis.fetch = originalFetch;
}

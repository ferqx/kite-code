import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Extension } from '@kite-ai/agent/extensions';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createClient, type SessionExportFrame } from '@kite-ai/client';
import { createBrowserClient } from '@kite-ai/client/browser';
import { startService } from '@kite-ai/service';
import { startDevelopmentWeb } from '@kite-ai/service/development-web';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
test('public namespace Fork reports frozen copy/rebuild/omit rules and exports original raw provenance; same command reads do not prepare or replay business', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-public-namespace-fork-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'owned' },
    host = { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'owned' },
    store = await openSqliteStore(profile),
    expectedStoreId = (await store.getMetadata()).storeId,
    artifacts = createArtifactStore({ profile, store });
  let effects = 0,
    rebuilds = 0;
  const extension: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    records: [
      {
        contentType: 'fixture.copy',
        contentVersion: 1,
        schema: { type: 'object' },
        fork: { mode: 'copy', version: 'copy-1' },
      },
      {
        contentType: 'fixture.rebuild',
        contentVersion: 1,
        schema: { type: 'object' },
        fork: {
          mode: 'rebuild',
          version: 'rebuild-1',
          async prepare(input) {
            rebuilds++;
            return [
              {
                key: 'derived',
                contentType: 'fixture.rebuild',
                contentVersion: 1,
                value: {
                  selected: input.selectedMessages.map((message) => message.id),
                  upper: input.boundary.upperSeq,
                  from: input.records.map((record) => record.key),
                },
              },
            ];
          },
        },
      },
      { contentType: 'fixture.omit', contentVersion: 1, schema: { type: 'object' } },
    ],
    tools: [
      {
        id: 'fixture.seed',
        version: '1',
        description: 'Write the isolated source namespace',
        inputSchema: { type: 'object' },
        async execute(_input, context) {
          effects++;
          for (const kind of ['copy', 'rebuild', 'omit'])
            await context.records.write({
              key: kind,
              expectedRevision: null,
              contentType: `fixture.${kind}`,
              contentVersion: 1,
              value: { original: kind },
              ...(kind === 'copy' ? { executable: true } : {}),
            });
          return { outcome: 'succeeded', content: 'Committed source only' };
        },
      },
    ],
  };
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'seed', name: 'fixture.seed', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'Source completed' }, finish],
  ]);
  const runtime = createRuntime({
    store,
    artifacts,
    model,
    extensions: [extension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned' };
      },
    },
  });
  const service = await startService({
      runtime,
      profile: host,
      buildId: 'namespaces',
      subjectId: 'owner',
    }),
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        profile: host,
        apiMajor: 1,
        requiredCapabilities: ['context', 'session_exports'],
      },
    });
  let gateway: ReturnType<typeof startDevelopmentWeb> | undefined,
    browser: ReturnType<typeof createBrowserClient> | undefined;
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: `file://${root}`,
      name: 'Owned',
    });
    await client.createSession({
      expectedStoreId,
      sessionId: 'source',
      workspaceId: 'w',
      commandId: 'create',
      title: 'Source',
    });
    await client.startRun('source', {
      expectedStoreId,
      commandId: 'work',
      kind: 'run.start',
      content: 'Commit source',
    });
    await runtime.waitForCommand('work', { timeoutMs: 15000 });
    const source = await client.getView('source'),
      boundary = source.messages.find((message) => message.role === 'user')!,
      intent = {
        expectedStoreId,
        commandId: 'fork',
        expectedContextSelectionId: source.session.contextSelectionId,
        newSessionId: 'branch',
        title: 'Branch',
        boundary: { messageId: boundary.id, seq: boundary.seq },
      },
      fork = await client.forkSession('source', intent);
    expect(fork.omittedExtensionState).toBe(true);
    expect(fork.namespaceReport).toEqual([
      {
        extensionId: 'fixture',
        contentType: 'fixture.copy',
        contentVersion: 1,
        mode: 'copy',
        ruleVersion: 'copy-1',
        copied: 1,
        rebuilt: 0,
        omitted: 0,
      },
      {
        extensionId: 'fixture',
        contentType: 'fixture.rebuild',
        contentVersion: 1,
        mode: 'rebuild',
        ruleVersion: 'rebuild-1',
        copied: 0,
        rebuilt: 1,
        omitted: 0,
      },
      {
        extensionId: 'fixture',
        contentType: 'fixture.omit',
        contentVersion: 1,
        mode: 'omit',
        ruleVersion: null,
        copied: 0,
        rebuilt: 0,
        omitted: 1,
      },
    ]);
    expect((await client.getCommand('fork')).receipt).toMatchObject({
      namespaceReport: fork.namespaceReport,
    });
    expect(rebuilds).toBe(1);
    expect((await client.forkSession('source', intent)).namespaceReport).toEqual(
      fork.namespaceReport,
    );
    expect(rebuilds).toBe(1);
    const branch = await client.getView('branch');
    expect(branch.runs).toHaveLength(0);
    expect(branch.executions).toHaveLength(0);
    expect(branch.messages.map((message) => message.role)).toEqual(['user']);
    gateway = startDevelopmentWeb({ admittedClient: client });
    const document = await fetch(gateway.endpoint);
    await document.body?.cancel();
    const cookie = document.headers.get('set-cookie')!.split(';')[0]!;
    browser = createBrowserClient({
      origin: gateway.endpoint,
      pageIdentity: gateway.pageIdentity,
      fetch: Object.assign(
        (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          fetch(url, {
            ...init,
            headers: {
              ...Object.fromEntries(new Headers(init?.headers)),
              cookie,
              origin: gateway!.endpoint,
            },
          }),
        { preconnect: fetch.preconnect },
      ),
    });
    await browser.connect();
    const cursor = (await store.getMetadata()).lastChangeCursor;
    for (const stream of [
      client.exportSession('branch', { storeId: expectedStoreId }),
      browser.exportSession('branch'),
    ]) {
      const frames: SessionExportFrame[] = [];
      for await (const frame of stream) frames.push(frame);
      expect(frames.at(-1)).toMatchObject({ kind: 'complete', rawTextVerified: true });
      const rows = frames.flatMap((frame) =>
        frame.kind === 'record' && frame.record.section === 'extension_records'
          ? [frame.record]
          : [],
      );
      expect(rows).toHaveLength(2);
      const copy = rows.find((row) => row.id === 'copy')!.record as {
          json: string;
          origin_store_id: string;
          fork_provenance_json: string;
        },
        derived = rows.find((row) => row.id === 'derived')!.record as {
          json: string;
          origin_store_id: null;
          fork_provenance_json: string;
        };
      expect(JSON.parse(copy.json)).toEqual({ original: 'copy' });
      expect(copy.origin_store_id).toBe(expectedStoreId);
      expect(JSON.parse(copy.fork_provenance_json)).toMatchObject({
        kind: 'fork_record',
        mode: 'copy',
        storeId: expectedStoreId,
        commandId: 'fork',
        sourceSessionId: 'source',
        sourceSelectionId: intent.expectedContextSelectionId,
        sourceUpperSeq: boundary.seq,
        ruleVersion: 'copy-1',
      });
      expect(derived.origin_store_id).toBeNull();
      expect(JSON.parse(derived.json)).toEqual({
        selected: [boundary.id],
        upper: boundary.seq,
        from: ['rebuild'],
      });
      expect(JSON.parse(derived.fork_provenance_json)).toMatchObject({
        mode: 'rebuild',
        commandId: 'fork',
        ruleVersion: 'rebuild-1',
      });
    }
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(client.lastAppliedCursor).toBeUndefined();
    expect(effects).toBe(1);
    expect(model.requests).toHaveLength(2);
    expect(rebuilds).toBe(1);
    const hidden = await fetch(`${service.endpoint}/v1/sessions/source/fork`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${service.bootstrap.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...intent,
        commandId: 'hidden',
        newSessionId: 'hidden',
        namespacePlan: { writes: [] },
      }),
    });
    expect(hidden.status).toBe(400);
    await hidden.body?.cancel();
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    const second = await client.forkSession('branch', {
      expectedStoreId,
      commandId: 'fork-derived',
      expectedContextSelectionId: branch.session.contextSelectionId,
      newSessionId: 'second',
      title: 'Second',
    });
    expect(second.omittedExtensionState).toBe(false);
    expect(
      second.namespaceReport?.map((report) => [
        report.mode,
        report.copied,
        report.rebuilt,
        report.omitted,
      ]),
    ).toEqual([
      ['copy', 1, 0, 0],
      ['rebuild', 0, 1, 0],
    ]);
    expect(rebuilds).toBe(2);
    expect(effects).toBe(1);
    expect(model.requests).toHaveLength(2);
  } finally {
    browser?.disposeNetwork();
    client.disposeNetwork();
    await gateway?.close();
    await service.close();
    await artifacts.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

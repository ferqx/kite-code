import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type {
  Json,
  SessionExportManifest,
  SessionExportSection,
  Store,
} from '../../../src/storage';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function fixture(large = false, many = false, child = false) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-session-export-'))),
    profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  const artifacts = createArtifactStore({ profile, store });
  let calls = 0,
    effects = 0;
  const body = large ? `original-17MiB-${'x'.repeat(17 * 1024 * 1024)}` : 'actual original answer';
  const model: ModelAdapter = {
    async *stream() {
      calls++;
      if ((many || child) && calls === 1) {
        for (let i = 0; i < 1; i++)
          yield { type: 'tool_call', id: `call-${i}`, name: 'fixture.record', arguments: '{}' };
        yield { ...finish, reason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', text: body };
        yield finish;
      }
    },
  };
  const runtime = createRuntime({
    store,
    artifacts,
    childConfigurations: child
      ? [
          {
            id: 'child',
            version: '1',
            model: {
              async *stream() {
                calls++;
                yield { type: 'text_delta', text: 'real child answer' };
                yield finish;
              },
            },
            modelId: 'fixed-child',
            toolIds: [],
            snapshot: { trusted: true },
          },
        ]
      : undefined,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        records: [{ contentType: 'fixture.note', contentVersion: 1, schema: { type: 'object' } }],
        tools: [
          {
            id: 'fixture.record',
            version: '1',
            description: 'actual sealed record',
            inputSchema: { type: 'object' },
            async execute(_input, ctx) {
              effects++;
              if (child) {
                const ref = await ctx.operations.ensure({
                  key: 'child',
                  request: {
                    kind: 'agent',
                    configurationId: 'child',
                    input: { content: 'real child' },
                  },
                });
                await ctx.operations.wait(ref, { signal: ctx.signal, timeoutMs: 10000 });
              } else
                for (let i = 0; i < 210; i++)
                  await ctx.records.write({
                    key: `note-${i}`,
                    expectedRevision: null,
                    contentType: 'fixture.note',
                    contentVersion: 1,
                    value: { actual: effects },
                  });
              return { outcome: 'succeeded', content: 'written' };
            },
          },
        ],
      },
    ],
  });
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'private',
    rootUri: `file://${directory}`,
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create',
    subjectId: 'owner',
    title: 'original',
  });
  await runtime.submitCommand({
    expectedStoreId: storeId,
    sessionId: 's',
    commandId: 'work',
    subjectId: 'owner',
    request: { kind: 'run.start', content: 'actual work' },
  });
  await runtime.waitForCommand('work', { timeoutMs: 30000 });
  return {
    directory,
    profile,
    store,
    storeId,
    artifacts,
    runtime,
    body,
    counts: () => ({ calls, effects }),
    scope: { expectedStoreId: storeId, sessionId: 's', subjectId: 'owner' },
    async close() {
      await runtime.close();
      await artifacts.close();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
async function all(
  store: Store,
  scope: { expectedStoreId: string; sessionId: string; subjectId: string },
  manifest: SessionExportManifest,
  section: SessionExportSection,
) {
  const result = [];
  let afterSeq: string | undefined;
  do {
    const page = await store.readSessionExportPage({ ...scope, manifest, section, afterSeq });
    result.push(...page.records);
    afterSeq = page.nextAfterSeq ?? undefined;
  } while (afterSeq);
  return result;
}

test('actual >200 records export is complete with immutable Model/Tool identities; scoped cold reads are zero calls/writes', async () => {
  const f = await fixture(false, true);
  try {
    const before = f.counts(),
      water = (await f.store.getMetadata()).lastChangeCursor;
    const manifest = await f.runtime.beginSessionExport(f.scope);
    const executions = await all(f.store, f.scope, manifest, 'executions'),
      messages = await all(f.store, f.scope, manifest, 'messages'),
      parts = await all(f.store, f.scope, manifest, 'message_parts'),
      records = await all(f.store, f.scope, manifest, 'extension_records');
    expect(executions.length).toBe(3);
    expect(messages.length).toBe(4);
    expect(parts.length).toBe(messages.length);
    expect(records.length).toBe(210);
    expect(new Set(executions.map((r) => r.seq)).size).toBe(3);
    expect(executions.every((r) => !('owner_generation' in (r.record as object)))).toBe(true);
    const runs = await all(f.store, f.scope, manifest, 'runs');
    expect('config_json' in (runs[0]!.record as object)).toBe(false);
    expect((await f.runtime.verifySessionExport({ ...f.scope, manifest })).verified).toBe(true);
    expect(f.counts()).toEqual(before);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(water);
    expect(
      (
        await f.runtime
          .beginSessionExport({ ...f.scope, subjectId: 'intruder' })
          .catch((error) => error)
      ).code,
    ).toBe('export_scope_denied');
    expect(
      (
        await f.runtime
          .beginSessionExport({ ...f.scope, expectedStoreId: 'foreign' })
          .catch((error) => error)
      ).code,
    ).toBe('store_identity_mismatch');
    expect(
      (
        await f.runtime
          .verifySessionExport({
            ...f.scope,
            manifest: { ...manifest, sections: manifest.sections.slice(1) },
          })
          .catch((error) => error)
      ).code,
    ).toBe('export_changed');
    expect(
      (
        await f.runtime
          .readSessionExportPage({
            ...f.scope,
            manifest,
            section: 'messages',
            afterSeq: '9223372036854775808',
          })
          .catch((error) => error)
      ).code,
    ).toBe('export_invalid_page');
    await f.runtime.close();
    await f.artifacts.close();
    await f.store.close();
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      const m = await cold.beginSessionExport(f.scope);
      expect((await all(cold, f.scope, m, 'messages')).length).toBe(4);
      expect((await cold.verifySessionExport({ ...f.scope, manifest: m })).verified).toBe(true);
      expect((await cold.getSession('s'))!.ownerInstanceId).toBeNull();
      expect((await cold.getMetadata()).lastChangeCursor).toBe(water);
    } finally {
      await cold.close();
    }
    expect(f.counts()).toEqual(before);
  } finally {
    await f.close();
  }
}, 40000);

test('unknown future Part/extension raw envelopes survive without installed code; >8MiB raw text is lossless bounded chunks and media retains original scope', async () => {
  const f = await fixture(true);
  try {
    const physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    const future = `{"future":"${'z'.repeat(9 * 1024 * 1024)}","tail":"exact-original"}`;
    const provenance = `{"future":"${'p'.repeat(70 * 1024)}","tail":"exact-provenance"}`;
    try {
      const message = physical
        .query("SELECT id FROM message WHERE role='assistant' LIMIT 1")
        .get() as { id: string };
      physical.run(
        'INSERT INTO message_part(message_id,ordinal,kind,content_version,revision,json) VALUES(?,1,?,?,?,?)',
        [message.id, 'future.part', 900, 1, future],
      );
      physical.run(
        'INSERT INTO message_part(message_id,ordinal,kind,content_version,revision,json) VALUES(?,2,?,?,?,?)',
        [message.id, 'future.invalid', 901, 1, '{ invalid original envelope'],
      );
      physical.run(
        "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json) VALUES('missing.extension','session','s','future',1,'future.state',900,?,'{  \"unknown\": [true, null], \"kept\": 4 }')",
        [f.storeId],
      );
    } finally {
      physical.close();
    }
    const modify = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    try {
      modify.run(
        "UPDATE extension_record SET rowid=9007199254740993,origin_store_id='original-other-store',fork_provenance_json=? WHERE extension_id='missing.extension'",
        [provenance],
      );
    } finally {
      modify.close();
    }
    const manifest = await f.runtime.beginSessionExport(f.scope),
      rows = await all(f.store, f.scope, manifest, 'message_parts'),
      futureRow = rows.find((r) => (r.record as Record<string, Json>).kind === 'future.part')!;
    expect(futureRow).toBeDefined();
    expect(
      (
        rows.find((r) => (r.record as Record<string, Json>).kind === 'future.invalid')!
          .record as Record<string, Json>
      ).json,
    ).toBe('{ invalid original envelope');
    const data = futureRow.record as Record<string, Json>,
      descriptor = data.json as { kind: string; sha256: string; byteLength: string };
    expect(data.content_version).toBe('900');
    expect(descriptor.kind).toBe('export_text');
    const chunks: Buffer[] = [];
    let afterByte: string | undefined;
    do {
      const page = await f.runtime.readSessionExportText({
        ...f.scope,
        manifest,
        section: 'message_parts',
        seq: futureRow.seq,
        field: 'json',
        afterByte,
      });
      const bytes = Buffer.from(page.contentBase64, 'base64');
      expect(bytes.length).toBeLessThanOrEqual(65536);
      chunks.push(bytes);
      afterByte = page.nextAfterByte ?? undefined;
    } while (afterByte);
    const bytes = Buffer.concat(chunks);
    expect(bytes.toString()).toBe(future);
    expect(String(bytes.length)).toBe(descriptor.byteLength);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(descriptor.sha256);
    const extension = await all(f.store, f.scope, manifest, 'extension_records');
    expect((extension[0]!.record as Record<string, Json>).json).toBe(
      '{  "unknown": [true, null], "kept": 4 }',
    );
    expect(extension[0]!.seq).toBe('9007199254740993');
    expect((extension[0]!.record as Record<string, Json>).origin_store_id).toBe(
      'original-other-store',
    );
    const provenanceDescriptor = (extension[0]!.record as Record<string, Json>)
      .fork_provenance_json as { kind: string; byteLength: string; sha256: string };
    expect(provenanceDescriptor.kind).toBe('export_text');
    const provenanceChunks: Buffer[] = [];
    let provenanceAfter: string | undefined;
    do {
      const page = await f.runtime.readSessionExportText({
        ...f.scope,
        manifest,
        section: 'extension_records',
        seq: extension[0]!.seq,
        field: 'fork_provenance_json',
        afterByte: provenanceAfter,
      });
      provenanceChunks.push(Buffer.from(page.contentBase64, 'base64'));
      provenanceAfter = page.nextAfterByte ?? undefined;
    } while (provenanceAfter);
    const provenanceBytes = Buffer.concat(provenanceChunks);
    expect(provenanceChunks).toHaveLength(2);
    expect(provenanceBytes.toString()).toBe(provenance);
    expect(String(provenanceBytes.length)).toBe(provenanceDescriptor.byteLength);
    expect(createHash('sha256').update(provenanceBytes).digest('hex')).toBe(
      provenanceDescriptor.sha256,
    );
    expect(manifest.sections.find((s) => s.section === 'extension_records')!.highWaterSeq).toBe(
      '9007199254740993',
    );
    const invalidText = await f.runtime
      .readSessionExportText({
        ...f.scope,
        manifest,
        section: 'message_parts',
        seq: futureRow.seq,
        field: 'json',
        afterByte: '9223372036854775808',
      })
      .catch((error) => error);
    expect(invalidText.code).toBe('export_invalid_page');
    const refs = await all(f.store, f.scope, manifest, 'artifact_refs');
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((r) => r.sessionId === 's')).toBe(true);
    const exec = (await all(f.store, f.scope, manifest, 'executions')).find(
      (r) => (r.record as Record<string, Json>).kind === 'model',
    )!;
    const output = await f.runtime.readModelOutput({ ...f.scope, executionId: exec.id });
    expect(output.output.content).toBe(f.body);
    expect(output.output.complete).toBe(true);
    expect((await f.runtime.verifySessionExport({ ...f.scope, manifest })).verified).toBe(true);
    expect(f.counts()).toEqual({ calls: 1, effects: 0 });
    await f.runtime.close();
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      const original = await cold.beginSessionExport(f.scope);
      const raw = await all(cold, f.scope, original, 'extension_records');
      expect((raw[0]!.record as Record<string, Json>).origin_store_id).toBe('original-other-store');
      expect((raw[0]!.record as Record<string, Json>).fork_provenance_json).toEqual(
        provenanceDescriptor,
      );
      expect((await cold.verifySessionExport({ ...f.scope, manifest: original })).verified).toBe(
        true,
      );
      const stale = await cold
        .verifySessionExport({ ...f.scope, manifest })
        .catch((error) => error);
      expect(stale.code).toBe('export_changed');
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
}, 40000);

test('business writes and physical external commits invalidate pages and completion, no false valid footer', async () => {
  const f = await fixture();
  try {
    const manifest = await f.runtime.beginSessionExport(f.scope);
    await f.runtime.readSessionExportPage({ ...f.scope, manifest, section: 'messages' });
    await f.runtime.renameSession({
      ...f.scope,
      commandId: 'rename',
      ifRevision: '0',
      title: 'changed',
    });
    const changed = await f.runtime
      .verifySessionExport({ ...f.scope, manifest })
      .catch((error) => error);
    expect(changed.code).toBe('export_changed');
    expect(
      (
        await f.runtime
          .readSessionExportPage({ ...f.scope, manifest, section: 'executions' })
          .catch((error) => error)
      ).code,
    ).toBe('export_changed');
    const next = await f.runtime.beginSessionExport(f.scope);
    const physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    try {
      physical.run('UPDATE message_part SET json=\'{"modified":true}\' WHERE ordinal=0');
    } finally {
      physical.close();
    }
    expect(
      (await f.runtime.verifySessionExport({ ...f.scope, manifest: next }).catch((error) => error))
        .code,
    ).toBe('export_changed');
    const refreshed = await f.runtime.beginSessionExport(f.scope);
    expect(
      (await f.runtime.verifySessionExport({ ...f.scope, manifest: refreshed })).verified,
    ).toBe(true);
    expect(f.counts()).toEqual({ calls: 1, effects: 0 });
  } finally {
    await f.close();
  }
}, 20000);

test('actual same-Loop child group is included only via sealed carrier ancestry, direct public child export is rejected', async () => {
  const f = await fixture(false, false, true);
  try {
    const manifest = await f.runtime.beginSessionExport(f.scope),
      sessions = await all(f.store, f.scope, manifest, 'sessions');
    expect(sessions.length).toBe(2);
    const child = sessions.find((s) => s.id !== 's')!;
    const executions = await all(f.store, f.scope, manifest, 'executions');
    expect(
      executions.some(
        (e) => e.sessionId === child.id && (e.record as Record<string, Json>).kind === 'model',
      ),
    ).toBe(true);
    expect((await f.runtime.verifySessionExport({ ...f.scope, manifest })).verified).toBe(true);
    expect(
      (
        await f.runtime
          .beginSessionExport({ ...f.scope, sessionId: child.id })
          .catch((error) => error)
      ).code,
    ).toBe('group_root_required');
    const before = f.counts();
    await all(f.store, f.scope, manifest, 'commands');
    expect(f.counts()).toEqual(before);
  } finally {
    await f.close();
  }
}, 20000);

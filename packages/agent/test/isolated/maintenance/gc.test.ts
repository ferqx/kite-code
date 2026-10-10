import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { runSelectedMaintenance } from '../../../../../apps/cli/host/maintenance';
import { parseCLIArguments } from '../../../../../apps/cli/src/arguments';
import { prepareQualifiedSqliteFixture } from '../../../../../tests/fixtures/unified-agent/qualified-sqlite-fixture';
import { createArtifactStore } from '../../../src/artifacts';
import { artifactPath } from '../../../src/artifacts-files';
import { collectProfileGarbage, createProfileBackup } from '../../../src/maintenance';
import { acquireProfileAccess, selectProfile } from '../../../src/platform/profile';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

let selected: Awaited<ReturnType<typeof prepareQualifiedSqliteFixture>>;
beforeAll(async () => {
  selected = await prepareQualifiedSqliteFixture();
}, 60000);
afterAll(() => selected?.close());
async function fixture() {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-gc-')),
    profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId,
    path = selectProfile(profile).profilePath;
  await store.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: `file://${root}`,
    name: 'w',
  });
  await store.createSession({
    expectedStoreId: storeId,
    subjectId: 'user',
    workspaceId: 'w',
    sessionId: 's',
    commandId: 'create',
    title: 's',
  });
  const put = (text: string) => {
    const bytes = Buffer.from(text),
      hash = createHash('sha256').update(bytes).digest('hex'),
      file = artifactPath(path, hash);
    mkdirSync(join(path, 'blobs', hash.slice(0, 2)), { recursive: true, mode: 0o700 });
    writeFileSync(file, bytes, { mode: 0o400 });
    return { bytes, hash, file };
  };
  const referenced = put('referenced original'),
    orphan = put('unregistered immutable');
  await store.registerArtifact({
    expectedStoreId: storeId,
    refId: 'ref',
    hash: referenced.hash,
    size: String(referenced.bytes.length),
    sessionId: 's',
    subjectId: 'user',
    scope: { kind: 'session', id: 's' },
    mediaType: 'text/plain',
  });
  return { root, profile, store, storeId, path, referenced, orphan };
}
test.skipIf(process.platform === 'win32')(
  'explicit GC respects live/backup exclusion, grace, exact Store and retained references through the actual CLI entry',
  async () => {
    const f = await fixture();
    const originalNow = Date.now;
    try {
      expect(
        await collectProfileGarbage({ profile: f.profile, expectedStoreId: f.storeId }).catch(
          (e) => e,
        ),
      ).toMatchObject({ code: 'owner_busy' });
      expect(existsSync(f.orphan.file)).toBe(true);
      await f.store.close();
      const core = readFileSync(join(f.path, 'core.db'));
      await expect(
        collectProfileGarbage({ profile: f.profile, expectedStoreId: 'foreign' }),
      ).rejects.toThrow('store_identity_mismatch');
      const recent = await collectProfileGarbage({
        profile: f.profile,
        expectedStoreId: f.storeId,
      });
      expect(recent).toMatchObject({ removedFiles: 0, retainedReferenced: 1, retainedRecent: 1 });
      const backup = await createProfileBackup({
        profile: f.profile,
        destinationRoot: join(f.root, 'backups'),
      });
      expect(existsSync(artifactPath(backup.directory, f.referenced.hash))).toBe(true);
      const now = originalNow();
      Date.now = () => now + 8 * 86400000; // Advance only the maintenance clock; filesystem timestamps stay real.
      const args = parseCLIArguments([
        'maintenance',
        'gc',
        '--data-root',
        f.profile.dataRoot,
        '--profile',
        f.profile.profile,
        '--expected-store',
        f.storeId,
      ]);
      if (args.kind !== 'maintenance') throw Error('GC parser');
      const lines: string[] = [];
      expect(
        await runSelectedMaintenance({ arguments: args, write: (line) => lines.push(line) }),
      ).toBe(0);
      expect(JSON.parse(lines[0]!).gc).toMatchObject({
        outcome: 'collected',
        removedFiles: 1,
        retainedReferenced: 1,
        removedBytes: String(f.orphan.bytes.length),
      });
      expect(existsSync(f.orphan.file)).toBe(false);
      expect(readFileSync(f.referenced.file)).toEqual(f.referenced.bytes);
      expect(readFileSync(artifactPath(backup.directory, f.referenced.hash))).toEqual(
        f.referenced.bytes,
      );
      expect(readFileSync(join(f.path, 'core.db'))).toEqual(core);
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, 'gc-close-owner.fixture.ts')],
        {
          env: {
            ...process.env,
            KITE_MAINTENANCE_ENGINE: JSON.stringify(selected.engine.selection),
            KITE_MAINTENANCE_PROFILE: JSON.stringify(f.profile),
            KITE_MAINTENANCE_STORE: f.storeId,
          },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const stderr = new Response(child.stderr).text();
      const reader = child.stdout.getReader();
      try {
        const ready = await reader.read();
        const observed = JSON.parse(new TextDecoder().decode(ready.value));
        expect(observed.failure).toBe('maintenance_fixture_close_unconfirmed');
        expect(observed.connectionAlive).toBe(true);
        await expect(
          createProfileBackup({ profile: f.profile, destinationRoot: join(f.root, 'blocked') }),
        ).rejects.toMatchObject({ code: 'owner_busy' });
        expect(existsSync(observed.path)).toBe(true);
        const other = acquireProfileAccess(
          { dataRoot: f.profile.dataRoot, profile: 'other' },
          'exclusive',
        );
        other.lock.release();
      } finally {
        child.stdin.end();
        expect(await child.exited).toBe(0);
        while (!(await reader.read()).done) {}
        reader.releaseLock();
        expect(await stderr).toBe('');
      }
      const recovered = await createProfileBackup({
        profile: f.profile,
        destinationRoot: join(f.root, 'after-exit'),
      });
      expect(readFileSync(artifactPath(recovered.directory, f.referenced.hash))).toEqual(
        f.referenced.bytes,
      );
      expect(recovered.manifest.source.storeId).toBe(f.storeId);
      expect(readFileSync(join(f.path, 'core.db'))).toEqual(core);
      const cold = await openSqliteStore(f.profile);
      try {
        expect((await cold.getMetadata()).storeId).toBe(f.storeId);
        expect((await cold.getSession('s'))!.title).toBe('s');
        expect(await cold.getCommand('create')).toBeDefined();
      } finally {
        await cold.close();
      }
    } finally {
      Date.now = originalNow;
      await f.store.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);
test.skipIf(process.platform === 'win32')(
  'GC rejects hostile private entries before deleting candidates and a cancelled invocation publishes no completed result',
  async () => {
    const f = await fixture();
    const originalNow = Date.now;
    try {
      await f.store.removeWorkspace({
        expectedStoreId: f.storeId,
        subjectId: 'user',
        workspaceId: 'w',
        commandId: 'remove',
      });
      await f.store.close();
      const core = readFileSync(join(f.path, 'core.db'));
      const now = originalNow();
      Date.now = () => now + 8 * 86400000;
      const outside = join(f.root, 'outside');
      writeFileSync(outside, 'untouched');
      const prefix = Array.from({ length: 256 }, (_, n) => n.toString(16).padStart(2, '0')).find(
        (n) => !existsSync(join(f.path, 'blobs', n)),
      )!;
      const link = join(f.path, 'blobs', prefix);
      symlinkSync(f.root, link);
      await expect(
        collectProfileGarbage({ profile: f.profile, expectedStoreId: f.storeId }),
      ).rejects.toThrow();
      expect(existsSync(f.orphan.file)).toBe(true);
      expect(readFileSync(join(f.path, 'core.db'))).toEqual(core);
      expect(readFileSync(outside, 'utf8')).toBe('untouched');
      rmSync(link);
      await expect(
        collectProfileGarbage({
          profile: f.profile,
          expectedStoreId: f.storeId,
          signal: AbortSignal.abort(),
        }),
      ).rejects.toThrow();
      expect(existsSync(f.orphan.file)).toBe(true);
      expect(() =>
        parseCLIArguments([
          'maintenance',
          'gc',
          '--data-root',
          f.profile.dataRoot,
          '--profile',
          'test',
          '--expected-store',
          f.storeId,
          '--grace-period-ms',
          '0',
        ]),
      ).toThrow('maintenance_gc_grace_invalid');
    } finally {
      Date.now = originalNow;
      await f.store.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'offline GC purges actual finished Runtime and internal Fork bodies, preserves other scopes and original de-duplication facts',
  async () => {
    const f = await fixture();
    const originalNow = Date.now;
    const sentinel = 'PURGE-WORKSPACE-HISTORY-ONLY-';
    const finish: ModelEvent = {
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const runtime = createRuntime({
      store: f.store,
      model: createFixedModel([
        [
          { type: 'tool_call', id: 'seed', name: 'fixture.seed', arguments: '{}' },
          { ...finish, reason: 'tool_calls' },
        ],
        [{ type: 'text_delta', text: sentinel.repeat(6000) }, finish],
      ]),
      artifacts: createArtifactStore({ profile: f.profile, store: f.store }),
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
          records: [
            {
              contentType: 'fixture.history',
              contentVersion: 1,
              schema: { type: 'object' },
              fork: { mode: 'omit' },
            },
          ],
          tools: [
            {
              id: 'fixture.seed',
              version: '1',
              description: 'Write actual history bodies',
              inputSchema: { type: 'object' },
              async execute(_input, context) {
                await context.records.write({
                  key: 'history',
                  expectedRevision: null,
                  contentType: 'fixture.history',
                  contentVersion: 1,
                  value: { body: sentinel.repeat(1000) },
                });
                await context.artifacts!.publish({
                  key: 'history',
                  mediaType: 'text/plain',
                  content: Buffer.from(sentinel.repeat(4000)),
                });
                return { outcome: 'succeeded', content: sentinel.repeat(4000) };
              },
            },
          ],
        },
      ],
    });
    let peer: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let sql: Database | undefined;
    const request = {
      expectedStoreId: f.storeId,
      subjectId: 'user',
      sessionId: 's',
      commandId: 'work',
      request: { kind: 'run.start' as const, content: sentinel.repeat(4000) },
    };
    const removalInput = {
      expectedStoreId: f.storeId,
      subjectId: 'user',
      workspaceId: 'w',
      commandId: 'remove',
    };
    try {
      await runtime.submitCommand(request);
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect(
        (await f.store.getView('s')).executions.map((e) => ({
          status: e.status,
          error: e.status === 'succeeded' ? null : e.result,
        })),
      ).toEqual([
        { status: 'succeeded', error: null },
        { status: 'succeeded', error: null },
        { status: 'succeeded', error: null },
      ]);
      await runtime.forkSession({
        expectedStoreId: f.storeId,
        subjectId: 'user',
        sourceSessionId: 's',
        newSessionId: 'forked',
        commandId: 'fork',
        expectedContextSelectionId: (await f.store.getSession('s'))!.contextSelectionId,
        title: 'internal fork',
      });
      expect((await f.store.listMessages('forked')).length).toBeGreaterThan(0);
      await f.store.createWorkspace({
        expectedStoreId: f.storeId,
        id: 'other',
        rootUri: `file://${f.root}`,
        name: 'keep',
      });
      await f.store.createSession({
        expectedStoreId: f.storeId,
        subjectId: 'user',
        workspaceId: 'other',
        sessionId: 'other',
        commandId: 'other-create',
        title: 'keep',
      });
      await f.store.registerArtifact({
        expectedStoreId: f.storeId,
        subjectId: 'user',
        sessionId: 'other',
        refId: 'shared-ref',
        hash: f.referenced.hash,
        size: String(f.referenced.bytes.length),
        scope: { kind: 'session', id: 'other' },
        mediaType: 'text/plain',
      });
      const other = await f.store.getView('other');
      const command = await f.store.getCommand('work');
      const originalReceipts = await Promise.all(
        ['create', 'work', 'fork'].map((id) => f.store.getCommand(id)),
      );
      const originalCommands = originalReceipts.map((c) => ({
        id: c!.id,
        requestDigest: c!.requestDigest,
        receipt: c!.receipt,
        status: c!.status,
      }));
      const receipt = await runtime.removeWorkspace(removalInput);
      const removalCursor = (await f.store.getMetadata()).lastChangeCursor;
      const userFile = join(f.root, 'project-file');
      writeFileSync(userFile, 'project stays');
      const privateFile = join(f.path, 'retained-user-draft');
      writeFileSync(privateFile, 'unsent user data', { mode: 0o600 });
      await runtime.close();
      await f.store.close();
      const recent = await collectProfileGarbage({
        profile: f.profile,
        expectedStoreId: f.storeId,
      });
      expect(recent).toMatchObject({ purgedWorkspaces: 0, retainedRecentWorkspaces: 1 });
      Date.now = () => originalNow() + 8 * 86400000;
      // A valid relational edge outside the removed Workspace must stop all history deletion.
      sql = new Database(join(f.path, 'core.db'));
      const source = sql
        .query<{ id: string }, []>("SELECT id FROM execution WHERE session_id='s' LIMIT 1")
        .get()!;
      sql.run("UPDATE command SET agent_source_execution_id=? WHERE id='other-create'", [
        source.id,
      ]);
      sql.close(true);
      sql = undefined;
      const guardedCore = readFileSync(join(f.path, 'core.db'));
      await expect(
        collectProfileGarbage({ profile: f.profile, expectedStoreId: f.storeId }),
      ).rejects.toThrow('gc_external_history_reference');
      expect(readFileSync(join(f.path, 'core.db'))).toEqual(guardedCore);
      sql = new Database(join(f.path, 'core.db'));
      sql.run("UPDATE command SET agent_source_execution_id=NULL WHERE id='other-create'");
      sql.close(true);
      sql = undefined;
      const gc = await collectProfileGarbage({ profile: f.profile, expectedStoreId: f.storeId });
      expect(gc).toMatchObject({ purgedWorkspaces: 1, purgedSessions: 2, retainedReferenced: 1 });
      expect(gc.removedFiles).toBeGreaterThan(1);
      expect(readFileSync(f.referenced.file)).toEqual(f.referenced.bytes);
      expect(readFileSync(privateFile, 'utf8')).toBe('unsent user data');
      expect(readFileSync(userFile, 'utf8')).toBe('project stays');
      expect(readFileSync(join(f.path, 'core.db')).includes(Buffer.from(sentinel))).toBe(false);
      for (const suffix of ['-wal', '-journal'])
        if (existsSync(join(f.path, `core.db${suffix}`)))
          expect(
            readFileSync(join(f.path, `core.db${suffix}`)).includes(Buffer.from(sentinel)),
          ).toBe(false);
      Date.now = originalNow;
      peer = await openSqliteStore(f.profile);
      expect(await peer.getWorkspaceRemoval(removalInput)).toEqual(receipt);
      expect(await peer.removeWorkspace(removalInput)).toEqual(receipt);
      expect((await peer.getSession('s'))!.historyPurgedAt).toBeGreaterThan(0);
      expect((await peer.getSession('forked'))!.historyPurgedAt).toBeGreaterThan(0);
      expect((await peer.getView('s')).messages).toEqual([]);
      expect((await peer.getView('forked')).messages).toEqual([]);
      expect(
        (await peer.getView('s')).executions.every(
          (e) => e.status === 'succeeded' && e.input === null && e.result === null,
        ),
      ).toBe(true);
      const retainedCommands = await Promise.all(
        ['create', 'work', 'fork'].map((id) => peer!.getCommand(id)),
      );
      expect(
        retainedCommands.map((c) => ({
          id: c!.id,
          requestDigest: c!.requestDigest,
          receipt: c!.receipt,
          status: c!.status,
        })),
      ).toEqual(originalCommands);
      expect(await peer.acceptCommand(request)).toMatchObject({
        id: command!.id,
        requestDigest: command!.requestDigest,
        receipt: command!.receipt,
        status: command!.status,
      });
      expect((await peer.getView('other')).session).toEqual(other.session);
      expect((await peer.getMetadata()).replayFloor).toBe(removalCursor);
      const expired = await peer.getChanges({ after: '0' }).catch((e) => e);
      expect(expired).toMatchObject({ code: 'cursor_expired' });
      expect((await peer.getChanges({ after: removalCursor })).events).toMatchObject([
        {
          type: 'workspace.history_collected',
          payload: { purgedWorkspaces: 1, purgedSessions: 2 },
        },
      ]);
      const late = await peer
        .createSession({
          expectedStoreId: f.storeId,
          subjectId: 'user',
          workspaceId: 'w',
          sessionId: 'late',
          commandId: 'late',
          title: 'late',
        })
        .catch((e) => e);
      expect(late).toMatchObject({ code: 'workspace_removed' });
      await peer.close();
      peer = undefined;
      Date.now = () => originalNow() + 8 * 86400000;
      expect(
        await collectProfileGarbage({ profile: f.profile, expectedStoreId: f.storeId }),
      ).toMatchObject({ purgedWorkspaces: 0, removedFiles: 0 });
      expect(readFileSync(join(f.path, 'core.db')).includes(Buffer.from(sentinel))).toBe(false);
    } finally {
      Date.now = originalNow;
      sql?.close(true);
      await peer?.close();
      await runtime.close();
      await f.store.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

for (const scope of ['workspace', 'session'] as const)
  test.skipIf(process.platform === 'win32')(
    `grace never purges an unknown Runtime Execution and its exact recovery evidence after ${scope} deletion`,
    async () => {
      const f = await fixture();
      const originalNow = Date.now;
      const finish: ModelEvent = {
        type: 'finish',
        reason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      const runtime = createRuntime({
        store: f.store,
        model: createFixedModel([
          [
            { type: 'tool_call', id: 'uncertain', name: 'fixture.effect', arguments: '{}' },
            { ...finish, reason: 'tool_calls' },
          ],
          [finish],
        ]),
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
            tools: [
              {
                id: 'fixture.effect',
                version: '1',
                description: 'Actual uncertain adapter evidence',
                inputSchema: { type: 'object' },
                async execute() {
                  return {
                    outcome: 'outcome_unknown',
                    content: 'unconfirmed effect: retain original evidence',
                  };
                },
              },
            ],
          },
        ],
      });
      let peer: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
      try {
        await runtime.submitCommand({
          expectedStoreId: f.storeId,
          subjectId: 'user',
          sessionId: 's',
          commandId: 'unknown-work',
          request: { kind: 'run.start', content: 'retain original uncertain input' },
        });
        await runtime.waitForCommand('unknown-work', { timeoutMs: 5000 });
        const uncertain = (await f.store.getView('s')).executions.find(
          (e) => e.status === 'outcome_unknown',
        )!;
        expect(uncertain).toBeDefined();
        if (scope === 'workspace')
          await runtime.removeWorkspace({
            expectedStoreId: f.storeId,
            subjectId: 'user',
            workspaceId: 'w',
            commandId: 'remove',
          });
        else
          await runtime.deleteSession({
            expectedStoreId: f.storeId,
            subjectId: 'user',
            sessionId: 's',
            commandId: 'delete',
            ifRevision: (await f.store.getSession('s'))!.controlRevision,
          });
        const original = await f.store.getView('s');
        await runtime.close();
        await f.store.close();
        const core = readFileSync(join(f.path, 'core.db'));
        Date.now = () => originalNow() + 8 * 86400000;
        expect(
          await collectProfileGarbage({ profile: f.profile, expectedStoreId: f.storeId }),
        ).toMatchObject({
          purgedWorkspaces: 0,
          retainedUnsettledWorkspaces: scope === 'workspace' ? 1 : 0,
          retainedUnsettledSessionGroups: scope === 'session' ? 1 : 0,
          retainedReferenced: 1,
        });
        expect(readFileSync(join(f.path, 'core.db'))).toEqual(core);
        Date.now = originalNow;
        peer = await openSqliteStore(f.profile);
        const retained = await peer.getView('s');
        expect(retained.messages).toEqual(original.messages);
        expect(retained.executions).toEqual(original.executions);
        expect(retained.runs).toEqual(original.runs);
        expect(retained.snapshotCursor).toBe(original.snapshotCursor);
        expect((await peer.getExecution(uncertain.id))!.status).toBe('outcome_unknown');
      } finally {
        Date.now = originalNow;
        await peer?.close();
        await runtime.close();
        await f.store.close();
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

test.skipIf(process.platform === 'win32')(
  'single-group GC preserves live Fork ancestry, then collects the deleted chain together and retains the original delete receipt',
  async () => {
    const f = await fixture();
    const originalNow = Date.now;
    const sentinel = 'PURGE-SINGLE-GROUP-HISTORY-';
    let calls = 0;
    const runtime = createRuntime({
      store: f.store,
      model: {
        async *stream() {
          calls++;
          yield { type: 'text_delta', text: sentinel.repeat(6000) };
          yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
      artifacts: createArtifactStore({ profile: f.profile, store: f.store }),
      permissions: {
        async authorize() {
          return { allowed: true, revision: '1' };
        },
      },
    });
    let peer: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    const base = { expectedStoreId: f.storeId, subjectId: 'user' };
    const deletion = async (sessionId: string) => {
      const input = {
        ...base,
        sessionId,
        commandId: `delete-${sessionId}`,
        ifRevision: (await f.store.getSession(sessionId))!.controlRevision,
      };
      return { input, result: await runtime.deleteSession(input) };
    };
    try {
      await runtime.submitCommand({
        ...base,
        sessionId: 's',
        commandId: 'work',
        request: { kind: 'run.start', content: sentinel.repeat(4000) },
      });
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect(calls).toBe(1);
      expect((await f.store.getView('s')).executions.map((e) => e.status)).toEqual(['succeeded']);
      for (const [source, id] of [
        ['s', 'f1'],
        ['f1', 'f2'],
      ])
        await runtime.forkSession({
          ...base,
          sourceSessionId: source!,
          newSessionId: id!,
          commandId: `create-${id}`,
          expectedContextSelectionId: (await f.store.getSession(source!))!.contextSelectionId,
          title: id!,
          boundary: null, // No Message aliases: the actual Fork creation still keeps ancestry.
        });
      await f.store.createSession({
        ...base,
        workspaceId: 'w',
        sessionId: 'independent',
        commandId: 'create-independent',
        title: 'independent',
      });
      const independent = await deletion('independent');
      await deletion('s');
      await deletion('f1');
      const sourceView = await f.store.getView('s');
      const liveView = await f.store.getView('f2');
      const userFile = join(f.root, 'project');
      writeFileSync(userFile, 'project remains');
      await runtime.close();
      const recent = await collectProfileGarbage({
        profile: f.profile,
        expectedStoreId: f.storeId,
      });
      expect(recent).toMatchObject({ purgedSessionGroups: 0, retainedRecentSessionGroups: 3 });
      Date.now = () => originalNow() + 8 * 86400000;
      expect(
        await collectProfileGarbage({ profile: f.profile, expectedStoreId: f.storeId }),
      ).toMatchObject({
        purgedWorkspaces: 0,
        purgedSessionGroups: 1,
        purgedSessions: 1,
        retainedReferencedSessionGroups: 2,
      });
      Date.now = originalNow;
      peer = await openSqliteStore(f.profile);
      const collectedAt = (await peer.getSession('independent'))!.historyPurgedAt;
      expect(collectedAt).toBeGreaterThan(0);
      const retainedDelete = {
        session: independent.result.session,
        command: {
          id: independent.result.command.id,
          requestDigest: independent.result.command.requestDigest,
          receipt: independent.result.command.receipt,
          status: independent.result.command.status,
        },
      };
      expect(await peer.deleteSession(independent.input)).toMatchObject(retainedDelete);
      expect((await peer.getSession('s'))!.historyPurgedAt).toBeUndefined();
      expect((await peer.getView('s')).messages).toEqual(sourceView.messages);
      expect((await peer.getView('s')).executions).toEqual(sourceView.executions);
      expect((await peer.getView('f2')).session).toEqual(liveView.session);
      expect(readFileSync(f.referenced.file)).toEqual(f.referenced.bytes);
      await peer.deleteSession({
        ...base,
        sessionId: 'f2',
        commandId: 'delete-f2',
        ifRevision: liveView.session.controlRevision,
      });
      await peer.close();
      peer = undefined;
      Date.now = () => originalNow() + 9 * 86400000;
      expect(
        await collectProfileGarbage({ profile: f.profile, expectedStoreId: f.storeId }),
      ).toMatchObject({
        purgedWorkspaces: 0,
        purgedSessionGroups: 3,
        purgedSessions: 3,
        retainedReferencedSessionGroups: 0,
      });
      expect(readFileSync(join(f.path, 'core.db')).includes(Buffer.from(sentinel))).toBe(false);
      expect(existsSync(f.referenced.file)).toBe(false);
      expect(readFileSync(userFile, 'utf8')).toBe('project remains');
      expect(calls).toBe(1);
      Date.now = originalNow;
      peer = await openSqliteStore(f.profile);
      for (const id of ['s', 'f1', 'f2']) {
        expect((await peer.getSession(id))!.historyPurgedAt).toBeGreaterThan(collectedAt!);
        expect((await peer.getView(id)).messages).toEqual([]);
      }
      expect((await peer.getSession('independent'))!.historyPurgedAt).toBe(collectedAt);
      expect(await peer.deleteSession(independent.input)).toMatchObject(retainedDelete);
      const late = await peer
        .acceptCommand({
          ...base,
          sessionId: 's',
          commandId: 'late',
          request: { kind: 'run.start', content: 'no resurrection' },
        })
        .catch((e) => e);
      expect(late).toMatchObject({ code: 'session_not_found' });
      expect((await peer.listWorkspaces({ limit: 100 })).map((w) => w.id)).toEqual(['w']);
      await peer.createSession({
        ...base,
        workspaceId: 'w',
        sessionId: 'new',
        commandId: 'create-new',
        title: 'Workspace remains usable',
      });
      expect((await peer.getSession('new'))!.deletedAt).toBeNull();
      const originalSourceTime = (await peer.getSession('s'))!.historyPurgedAt;
      await peer.removeWorkspace({ ...base, workspaceId: 'w', commandId: 'remove-later' });
      await peer.close();
      peer = undefined;
      Date.now = () => originalNow() + 10 * 86400000;
      expect(
        await collectProfileGarbage({ profile: f.profile, expectedStoreId: f.storeId }),
      ).toMatchObject({
        purgedWorkspaces: 1,
        purgedSessionGroups: 0,
        purgedSessions: 5,
      });
      Date.now = originalNow;
      peer = await openSqliteStore(f.profile);
      expect((await peer.getSession('s'))!.historyPurgedAt).toBe(originalSourceTime);
      expect((await peer.getSession('independent'))!.historyPurgedAt).toBe(collectedAt);
      expect((await peer.getSession('new'))!.historyPurgedAt).toBeGreaterThan(originalSourceTime!);
      expect(await peer.deleteSession(independent.input)).toMatchObject(retainedDelete);
    } finally {
      Date.now = originalNow;
      await peer?.close();
      await runtime.close();
      await f.store.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

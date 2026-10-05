import { strict as assert } from 'node:assert';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { selectProfile } from '@kite-ai/agent/profile';
import { createClient } from '@kite-ai/client';
import type { FileRecoveryIntent } from '@kite-ai/client/file-recovery-intent';
import { NativeFileRecovery } from '../electron/file-recovery';
import { fileRecoveryIntentId } from '../electron/file-recovery-journal';
import { openPrivateData } from '../electron/private-data';
import { acquireDesktopProfileAccess } from '../electron/profile-access';

const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const client = createClient({
  endpoint: input.bootstrap.endpoint,
  token: input.bootstrap.token,
  expected: {
    profile: input.bootstrap.profile,
    apiMajor: 1,
    requiredCapabilities: ['file_recovery', 'extensions_actions', 'context'],
    instanceId: input.bootstrap.instanceId,
    buildId: input.bootstrap.buildId,
  },
});
await client.connect();
const scope = { generation: 1, selection: 1, storeId: client.serverInfo!.storeId!, sessionId: 's' };
const access = () => acquireDesktopProfileAccess(input.access),
  profile = selectProfile(input.access.profile);
let data = openPrivateData(profile.profilePath, await access()),
  manager = new NativeFileRecovery(
    client,
    () => scope,
    () => {},
    data,
  );
const originalFetch = globalThis.fetch;
let posts = 0,
  lose = false;
const observedFetch: typeof fetch = Object.assign(
  async (request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (init?.method === 'POST') posts++;
    const result = await originalFetch(request, init);
    if (
      lose &&
      init?.method === 'POST' &&
      (String(request).endsWith('/fork') ||
        (String(request).endsWith('/commands') &&
          JSON.parse(String(init.body)).kind === 'extension.invoke'))
    ) {
      lose = false;
      await result.text();
      throw Error('owned_response_loss');
    }
    return result;
  },
  { preconnect: originalFetch.preconnect },
);
globalThis.fetch = observedFetch;
async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean) {
  const end = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (matches(value)) return value;
    if (Date.now() > end) throw Error('native_file_recovery_deadline');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function cold(intent: FileRecoveryIntent) {
  const id = fileRecoveryIntentId(intent),
    before = posts;
  manager.release();
  data.close();
  data = openPrivateData(profile.profilePath, await access());
  manager = new NativeFileRecovery(
    client,
    () => scope,
    () => {},
    data,
  );
  const saved = await manager.saved();
  assert.deepEqual(
    saved.find((value) => fileRecoveryIntentId(value) === id),
    intent,
  );
  assert.equal(posts, before);
  return manager.lookup(id, `cold-${id}`);
}
try {
  if (input.killWindow === 'before_post') {
    const update = data.updateFileRecovery.bind(data);
    data.updateFileRecovery = async (next, previous) => {
      const saved = await update(next, previous);
      if (next.code?.phase === 'submitting') {
        writeFileSync(
          input.barrier,
          JSON.stringify({ code: next.code.request.commandId, fork: next.fork!.request.commandId }),
          { mode: 0o600 },
        );
        setInterval(() => {}, 1000);
        await new Promise<void>(() => {});
      }
      return saved;
    };
    const observed = await manager.detail(input.pointId, 'before-post', 0);
    await manager.begin(observed.observationId, 'both', 'Crash original IDs', 0);
    throw Error('kill_barrier_not_reached');
  }
  if (input.killWindow === 'cold_lookup') {
    const values = await manager.saved();
    assert.equal(values.length, 1);
    const original = values[0]!;
    assert.equal(original.code!.phase, 'submitting');
    assert.equal(original.fork!.phase, 'not_started');
    const ids = JSON.parse(readFileSync(input.barrier, 'utf8'));
    assert.equal(original.code!.request.commandId, ids.code);
    assert.equal(original.fork!.request.commandId, ids.fork);
    const cold = await manager.lookup(ids.code, 'cold-killed');
    assert.equal(cold.code!.phase, 'unknown');
    assert.equal(cold.fork!.phase, 'not_started');
    assert.equal(posts, 0);
    await manager.lookup(ids.code, 'cold-killed-again');
    assert.equal(posts, 0);
    console.log('native-file-recovery-killed-before-post-qualified');
  } else {
    const kinds: readonly ('session' | 'code' | 'both')[] = input.drift
      ? ['both']
      : ['session', 'code', 'both'];
    for (const kind of kinds) {
      const facts = await manager.detail(input.pointId, `read-${kind}`, 0),
        before = readFileSync(input.path),
        inode = statSync(input.path).ino;
      lose = true;
      const initial = await manager.begin(facts.observationId, kind, `Native ${kind}`, 0),
        id = fileRecoveryIntentId(initial);
      assert.equal(initial[kind === 'session' ? 'fork' : 'code']!.phase, 'unknown');
      assert.equal(
        initial.code?.request.input &&
          typeof initial.code.request.input === 'object' &&
          !Array.isArray(initial.code.request.input)
          ? initial.code.request.input.checkpointId
          : input.pointId,
        input.pointId,
      );
      let current = await cold(initial);
      if (kind === 'session') {
        assert.equal(current.fork!.phase, 'succeeded');
        assert.deepEqual(readFileSync(input.path), before);
        assert.equal(statSync(input.path).ino, inode);
        const view = await client.getView(current.fork!.request.newSessionId);
        assert.equal(view.session.workspaceId, 'w');
        continue;
      }
      const cards = await until(
        () =>
          client.listInteractions('s', { storeId: scope.storeId, state: 'pending', limit: 100 }),
        (page) =>
          page.interactions.some(
            (card) => card.definitionId === 'builtin.files/files.checkpoint.restore',
          ),
      );
      const card = cards.interactions.find(
        (card) => card.definitionId === 'builtin.files/files.checkpoint.restore',
      )!;
      assert.equal(card.kind, 'approval');
      assert.equal(card.runId, null);
      assert.equal(card.definitionVersion, '1');
      assert.deepEqual(readFileSync(input.path), before);
      assert.equal(statSync(input.path).ino, inode);
      const actual = await client.getExecution(card.executionId!);
      assert.equal(actual.kind, 'job');
      assert.equal(actual.status, 'planned');
      await client.answerInteraction('s', card.id, {
        expectedStoreId: scope.storeId,
        commandId: `approve-native-${kind}`,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
      });
      await until(
        () => client.getExecution(card.executionId!),
        (value) => ['succeeded', 'failed', 'outcome_unknown'].includes(value.status),
      );
      current = await until(
        () => manager.lookup(id, `lookup-${kind}`),
        (value) =>
          value.code!.phase === 'succeeded' ||
          value.code!.phase === 'failed' ||
          value.code!.phase === 'unknown',
      );
      assert.equal(current.code!.phase, 'succeeded');
      assert.deepEqual(readFileSync(input.path), readFileSync(input.preimage));
      if (kind === 'code') {
        assert.notEqual(statSync(input.path).ino, inode);
        assert.equal(current.fork, null);
        await cold(current);
        continue;
      }
      assert.equal(current.fork!.phase, 'not_started');
      if (input.drift) {
        const beforePosts = posts,
          codeId = current.code!.request.commandId,
          forkId = current.fork!.request.commandId;
        writeFileSync(input.path, 'owned independent editor drift\r\n');
        await assert.rejects(manager.continue(id), /file_recovery_code_changed/);
        assert.equal(posts, beforePosts);
        assert.equal((await manager.saved())[0]!.code!.phase, 'succeeded');
        assert.equal((await manager.saved())[0]!.fork!.phase, 'not_started');
        writeFileSync(input.path, readFileSync(input.preimage));
        await client.startRun('s', {
          expectedStoreId: scope.storeId,
          commandId: 'native-later-run',
          kind: 'run.start',
          content: 'LATER_ACTUAL_RUN: actual fresh read then write and create after code success',
        });
        const command = await until(
          () => client.getCommand('native-later-run'),
          (value) => value.status === 'applied',
        );
        const receipt = command.receipt;
        if (
          !receipt ||
          typeof receipt !== 'object' ||
          Array.isArray(receipt) ||
          typeof receipt.runId !== 'string'
        )
          throw Error('actual_later_run_receipt_missing');
        const run = await until(
          () => client.getRun(receipt.runId as string),
          (value) => ['completed', 'failed', 'cancelled'].includes(value.status),
        );
        assert.equal(run.status, 'completed');
        const post = readFileSync(input.path),
          writes = posts;
        await assert.rejects(manager.continue(id), /file_recovery_code_changed/);
        assert.equal(posts, writes);
        assert.deepEqual(readFileSync(input.path), post);
        const saved = (await manager.saved())[0]!;
        assert.equal(saved.code!.phase, 'succeeded');
        assert.equal(saved.fork!.phase, 'not_started');
        assert.equal(saved.code!.request.commandId, codeId);
        assert.equal(saved.fork!.request.commandId, forkId);
        await cold(saved);
        assert.equal(posts, writes);
        continue;
      }
      const forkId = current.fork!.request.commandId,
        beforeContinue = posts;
      lose = true;
      const partial = await manager.continue(id);
      assert.equal(partial.code!.phase, 'succeeded');
      assert.equal(partial.fork!.phase, 'unknown');
      assert.equal(partial.fork!.request.commandId, forkId);
      assert.equal(posts, beforeContinue + 1);
      const final = await cold(partial);
      assert.equal(final.fork!.phase, 'succeeded');
      assert.equal(final.code!.request.commandId, initial.code!.request.commandId);
      const writes = posts;
      await manager.lookup(id, 'again-original');
      assert.equal(posts, writes);
    }
    assert.equal((await manager.saved()).length, input.drift ? 1 : 3);
    console.log(
      'native-file-recovery-node-qualified',
      JSON.stringify({
        posts,
        scopes: (await manager.saved()).map((value) => ({
          scope: value.scope,
          code: value.code?.phase,
          fork: value.fork?.phase,
        })),
      }),
    );
  }
} finally {
  globalThis.fetch = originalFetch;
  manager.release();
  data.close();
  client.disposeNetwork();
}

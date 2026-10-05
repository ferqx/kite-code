import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from '@kite-ai/agent/maintenance';
import {
  carrier,
  prepareReconnectionEngine,
  reconnect,
  reconnectionHostFixture,
} from '../fixtures/mcp-reconnection-host';

let engine: Awaited<ReturnType<typeof prepareReconnectionEngine>> | undefined;
beforeAll(async () => {
  engine = await prepareReconnectionEngine();
}, 60000);
afterAll(() => engine?.close());
const signal = () => new AbortController().signal;

test('public v11 offline restore preserves original A bytes while actual admitted B refuses every original request before HTTP', async () => {
  const f = await reconnectionHostFixture();
  try {
    const a = await f.ordinary('restore_A');
    await f.connectionReady(a.intent);
    const observed = await f.port().observe(carrier(a.intent), signal());
    const r = reconnect(observed, 'restore_R');
    await f.port().submit(r, observed);
    const ready = await f.reconnectionReady(r);
    expect(ready.fact?.oldStop.confirmed).toBe(true);
    const path = join(f.profile.profilePath, 'ui/mcp-reconnection-intents.json');
    const bytes = readFileSync(path),
      rows = f.journal.list(),
      storeA = f.storeId;
    const sha = createHash('sha256').update(bytes).digest('hex');
    await f.offline();
    const backup = await createProfileBackup({
      profile: f.profile,
      destinationRoot: join(f.root, 'backups'),
    });
    expect(backup.manifest.version).toBe(11);
    expect(backup.manifest.assets.mcpReconnectionIntents?.proof?.sha256).toBe(sha);
    expect(readFileSync(join(backup.directory, 'ui/mcp-reconnection-intents.json'))).toEqual(bytes);
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    const restored = await restoreProfileBackup({
      profile: f.profile,
      expectedStoreId: storeA,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(storeA);
    await f.reopen();
    expect(f.client.serverInfo?.storeId).toBe(restored.storeId);
    expect(f.journal.list()).toEqual(rows);
    expect(readFileSync(path)).toEqual(bytes);
    const before = f.counts(),
      cursor = (await f.store.getMetadata()).lastChangeCursor;
    const actualFetch = globalThis.fetch;
    let http = 0;
    globalThis.fetch = Object.assign((...args: Parameters<typeof fetch>) => {
      http++;
      return actualFetch(...args);
    }, actualFetch);
    try {
      expect((await f.port().list())[0]?.intent).toEqual(r);
      expect((await f.port().lookup(r, signal())).phase).toBe('outcome_unknown');
      expect((await f.port().submit(r, observed)).phase).toBe('outcome_unknown');
      await expect(f.port().observe(carrier(r), signal())).rejects.toThrow();
      expect((await f.connection().lookup(a.intent, signal())).phase).toBe('outcome_unknown');
    } finally {
      globalThis.fetch = actualFetch;
    }
    expect(http).toBe(0);
    expect(f.counts()).toEqual(before);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.journal.list()).toEqual(rows);
    expect(readFileSync(path)).toEqual(bytes);
    expect(f.counts()).toMatchObject({ models: 0, vault: 0, effects: 0 });
    console.log(
      JSON.stringify({
        stage: 'reconnection_restore_foreign',
        originStoreId: storeA,
        currentStoreId: restored.storeId,
        commandId: r.request.commandId,
        actionId: ready.fact?.execution.id,
        journalSha256: sha,
        journalBytes: bytes.length,
        http,
      }),
    );
  } finally {
    await f.close();
  }
}, 30000);

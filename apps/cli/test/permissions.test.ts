import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { selectProfile } from '@kite-ai/agent/profile';
import { createClient } from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';
import {
  clearPermissionGrants,
  createStdioPermissionReader,
  promptPermissionMode,
  promptWorkspaceTrust,
  runNonInteractive,
  setPermissionMode,
} from '../src';

async function paired() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cli-permissions-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  const host = await launchPairedService({
    entrypoint: join(import.meta.dir, '../../service/src/main.ts'),
    profile,
    instanceId: crypto.randomUUID(),
    buildId: 'permission-cli',
    apiMajor: 1,
    requiredCapabilities: ['sessions', 'permission_controls'],
  }).catch((error) => {
    rmSync(root, { recursive: true, force: true });
    throw error;
  });
  const { client } = host;
  const storeId = host.bootstrap.storeId!;
  const close = async () => {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  };
  try {
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'Permission CLI',
      rootUri: `file://${workspace}`,
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Permission CLI',
    });
    return {
      client,
      storeId,
      host,
      profile,
      root,
      close,
      counts() {
        const db = new Database(profile.databasePath, { readonly: true });
        try {
          return {
            commands: (db.query('SELECT COUNT(*) AS n FROM command').get() as { n: number }).n,
            mutations: (db.query('SELECT COUNT(*) AS n FROM host_mutation').get() as { n: number })
              .n,
            runs: (db.query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n,
            executions: (db.query('SELECT COUNT(*) AS n FROM execution').get() as { n: number }).n,
          };
        } finally {
          db.close();
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test('explicit CLI stdio controls actual paired production mode/default and trust/revoke without creating work', async () => {
  const f = await paired(),
    lines: string[] = [];
  const options = { client: f.client, write: (line: string) => lines.push(line) };
  try {
    const modeReader = createStdioPermissionReader(Readable.from(['ask default\n']));
    const mode = await promptPermissionMode('s', f.storeId, modeReader, options);
    modeReader.dispose();
    expect(mode).toMatchObject({ status: 'applied', exitCode: 0 });
    expect(mode.intent).toMatchObject({
      kind: 'permission.mode',
      sessionId: 's',
      request: { expectedStoreId: f.storeId, mode: 'ask', makeDefault: true, ifRevision: '0' },
    });
    expect(await f.client.getPermissionMode('s', { storeId: f.storeId })).toMatchObject({
      mode: 'ask',
      defaultMode: 'ask',
    });
    for (const [line, trusted] of [
      ['trust\n', true],
      ['untrust\n', false],
    ] as const) {
      const reader = createStdioPermissionReader(Readable.from([line]));
      const outcome = await promptWorkspaceTrust('w', f.storeId, reader, options);
      reader.dispose();
      expect(outcome).toMatchObject({ status: 'applied', exitCode: 0 });
      expect(await f.client.getWorkspaceTrust('w', { storeId: f.storeId })).toMatchObject({
        trusted,
        status: trusted ? 'trusted' : 'untrusted',
      });
    }
    expect(lines.join('\n')).toContain('"readScopes"');
    expect(lines.join('\n')).toContain('"canonicalIdentity"');
    expect(lines.join('\n')).toContain(f.storeId);
    expect(lines.join('\n')).not.toContain(f.root);
    expect(lines.filter((line) => line.endsWith('applied'))).toHaveLength(3);
    expect(f.counts()).toEqual({ commands: 1, mutations: 3, runs: 0, executions: 0 });
  } finally {
    await f.close();
  }
}, 15000);

test('CLI EOF, unfinished/invalid/over-budget UTF-8 and absent choices leave the observed control unchanged', async () => {
  const f = await paired();
  try {
    const inputs = [
      '',
      '\n',
      'ask',
      'cancel\n',
      'full default extra\n',
      'trust\n',
      new Uint8Array([0xff, 10]),
      `${'a'.repeat(257)}\n`,
    ];
    for (const input of inputs) {
      const reader = createStdioPermissionReader(Readable.from([input]));
      const result = await promptPermissionMode('s', f.storeId, reader, {
        client: f.client,
        write() {},
      });
      expect(result).toEqual({ status: 'not_submitted', exitCode: 3 });
      reader.dispose();
    }
    expect(await f.client.getPermissionMode('s', { storeId: f.storeId })).toMatchObject({
      mode: 'auto',
      revision: '0',
      defaultMode: 'auto',
      defaultRevision: '0',
    });
    expect(f.counts()).toEqual({ commands: 1, mutations: 0, runs: 0, executions: 0 });
  } finally {
    await f.close();
  }
}, 15000);

test('a competing mode writer rejects the original prompt CAS and retains its original intent without refreshed authority', async () => {
  const f = await paired();
  let prompted!: () => void, answer!: (line: string) => void;
  const shown = new Promise<void>((resolve) => {
    prompted = resolve;
  });
  const choice = new Promise<string>((resolve) => {
    answer = resolve;
  });
  const reader = {
    readLine() {
      prompted();
      return choice;
    },
  };
  try {
    const initial = await f.client.getPermissionMode('s', { storeId: f.storeId });
    const pending = promptPermissionMode('s', f.storeId, reader, { client: f.client, write() {} });
    await shown;
    await f.client.setPermissionMode('s', {
      expectedStoreId: f.storeId,
      commandId: 'competing',
      mode: 'accept_edits',
      ifRevision: initial.revision,
      makeDefault: false,
      ifDefaultRevision: initial.defaultRevision,
    });
    answer('ask default');
    const result = await pending;
    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 1,
      errorCode: 'host_control_conflict',
    });
    expect(result.intent).toMatchObject({
      sessionId: 's',
      request: {
        expectedStoreId: f.storeId,
        mode: 'ask',
        ifRevision: '0',
        ifDefaultRevision: '0',
        makeDefault: true,
      },
    });
    expect(await f.client.getPermissionMode('s', { storeId: f.storeId })).toMatchObject({
      mode: 'accept_edits',
      defaultMode: 'auto',
      defaultRevision: '0',
    });
    expect(f.counts()).toMatchObject({ runs: 0, executions: 0 });
  } finally {
    await f.close();
  }
}, 15000);

test('Ctrl+C and dispose stop only the local control prompt; late input has zero mutation and zero work cancellation', async () => {
  const f = await paired();
  try {
    for (const method of ['abort', 'dispose'] as const) {
      const input = new PassThrough(),
        signal = new AbortController(),
        reader = createStdioPermissionReader(input);
      let prompted!: () => void;
      const shown = new Promise<void>((resolve) => {
        prompted = resolve;
      });
      const pending = promptWorkspaceTrust('w', f.storeId, reader, {
        client: f.client,
        signal: signal.signal,
        write(line) {
          if (line.startsWith('Review ')) prompted();
        },
      });
      await shown;
      if (method === 'abort') signal.abort();
      else reader.dispose();
      input.end('trust\n');
      expect(await pending).toEqual({
        status: 'not_submitted',
        exitCode: method === 'abort' ? 130 : 3,
      });
      reader.dispose();
      expect(await reader.readLine()).toBeUndefined();
      input.destroy();
    }
    expect(await f.client.getWorkspaceTrust('w', { storeId: f.storeId })).toMatchObject({
      trusted: false,
      revision: '0',
    });
    expect(f.counts()).toEqual({ commands: 1, mutations: 0, runs: 0, executions: 0 });
  } finally {
    await f.close();
  }
}, 15000);

test('noninteractive permission commands preserve explicit IDs, closed JSON and no credential/extra argument authority', async () => {
  const f = await paired(),
    lines: string[] = [];
  const options = { client: f.client, write: (line: string) => lines.push(line) };
  try {
    expect(
      await runNonInteractive(
        ['permission-mode', 's', JSON.stringify({ storeId: f.storeId })],
        options,
      ),
    ).toBe(0);
    expect(
      await runNonInteractive(
        ['workspace-trust', 'w', JSON.stringify({ storeId: f.storeId })],
        options,
      ),
    ).toBe(0);
    const request = {
      expectedStoreId: f.storeId,
      commandId: 'cli-explicit',
      mode: 'full',
      ifRevision: '0',
      makeDefault: false,
      ifDefaultRevision: '0',
    };
    expect(
      await runNonInteractive(['set-permission-mode', 's', JSON.stringify(request)], options),
    ).toBe(0);
    expect(
      await runNonInteractive(
        [
          'set-permission-mode',
          's',
          JSON.stringify({ ...request, commandId: 'invalid', subjectId: 'forged' }),
        ],
        options,
      ),
    ).toBe(1);
    for (const args of [
      ['permission-mode', 's', JSON.stringify({ storeId: f.storeId, subjectId: 'forged' })],
      ['permission-mode', 's', JSON.stringify({ storeId: f.storeId }), '--unknown'],
      ['set-permission-mode', 's', JSON.stringify(request), '--token=private'],
    ]) {
      let failure: unknown;
      try {
        await runNonInteractive(args, options);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
    }
    expect(await f.client.getPermissionMode('s', { storeId: f.storeId })).toMatchObject({
      mode: 'full',
      defaultMode: 'auto',
    });
    expect(lines.join('\n')).toContain('cli-explicit');
    expect(f.counts()).toEqual({ commands: 1, mutations: 1, runs: 0, executions: 0 });
  } finally {
    await f.close();
  }
}, 15000);

test('CLI grant directory and explicit clear use actual Session epoch without starting work; stale and hidden choices fail closed', async () => {
  const f = await paired();
  const lines: string[] = [];
  const options = { client: f.client, write: (line: string) => lines.push(line) };
  try {
    const initial = await f.client.listPermissionGrants('s', { storeId: f.storeId });
    const before = f.counts();
    expect(
      await runNonInteractive(
        ['permission-grants', 's', JSON.stringify({ storeId: f.storeId })],
        options,
      ),
    ).toBe(0);
    expect(f.counts()).toEqual(before);
    const original = {
      expectedStoreId: f.storeId,
      commandId: 'clear-cli',
      ifRevision: initial.revision,
    };
    expect(
      await runNonInteractive(['clear-permission-grants', 's', JSON.stringify(original)], options),
    ).toBe(0);
    expect(
      await f.client.getPermissionMutation(original.commandId, {
        storeId: original.expectedStoreId,
      }),
    ).toMatchObject({
      kind: 'permission.grants.clear',
      state: 'applied',
      receipt: { status: 'applied', sessionId: 's' },
    });
    expect(
      (await clearPermissionGrants('s', { ...original, commandId: 'stale-clear' }, options))
        .exitCode,
    ).toBe(1);
    expect(
      (
        await clearPermissionGrants(
          's',
          { ...original, commandId: 'hidden-clear', subjectId: 'forged' } as typeof original,
          options,
        )
      ).exitCode,
    ).toBe(1);
    expect(f.counts()).toEqual({ commands: 1, mutations: 1, runs: 0, executions: 0 });
    expect(lines.join('\n')).toContain('clear-cli');
  } finally {
    await f.close();
  }
});

test('a physically lost actual committed CLI permission response causes one POST and original receipt lookup only', async () => {
  const f = await paired(),
    sockets = new Set<Socket>(),
    posts: string[] = [];
  const proxy = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const upstream = await fetch(f.host.bootstrap.endpoint + request.url, {
        method: request.method,
        headers: {
          authorization: `Bearer ${f.host.bootstrap.token}`,
          'content-type': 'application/json',
        },
        ...(body.byteLength ? { body } : {}),
      });
      const complete = await upstream.text();
      if (request.method === 'POST') {
        posts.push(JSON.parse(body.toString()).commandId);
        expect(upstream.status).toBe(200);
        request.socket.destroy();
        response.destroy();
        return;
      }
      response.writeHead(upstream.status, { 'content-type': 'application/json' });
      response.end(complete);
    } catch {
      response.destroy();
    }
  });
  proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const client = createClient({
    endpoint: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    token: f.host.bootstrap.token,
    bootstrap: f.host.bootstrap,
    expected: {
      profile: f.host.bootstrap.profile,
      apiMajor: 1,
      instanceId: f.host.bootstrap.instanceId,
      buildId: f.host.bootstrap.buildId,
      requiredCapabilities: ['permission_controls'],
    },
  });
  try {
    await client.connect();
    const observed = await client.getPermissionMode('s', { storeId: f.storeId });
    const request = {
      expectedStoreId: f.storeId,
      commandId: 'lost-original',
      mode: 'ask' as const,
      ifRevision: observed.revision,
      makeDefault: true,
      ifDefaultRevision: observed.defaultRevision,
    };
    const result = await setPermissionMode('s', request, { client, write() {} });
    expect(result).toMatchObject({
      status: 'applied',
      exitCode: 0,
      intent: { sessionId: 's', request },
    });
    expect(posts).toEqual(['lost-original']);
    expect(await f.client.getPermissionMutation('lost-original', { storeId: f.storeId })).toEqual(
      result.mutation!,
    );
    expect(f.counts()).toEqual({ commands: 1, mutations: 1, runs: 0, executions: 0 });
  } finally {
    client.disposeNetwork();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await f.close();
  }
}, 15000);

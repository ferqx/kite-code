import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { dirname, join } from 'node:path';

import { selectProfile } from '@kite-ai/agent/profile';
import { createClient } from '@kite-ai/client';
import {
  inspectProcess,
  readDaemonReservation,
  requestDaemonBootstrap,
  selectDaemonEndpoint,
} from '@kite-ai/service/daemon';
import { runSelectedDaemon } from '../../host/daemon';
import { runSelectedManagement } from '../../host/management';
import type { ManagementCLIArguments } from '../../src/arguments';
import { buildOwnedDaemon } from '../fixtures/daemon-host-build';

let root: string, entry: string, driver: string;
const nativeTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
beforeAll(async () => {
  root = mkdtempSync('/private/tmp/kite-shared-management-');
  const old = await buildOwnedDaemon(join(root, 'artifact'));
  const result = await Bun.build({
    entrypoints: [
      new URL('../fixtures/shared-management-daemon-child.ts', import.meta.url).pathname,
      new URL('../fixtures/shared-management-driver.ts', import.meta.url).pathname,
    ],
    target: 'bun',
    packages: 'external',
    outdir: dirname(old),
  });
  expect(result.success).toBe(true);
  entry = join(dirname(old), 'shared-management-daemon-child.js');
  driver = join(dirname(old), 'shared-management-driver.js');
}, 60000);
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw Error('shared_fixture_timeout');
    await Bun.sleep(5);
  }
}
async function limit<T>(value: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('shared_fixture_deadline')), 10000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function fixture() {
  const base = join(root, randomUUID());
  mkdirSync(base, { mode: 0o700 });
  const dataRoot = join(base, 'data');
  const profile = selectProfile({ dataRoot, profile: 'owned' });
  const endpoint = selectDaemonEndpoint({
    profileAccessKey: profile.profileAccessKey,
    explicitSocket: join(base, 's.sock'),
  });
  const web = join(base, 'web');
  mkdirSync(web);
  const manifest = [
    ['/index.html', 'text/html; charset=utf-8', '<title>Owned</title>'],
    ['/app.js', 'text/javascript; charset=utf-8', 'globalThis.owned=true;'],
    ['/app.css', 'text/css; charset=utf-8', 'body{}'],
  ].map(([path, mediaType, content]) => {
    writeFileSync(join(web, path!.slice(1)), content!);
    return { path, mediaType, size: Buffer.byteLength(content!), sha256: hash(content!) };
  });
  const raw = JSON.stringify(manifest);
  writeFileSync(join(web, 'manifest.json'), raw);
  const executable = realpathSync(process.execPath);
  const artifact = {
    entrypoint: entry,
    entrypointSha256: hash(readFileSync(entry)),
    executable,
    executableSha256: hash(readFileSync(executable)),
    apiMajor: 1 as const,
    buildId: 'running-older-build',
    daemon: {
      entrypoint: entry,
      entrypointSha256: hash(readFileSync(entry)),
      web: { directory: web, manifestSha256: hash(raw) },
    },
  };
  const daemon = (action: 'start' | 'stop') =>
    runSelectedDaemon({
      arguments: { kind: 'server', action, server: endpoint.socket, cancel: false, json: false },
      dataRoot,
      profile: 'owned',
      cwd: base,
      artifact,
      write() {},
    });
  await daemon('start');
  const bootstrap = await requestDaemonBootstrap(endpoint, {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  });
  const client = createClient({
    endpoint: bootstrap.httpEndpoint,
    token: bootstrap.token,
    expected: {
      profile: bootstrap.profile,
      instanceId: bootstrap.instanceId,
      apiMajor: 1,
      requiredCapabilities: [],
    },
  });
  const info = await client.connect();
  const storeId = info.storeId!;
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'workspace',
    rootUri: `file://${base}`,
    name: 'Owned',
  });
  const session = (id: string, workspaceId = 'workspace') =>
    client.createSession({
      expectedStoreId: storeId,
      commandId: `create-${id}`,
      sessionId: id,
      workspaceId,
      title: id,
    });
  const lines: string[] = [];
  let assetReads = 0;
  const run = (
    arguments_: ManagementCLIArguments,
    extra: Partial<Parameters<typeof runSelectedManagement>[0]> = {},
  ) =>
    runSelectedManagement({
      arguments: { ...arguments_, server: endpoint.socket } as ManagementCLIArguments,
      dataRoot,
      profile: 'owned',
      write: (line) => lines.push(line),
      resolveArtifact() {
        assetReads++;
        throw Error('paired_asset_must_not_resolve');
      },
      ...extra,
    });
  const alive = async () => {
    expect(inspectProcess(bootstrap.pid, bootstrap.processStartIdentity)).toBe('alive');
    expect((await requestDaemonBootstrap(endpoint, bootstrap.profile)).instanceId).toBe(
      bootstrap.instanceId,
    );
  };
  return {
    base,
    dataRoot,
    profile,
    endpoint,
    bootstrap,
    client,
    storeId,
    session,
    lines,
    run,
    alive,
    reads: () => assetReads,
    async close() {
      client.disposeNetwork();
      await daemon('stop');
      expect(readDaemonReservation(endpoint)).toBeUndefined();
    },
  };
}

nativeTest(
  'shared management exact Session and Context mutations detach without paired assets or peer cancellation',
  async () => {
    const f = await fixture();
    try {
      await f.session('s');
      await f.session('peer');
      await f.client.startRun('peer', {
        expectedStoreId: f.storeId,
        commandId: 'peer-held',
        kind: 'run.start',
        content: 'hold external',
      });
      await until(() => existsSync(join(f.base, 'entered-peer')));
      expect(
        await limit(
          f.run({
            kind: 'session',
            action: 'rename',
            sessionId: 's',
            input: {
              expectedStoreId: f.storeId,
              commandId: 'rename',
              ifRevision: '0',
              title: 'Shared title',
            },
          }),
        ),
      ).toBe(0);
      expect((await f.client.getView('s')).session.title).toBe('Shared title');
      const selection = (await f.client.getView('s')).session.contextSelectionId;
      expect(
        await f.run({
          kind: 'context',
          action: 'read',
          sessionId: 's',
          input: { storeId: f.storeId, contextSelectionId: selection },
        }),
      ).toBe(0);
      expect(
        await f.run({
          kind: 'session',
          action: 'fork',
          sessionId: 's',
          input: {
            expectedStoreId: f.storeId,
            commandId: 'fork',
            newSessionId: 'forked',
            title: 'Forked',
            expectedContextSelectionId: selection,
          },
        }),
      ).toBe(0);
      const fork = (await f.client.getView('forked')).session;
      expect(fork.workspaceId).toBe('workspace');
      expect(
        await f.run({
          kind: 'context',
          action: 'rewind',
          sessionId: 'forked',
          input: {
            expectedStoreId: f.storeId,
            commandId: 'rewind',
            expectedContextSelectionId: fork.contextSelectionId,
            boundary: null,
          },
        }),
      ).toBe(0);
      expect(
        await f.run({
          kind: 'session',
          action: 'delete',
          sessionId: 'forked',
          input: {
            expectedStoreId: f.storeId,
            commandId: 'delete',
            ifRevision: fork.controlRevision,
          },
        }),
      ).toBe(2);
      expect((await f.client.getView('forked')).session.deletedAt).not.toBeNull();
      expect(f.reads()).toBe(0);
      await f.alive();
      expect((await f.client.getView('peer')).runs.some((run) => run.isActive)).toBe(true);
      expect(existsSync(join(f.base, 'cancelled-peer'))).toBe(false);
    } finally {
      await f.close();
    }
  },
  30000,
);

nativeTest(
  'shared management refuses foreign Store Workspace profile and aborted unsent intent with zero writes',
  async () => {
    const f = await fixture();
    try {
      await f.session('s');
      const input = {
        expectedStoreId: f.storeId,
        commandId: 'unsent',
        ifRevision: '0',
        title: 'Wrong',
      };
      await expect(
        f.run({
          kind: 'session',
          action: 'rename',
          sessionId: 's',
          input: { ...input, expectedStoreId: 'foreign' },
        }),
      ).rejects.toMatchObject({ code: 'store_identity_mismatch' });
      const other = join(f.base, 'elsewhere');
      mkdirSync(other);
      await f.client.createWorkspace({
        expectedStoreId: f.storeId,
        id: 'foreign',
        rootUri: `file://${other}`,
        name: 'foreign',
      });
      await f.session('foreign-session', 'foreign');
      await expect(
        f.run({ kind: 'session', action: 'rename', sessionId: 'foreign-session', input }),
      ).rejects.toMatchObject({ code: 'workspace_identity_mismatch' });
      await expect(
        f.run({ kind: 'session', action: 'rename', sessionId: 's', input }, { profile: 'wrong' }),
      ).rejects.toMatchObject({ code: 'shared_bootstrap_failed' });
      const abort = new AbortController();
      expect(
        await f.run(
          { kind: 'session', action: 'rename', sessionId: 's', input },
          {
            signal: abort.signal,
            write(line) {
              if (line.startsWith('management intent saved')) abort.abort();
            },
          },
        ),
      ).toBe(130);
      await expect(f.client.getCommand('unsent')).rejects.toMatchObject({ status: 404 });
      expect((await f.client.getView('s')).session.title).toBe('s');
      expect((await f.client.getView('foreign-session')).session.title).toBe('foreign-session');
      expect(f.reads()).toBe(0);
      await f.alive();
    } finally {
      await f.close();
    }
  },
  30000,
);

nativeTest(
  'shared management CtrlC cancels only admitted original compression and host termination detaches',
  async () => {
    const f = await fixture();
    try {
      await f.session('s');
      await f.session('peer');
      for (const id of ['s', 'peer']) {
        await f.client.startRun(id, {
          expectedStoreId: f.storeId,
          commandId: `seed-${id}`,
          kind: 'run.start',
          content: 'seed',
        });
      }
      await until(() => existsSync(join(f.base, 'models')));
      const deadline = Date.now() + 5000;
      while (
        (await f.client.getView('s')).runs.some((run) => run.isActive) ||
        (await f.client.getView('peer')).runs.some((run) => run.isActive)
      ) {
        if (Date.now() > deadline) throw Error('seed_timeout');
        await Bun.sleep(5);
      }
      writeFileSync(join(f.base, 'hold-summary'), 'hold');
      const selection = (await f.client.getView('s')).session.contextSelectionId;
      const interrupt = new AbortController();
      const compact = f.run(
        {
          kind: 'context',
          action: 'compact',
          sessionId: 's',
          input: {
            expectedStoreId: f.storeId,
            commandId: 'compact-cancel',
            expectedContextSelectionId: selection,
          },
        },
        { signal: interrupt.signal },
      );
      await until(() => existsSync(join(f.base, 'summary-entered')));
      interrupt.abort();
      expect(await limit(compact)).toBe(130);
      await until(() => existsSync(join(f.base, 'summary-cancelled')));
      const cancelled = await f.client.getCommand('compact-cancel');
      expect(cancelled.id).toBe('compact-cancel');
      expect((await f.client.getView('s')).runs.some((run) => run.status === 'cancelled')).toBe(
        true,
      );
      rmSync(join(f.base, 'summary-entered'));
      rmSync(join(f.base, 'summary-cancelled'));
      const exit = new AbortController();
      const detached = f.run(
        {
          kind: 'context',
          action: 'compact',
          sessionId: 'peer',
          input: {
            expectedStoreId: f.storeId,
            commandId: 'compact-detach',
            expectedContextSelectionId: (await f.client.getView('peer')).session.contextSelectionId,
          },
        },
        { exitSignal: exit.signal },
      );
      await until(() => existsSync(join(f.base, 'summary-entered')));
      exit.abort();
      expect(await limit(detached)).toBe(2);
      await f.alive();
      expect((await f.client.getView('peer')).runs.some((run) => run.isActive)).toBe(true);
      expect(existsSync(join(f.base, 'summary-cancelled'))).toBe(false);
      expect(f.reads()).toBe(0);
    } finally {
      await f.close();
    }
  },
  30000,
);

nativeTest(
  'shared management reads abort without mutations and physically lost rename reconciles original once',
  async () => {
    const f = await fixture(),
      originalFetch = globalThis.fetch;
    const sockets = new Set<Socket>();
    let posts = 0,
      gets = 0;
    const relay = createServer(async (request) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const result = await originalFetch(f.bootstrap.httpEndpoint + request.url, {
        method: request.method,
        headers: {
          authorization: `Bearer ${f.bootstrap.token}`,
          'content-type': 'application/json',
        },
        ...(bytes.length ? { body: bytes } : {}),
      });
      await result.arrayBuffer();
      request.socket.destroy();
    });
    relay.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    try {
      await f.session('s');
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (init?.method === 'POST' && url.endsWith('/rename')) {
          posts++;
          return originalFetch(
            `http://127.0.0.1:${(relay.address() as AddressInfo).port}/v1/sessions/s/rename`,
            init,
          );
        }
        if (url.includes('/v1/commands/lost')) gets++;
        return originalFetch(input, init);
      }) as typeof fetch;
      expect(
        await f.run({
          kind: 'session',
          action: 'rename',
          sessionId: 's',
          input: {
            expectedStoreId: f.storeId,
            commandId: 'lost',
            ifRevision: '0',
            title: 'Original lost title',
          },
        }),
      ).toBe(0);
      expect(posts).toBe(1);
      expect(gets).toBeGreaterThan(0);
      expect((await f.client.getView('s')).session.title).toBe('Original lost title');
      globalThis.fetch = originalFetch;
      let mutations = 0;
      const abort = new AbortController();
      globalThis.fetch = (async (input, init) => {
        if (init?.method === 'POST') mutations++;
        if (String(input).includes('/context?')) {
          abort.abort();
          init?.signal?.throwIfAborted();
        }
        return originalFetch(input, init);
      }) as typeof fetch;
      expect(
        await f.run(
          { kind: 'context', action: 'read', sessionId: 's', input: { storeId: f.storeId } },
          { signal: abort.signal },
        ),
      ).toBe(130);
      expect(mutations).toBe(0);
      globalThis.fetch = (async (input, init) => {
        const response = await originalFetch(input, init);
        if (String(input).endsWith('/v1/server')) {
          const info = (await response.json()) as { capabilities: string[] };
          info.capabilities = info.capabilities.filter((value) => value !== 'context');
          return new Response(JSON.stringify(info), {
            status: response.status,
            headers: response.headers,
          });
        }
        return response;
      }) as typeof fetch;
      await expect(
        f.run({ kind: 'context', action: 'read', sessionId: 's', input: { storeId: f.storeId } }),
      ).rejects.toMatchObject({ code: 'shared_connection_failed' });
      expect(f.reads()).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await f.close();
    }
  },
  30000,
);

nativeTest(
  'shared rejected fork collision never cancels an existing foreign Workspace command',
  async () => {
    const f = await fixture(),
      originalFetch = globalThis.fetch;
    try {
      await f.session('s');
      const foreign = join(f.base, 'foreign');
      mkdirSync(foreign);
      await f.client.createWorkspace({
        expectedStoreId: f.storeId,
        id: 'foreign',
        rootUri: `file://${foreign}`,
        name: 'foreign',
      });
      await f.session('foreign-source', 'foreign');
      const originalSelection = (await f.client.getView('foreign-source')).session
        .contextSelectionId;
      await f.client.forkSession('foreign-source', {
        expectedStoreId: f.storeId,
        commandId: 'existing-fork',
        expectedContextSelectionId: originalSelection,
        newSessionId: 'foreign-fork',
        title: 'Original foreign fork',
      });
      const abort = new AbortController();
      let cancels = 0;
      globalThis.fetch = (async (input, init) => {
        if (
          init?.method === 'POST' &&
          typeof init.body === 'string' &&
          JSON.parse(init.body).kind === 'command.cancel'
        )
          cancels++;
        const response = await originalFetch(input, init);
        if (init?.method === 'POST' && String(input).endsWith('/sessions/s/fork')) {
          expect(response.status).toBe(409);
          abort.abort();
        }
        return response;
      }) as typeof fetch;
      expect(
        await f.run(
          {
            kind: 'session',
            action: 'fork',
            sessionId: 's',
            input: {
              expectedStoreId: f.storeId,
              commandId: 'existing-fork',
              expectedContextSelectionId: (await f.client.getView('s')).session.contextSelectionId,
              newSessionId: 'foreign-fork',
              title: 'Attempted cross scope',
            },
          },
          { signal: abort.signal },
        ),
      ).toBe(130);
      expect(cancels).toBe(0);
      expect((await f.client.getCommand('existing-fork')).cancelRequestedAt).toBeNull();
      expect((await f.client.getView('foreign-fork')).session.title).toBe('Original foreign fork');
      expect(f.reads()).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      await f.close();
    }
  },
  30000,
);

nativeTest(
  'actual shared management argv goes through process parser and host without asset resolver',
  async () => {
    const f = await fixture();
    try {
      await f.session('s');
      const child = Bun.spawn(
        [
          process.execPath,
          driver,
          'session',
          'rename',
          's',
          '--input',
          JSON.stringify({
            expectedStoreId: f.storeId,
            commandId: 'argv-rename',
            ifRevision: '0',
            title: 'Actual shared argv',
          }),
          '--data-root',
          f.dataRoot,
          '--server',
          f.endpoint.socket,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      try {
        const [code, out, err] = await limit(
          Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]),
        );
        expect(code).toBe(0);
        expect(err).toBe('');
        expect(out).toContain('"status":"applied"');
        expect((await f.client.getView('s')).session.title).toBe('Actual shared argv');
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGTERM');
          await child.exited;
        }
      }
      await f.alive();
      expect(f.reads()).toBe(0);
    } finally {
      await f.close();
    }
  },
  30000,
);

nativeTest(
  'shared compression and reset use original context selection and include remains an explicit result lookup',
  async () => {
    const f = await fixture();
    try {
      await f.session('s');
      await f.client.startRun('s', {
        expectedStoreId: f.storeId,
        commandId: 'compression-seed',
        kind: 'run.start',
        content: 'seed original messages',
      });
      const end = Date.now() + 5000;
      while ((await f.client.getView('s')).runs.some((run) => run.isActive)) {
        if (Date.now() > end) throw Error('seed_timeout');
        await Bun.sleep(5);
      }
      const selection = (await f.client.getView('s')).session.contextSelectionId;
      expect(
        await f.run({
          kind: 'context',
          action: 'compact',
          sessionId: 's',
          input: {
            expectedStoreId: f.storeId,
            commandId: 'compact-normal',
            expectedContextSelectionId: selection,
          },
        }),
      ).toBe(0);
      const context = await f.client.getContext('s', { storeId: f.storeId });
      expect(context.compression?.runId).toBeTruthy();
      expect(
        await f.run({
          kind: 'context',
          action: 'reset',
          sessionId: 's',
          input: {
            expectedStoreId: f.storeId,
            commandId: 'reset-normal',
            expectedContextSelectionId: selection,
            expectedCompressionId: context.compression!.id,
          },
        }),
      ).toBe(1);
      expect((await f.client.getContext('s', { storeId: f.storeId })).compression?.id).toBe(
        context.compression!.id,
      );
      expect(
        await f.run({
          kind: 'context',
          action: 'include',
          sessionId: 's',
          executionId: 'missing-result',
          input: {
            expectedStoreId: f.storeId,
            commandId: 'include-missing',
            expectedContextSelectionId: selection,
            resultRevision: '1',
          },
        }),
      ).toBe(1);
      expect(
        (await f.client.getView('s')).runs.filter(
          (run) => run.originCommandId === 'include-missing',
        ),
      ).toHaveLength(0);
      expect(f.reads()).toBe(0);
      await f.alive();
    } finally {
      await f.close();
    }
  },
  30000,
);

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BunStdioChild,
  type BunStdioChildSpawnOptions,
  KITE_APP_SERVER_PROTOCOL_METHODS_,
  kiteAppServerVersion,
} from '@kite-ai/kite-local-runtime/client';
import { createManagedLocalAppServerComposition } from '../../scripts/release/app-server-client';
import {
  sourceKiteSessionStorePath,
  sourceServiceBuildIdentity,
} from '../../scripts/release/local-service-client';

describe('release App Server client pairing', () => {
  test('source uses the checked-in entrypoint and persistent worktree profile', async () => {
    const root = realpathSync.native(
      mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-app-source-')),
    );
    const systemHome = join(root, 'home');
    const kiteHome = join(root, 'kite-home');
    const workspace = join(root, 'workspace');
    for (const path of [systemHome, workspace]) mkdirSync(path);
    const repositoryRoot = realpathSync.native(join(import.meta.dir, '../..'));
    const composition = createManagedLocalAppServerComposition({
      argv: ['kite-tui', '--kite-home', kiteHome],
      environment: { PATH: process.env.PATH },
      systemHome,
      repositoryRoot,
      executableMode: 'source',
    });
    const expectedBuild = sourceServiceBuildIdentity(repositoryRoot);
    expect(composition).toMatchObject({
      mode: 'source',
      buildId: expectedBuild,
      configRoot: kiteHome,
    });
    expect(join(composition.runtimeRoot, 'kite-session.sqlite')).toBe(
      sourceKiteSessionStorePath(kiteHome, repositoryRoot),
    );
    const client = composition.connect({
      workspace,
      clientInfo: { name: 'source-pairing', version: '1', instanceId: 'source-pairing-1' },
    });
    try {
      await client.connect();
      expect(client.runtime.snapshotStore.getSnapshot().status).toBe('active');
    } finally {
      await client[Symbol.asyncDispose]();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('installed pins the launcher-provided immutable candidate and exact build identity', async () => {
    const root = realpathSync.native(
      mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-app-installed-')),
    );
    try {
      const systemHome = join(root, 'home');
      const kiteHome = join(root, 'kite-home');
      const workspace = join(root, 'workspace');
      const installRoot = join(root, 'install');
      const manifest = Buffer.from('{"schema":"fixture"}\n');
      const candidateId = createHash('sha256').update(manifest).digest('hex').slice(0, 24);
      const candidateRoot = join(installRoot, 'releases', candidateId);
      const binRoot = join(candidateRoot, 'bin');
      for (const path of [systemHome, workspace, join(installRoot, 'bin'), binRoot]) {
        mkdirSync(path, { recursive: true });
      }
      const clientExecutable = join(binRoot, 'kite');
      const serviceExecutable = join(binRoot, 'kite-service');
      writeFileSync(clientExecutable, 'fixture');
      writeFileSync(serviceExecutable, 'fixture');
      writeFileSync(join(candidateRoot, 'manifest.json'), manifest);
      writeFileSync(join(candidateRoot, '.candidate-id'), `${candidateId}\n`);
      writeFileSync(join(installRoot, 'active'), `${candidateId}\n`);
      writeFileSync(
        join(installRoot, '.kite-code-managed.json'),
        JSON.stringify({
          schema: 'KiteCodeManagedInstall',
          version: 2,
          target: 'fixture',
          canonicalRoot: realpathSync.native(installRoot),
          currentCandidateId: candidateId,
          previousCandidateId: null,
          activePointer: 'active',
        }),
      );
      let spawned: BunStdioChildSpawnOptions | undefined;
      const composition = createManagedLocalAppServerComposition({
        argv: ['kite-tui', '--kite-home', kiteHome],
        environment: { KITE_CODE_RELEASE_ROOT: candidateRoot },
        systemHome,
        executableMode: 'installed',
        repositoryRoot: join(root, 'must-not-be-read'),
        processExecutable: clientExecutable,
        spawn: (options) => {
          spawned = options;
          return new InitializeChild(candidateId);
        },
      });
      expect(composition).toMatchObject({
        mode: 'installed',
        buildId: candidateId,
        runtimeRoot: kiteHome,
        configRoot: kiteHome,
      });
      const client = composition.connect({
        workspace,
        clientInfo: { name: 'installed-pairing', version: '1', instanceId: 'installed-pairing-1' },
      });
      await client.connect();
      expect(spawned?.argv).toEqual([serviceExecutable, 'app-server', 'run-stdio']);
      expect(spawned?.env.KITE_STANDALONE_EXECUTABLE).toBe('1');
      await client[Symbol.asyncDispose]();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

class InitializeChild implements BunStdioChild {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly stdin: BunStdioChild['stdin'];
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder();
  readonly #version: string;
  #stdout!: ReadableStreamDefaultController<Uint8Array>;
  #stderr!: ReadableStreamDefaultController<Uint8Array>;
  #resolveExit!: (value: number) => void;
  #closed = false;

  constructor(buildId: string) {
    this.#version = kiteAppServerVersion(buildId);
    this.stdout = new ReadableStream({ start: (controller) => (this.#stdout = controller) });
    this.stderr = new ReadableStream({ start: (controller) => (this.#stderr = controller) });
    this.exited = new Promise((resolve) => (this.#resolveExit = resolve));
    this.stdin = {
      write: (chunk) => this.#write(chunk),
      flush: () => undefined,
      end: () => this.#finish(),
    };
  }

  kill(): void {
    this.#finish();
  }

  #write(chunk: Uint8Array): void {
    const request = JSON.parse(this.#decoder.decode(chunk).trim()) as {
      id: string;
      method: string;
    };
    if (request.method !== 'initialize') throw new Error('Unexpected fixture request.');
    this.#stdout.enqueue(
      this.#encoder.encode(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: 1,
            protocolSchema: 'kite.runtime-protocol.v1',
            serverInfo: { version: this.#version, instanceId: 'installed-fixture' },
            capabilities: {
              methods: [
                'initialize',
                'runtime/command',
                'runtime/query',
                'runtime/subscribe',
                'runtime/unsubscribe',
                ...KITE_APP_SERVER_PROTOCOL_METHODS_,
                'server/ping',
              ],
              subscriptions: ['session', 'sessions'],
            },
            limits: {
              maxMessageBytes: 1_048_576,
              maxDepth: 32,
              maxInFlightRequests: 64,
              maxSubscriptions: 64,
              maxOutboundMessages: 256,
            },
          },
        })}\n`,
      ),
    );
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stdout.close();
    this.#stderr.close();
    this.#resolveExit(0);
  }
}

import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { selectProfile } from '@kite-ai/agent/profile';
import type { ModelOutputSnapshot } from '@kite-ai/client';
import { inspectProcess } from '@kite-ai/service/daemon';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { buildNativeCandidate } from '../../../apps/desktop/scripts/build-native';
import { readProcessStartIdentity } from '../../../apps/service/src/daemon/process-identity';
import { packNativeBundle, unpackNativeBundle } from '../../../scripts/release/native-archive';
import {
  installNativeBundle,
  rollbackNativeBundle,
  uninstallNativeBundle,
} from '../../../scripts/release/native-install';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';
import {
  materializeTerminalPredecessor,
  TERMINAL_PREDECESSOR_COMMIT,
} from '../../fixtures/unified-agent/terminal-predecessor';

const repositoryRoot = resolve(import.meta.dir, '../../..');
const sessionId = 'native-version-session';
const tasks = ['native-A-original', 'native-B-full-original', 'native-A-after-rollback'];
const bodies = [
  'ORIGINAL NATIVE A BODY',
  `B CURRENT FULL BODY\n${'二代🙂\n'.repeat(32000)}B EXACT ORIGINAL TAIL`,
  'NATIVE A AFTER ROLLBACK BODY',
];
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
type StoredFacts = {
  storeId: string;
  cursor: string;
  engine: { version: string; sourceId: string };
  runs: { id: string; status: string; originCommandId: string }[];
  commands: { id: string; status: string; originStoreId: string }[];
  messages: { id: string }[];
  executions: { id: string; kind: string }[];
  outputs: { identity: { executionId: string }; snapshotCursor: string }[];
};
async function execute(argv: string[], cwd: string, home: string, timeoutMs = 30000) {
  const child = Bun.spawn(argv, {
    cwd,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code)
      throw Error(
        `native_version_command_failed:${argv[1]}:${code}:${stderr.slice(-6000)}:${stdout.slice(-1000)}`,
      );
    return stdout;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}

test.skipIf(!['darwin', 'linux'].includes(process.platform))(
  'real Native code upgrade and cold rollback retain original complete data and continue through the installed window',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-versions-'))),
      home = join(root, 'home'),
      workspace = join(root, 'workspace'),
      prefix = join(root, 'installed');
    for (const path of [home, workspace]) mkdirSync(path, { mode: 0o700 });
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    const privatePath = join(profile.profilePath, 'desktop-private/data.sqlite'),
      configurationPath = join(profile.profilePath, 'config.jsonc');
    const requests: { task: string; contextHasB: boolean }[] = [],
      facts: StoredFacts[] = [];
    let activeIndex = 0,
      success = false,
      uninstalled = false;
    let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    let provider: ReturnType<typeof Bun.serve> | undefined;
    let preserved:
      | {
          core: Buffer<ArrayBuffer>;
          native: Buffer<ArrayBuffer>;
          config: Buffer<ArrayBuffer>;
          coreInode: number;
          nativeInode: number;
        }
      | undefined;
    try {
      const req = createRequire(join(repositoryRoot, 'apps/desktop/package.json')),
        electronPath = req('electron') as string,
        electronDist =
          process.platform === 'darwin'
            ? resolve(dirname(dirname(electronPath)), '../..')
            : dirname(electronPath);
      const predecessor = await materializeTerminalPredecessor({
        root,
        repositoryRoot,
        nativeElectronDist: electronDist,
      });
      const oldNative = predecessor.nativeCandidate!;
      expect(predecessor.provenance.commit).toBe(TERMINAL_PREDECESSOR_COMMIT);
      expect(predecessor.provenance.platform).toBe(process.platform);
      expect(predecessor.provenance.sourceRemoved).toBe(true);
      expect(existsSync(predecessor.provenance.sourceRoot)).toBe(false);
      expect(oldNative.terminal.manifest.source.commit).toBe(TERMINAL_PREDECESSOR_COMMIT);
      expect(oldNative.terminal.manifest.source.dirty).toBe(false);
      const currentHead = (
        await execute(['git', 'rev-parse', 'HEAD'], repositoryRoot, home)
      ).trim();
      const terminal = await buildTerminalBundle({
        destination: join(root, 'current-terminal'),
        repositoryRoot,
        bunExecutable: process.execPath,
      });
      const current = await buildNativeCandidate({
        terminalRoot: terminal.root,
        electronDist,
        outdir: join(root, 'current-native'),
      });
      expect(current.terminal.manifest.source.commit).toBe(currentHead);
      expect(currentHead).not.toBe(TERMINAL_PREDECESSOR_COMMIT);
      expect(current.terminal.manifest.productVersion).toBe(
        oldNative.terminal.manifest.productVersion,
      );
      expect(current.digest).not.toBe(oldNative.digest);
      expect(current.terminal.digest).not.toBe(oldNative.terminal.digest);
      const oldFiles = new Map(
        oldNative.terminal.manifest.files.map((file) => [file.path, file.sha256]),
      );
      const changedAgentFiles = current.terminal.manifest.files.filter(
        (file) =>
          file.path.startsWith('node_modules/@kite-ai/agent/') &&
          oldFiles.get(file.path) !== file.sha256,
      );
      expect(changedAgentFiles.length).toBeGreaterThan(0);
      const entrypointHashes = ['app/main.cjs', 'app/renderer.js'].map((path) => ({
        path,
        prior: hash(readFileSync(join(oldNative.root, path))),
        current: hash(readFileSync(join(current.root, path))),
      }));
      // Preserve both original macOS frontend-code assertions. The first admitted Linux
      // predecessor is newer: its real change is in the paired Agent, not a fabricated UI.
      if (process.platform === 'darwin')
        for (const entry of entrypointHashes) expect(entry.current).not.toBe(entry.prior);
      const candidates: ReturnType<typeof verifyNativeRuntimeBundle>[] = [];
      const archives: { candidateId: string; sha256: string }[] = [];
      for (const [name, source] of [
        ['old', oldNative.root],
        ['new', current.root],
      ] as const) {
        const packed = await packNativeBundle({
          bundleRoot: source,
          archivePath: join(root, `${name}.tar.gz`),
        });
        const unpacked = unpackNativeBundle({
          ...packed,
          destination: join(root, `${name}-unpacked`),
        });
        renameSync(unpacked.root, join(root, `${name}-relocated`));
        const relocated = verifyNativeRuntimeBundle(join(root, `${name}-relocated`));
        expect(relocated.digest).toBe(packed.candidateId);
        expect(hash(readFileSync(packed.archivePath))).toBe(packed.sha256);
        candidates.push(relocated);
        archives.push(packed);
        rmSync(source, { recursive: true });
        expect(existsSync(source)).toBe(false);
      }
      for (const source of [terminal.root, predecessor.candidate.root]) {
        rmSync(source, { recursive: true });
        expect(existsSync(source)).toBe(false);
      }
      const installed = [installNativeBundle({ bundleRoot: candidates[0]!.root, prefix })];
      const probe = await Bun.build({
        entrypoints: [
          join(repositoryRoot, 'tests/fixtures/unified-agent/native-cross-version-store.ts'),
        ],
        target: 'bun',
        packages: 'external',
        outdir: join(root, 'probe'),
        naming: 'store.js',
      });
      expect(probe.success).toBe(true);
      const probeHash = hash(readFileSync(join(root, 'probe/store.js')));
      async function store(operation: 'seed' | 'snapshot') {
        const releaseRoot = installed[activeIndex]!.releaseRoot,
          inner = join(releaseRoot, 'terminal');
        const link = join(root, 'probe/node_modules');
        rmSync(link, { force: true });
        symlinkSync(join(inner, 'node_modules'), link, 'dir');
        return JSON.parse(
          await execute(
            [
              join(inner, 'runtime/bun'),
              join(root, 'probe/store.js'),
              operation,
              profile.dataRoot,
              workspace,
              sessionId,
            ],
            workspace,
            home,
          ),
        ) as StoredFacts;
      }
      const originalStoreId = (await store('seed')).storeId;
      const preserve = () => ({
        core: readFileSync(profile.databasePath),
        native: readFileSync(privatePath),
        config: readFileSync(configurationPath),
        coreInode: lstatSync(profile.databasePath).ino,
        nativeInode: lstatSync(privatePath).ino,
      });
      const unchanged = (before: ReturnType<typeof preserve>) => {
        expect(readFileSync(profile.databasePath)).toEqual(before.core);
        expect(readFileSync(privatePath)).toEqual(before.native);
        expect(readFileSync(configurationPath)).toEqual(before.config);
        expect(lstatSync(profile.databasePath).ino).toBe(before.coreInode);
        expect(lstatSync(privatePath).ino).toBe(before.nativeInode);
      };
      provider = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const url = new URL(request.url),
            path = url.pathname;
          try {
            if (path === '/process') {
              const pid = Number(url.searchParams.get('pid'));
              const startIdentity = readProcessStartIdentity(pid);
              expect(startIdentity).toBeDefined();
              return Response.json({ pid, startIdentity });
            }
            if (path === '/snapshot') {
              const result = await store('snapshot');
              expect(result.storeId).toBe(originalStoreId);
              expect(result.engine.version).toBe(
                candidates[activeIndex]!.terminal.manifest.sqlite.version,
              );
              expect(result.engine.sourceId).toBe(
                candidates[activeIndex]!.terminal.manifest.sqlite.sourceId,
              );
              expect(result.runs).toHaveLength(requests.length);
              expect(
                result.commands.every(
                  (value) => value.status === 'applied' && value.originStoreId === originalStoreId,
                ),
              ).toBe(true);
              if (facts.length)
                for (const name of ['commands', 'runs', 'messages', 'executions'] as const)
                  for (const prior of facts.at(-1)![name])
                    expect(result[name].find((value) => value.id === prior.id)).toEqual(prior);
              // Stored output heads/segments retain the original scope/hash/ref, including unknown fields.
              if (facts.length)
                for (const prior of facts.at(-1)!.outputs) {
                  const saved = result.outputs.find(
                    (value) => value.identity.executionId === prior.identity.executionId,
                  )!;
                  expect(saved).toBeDefined();
                  expect({ ...saved, snapshotCursor: prior.snapshotCursor }).toEqual(prior);
                }
              facts.push(result);
              return Response.json({ ...result, providerCalls: requests.length });
            }
            if (path === '/upgrade') {
              const before = preserve();
              const next = installNativeBundle({ bundleRoot: candidates[1]!.root, prefix });
              installed.push(next);
              activeIndex = 1;
              unchanged(before);
              return Response.json(next);
            }
            if (path === '/rollback') {
              const before = preserve(),
                result = rollbackNativeBundle(prefix);
              activeIndex = result.candidateId === candidates[0]!.digest ? 0 : 1;
              unchanged(before);
              return Response.json(result);
            }
            if (path === '/locks')
              return Response.json(
                installed.map((value) => {
                  const held = { outer: false, inner: false };
                  for (const [key, path] of [
                    ['outer', value.releaseRoot],
                    ['inner', join(value.releaseRoot, 'terminal')],
                  ] as const) {
                    try {
                      const lease = acquireArtifactAccess({ root: path, mode: 'exclusive' });
                      lease.release();
                    } catch {
                      held[key] = true;
                    }
                  }
                  return held;
                }),
              );
            if (path === '/busy') {
              const before = readFileSync(join(prefix, 'active'));
              expect(() => uninstallNativeBundle(prefix)).toThrow(/busy/);
              expect(readFileSync(join(prefix, 'active'))).toEqual(before);
              expect(existsSync(prefix)).toBe(true);
              return Response.json({ blocked: true });
            }
            if (path === '/uninstall') {
              preserved = preserve();
              uninstallNativeBundle(prefix);
              unchanged(preserved);
              uninstalled = true;
              return Response.json({ removed: true });
            }
            const body = (await request.json()) as {
              messages: { role: string; content: unknown }[];
            };
            const text = (value: unknown): string =>
              typeof value === 'string'
                ? value
                : Array.isArray(value)
                  ? value.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
                  : '';
            const task = text(
                body.messages.filter((value) => value.role === 'user').at(-1)?.content,
              ),
              index = tasks.indexOf(task);
            expect(index).toBe(requests.length);
            expect(index).toBeGreaterThanOrEqual(0);
            requests.push({
              task,
              contextHasB: body.messages.some((value) => text(value.content) === bodies[1]),
            });
            const frame = (delta: unknown, reason: string | null) =>
              `data: ${JSON.stringify({ id: `owned-native-version-${index}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
            let response = '';
            for (let offset = 0; offset < bodies[index]!.length; offset += 16000)
              response += frame({ content: bodies[index]!.slice(offset, offset + 16000) }, null);
            return new Response(`${response}${frame({}, 'stop')}data: [DONE]\n\n`, {
              headers: { 'content-type': 'text/event-stream' },
            });
          } catch (error) {
            console.error(error);
            return new Response(String(error), { status: 500 });
          }
        },
      });
      writeFileSync(
        configurationPath,
        JSON.stringify({
          modelId: 'fixed',
          tools: [],
          models: [
            {
              id: 'fixed',
              provider: 'compatible',
              model: 'fixed',
              baseURL: `${provider.url.href}v1`,
            },
          ],
        }),
        { mode: 0o600 },
      );
      writeFileSync(
        join(home, 'expected.json'),
        JSON.stringify({
          storeId: originalStoreId,
          sessionId,
          candidates: candidates.map((value, index) => ({
            id: value.digest,
            root: index === 0 ? installed[0]!.releaseRoot : join(prefix, 'releases', value.digest),
            electron: value.manifest.entries.electron,
          })),
          tasks,
          bodies,
        }),
        { mode: 0o600 },
      );
      const compiled = await Bun.build({
        entrypoints: [
          join(repositoryRoot, 'apps/desktop/test/native-cross-version-electron.fixture.ts'),
        ],
        target: 'node',
        format: 'esm',
        packages: 'bundle',
        external: ['playwright'],
        outdir: root,
        naming: 'electron-driver.mjs',
      });
      expect(compiled.success).toBe(true);
      const driverHash = hash(readFileSync(join(root, 'electron-driver.mjs')));
      driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'electron-driver.mjs'),
          join(prefix, 'bin/kite-desktop'),
          home,
          provider.url.href.replace(/\/$/, ''),
          join(repositoryRoot, 'apps/desktop/package.json'),
        ],
        {
          cwd: home,
          env: {
            HOME: home,
            PATH: '/usr/bin:/bin',
            LANG: 'C.UTF-8',
            ...(process.platform === 'linux'
              ? { DISPLAY: process.env.DISPLAY ?? '', XAUTHORITY: process.env.XAUTHORITY ?? '' }
              : {}),
          },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const out = new Response(driver.stdout).text(),
        err = new Response(driver.stderr).text();
      const timer = setTimeout(() => driver!.kill('SIGTERM'), 120000);
      try {
        const code = await driver.exited,
          stdout = await out,
          stderr = await err;
        console.log(stdout);
        if (code) console.error(stderr);
        expect(code).toBe(0);
      } finally {
        clearTimeout(timer);
      }
      const report = JSON.parse(readFileSync(join(home, 'native-version-report.json'), 'utf8')) as {
        owned: { pid: number; startIdentity: string; root: string }[];
        phases: { instanceId: string; candidateId: string; outputs: ModelOutputSnapshot[] }[];
      };
      expect(report.owned).toHaveLength(4);
      expect(new Set(report.phases.map((value) => value.instanceId)).size).toBe(4);
      expect(report.phases.map((value) => value.candidateId)).toEqual([
        candidates[0]!.digest,
        candidates[1]!.digest,
        candidates[0]!.digest,
        candidates[1]!.digest,
      ]);
      expect(report.phases.map((value) => value.outputs.length)).toEqual([1, 2, 3, 3]);
      for (const [index, phase] of report.phases.entries()) {
        expect(phase.outputs.every((value) => value.storeId === originalStoreId)).toBe(true);
        if (index)
          for (const prior of report.phases[index - 1]!.outputs) {
            const saved = phase.outputs.find((value) => value.executionId === prior.executionId)!;
            expect({ ...saved, snapshotCursor: prior.snapshotCursor }).toEqual(prior);
          }
      }
      expect(requests).toHaveLength(3);
      expect(requests[2]!.contextHasB).toBe(true);
      expect(uninstalled).toBe(true);
      expect(existsSync(prefix)).toBe(false);
      expect(preserved).toBeDefined();
      unchanged(preserved!);
      for (const owned of report.owned)
        expect(inspectProcess(owned.pid, owned.startIdentity)).toBe('dead');
      for (const candidate of candidates)
        expect(verifyNativeRuntimeBundle(candidate.root).digest).toBe(candidate.digest);
      console.log(
        `NATIVE_REAL_CODE_COMPATIBILITY ${JSON.stringify({ prior: predecessor.provenance, current: current.terminal.manifest.source, changedAgentFiles: changedAgentFiles.map((file) => file.path), entrypointHashes, candidates: candidates.map((value) => ({ native: value.digest, terminal: value.terminal.digest })), archives, probeHash, driverHash, storeId: originalStoreId, commands: facts.at(-1)!.commands.map((value) => value.id), runs: facts.at(-1)!.runs.map((value) => value.id), fullBodyBytes: Buffer.byteLength(bodies[1]!), fullBodyHash: hash(bodies[1]!), requests, instances: report.phases.map((value) => value.instanceId), owned: report.owned, normalExits: 4, exclusiveAfterStops: true, coreAndNativeInodesRetained: true, dataRestored: false, cleanup: 'confirmed' })}`,
      );
      success = true;
    } finally {
      if (driver?.exitCode === null) {
        driver.kill('SIGKILL');
        await driver.exited;
      }
      provider?.stop(true);
      if (success) rmSync(root, { recursive: true });
      else console.log(`OWNED_NATIVE_VERSION_FAILURE_ROOT ${root}`);
    }
  },
  420000,
);

import { constants, Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
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
import { pathToFileURL } from 'node:url';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { CommandRecord } from '@kite-ai/agent/storage';
import type { Command, Execution, ModelOutputSnapshot } from '@kite-ai/client';
import { inspectProcess } from '@kite-ai/service/daemon';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { buildNativeCandidate } from '../../../apps/desktop/scripts/build-native';
import { readProcessStartIdentity } from '../../../apps/service/src/daemon/process-identity';
import { ownedUserConfiguration } from '../../../apps/service/test/fixtures/user-configuration-fixture';
import { packNativeBundle, unpackNativeBundle } from '../../../scripts/release/native-archive';
import {
  installNativeBundle,
  rollbackNativeBundle,
  uninstallNativeBundle,
} from '../../../scripts/release/native-install';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';
import { privateDirectory } from '../../fixtures/test-filesystem';
import {
  COMPATIBLE_TERMINAL_PREDECESSOR_COMMIT,
  materializeCompatibleTerminalPredecessor,
  materializeTerminalPredecessor,
  TERMINAL_PREDECESSOR_COMMIT,
} from '../../fixtures/unified-agent/terminal-predecessor';

const repositoryRoot = resolve(import.meta.dir, '../../..');
const sessionId = 'native-version-session';
const tasks = ['native-A-original', 'New task: native-B-full-original', 'native-A-after-rollback'];
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
  humanInputs: {
    publicCommand: CommandRecord | null;
    input: CommandRecord | null;
    decision: CommandRecord | null;
    business: CommandRecord | null;
  }[];
  messages: {
    id: string;
    role: string;
    runId: string | null;
    content: string;
    sourceIds?: string[];
  }[];
  persistedExecutions: { id: string; rowJson: string; rowBytes: number; rowSha256: string }[];
  persistedMessages: {
    id: string;
    sourceJson: string;
    sourceBytes: number;
    sourceSha256: string;
  }[];
  executions: Execution[];
  extensionCommands: Command[];
  outputs: { identity: { executionId: string }; snapshotCursor: string }[];
};
async function execute(argv: string[], cwd: string, home: string, timeoutMs = 30000) {
  const child = Bun.spawn(argv, {
    cwd,
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
    for (const path of [home, workspace]) privateDirectory(path);
    if (process.platform === 'darwin') {
      privateDirectory(`${workspace}-db8`);
      writeFileSync(join(`${workspace}-db8`, 'retained-project'), 'original DB8 project bytes');
    }
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    const privatePath = join(profile.profilePath, 'desktop-private/data.sqlite'),
      configurationPath = join(profile.profilePath, 'config.jsonc');
    const userConfiguration = ownedUserConfiguration(home);
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
    let db9CurrentPrivate: { bytes: Buffer<ArrayBuffer>; inode: number } | undefined;
    let db8Private:
      | { bytes: Buffer<ArrayBuffer>; inode: number; config: Buffer<ArrayBuffer> }
      | undefined;
    try {
      const req = createRequire(join(repositoryRoot, 'apps/desktop/package.json')),
        electronPath = req('electron') as string,
        electronDist =
          process.platform === 'darwin'
            ? resolve(dirname(dirname(electronPath)), '../..')
            : dirname(electronPath);
      const predecessor = await materializeCompatibleTerminalPredecessor({
        root,
        repositoryRoot,
        nativeElectronDist: electronDist,
      });
      const oldNative = predecessor.nativeCandidate!;
      expect(predecessor.provenance.commit).toBe(COMPATIBLE_TERMINAL_PREDECESSOR_COMMIT);
      expect(predecessor.provenance.platform).toBe(process.platform);
      expect(predecessor.provenance.sourceRemoved).toBe(true);
      expect(existsSync(predecessor.provenance.sourceRoot)).toBe(false);
      expect(oldNative.terminal.manifest.source.commit).toBe(
        COMPATIBLE_TERMINAL_PREDECESSOR_COMMIT,
      );
      expect(oldNative.terminal.manifest.source.dirty).toBe(false);
      const currentHead = (
        await execute(['git', 'rev-parse', 'HEAD'], repositoryRoot, home)
      ).trim();
      const terminal = await buildTerminalBundle({
        destination: join(root, 'current-terminal'),
        repositoryRoot,
        bunExecutable: process.execPath,
        ...(process.platform === 'darwin'
          ? { processHostFixture: 'native-extension-reference' as const }
          : {}),
      });
      const current = await buildNativeCandidate({
        testDiagnostics: true,
        terminalRoot: terminal.root,
        electronDist,
        outdir: join(root, 'current-native'),
      });
      expect(current.terminal.manifest.source.commit).toBe(currentHead);
      expect(currentHead).not.toBe(COMPATIBLE_TERMINAL_PREDECESSOR_COMMIT);
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
        expect(readFileSync(userConfiguration.path)).toEqual(before.config);
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
            if (path === '/db8-capture') {
              expect(readFileSync(privatePath).readUInt32BE(60)).toBe(8);
              db8Private = {
                bytes: readFileSync(privatePath),
                inode: lstatSync(privatePath).ino,
                config: readFileSync(configurationPath),
              };
              return Response.json({ version: 8 });
            }
            if (path === '/db9-current-private') {
              db9CurrentPrivate = {
                bytes: readFileSync(privatePath),
                inode: lstatSync(privatePath).ino,
              };
              return Response.json({ captured: true });
            }
            if (path === '/db9-private') {
              expect(db9CurrentPrivate).toBeDefined();
              expect(readFileSync(privatePath)).toEqual(db9CurrentPrivate!.bytes);
              expect(lstatSync(privatePath).ino).toBe(db9CurrentPrivate!.inode);
              return Response.json({ unchanged: true });
            }
            if (path === '/db8-private') {
              expect(db8Private).toBeDefined();
              expect(readFileSync(privatePath)).toEqual(db8Private!.bytes);
              expect(lstatSync(privatePath).ino).toBe(db8Private!.inode);
              expect(readFileSync(configurationPath)).toEqual(db8Private!.config);
              expect(readFileSync(join(`${workspace}-db8`, 'retained-project'), 'utf8')).toBe(
                'original DB8 project bytes',
              );
              return Response.json({ unchanged: true });
            }
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
              if (
                requests.length >= 2 &&
                result.runs.filter((run) => run.status === 'completed').length >= 2
              ) {
                const proof = result.humanInputs.find(
                  (entry) =>
                    (entry.publicCommand?.request as { content?: string } | undefined)?.content ===
                    tasks[1],
                );
                expect(proof).toBeDefined();
                const original = proof!.publicCommand!;
                const receipt = original.receipt as {
                  runId: string;
                  humanInputCommandId: string;
                  decisionCommandId: string;
                  businessCommandId: string;
                };
                expect(original).toMatchObject({
                  status: 'applied',
                  originStoreId: originalStoreId,
                  sessionId,
                });
                expect(receipt).toMatchObject({ outcome: 'human_input_applied' });
                expect(proof!.input).toMatchObject({
                  id: receipt.humanInputCommandId,
                  kind: 'human.input',
                  request: {
                    publicCommandId: original.id,
                    content: tasks[1],
                    originalRequest: original.request,
                  },
                  receipt: {
                    state: 'decided',
                    decisionCommandId: receipt.decisionCommandId,
                    businessCommandId: receipt.businessCommandId,
                  },
                });
                expect(proof!.decision).toMatchObject({
                  id: receipt.decisionCommandId,
                  kind: 'human.input.decision',
                  status: 'applied',
                  request: {
                    inputCommandId: proof!.input!.id,
                    inputDigest: proof!.input!.requestDigest,
                    proposal: { relation: 'independent_work', purpose: 'work' },
                  },
                  receipt: { businessCommandId: receipt.businessCommandId },
                });
                expect(proof!.business).toMatchObject({
                  id: receipt.businessCommandId,
                  status: 'applied',
                  rootWorkCommandId: original.id,
                  receipt: { runId: receipt.runId },
                });
                expect(result.runs.find((run) => run.id === receipt.runId)).toMatchObject({
                  originCommandId: receipt.businessCommandId,
                  status: 'completed',
                });
                const models = result.executions.filter(
                  (execution) => execution.kind === 'model' && execution.runId === receipt.runId,
                );
                expect(models).toHaveLength(1);
                const model = JSON.parse(
                  result.persistedExecutions.find((row) => row.id === models[0]!.id)!.rowJson,
                );
                expect(model).toMatchObject({
                  origin_command_id: receipt.businessCommandId,
                  root_work_command_id: original.id,
                  state: 'succeeded',
                });
                const user = result.messages.find(
                  (message) =>
                    message.role === 'user' &&
                    message.runId === receipt.runId &&
                    message.sourceIds?.includes(receipt.businessCommandId),
                );
                expect(user).toMatchObject({
                  content: tasks[1],
                  sourceIds: [receipt.businessCommandId],
                });
                expect(
                  JSON.parse(
                    result.persistedMessages.find((row) => row.id === user!.id)!.sourceJson,
                  ),
                ).toMatchObject({ content: tasks[1], sourceIds: [receipt.businessCommandId] });
              }
              expect(
                result.commands.every(
                  (value) => value.status === 'applied' && value.originStoreId === originalStoreId,
                ),
              ).toBe(true);
              if (facts.length)
                for (const name of ['commands', 'runs', 'messages', 'executions'] as const)
                  for (const prior of facts.at(-1)![name])
                    expect(result[name].find((value) => value.id === prior.id)).toEqual(prior);
              expect(result.persistedMessages).toHaveLength(result.messages.length);
              for (const row of result.persistedMessages) {
                expect(row.sourceBytes).toBe(Buffer.byteLength(row.sourceJson));
                expect(row.sourceSha256).toBe(hash(row.sourceJson));
              }
              if (facts.length)
                for (const prior of facts.at(-1)!.persistedMessages)
                  expect(result.persistedMessages.find((row) => row.id === prior.id)).toEqual(
                    prior,
                  );
              expect(result.persistedExecutions).toHaveLength(result.executions.length);
              for (const row of result.persistedExecutions) {
                expect(row.rowBytes).toBe(Buffer.byteLength(row.rowJson));
                expect(row.rowSha256).toBe(hash(row.rowJson));
              }
              if (facts.length)
                for (const prior of facts.at(-1)!.persistedExecutions)
                  expect(result.persistedExecutions.find((row) => row.id === prior.id)).toEqual(
                    prior,
                  );
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
                body.messages
                  .slice()
                  .reverse()
                  .find((value) => value.role === 'user' && tasks.includes(text(value.content)))
                  ?.content,
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
              modelCapabilities: { contextWindowTokens: 1_000_000 },
              baseURL: `${provider.url.href}v1`,
            },
          ],
        }),
        { mode: 0o600 },
      );
      // Keep both original Profile input and current user input for their respective real code.
      writeFileSync(userConfiguration.path, readFileSync(configurationPath), { mode: 0o600 });
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
        for (const line of stderr.split('\n'))
          if (line.startsWith('native_permission_attempt ')) console.error(line);
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
      for (const owned of report.owned)
        expect(inspectProcess(owned.pid, owned.startIdentity)).toBe('dead');
      for (const candidate of candidates)
        expect(verifyNativeRuntimeBundle(candidate.root).digest).toBe(candidate.digest);
      let db8Rollback: unknown;
      if (process.platform === 'darwin') {
        expect(db8Private!.bytes.readUInt32BE(60)).toBe(8);
        expect(readFileSync(privatePath).readUInt32BE(60)).toBe(9);
        db8Private = {
          bytes: readFileSync(privatePath),
          inode: lstatSync(privatePath).ino,
          config: readFileSync(configurationPath),
        };
        const backupRoot = join(root, 'db9-backup');
        const maintenance = JSON.parse(
          await execute(
            [
              join(prefix, 'bin/kite'),
              'maintenance',
              'backup',
              '--data-root',
              profile.dataRoot,
              '--profile',
              profile.profile,
              '--destination',
              backupRoot,
            ],
            home,
            home,
          ),
        );
        expect(maintenance.kind).toBe('offline_maintenance');
        expect(maintenance.status).toBe('verified');
        expect(maintenance.backup.manifest.version).toBe(18);
        expect(maintenance.backup.manifest.assets.desktopUi.format.userVersion).toBe(9);
        expect(maintenance.backup.manifest.source.storeId).toBe(originalStoreId);
        const inspection = JSON.parse(
          await execute(
            [join(prefix, 'bin/kite'), 'maintenance', 'inspect', maintenance.backup.directory],
            home,
            home,
          ),
        );
        expect(inspection.backup).toEqual(maintenance.backup);
        expect(readFileSync(privatePath)).toEqual(db8Private.bytes);
        expect(lstatSync(privatePath).ino).toBe(db8Private.inode);
        expect(readFileSync(configurationPath)).toEqual(db8Private.config);
        await execute(
          [
            realpathSync(Bun.which('node')!),
            join(root, 'electron-driver.mjs'),
            join(prefix, 'bin/kite-desktop'),
            home,
            provider.url.href.replace(/\/$/, ''),
            join(repositoryRoot, 'apps/desktop/package.json'),
            'compatible-cold',
          ],
          home,
          home,
          60000,
        );
        const report = JSON.parse(readFileSync(join(home, 'native-db8-report.json'), 'utf8')) as {
          owned: { pid: number; startIdentity: string; root: string }[];
          saved: { commandId: string; storeId: string; workspaceId: string };
          draft: { storeId: string; rootSessionId: string; content: string };
          applied: {
            receipt: {
              commandId: string;
              originStoreId: string;
              deletedSessions: number;
              outcome: string;
            };
          };
          oldPhysical: { method: string }[];
          physical: { method: string }[];
        };
        expect(report.owned).toHaveLength(2);
        for (const owned of report.owned)
          expect(inspectProcess(owned.pid, owned.startIdentity)).toBe('dead');
        expect(report.draft.storeId).toBe(originalStoreId);
        expect(report.draft.rootSessionId).toBe(sessionId);
        expect(typeof report.draft.content).toBe('string');
        expect(report.saved.storeId).toBe(originalStoreId);
        expect(report.applied.receipt).toMatchObject({
          commandId: report.saved.commandId,
          originStoreId: originalStoreId,
          deletedSessions: 0,
          outcome: 'workspace_removed',
        });
        expect(report.oldPhysical.every((row) => row.method === 'GET')).toBe(true);
        expect(report.physical.every((row) => row.method === 'GET')).toBe(true);
        expect(requests).toHaveLength(3);
        expect(readFileSync(join(`${workspace}-db8`, 'retained-project'), 'utf8')).toBe(
          'original DB8 project bytes',
        );
        db8Rollback = {
          compatiblePrivateFormatRead: 9,
          observedPriorPrivateFormatBeforeExtension: 8,
          maintenanceManifestVersion: 18,
          compatiblePrivateRead: report.draft,
          originalCommandId: report.saved.commandId,
          owned: report.owned,
          normalExits: 2,
          dataRestored: false,
          newProviderCalls: 0,
          originalPrivateBytesAndInodeRetainedBeforeLookup: true,
          currentVersionOriginalLookup: true,
          uninstalled: true,
        };
        console.log(`NATIVE_DB9_REAL_CODE_ROLLBACK ${JSON.stringify(db8Rollback)}`);
      }
      expect(uninstalled).toBe(true);
      expect(existsSync(prefix)).toBe(false);
      expect(preserved).toBeDefined();
      unchanged(preserved!);
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

test.skipIf(!['darwin', 'linux'].includes(process.platform))(
  'legacy installed Native rejects current Core schema and DB9 private originals without changing either owned Profile',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-legacy-rejection-')));
    let success = false;
    let provider: ReturnType<typeof Bun.serve> | undefined;
    try {
      const electronPath = createRequire(join(repositoryRoot, 'apps/desktop/package.json'))(
        'electron',
      ) as string;
      const predecessor = await materializeTerminalPredecessor({
        root,
        repositoryRoot,
        nativeElectronDist:
          process.platform === 'darwin'
            ? resolve(dirname(dirname(electronPath)), '../..')
            : dirname(electronPath),
      });
      const legacy = predecessor.nativeCandidate!;
      expect(predecessor.provenance.commit).toBe(TERMINAL_PREDECESSOR_COMMIT);
      expect(predecessor.provenance.sourceRemoved).toBe(true);
      expect(existsSync(predecessor.provenance.sourceRoot)).toBe(false);
      expect(legacy.terminal.manifest.source.commit).toBe(TERMINAL_PREDECESSOR_COMMIT);
      expect(legacy.terminal.manifest.source.dirty).toBe(false);
      const legacyMigration = join(
        legacy.terminal.root,
        'node_modules/@kite-ai/agent/storage/migrations',
      );
      expect(existsSync(join(legacyMigration, '0002-recovery-audit.sql'))).toBe(false);
      for (const [entry, target, naming, packages, external] of [
        [
          'tests/fixtures/unified-agent/native-cross-version-store.ts',
          'bun',
          'store.js',
          'external',
          [],
        ],
        [
          'apps/desktop/test/native-cross-version-electron.fixture.ts',
          'node',
          'electron-driver.mjs',
          'bundle',
          ['playwright'],
        ],
        [
          'apps/desktop/test/native-legacy-private.fixture.ts',
          'node',
          'private-driver.mjs',
          'bundle',
          [],
        ],
        [
          'apps/desktop/electron/profile-access-helper.ts',
          'bun',
          'profile-access.js',
          'bundle',
          [],
        ],
      ] as const) {
        expect(
          (
            await Bun.build({
              entrypoints: [join(repositoryRoot, entry)],
              target,
              packages,
              external: [...external],
              format: 'esm',
              outdir: root,
              naming,
            })
          ).success,
        ).toBe(true);
      }
      symlinkSync(join(legacy.terminal.root, 'node_modules'), join(root, 'node_modules'), 'dir');
      let providerCalls = 0;
      let currentLocks: () => { outer: boolean; inner: boolean }[] = () => [];
      let currentSnapshot: () => Promise<StoredFacts>;
      provider = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === '/process') {
            const pid = Number(url.searchParams.get('pid'));
            const startIdentity = readProcessStartIdentity(pid);
            if (!startIdentity) return new Response('owned process missing', { status: 409 });
            return Response.json({ pid, startIdentity });
          }
          if (url.pathname === '/locks') return Response.json(currentLocks());
          if (url.pathname === '/snapshot')
            return Response.json({ ...(await currentSnapshot()), providerCalls });
          providerCalls++;
          return new Response('legacy rejection must not call a Model', { status: 500 });
        },
      });
      const reports: unknown[] = [];
      for (const boundary of ['schema', 'private'] as const) {
        const caseRoot = join(root, boundary),
          home = join(caseRoot, 'home'),
          workspace = join(caseRoot, 'workspace');
        for (const path of [caseRoot, home, workspace, `${workspace}-db8`]) privateDirectory(path);
        const profile = selectProfile({
          dataRoot: join(home, '.kite-code/unified-agent'),
          profile: 'default',
        });
        const userConfiguration = ownedUserConfiguration(home);
        let storeId: string;
        if (boundary === 'schema') {
          const store = await openSqliteStore({
            dataRoot: profile.dataRoot,
            profile: profile.profile,
          });
          try {
            storeId = (await store.getMetadata()).storeId;
            await store.createWorkspace({
              expectedStoreId: storeId,
              id: 'native-version-workspace',
              name: 'Native versions',
              rootUri: pathToFileURL(workspace).href,
            });
            await store.createSession({
              expectedStoreId: storeId,
              subjectId: 'local-user',
              commandId: 'native-version-create',
              sessionId,
              workspaceId: 'native-version-workspace',
              title: 'Native real versions',
            });
          } finally {
            await store.close();
          }
        } else {
          const seeded = JSON.parse(
            await execute(
              [
                join(legacy.terminal.root, 'runtime/bun'),
                join(root, 'store.js'),
                'seed',
                profile.dataRoot,
                workspace,
                sessionId,
              ],
              workspace,
              home,
            ),
          ) as { storeId: string };
          storeId = seeded.storeId;
        }
        // The owned seed process has exited and checkpointed its WAL. Immutable URI
        // inspection cannot create sidecars for an otherwise read-only schema assertion.
        const wal = `${profile.databasePath}-wal`;
        expect(!existsSync(wal) || lstatSync(wal).size === 0).toBe(true);
        const databaseUri = new URL(pathToFileURL(profile.databasePath).href);
        databaseUri.searchParams.set('immutable', '1');
        const database = new Database(
          databaseUri.href,
          constants.SQLITE_OPEN_READONLY |
            constants.SQLITE_OPEN_URI |
            constants.SQLITE_OPEN_NOFOLLOW,
        );
        try {
          database.run('PRAGMA query_only=ON');
          expect(
            database
              .query<{ id: string }, []>('SELECT id FROM schema_migration ORDER BY id')
              .all()
              .map((row) => row.id),
          ).toEqual(
            boundary === 'schema' ? ['0001-baseline', '0002-recovery-audit'] : ['0001-baseline'],
          );
        } finally {
          database.close(true);
        }
        const prefix = join(caseRoot, 'installed');
        const installed = installNativeBundle({ bundleRoot: legacy.root, prefix });
        const configurationPath = join(profile.profilePath, 'config.jsonc');
        const configuration = JSON.stringify({
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
        });
        writeFileSync(configurationPath, configuration, { mode: 0o600 });
        writeFileSync(userConfiguration.path, configuration, { mode: 0o600 });
        const helperPath = join(root, 'profile-access.js');
        const produced = JSON.parse(
          await execute(
            [
              realpathSync(Bun.which('node')!),
              join(root, 'private-driver.mjs'),
              profile.profilePath,
              realpathSync(process.execPath),
              hash(readFileSync(process.execPath)),
              helperPath,
              hash(readFileSync(helperPath)),
              storeId,
              sessionId,
            ],
            home,
            home,
          ),
        ) as { privateVersion: number; dispatched: boolean };
        expect(produced).toEqual({ privateVersion: 9, dispatched: false });
        const privatePath = join(profile.profilePath, 'desktop-private/data.sqlite');
        expect(readFileSync(privatePath).readUInt32BE(60)).toBe(9);
        const protectedPaths = [
          profile.databasePath,
          privatePath,
          configurationPath,
          userConfiguration.path,
        ];
        const before = protectedPaths.map((path) => ({
          path,
          bytes: readFileSync(path),
          inode: lstatSync(path).ino,
        }));
        currentLocks = () => {
          const held = { outer: false, inner: false };
          for (const [key, path] of [
            ['outer', installed.releaseRoot],
            ['inner', join(installed.releaseRoot, 'terminal')],
          ] as const) {
            try {
              const lease = acquireArtifactAccess({ root: path, mode: 'exclusive' });
              lease.release();
            } catch {
              held[key] = true;
            }
          }
          return [held];
        };
        currentSnapshot = async () =>
          JSON.parse(
            await execute(
              [
                join(legacy.terminal.root, 'runtime/bun'),
                join(root, 'store.js'),
                'snapshot',
                profile.dataRoot,
                workspace,
                sessionId,
              ],
              workspace,
              home,
            ),
          ) as StoredFacts;
        writeFileSync(
          join(home, 'expected.json'),
          JSON.stringify({
            storeId,
            sessionId,
            candidates: [
              {
                id: legacy.digest,
                root: installed.releaseRoot,
                electron: legacy.manifest.entries.electron,
              },
            ],
            tasks: [],
            bodies: [],
          }),
          { mode: 0o600 },
        );
        await execute(
          [
            realpathSync(Bun.which('node')!),
            join(root, 'electron-driver.mjs'),
            join(prefix, 'bin/kite-desktop'),
            home,
            provider.url.href.replace(/\/$/, ''),
            join(repositoryRoot, 'apps/desktop/package.json'),
            `legacy-${boundary}`,
          ],
          home,
          home,
          45000,
        );
        const report = JSON.parse(
          readFileSync(join(home, 'native-legacy-report.json'), 'utf8'),
        ) as {
          error: string;
          owned?: { pid: number; startIdentity: string }[];
          electronPid?: number;
          servicePids?: number[];
          exit?: { code: number; signal: null };
          normalExits?: number;
        };
        expect(report.error).toBe(
          boundary === 'schema' ? 'required_capability_missing' : 'draft_storage_unavailable',
        );
        if (boundary === 'schema') {
          expect(typeof report.electronPid).toBe('number');
          expect(report.exit).toEqual({ code: 0, signal: null });
        } else {
          expect(report.owned).toHaveLength(1);
          expect(report.normalExits).toBe(1);
        }
        for (const process of report.owned ?? [])
          expect(inspectProcess(process.pid, process.startIdentity)).toBe('dead');
        for (const pid of [
          ...(report.servicePids ?? []),
          ...(report.electronPid ? [report.electronPid] : []),
        ])
          expect(() => process.kill(pid, 0)).toThrow();
        expect(providerCalls).toBe(0);
        expect(currentLocks()).toEqual([{ outer: false, inner: false }]);
        for (const value of before) {
          expect(readFileSync(value.path)).toEqual(value.bytes);
          expect(lstatSync(value.path).ino).toBe(value.inode);
        }
        uninstallNativeBundle(prefix);
        expect(existsSync(prefix)).toBe(false);
        for (const value of before) {
          expect(readFileSync(value.path)).toEqual(value.bytes);
          expect(lstatSync(value.path).ino).toBe(value.inode);
        }
        reports.push({
          boundary,
          sourcePrivateVersion: 9,
          report,
          originalBytesAndInodesRetained: true,
          dataRestored: false,
        });
      }
      console.log(
        `NATIVE_LEGACY_SAFE_REJECTION ${JSON.stringify({ prior: predecessor.provenance, producer: 'current public Store and Native PrivateData source owners', providerCalls, reports })}`,
      );
      success = true;
    } finally {
      provider?.stop(true);
      if (success) rmSync(root, { recursive: true });
      else console.log(`OWNED_NATIVE_LEGACY_FAILURE_ROOT ${root}`);
    }
  },
  300000,
);

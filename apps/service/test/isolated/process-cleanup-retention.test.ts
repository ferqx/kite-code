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
import { dirname, join, resolve } from 'node:path';
import { createProfileBackup } from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import {
  readDaemonReservation,
  requestDaemonBootstrap,
  selectDaemonEndpoint,
} from '../../src/daemon';

const repository = resolve(import.meta.dir, '../../../..');
const nativeTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let root: string, artifact: string, entry: string;
async function bounded<T>(work: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('retention_fixture_deadline')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function build(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  try {
    const [code, stdout, stderr] = await bounded(
      Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]),
      20000,
    );
    if (code !== 0) throw Error(`retention_build_failed:${stdout}\n${stderr}`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}
beforeAll(async () => {
  root = mkdtempSync('/private/tmp/kite-process-retention-');
  artifact = join(root, 'artifact');
  const modules = join(artifact, 'node_modules');
  const dependencies = new Map<string, Set<string>>();
  // Same complete public-manifest pattern as daemon-process: only output paths change.
  for (const directory of ['packages/agent', 'packages/ai', 'packages/client', 'apps/service']) {
    const source = join(repository, directory);
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      exports: Record<string, string>;
      scripts: { build: string };
      dependencies?: Record<string, string>;
    };
    const destination = join(modules, manifest.name);
    mkdirSync(destination, { recursive: true });
    for (const segment of manifest.scripts.build.split(/\s*&&\s*/)) {
      const words = segment.trim().split(/\s+/);
      if (words.shift() !== 'bun') throw Error('retention_manifest_unknown');
      const args = words.map((word) =>
        word === 'dist' || word === './dist'
          ? destination
          : word.replace(/^--outdir=(?:\.\/)?dist$/, `--outdir=${destination}`),
      );
      const out = args.indexOf('--outdir');
      if (out >= 0) args[out + 1] = destination;
      await build(args, source);
    }
    const exports = Object.fromEntries(
      Object.entries(manifest.exports).map(([key, value]) => [
        key,
        value.replace(/^\.\/src\//, './').replace(/\.ts$/, '.js'),
      ]),
    );
    writeFileSync(
      join(destination, 'package.json'),
      JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module', exports }),
    );
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const owners = dependencies.get(dependency) ?? new Set<string>();
      owners.add(source);
      dependencies.set(dependency, owners);
    }
    expect(existsSync(join(destination, 'src'))).toBe(false);
  }
  for (const [dependency, owners] of dependencies) {
    if (dependency.startsWith('@kite-ai/')) continue;
    const installed = [
      ...Array.from(owners, (owner) => join(owner, 'node_modules', dependency)),
      join(repository, 'node_modules', dependency),
    ].find(existsSync);
    if (!installed) throw Error(`retention_dependency_missing:${dependency}`);
    const target = join(modules, dependency);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(realpathSync(installed), target, 'dir');
  }
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, '../fixtures/process-cleanup-retention-child.ts')],
    target: 'bun',
    packages: 'external',
    outdir: artifact,
  });
  expect(result.success).toBe(true);
  entry = join(artifact, 'process-cleanup-retention-child.js');
}, 60000);
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
function selection(kind: string) {
  const directory = join(root, kind);
  mkdirSync(directory, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(directory, 'data'), profile: 'owned' });
  const web = join(directory, 'web');
  mkdirSync(web);
  const files = [
    ['/index.html', 'text/html; charset=utf-8', '<!doctype html><title>Fixture</title>'],
    ['/app.js', 'text/javascript; charset=utf-8', 'globalThis.fixture = true;'],
    ['/app.css', 'text/css; charset=utf-8', 'body{}'],
  ];
  const manifest = JSON.stringify(
    files.map(([path, mediaType, content]) => {
      writeFileSync(join(web, path!.slice(1)), content!);
      return { path, mediaType, size: Buffer.byteLength(content!), sha256: hash(content!) };
    }),
  );
  writeFileSync(join(web, 'manifest.json'), manifest);
  const retained = join(directory, 'retained.json'),
    models = join(directory, 'models');
  const startup = {
    profile: {
      dataRoot: profile.dataRoot,
      profile: profile.profile,
      profileAccessKey: profile.profileAccessKey,
    },
    instanceId: `retained-${kind}`,
    buildId: 'compiled-retention',
    token: 't'.repeat(64),
    hostConfiguration: { retained, models },
  };
  const input = {
    operation: 'start',
    startup,
    workspace: directory,
    socket: join(directory, 'd.sock'),
    web: { directory: web, manifestSha256: hash(manifest) },
  };
  const identity = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const endpoint = selectDaemonEndpoint({
    profileAccessKey: profile.profileAccessKey,
    explicitSocket: input.socket,
  });
  return { directory, profile, retained, models, startup, input, identity, endpoint };
}
function spawn(kind: string, input: unknown) {
  const child = Bun.spawn([process.execPath, entry, kind], {
    cwd: artifact,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(`${JSON.stringify(input)}\n`);
  child.stdin.end();
  return child;
}
for (const kind of ['paired', 'daemon'])
  nativeTest(
    `${kind} compiled runner retains real failed owners after all parent pipes close; SIGKILL is fixture cleanup only`,
    async () => {
      const value = selection(kind);
      const child = spawn(kind, kind === 'paired' ? value.startup : value.input);
      const stdout = child.stdout.getReader(),
        stderr = child.stderr.getReader();
      const noBootstrap = stdout.read();
      let pipesClosed = false;
      try {
        let diagnostics = '';
        while (!diagnostics.includes('\n')) {
          const chunk = await bounded(stderr.read());
          if (chunk.done) throw Error('retention_missing_diagnostic');
          diagnostics += new TextDecoder().decode(chunk.value);
          if (Buffer.byteLength(diagnostics) > 4096) throw Error('retention_diagnostic_too_large');
        }
        expect(JSON.parse(diagnostics.trim())).toEqual({
          code: 'process_service_cleanup_unconfirmed',
          phase: 'http_assembly',
        });
        expect(diagnostics).not.toContain('fixture_private');
        expect(diagnostics).not.toContain(value.startup.token);
        await stdout.cancel();
        expect(await noBootstrap).toEqual({ value: undefined, done: true });
        await stderr.cancel();
        stdout.releaseLock();
        stderr.releaseLock();
        pipesClosed = true;
        // Actual EOF plus closed stdout/stderr: neither a parent pipe nor a pending read holds it.
        await Bun.sleep(100);
        expect(child.exitCode).toBeNull();
        expect(process.kill(child.pid, 0)).toBe(true);
        expect(existsSync(value.retained)).toBe(true);
        const metadata = JSON.parse(readFileSync(value.retained, 'utf8')) as { storeId: string };
        expect(metadata.storeId).toBeString();
        expect(
          await createProfileBackup({
            profile: value.profile,
            destinationRoot: join(value.directory, 'backup'),
          }).catch((error) => error),
        ).toMatchObject({ code: 'owner_busy' });
        expect(existsSync(join(value.directory, 'backup'))).toBe(false);
        const db = new Database(value.profile.databasePath, { readonly: true });
        try {
          for (const table of ['workspace', 'run', 'execution'])
            expect(db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        } finally {
          db.close();
        }
        expect(existsSync(value.models)).toBe(false);
        if (kind === 'daemon') {
          const reservation = readDaemonReservation(value.endpoint);
          expect(reservation).toMatchObject({
            pid: child.pid,
            profile: value.identity,
            instanceId: value.startup.instanceId,
            buildId: value.startup.buildId,
            workspace: value.directory,
          });
          expect(reservation).not.toHaveProperty('socket');
          const bytes = readFileSync(value.endpoint.record);
          expect(
            await requestDaemonBootstrap(value.endpoint, value.identity).catch((error) => error),
          ).toMatchObject({ code: 'daemon_not_ready' });
          expect(existsSync(value.endpoint.socket)).toBe(false);
          const competitor = spawn('daemon', value.input);
          try {
            const [code, output, errors] = await bounded(
              Promise.all([
                competitor.exited,
                new Response(competitor.stdout).text(),
                new Response(competitor.stderr).text(),
              ]),
            );
            expect(code).toBe(1);
            expect(output).toBe('');
            expect(JSON.parse(errors.trim())).toEqual({ code: 'daemon_endpoint_busy' });
          } finally {
            if (competitor.exitCode === null) {
              competitor.kill('SIGKILL');
              await competitor.exited;
            }
          }
          expect(readFileSync(value.endpoint.record)).toEqual(bytes);
          expect(readDaemonReservation(value.endpoint)).toEqual(reservation);
        }
        expect(child.exitCode).toBeNull();
        expect(process.kill(child.pid, 0)).toBe(true);
      } finally {
        // Owned failed fixture only. This does not claim successful drain or safe external Job stop.
        if (child.exitCode === null) child.kill('SIGKILL');
        await bounded(child.exited);
        if (!pipesClosed) {
          await stdout.cancel();
          await stderr.cancel();
          stdout.releaseLock();
          stderr.releaseLock();
        }
      }
    },
    15000,
  );

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
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';

const repository = resolve(import.meta.dir, '../../../..');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let root: string, artifact: string;
let entries: Record<'paired' | 'daemon', string>;
async function bounded<T>(work: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('startup_frame_fixture_deadline')), ms);
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
    if (code !== 0) throw Error(`startup_frame_build_failed:${stdout}\n${stderr}`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}
beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-startup-frame-')));
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
      if (words.shift() !== 'bun') throw Error('startup_frame_manifest_unknown');
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
    if (!installed) throw Error(`startup_frame_dependency_missing:${dependency}`);
    const target = join(modules, dependency);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(realpathSync(installed), target, 'dir');
  }
  const require = createRequire(join(artifact, 'selected-public-entry.cjs'));
  entries = {
    paired: require.resolve('@kite-ai/service/main'),
    daemon: require.resolve('@kite-ai/service/daemon-main'),
  };
  for (const entry of Object.values(entries)) expect(entry.startsWith(artifact)).toBe(true);
}, 60000);
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
for (const kind of ['paired', 'daemon'] as const)
  test(`compiled ${kind} rejects incomplete UTF-8 after the startup LF before any profile files exist`, async () => {
    // Valid prefixes for 2-, 3-, and 4-byte code points were formerly held silently by the decoder.
    for (const [index, suffix] of [[0xc2], [0xe2, 0x82], [0xf0, 0x9f, 0x92]].entries()) {
      const directory = join(root, `${kind}-${index}`);
      mkdirSync(directory, { mode: 0o700 });
      const profile = selectProfile({ dataRoot: join(directory, 'data'), profile: 'owned' });
      const startup = {
        profile: {
          dataRoot: profile.dataRoot,
          profile: profile.profile,
          profileAccessKey: profile.profileAccessKey,
        },
        instanceId: 'raw-frame',
        buildId: 'compiled-frame',
        token: 't'.repeat(64),
      };
      let input: unknown = startup;
      if (kind === 'daemon') {
        // Supply valid selected assets: an invalid asset must not mask acceptance of a bad frame.
        const web = join(directory, 'web');
        mkdirSync(web);
        const files = [
          ['/index.html', 'text/html; charset=utf-8', '<!doctype html><title>Frame</title>'],
          ['/app.js', 'text/javascript; charset=utf-8', 'void 0;'],
          ['/app.css', 'text/css; charset=utf-8', 'body{}'],
        ];
        const manifest = JSON.stringify(
          files.map(([path, mediaType, content]) => {
            writeFileSync(join(web, path!.slice(1)), content!);
            return { path, mediaType, size: Buffer.byteLength(content!), sha256: hash(content!) };
          }),
        );
        writeFileSync(join(web, 'manifest.json'), manifest);
        input = {
          operation: 'preflight',
          startup,
          workspace: directory,
          web: { directory: web, manifestSha256: hash(manifest) },
        };
      }
      const child = Bun.spawn([process.execPath, entries[kind]], {
        cwd: artifact,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      try {
        // One actual private frame write, including bytes the streaming decoder cannot yet emit.
        child.stdin.write(
          Buffer.concat([Buffer.from(`${JSON.stringify(input)}\n`), Buffer.from(suffix)]),
        );
        child.stdin.end();
        const [code, stdout, stderr] = await bounded(
          Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]),
        );
        expect(code).toBe(1);
        expect(stdout).toBe('');
        expect(JSON.parse(stderr.trim())).toEqual({
          code: kind === 'paired' ? 'service_process_failed' : 'daemon_process_failed',
        });
        expect(stderr).not.toContain(startup.token);
        expect(existsSync(profile.dataRoot)).toBe(false);
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          await child.exited;
        }
      }
    }
  }, 15000);

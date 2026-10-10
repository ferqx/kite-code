import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { CLI_REGISTRATION_FILE, readCLIRegistration } from '../../apps/cli/host/cli-registration';
import {
  type TerminalBundleManifest,
  terminalBundleEntries,
  type VerifiedTerminalBundle,
  verifyTerminalBundle,
} from '../../apps/cli/host/terminal-artifact';
import { createTrustedAssets } from '../../apps/web/src/assets';
import { acquireArtifactAccess } from '../../packages/agent/src/artifact-access';
import { acquireFileLock } from '../../packages/agent/src/platform/locks';
import { retainWindowsArtifactScope } from '../../packages/agent/src/platform/windows-artifact-scope';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
} from '../../packages/agent/src/platform/windows-path-security';
import { desktopBundledDependencies } from '../../packages/ui/scripts/bundled-dependencies';
import {
  buildWindowsTerminalLauncher,
  copyWindowsSystemExecutable,
} from './build-windows-terminal-launcher';
import { buildTerminalSqliteEngine } from './sqlite-engine';
import { copyTerminalDependencies } from './terminal-dependencies';
import { rejectBundleOutput } from './terminal-paths';
import {
  installWindowsTerminalBundle,
  rollbackWindowsTerminalBundle,
  uninstallWindowsTerminalBundle,
} from './windows-terminal-install';

export { verifyTerminalBundle };

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const workspaces = [
  'packages/ai',
  'packages/agent',
  'packages/client',
  'packages/ui',
  'apps/service',
  'apps/cli',
];
type Package = {
  name: string;
  version: string;
  exports: Record<string, string>;
  scripts: { build: string };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
function error(code: string): never {
  throw Error(`terminal_${code}`);
}
function ownedDirectory(path: string) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) ||
    (process.getuid && stat.uid !== process.getuid())
  )
    error('directory_unsafe');
  if (process.platform === 'win32') {
    const scope = retainWindowsArtifactScope(path);
    scope.verify();
    scope.release();
  }
}
async function run(executable: string, args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn([executable, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? '', LANG: 'en_US.UTF-8' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw Error(`terminal_build_failed:${args[0]}:${stderr.slice(-4000)}`);
  return stdout.trim();
}
function copyTree(source: string, destination: string) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), destination);
    return;
  }
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(source).sort())
      copyTree(join(source, entry), join(destination, entry));
  } else if (stat.isFile()) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination);
    chmodSync(destination, stat.mode & 0o111 ? 0o755 : 0o644);
  } else error('file_unsupported');
}
function verifyBundledDependencies(root: string, names: readonly string[]): void {
  if (!names.length) return;
  const scanner = new Bun.Transpiler({ loader: 'js' });
  const walk = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name));
    } else if (stat.isFile() && path.endsWith('.js')) {
      for (const item of scanner.scanImports(readFileSync(path)))
        if (names.some((name) => item.path === name || item.path.startsWith(`${name}/`)))
          error('bundled_dependency_external');
    }
  };
  walk(root);
}
function syncTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) for (const name of readdirSync(path)) syncTree(join(path, name));
  const fd = openSync(path, constants.O_RDONLY | (stat.isDirectory() ? constants.O_DIRECTORY : 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function createInstallDirectory(path: string): void {
  if (existsSync(path)) return;
  createInstallDirectory(dirname(path));
  mkdirSync(path, { mode: 0o700 });
  syncDirectory(dirname(path));
}
function inventory(root: string) {
  const files: TerminalBundleManifest['files'][number][] = [],
    links: TerminalBundleManifest['links'][number][] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name),
        item = relative(root, path).split(sep).join('/'),
        stat = lstatSync(path);
      if (stat.isSymbolicLink()) links.push({ path: item, target: readlinkSync(path) });
      else if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        const mode =
          process.platform === 'win32'
            ? path.endsWith('.exe')
              ? 493
              : 420
            : stat.mode & 0o111
              ? 493
              : 420;
        chmodSync(path, mode);
        const bytes = readFileSync(path);
        files.push({ path: item, size: bytes.length, sha256: sha(bytes), mode });
      } else error('file_unsupported');
    }
  };
  walk(root);
  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    links: links.sort((a, b) => a.path.localeCompare(b.path)),
  };
}
/** Build a closed, relocatable native terminal bundle using only locked installed dependencies. */
export async function buildTerminalBundle(input: {
  destination: string;
  repositoryRoot?: string;
  bunExecutable?: string;
  sqliteLibrary?: string;
  /** Fixed test composition, baked before fingerprinting; production callers leave this absent. */
  processHostFixture?: 'native-mcp-loopback' | 'native-extension-reference';
  /** Public certificate only, embedded in that fixture and therefore in the candidate digest. */
  processHostFixtureCertificate?: string;
}): Promise<VerifiedTerminalBundle> {
  const repository = realpathSync(input.repositoryRoot ?? resolve(import.meta.dir, '../..'));
  if (
    input.processHostFixture !== undefined &&
    !['native-mcp-loopback', 'native-extension-reference'].includes(input.processHostFixture)
  )
    error('process_fixture_invalid');
  if (
    input.processHostFixtureCertificate !== undefined &&
    (input.processHostFixture !== 'native-mcp-loopback' ||
      typeof input.processHostFixtureCertificate !== 'string' ||
      Buffer.byteLength(input.processHostFixtureCertificate) > 16384 ||
      !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(
        input.processHostFixtureCertificate,
      ))
  )
    error('process_fixture_certificate_invalid');
  const destination = resolve(input.destination);
  if (existsSync(destination)) error('destination_exists');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  ownedDirectory(realpathSync(dirname(destination)));
  const runtime = realpathSync(input.bunExecutable ?? process.execPath);
  const bunVersion = await run(runtime, ['--version'], repository);
  if (bunVersion !== Bun.version) error('runtime_version_mismatch');
  if (process.platform === 'win32') privateDirectory(destination);
  else mkdirSync(destination, { mode: 0o700 });
  try {
    const root = realpathSync(destination),
      entries = terminalBundleEntries(process.platform);
    const packages = workspaces.map((source) => {
      const path = join(repository, source),
        manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as Package;
      return {
        name: manifest.name,
        source: path,
        destination: join(root, 'node_modules', manifest.name),
        manifest,
        bundledDependencies: manifest.name === '@kite-ai/ui' ? desktopBundledDependencies : [],
      };
    });
    for (const item of packages) {
      mkdirSync(item.destination, { recursive: true, mode: 0o700 });
      for (const segment of item.manifest.scripts.build.split(/\s*&&\s*/)) {
        const words = segment.trim().split(/\s+/);
        if (words.shift() !== 'bun') error('build_script_unsupported');
        const args = words.map((word) =>
          word === 'dist' || word === './dist'
            ? item.destination
            : word.replace(/^--outdir=(?:\.\/)?dist(?=\/|$)/, `--outdir=${item.destination}`),
        );
        await run(runtime, args, item.source);
      }
      verifyBundledDependencies(item.destination, item.bundledDependencies);
      const exports = Object.fromEntries(
        Object.entries(item.manifest.exports).map(([key, path]) => {
          if (typeof path !== 'string') error('workspace_export_unsupported');
          const built = (
            item.name === '@kite-ai/cli' ? path : path.replace(/^\.\/src\//, './')
          ).replace(/\.tsx?$/, '.js');
          if (!existsSync(join(item.destination, built))) error('workspace_export_missing');
          return [key, built];
        }),
      );
      writeFileSync(
        join(item.destination, 'package.json'),
        JSON.stringify(
          {
            name: item.name,
            version: item.manifest.version,
            type: 'module',
            exports,
            dependencies: item.manifest.dependencies
              ? Object.fromEntries(
                  Object.entries(item.manifest.dependencies).filter(
                    ([name]) => !item.bundledDependencies.includes(name),
                  ),
                )
              : undefined,
            peerDependencies: item.manifest.peerDependencies,
            optionalDependencies: item.manifest.optionalDependencies,
          },
          null,
          2,
        ) + '\n',
      );
    }
    // Standalone Service lifetimes outlive the launching CLI and retain the same candidate.
    for (const [entry, run] of [
      ['main', 'runServiceProcess'],
      ['daemon-main', 'runDaemonProcess'],
    ] as const) {
      const folder = join(root, 'node_modules/@kite-ai/service');
      renameSync(join(folder, `${entry}.js`), join(folder, `${entry}-implementation.js`));
      const fixture = entry === 'main' ? input.processHostFixture : undefined;
      const fixtureEntry =
        fixture === 'native-mcp-loopback'
          ? 'main-native-mcp-fixture'
          : 'main-native-extension-fixture';
      if (fixture) {
        const built = await Bun.build({
          entrypoints: [
            join(
              repository,
              fixture === 'native-mcp-loopback'
                ? 'apps/service/test/native-mcp-process.fixture.ts'
                : 'tests/fixtures/unified-agent/native-extension-process.ts',
            ),
          ],
          target: 'bun',
          packages: 'external',
          outdir: folder,
          naming: `${fixtureEntry}.js`,
          define: {
            __NATIVE_MCP_FIXTURE_CERTIFICATE__: JSON.stringify(
              input.processHostFixtureCertificate ?? '',
            ),
          },
          plugins: [
            {
              name: 'native-reference-default-process',
              setup(build) {
                build.onResolve({ filter: /^@kite-ai\/service\/main$/ }, () => ({
                  path: './main-implementation.js',
                  external: true,
                }));
              },
            },
          ],
        });
        if (!built.success)
          throw new AggregateError(built.logs, 'terminal_process_fixture_build_failed');
      }
      writeFileSync(
        join(folder, `${entry}.js`),
        `import {resolve} from 'node:path';
import {acquireArtifactAccess} from '@kite-ai/agent/artifact-access';
import {${run}} from './${fixture ? fixtureEntry : `${entry}-implementation`}.js';
export {${run}};
if(import.meta.main){const lease=acquireArtifactAccess({root:resolve(import.meta.dir,'../../..'),mode:'shared'});try{await ${run}();}finally{lease.release();}}
`,
      );
    }
    copyTerminalDependencies({
      repositoryRoot: repository,
      destination: join(root, 'node_modules'),
      workspacePackages: packages,
      ...(process.platform === 'win32' ? { dependencyLayout: 'materialized' as const } : {}),
    });
    if (process.platform === 'win32') {
      privateDirectory(join(root, 'runtime'));
      copyWindowsSystemExecutable(runtime, join(root, entries.runtime));
      defaultWindowsPathSecurity()!.writePrivateFile(
        join(root, 'runtime/windows-bunfig.toml'),
        Buffer.from('preload = []\n'),
      );
      defaultWindowsPathSecurity()!.writePrivateFile(
        join(root, 'runtime/windows-tsconfig.json'),
        Buffer.from('{"compilerOptions":{"paths":{}}}\n'),
      );
    } else {
      mkdirSync(join(root, 'runtime'), { mode: 0o700 });
      copyFileSync(runtime, join(root, entries.runtime));
    }
    chmodSync(join(root, entries.runtime), 0o755);
    const sqlite = await buildTerminalSqliteEngine({
      root,
      executable: join(root, entries.runtime),
      ...(input.sqliteLibrary ? { library: input.sqliteLibrary } : {}),
    });
    mkdirSync(join(root, 'entrypoints'), { mode: 0o700 });
    for (const name of ['cli', 'tui']) {
      const build = await Bun.build({
        entrypoints: [join(repository, `scripts/release/entrypoints/terminal-${name}.ts`)],
        target: 'bun',
        packages: 'external',
        outdir: join(root, 'entrypoints'),
        naming: `${name}.js`,
      });
      if (!build.success) throw new AggregateError(build.logs, 'terminal_entrypoint_build_failed');
    }
    for (const name of ['standard-cli', 'standard-tui', 'native-cli', 'native-tui']) {
      const build = await Bun.build({
        entrypoints: [join(repository, `scripts/release/entrypoints/${name}.ts`)],
        target: 'bun',
        packages: 'external',
        outdir: join(root, 'entrypoints'),
        naming: `${name}.js`,
      });
      if (!build.success) throw new AggregateError(build.logs, 'terminal_entrypoint_build_failed');
    }
    if (process.platform === 'win32') {
      const folder = join(root, 'windows-frontdoor');
      privateDirectory(folder);
      const verifierPath = join(folder, 'terminal-verifier.exe');
      const compileRoot = join(root, `.windows-verifier-${randomUUID()}`);
      privateDirectory(compileRoot);
      const compiledPath = join(compileRoot, 'terminal-verifier.exe');
      const compiled = await Bun.build({
        entrypoints: [join(repository, 'scripts/release/entrypoints/windows-terminal-verifier.ts')],
        target: 'bun',
        packages: 'bundle',
        compile: {
          executablePath: runtime,
          outfile: compiledPath,
          autoloadDotenv: false,
          autoloadBunfig: false,
          autoloadTsconfig: false,
          autoloadPackageJson: false,
        },
      });
      if (!compiled.success)
        throw new AggregateError(compiled.logs, 'terminal_windows_verifier_build_failed');
      copyWindowsSystemExecutable(compiledPath, verifierPath);
      rmSync(compileRoot, { recursive: true, force: false });
      const bytes = readFileSync(verifierPath);
      const launchers = await buildWindowsTerminalLauncher({
        outdir: join(root, `.windows-launcher-${randomUUID()}`),
        verifierPath,
        verifierSha256: sha(bytes),
        verifierSize: bytes.length,
      });
      for (const name of launchers.launchers)
        defaultWindowsPathSecurity()!.copyPrivateFile(
          join(launchers.root, name),
          join(folder, name),
        );
      rmSync(launchers.root, { recursive: true, force: false });
    }
    const web = await Bun.build({
      entrypoints: [join(repository, 'apps/web/src/browser.tsx')],
      target: 'browser',
      format: 'esm',
      minify: true,
      splitting: false,
    });
    if (!web.success || web.outputs.length !== 1) throw Error('terminal_web_build_failed');
    const { assets, manifest: webManifest } = await createTrustedAssets(
      await web.outputs[0]!.text(),
    );
    mkdirSync(join(root, 'web'), { mode: 0o700 });
    for (const [path, asset] of assets)
      writeFileSync(join(root, 'web', path.slice(1)), asset.content);
    writeFileSync(join(root, 'web/manifest.json'), JSON.stringify(webManifest, null, 2));
    if (existsSync(join(repository, 'LICENSE')))
      copyFileSync(join(repository, 'LICENSE'), join(root, 'LICENSE'));
    const source = {
      commit: await run('git', ['rev-parse', 'HEAD'], repository),
      dirty: !!(await run('git', ['status', '--porcelain'], repository)),
    };
    const productVersion = (
      JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { version: string }
    ).version;
    const manifest: TerminalBundleManifest = {
      version: 1,
      apiMajor: 1,
      target: { platform: process.platform, arch: process.arch },
      bunVersion,
      sqlite,
      productVersion,
      source,
      entries,
      ...inventory(root),
    };
    writeFileSync(join(root, 'terminal-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
      mode: 0o644,
    });
    return verifyTerminalBundle(root);
  } catch (cause) {
    rmSync(destination, { recursive: true, force: true });
    throw cause;
  }
}

const markerName = '.kite-terminal-install.json';
const candidatePattern = /^[a-f0-9]{64}$/;
function durable(path: string, contents: string, mode = 0o600) {
  const temporary = join(dirname(path), `.publish-${randomUUID()}`);
  try {
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    try {
      fchmodSync(fd, mode);
      writeFileSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}
function installed(root: string) {
  ownedDirectory(root);
  privateRegular(join(root, markerName));
  const value = JSON.parse(readFileSync(join(root, markerName), 'utf8')) as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !== 'root,version' ||
    value.version !== 1 ||
    value.root !== root
  )
    error('install_identity_mismatch');
}
function privateRegular(path: string) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o022) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    error('install_file_unsafe');
}
function active(root: string): { current: string; previous: string | null } | undefined {
  const path = join(root, 'active');
  if (!existsSync(path)) return undefined;
  privateRegular(path);
  const bytes = readFileSync(path, 'utf8'),
    lines = bytes.split('\n');
  if (
    lines.length !== 3 ||
    lines[2] !== '' ||
    !candidatePattern.test(lines[0]!) ||
    (lines[1] !== '' && !candidatePattern.test(lines[1]!))
  )
    error('active_invalid');
  return { current: lines[0]!, previous: lines[1] || null };
}
function launcher(name: 'cli' | 'tui') {
  return `#!/bin/sh\nset -eu\nunset NODE_PATH NODE_OPTIONS BUN_OPTIONS ELECTRON_RUN_AS_NODE\nroot=$(CDPATH= cd -P -- "\${0%/*}/.." && pwd)\nIFS= read -r candidate < "$root/active"\ncase "$candidate" in ''|*[!0-9a-f]*) echo terminal_active_invalid >&2; exit 1;; esac\n[ "\${#candidate}" -eq 64 ] || exit 1\nexec "$root/releases/$candidate/runtime/bun" "$root/releases/$candidate/entrypoints/standard-${name}.js" "$@"\n`;
}
export interface InstalledTerminalBundle {
  root: string;
  candidateId: string;
  releaseRoot: string;
  previousCandidateId: string | null;
}
/** Separate immutable candidate publication; no application data path is accepted by this owner. */
export function installTerminalBundle(input: {
  bundleRoot: string;
  prefix: string;
}): InstalledTerminalBundle {
  if (process.platform === 'win32') return installWindowsTerminalBundle(input);
  if (!['darwin', 'linux'].includes(process.platform)) error('install_platform_unsupported');
  const bundle = verifyTerminalBundle(input.bundleRoot),
    requested = resolve(input.prefix);
  rejectBundleOutput(bundle.root, requested);
  createInstallDirectory(requested);
  const root = realpathSync(requested);
  if (root !== requested) error('directory_unsafe');
  ownedDirectory(root);
  const lock = acquireFileLock(join(root, '.install.lock'), 'exclusive');
  let stage: string | undefined;
  try {
    if (existsSync(join(root, markerName))) installed(root);
    else {
      if (readdirSync(root).some((name) => name !== '.install.lock')) error('install_not_empty');
      durable(join(root, markerName), JSON.stringify({ version: 1, root }) + '\n');
    }
    readCLIRegistration(root);
    const previous = active(root);
    mkdirSync(join(root, 'releases'), { mode: 0o700, recursive: true });
    ownedDirectory(join(root, 'releases'));
    const releaseRoot = join(root, 'releases', bundle.candidateId);
    if (!existsSync(releaseRoot)) {
      stage = join(root, 'releases', `.stage-${randomUUID()}`);
      copyTree(bundle.root, stage);
      if (verifyTerminalBundle(stage).digest !== bundle.digest) error('candidate_changed');
      syncTree(stage);
      renameSync(stage, releaseRoot);
      stage = undefined;
      syncDirectory(join(root, 'releases'));
    }
    ownedDirectory(releaseRoot);
    if (verifyTerminalBundle(releaseRoot).digest !== bundle.digest) error('candidate_changed');
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    ownedDirectory(bin);
    for (const [file, name] of [
      ['kite', 'cli'],
      ['kite-tui', 'tui'],
    ] as const) {
      const path = join(bin, file),
        body = launcher(name);
      if (
        existsSync(path) &&
        (!lstatSync(path).isFile() ||
          lstatSync(path).isSymbolicLink() ||
          readFileSync(path, 'utf8') !== body ||
          (lstatSync(path).mode & 0o777) !== 0o755)
      )
        error('launcher_changed');
      if (!existsSync(path)) durable(path, body, 0o755);
    }
    const previousCandidateId =
      previous?.current === bundle.candidateId ? previous.previous : (previous?.current ?? null);
    durable(join(root, 'active'), `${bundle.candidateId}\n${previousCandidateId ?? ''}\n`);
    return { root, candidateId: bundle.candidateId, releaseRoot, previousCandidateId };
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    lock.release();
  }
}
export function rollbackTerminalBundle(prefix: string): InstalledTerminalBundle {
  if (process.platform === 'win32') return rollbackWindowsTerminalBundle(prefix);
  const root = resolve(prefix);
  installed(root);
  const lock = acquireFileLock(join(root, '.install.lock'), 'exclusive');
  try {
    readCLIRegistration(root);
    const selection = active(root);
    if (!selection?.previous) error('previous_unavailable');
    const releaseRoot = join(root, 'releases', selection.previous);
    ownedDirectory(releaseRoot);
    const bundle = verifyTerminalBundle(releaseRoot);
    if (bundle.digest !== selection.previous) error('candidate_changed');
    durable(join(root, 'active'), `${selection.previous}\n${selection.current}\n`);
    return {
      root,
      candidateId: selection.previous,
      releaseRoot,
      previousCandidateId: selection.current,
    };
  } finally {
    lock.release();
  }
}
/** Uninstall refuses any live candidate use, then removes only this managed artifact root. */
export function uninstallTerminalBundle(prefix: string) {
  if (process.platform === 'win32') return uninstallWindowsTerminalBundle(prefix);
  const root = resolve(prefix);
  installed(root);
  const lock = acquireFileLock(join(root, '.install.lock'), 'exclusive'),
    uses: ReturnType<typeof acquireArtifactAccess>[] = [];
  let removed: string | undefined;
  try {
    readCLIRegistration(root);
    const selection = active(root);
    if (!selection) error('active_invalid');
    const bin = join(root, 'bin');
    ownedDirectory(bin);
    if (readdirSync(bin).sort().join(',') !== 'kite,kite-tui') error('install_unknown_entry');
    for (const [file, name] of [
      ['kite', 'cli'],
      ['kite-tui', 'tui'],
    ] as const) {
      const path = join(bin, file);
      privateRegular(path);
      if (readFileSync(path, 'utf8') !== launcher(name) || (lstatSync(path).mode & 0o777) !== 0o755)
        error('launcher_changed');
    }
    ownedDirectory(join(root, 'releases'));
    const entries = readdirSync(join(root, 'releases'));
    const candidates = new Set(entries.filter((name) => candidatePattern.test(name)));
    if (
      !candidates.has(selection.current) ||
      (selection.previous && !candidates.has(selection.previous))
    )
      error('active_invalid');
    for (const name of entries) {
      if (/^\.use-[a-f0-9]{64}\.lock$/.test(name)) {
        if (!candidates.has(name.slice(5, -5))) error('install_unknown_entry');
        const path = join(root, 'releases', name);
        privateRegular(path);
        if ((lstatSync(path).mode & 0o777) !== 0o600 || lstatSync(path).size !== 0)
          error('install_file_unsafe');
        continue;
      }
      if (!candidatePattern.test(name)) error('install_unknown_entry');
      const candidate = join(root, 'releases', name);
      uses.push(acquireArtifactAccess({ root: candidate, mode: 'exclusive' }));
      if (verifyTerminalBundle(candidate).digest !== name) error('candidate_changed');
    }
    if (
      readdirSync(root).some(
        (name) =>
          ![
            'releases',
            'bin',
            'active',
            markerName,
            '.install.lock',
            CLI_REGISTRATION_FILE,
          ].includes(name),
      )
    )
      error('install_unknown_entry');
    removed = join(dirname(root), `.terminal-uninstall-${randomUUID()}`);
    renameSync(root, removed);
    syncDirectory(dirname(root));
  } finally {
    for (const use of uses.reverse()) use.release();
    lock.release();
  }
  if (removed) {
    rmSync(removed, { recursive: true, force: false });
    syncDirectory(dirname(root));
  }
}

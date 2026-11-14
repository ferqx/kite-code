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
  mkdtempSync,
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
import { open } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { cliBundledDependencies } from '../../apps/cli/bundled-dependencies';
import { CLI_REGISTRATION_FILE, readCLIRegistration } from '../../apps/cli/host/cli-registration';
import {
  type TerminalBundleManifest,
  terminalBundleEntries,
  type VerifiedTerminalBundle,
  verifyTerminalBundle,
} from '../../apps/cli/host/terminal-artifact';
import { serviceBundledDependencies } from '../../apps/service/bundled-dependencies';
import {
  type DesktopRuntimeManifest,
  type EmbeddedRuntimeManifest,
  macosNodeDesktopRuntimeEntries,
  nodeNativeInstallerPath,
  nodeNativeMaintenancePath,
  terminalEmptyAssetDirectories,
  type VerifiedTerminalRuntimeBundle,
  verifyEmbeddedRuntimeBundle,
  windowsNodeDesktopRuntimeEntries,
} from '../../apps/service/src/runtime-assets';
import { createTrustedAssets } from '../../apps/web/src/assets';
import { agentBundledDependencies } from '../../packages/agent/scripts/bundled-dependencies';
import { desktopModuleSpecifier } from '../../packages/agent/scripts/desktop-bundling';
import { acquireArtifactAccess } from '../../packages/agent/src/artifact-access';
import { acquireFileLock } from '../../packages/agent/src/platform/locks';
import { retainWindowsArtifactScope } from '../../packages/agent/src/platform/windows-artifact-scope';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
} from '../../packages/agent/src/platform/windows-path-security';
import { aiBundledDependencies } from '../../packages/ai/bundled-dependencies';
import { desktopBundledDependencies } from '../../packages/ui/scripts/bundled-dependencies';
import { tuiBundledDependencies } from '../../packages/ui/scripts/tui-bundled-dependencies';
import { initializeDesktopBuildEnvironment } from '../development/windows-desktop-environment';
import { workspaceBuildCommand } from '../tooling/build-command';
import { build as bundle } from '../tooling/bun-build';
import { spawn as spawnProcess } from '../tooling/process';
import { scanImports } from '../tooling/scan-imports';
import {
  buildWindowsTerminalLauncher,
  compileWindowsNodeVerifier,
  copyWindowsSystemExecutable,
} from './build-windows-terminal-launcher';
import { compileSqlite, sqliteLibraryBasename } from './compile-sqlite';
import { buildDesktopRuntime, buildDesktopWorkspace, desktopModuleMap } from './desktop-runtime';
import { type MacosTerminalSigning, signMacosTerminalCode } from './macos-dmg/terminal-signing';
import {
  cachedNodeDistribution,
  extractNodeDistribution,
  extractReviewedSqlite,
} from './node-inputs';
import { buildTerminalSqliteEngine } from './sqlite-engine';
import { copyTerminalDependencies, terminalBundledNotices } from './terminal-dependencies';
import { rejectBundleOutput } from './terminal-paths';
import {
  installWindowsTerminalBundle,
  rollbackWindowsTerminalBundle,
  uninstallWindowsTerminalBundle,
} from './windows-terminal-install';
import {
  windowsNativeVerifierChecksumPath,
  windowsTerminalVerifierPath,
} from './windows-verifier-assets';

export { verifyTerminalBundle };

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const workspaces = [
  'packages/trajectory',
  'packages/trace-extension-sdk',
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
async function run(
  executable: string,
  args: string[],
  cwd: string,
  buildEnv?: Readonly<Record<string, string>>,
): Promise<string> {
  const child = spawnProcess([executable, ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      LANG: 'en_US.UTF-8',
      // An isolated application HOME must not silently select a fresh compiler
      // installation. Retain only the caller's explicit Rust cache locations.
      ...(process.env.CARGO_HOME ? { CARGO_HOME: process.env.CARGO_HOME } : {}),
      ...(process.env.RUSTUP_HOME ? { RUSTUP_HOME: process.env.RUSTUP_HOME } : {}),
      ...buildEnv,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exit, output, diagnostic] = await Promise.allSettled([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exit.status === 'rejected')
    throw new AggregateError([exit.reason], 'terminal_build_close_unconfirmed');
  if (output.status === 'rejected') throw output.reason;
  if (diagnostic.status === 'rejected') throw diagnostic.reason;
  const code = exit.value,
    stdout = output.value,
    stderr = diagnostic.value;
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
  const walk = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name));
    } else if (stat.isFile() && path.endsWith('.js')) {
      for (const item of scanImports(readFileSync(path)))
        if (names.some((name) => item.path === name || item.path.startsWith(`${name}/`)))
          error(`bundled_dependency_external:${relative(root, path)}:${item.path}`);
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
async function inventory(root: string) {
  const files: { path: string; size: number; sha256: string; mode: 420 | 493 }[] = [],
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
            ? path.endsWith('.exe') || path.endsWith('runtime-native.node')
              ? 493
              : 420
            : stat.mode & 0o111
              ? 493
              : 420;
        // Windows admission uses the original native owner/DACL, not POSIX mode
        // bits. Rewriting unchanged attributes here adds no permission evidence.
        if (process.platform !== 'win32') chmodSync(path, mode);
        if (process.platform === 'win32')
          files.push({ path: item, size: stat.size, sha256: '', mode });
        else {
          const bytes = readFileSync(path);
          files.push({ path: item, size: bytes.length, sha256: sha(bytes), mode });
        }
      } else error('file_unsupported');
    }
  };
  walk(root);
  if (process.platform === 'win32') {
    // Bound both cold-file reads and memory. Every file is hashed from this
    // candidate; the complete native permission/identity verifier still follows.
    let next = 0;
    const closeFailures: unknown[] = [];
    const reads = await Promise.allSettled(
      Array.from({ length: Math.min(8, files.length) }, async () => {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        for (;;) {
          if (closeFailures.length) return;
          const file = files[next++];
          if (!file) return;
          const handle = await open(join(root, file.path), 'r');
          try {
            const hash = createHash('sha256');
            let total = 0;
            for (;;) {
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
              if (!bytesRead) break;
              total += bytesRead;
              if (total > file.size) error('file_changed');
              hash.update(buffer.subarray(0, bytesRead));
            }
            if (total !== file.size) error('file_changed');
            file.sha256 = hash.digest('hex');
          } finally {
            try {
              await handle.close();
            } catch (cause) {
              closeFailures.push(cause);
            }
          }
        }
      }),
    );
    // Wait for every original reader to close before the builder may remove a
    // failed candidate. A rejected read must never race the cleanup operation.
    if (closeFailures.length)
      throw new AggregateError(
        [
          ...reads.flatMap((read) => (read.status === 'rejected' ? [read.reason] : [])),
          ...closeFailures,
        ],
        'terminal_inventory_close_unconfirmed',
      );
    const failed = reads.find((read) => read.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    links: links.sort((a, b) => a.path.localeCompare(b.path)),
  };
}
interface BuildTerminalBundleInput {
  destination: string;
  repositoryRoot?: string;
  nodeExecutable?: string;
  nodeDistribution?: string;
  sqliteLibrary?: string;
  macosSigning?: MacosTerminalSigning;
  /** Fixed test composition, baked before fingerprinting; production callers leave this absent. */
  processHostFixture?: 'native-mcp-loopback' | 'native-extension-reference';
  /** Public certificate only, embedded in that fixture and therefore in the candidate digest. */
  processHostFixtureCertificate?: string;
}
/** Build a closed, relocatable runtime from the locked installed dependencies. */
export function buildTerminalBundle(
  input: BuildTerminalBundleInput & { desktopOnly: true },
): Promise<VerifiedTerminalRuntimeBundle<DesktopRuntimeManifest>>;
export function buildTerminalBundle(
  input: BuildTerminalBundleInput,
): Promise<VerifiedTerminalBundle>;
export async function buildTerminalBundle(
  input: BuildTerminalBundleInput & { desktopOnly?: true },
): Promise<VerifiedTerminalRuntimeBundle<EmbeddedRuntimeManifest>> {
  const desktop = input.desktopOnly === true;
  const macosArm64 = process.platform === 'darwin' && process.arch === 'arm64';
  const windowsX64 = process.platform === 'win32' && process.arch === 'x64';
  if (windowsX64) initializeDesktopBuildEnvironment();
  if (
    desktop &&
    ((!windowsX64 && !macosArm64) ||
      input.processHostFixture !== undefined ||
      input.sqliteLibrary !== undefined)
  )
    error('desktop_runtime_inputs_invalid');
  if (input.macosSigning && !macosArm64) error('macos_signing_requires_macos_arm64');
  const repository = realpathSync(input.repositoryRoot ?? resolve(import.meta.dirname, '../..'));
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
  const toolchain = realpathSync(input.nodeExecutable ?? process.execPath);
  if ((await run(toolchain, ['--version'], repository)) !== process.version)
    error('runtime_version_mismatch');
  const register = join(repository, 'scripts/tooling/register.mjs');
  if (process.platform === 'win32') privateDirectory(destination);
  else mkdirSync(destination, { mode: 0o700 });
  try {
    const root = realpathSync(destination);
    const entries = desktop
      ? macosArm64
        ? macosNodeDesktopRuntimeEntries
        : windowsNodeDesktopRuntimeEntries
      : terminalBundleEntries(process.platform, 'node');
    const nodeWork = mkdtempSync(join(root, '.node-build-'));
    const distribution = extractNodeDistribution(
      repository,
      resolve(input.nodeDistribution ?? cachedNodeDistribution(repository)),
      nodeWork,
    );
    const sqliteSource = extractReviewedSqlite(repository, nodeWork);
    const runtime = distribution.executable;
    if ((await run(runtime, ['--version'], repository)) !== `v${distribution.version}`)
      error('runtime_version_mismatch');
    const buildEnv = {
      KITE_RELEASE_NODE_HEADERS: distribution.headers,
      KITE_RELEASE_SQLITE_HEADERS: sqliteSource,
      ...(distribution.library ? { KITE_RELEASE_NODE_LIBRARY: distribution.library } : {}),
      ...(process.platform === 'win32'
        ? {
            ...Object.fromEntries(
              ['SystemRoot', 'WINDIR', 'KITE_WINDOWS_MSVC', 'INCLUDE', 'LIB', 'LIBPATH'].flatMap(
                (key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]]),
              ),
            ),
            TMP: nodeWork,
            TEMP: nodeWork,
          }
        : { TMPDIR: nodeWork }),
    };
    const excludedServiceSource = new Set([
      './src/daemon.ts',
      './src/daemon-main.ts',
      './src/development-web.ts',
    ]);
    const desktopWorkers = new Set([
      'src/tools/documents/build-assets.ts',
      'src/tools/images/build-assets.ts',
      'src/tools/web-fetch/build-assets.ts',
    ]);
    const packages = workspaces
      .filter((source) => !desktop || !['packages/ui', 'apps/cli'].includes(source))
      .map((source) => {
        const path = join(repository, source),
          manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as Package;
        const desktopService = desktop && manifest.name === '@kite-ai/service';
        const exports = Object.fromEntries(
          Object.entries(manifest.exports)
            .filter(
              ([key, path]) =>
                !(manifest.name === '@kite-ai/trace-extension-sdk' && key === './bundle') &&
                (!desktopService || !excludedServiceSource.has(path)),
            )
            .map(([key, path]) => {
              if (typeof path !== 'string') error('workspace_export_unsupported');
              const built = (
                manifest.name === '@kite-ai/cli' ? path : path.replace(/^\.\/src\//, './')
              ).replace(/\.tsx?$/, '.js');
              if (desktop && !built.startsWith('./')) error('workspace_export_unsupported');
              return [key, built];
            }),
        );
        return {
          name: manifest.name,
          source: path,
          destination: join(root, desktop ? 'code' : 'node_modules', manifest.name),
          manifest,
          exports,
          bundledDependencies:
            manifest.name === '@kite-ai/ui'
              ? [...desktopBundledDependencies, ...tuiBundledDependencies]
              : manifest.name === '@kite-ai/agent'
                ? agentBundledDependencies
                : manifest.name === '@kite-ai/ai'
                  ? aiBundledDependencies
                  : manifest.name === '@kite-ai/service'
                    ? serviceBundledDependencies
                    : manifest.name === '@kite-ai/cli'
                      ? cliBundledDependencies
                      : [],
        };
      });
    const desktopModules = desktop ? desktopModuleMap(packages) : undefined;
    let signedRuntimeAddonSha256: string | undefined;
    const buildWorkspace = async (item: (typeof packages)[number]) => {
      mkdirSync(item.destination, { recursive: true, mode: 0o700 });
      const desktopService = desktop && item.name === '@kite-ai/service';
      for (const segment of item.manifest.scripts.build.split(/\s*&&\s*/)) {
        const words = workspaceBuildCommand(segment, item.source, register);
        if (!words) error('build_script_unsupported');
        if (item.name === '@kite-ai/trace-extension-sdk' && words.includes('./src/bundle.ts'))
          continue; // Authoring-only bundler requires a checkout and is not a runtime export.
        const args = words
          .filter((word) => !desktopService || !excludedServiceSource.has(word))
          .map((word) =>
            word === 'dist' || word === './dist'
              ? item.destination
              : word.replace(/^--outdir=(?:\.\/)?dist(?=\/|$)/, `--outdir=${item.destination}`),
          );
        if (
          desktopModules &&
          resolve(item.source, args[0] ?? '') ===
            join(repository, 'scripts/tooling/build-command.ts')
        ) {
          await buildDesktopWorkspace(item.source, args.slice(1), desktopModules);
        } else {
          if (
            (desktop && item.name === '@kite-ai/agent' && desktopWorkers.has(args[0]!)) ||
            (desktopService && args[0] === './src/trace-integrations/opentelemetry/build-assets.ts')
          )
            args.push('--desktop');
          await run(toolchain, ['--import', register, ...args], item.source, buildEnv);
          if (
            input.macosSigning &&
            item.name === '@kite-ai/agent' &&
            args[0] === 'scripts/build-node-runtime.ts'
          ) {
            const addon = join(item.destination, 'runtime-native.node');
            input.macosSigning.sign(addon, 'code');
            signedRuntimeAddonSha256 = sha(readFileSync(addon));
          }
        }
      }
      verifyBundledDependencies(item.destination, item.bundledDependencies);
      if (item.name === '@kite-ai/agent') {
        const directory = join(item.destination, 'tools/git-worktree');
        const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
        const assets = ['worker.js'];
        if (
          manifest.schemaVersion !== 1 ||
          manifest.emptyHooks !== 'empty-hooks' ||
          Object.keys(manifest).sort().join(',') !== 'emptyHooks,files,schemaVersion' ||
          !manifest.files ||
          Object.keys(manifest.files).sort().join(',') !== assets.join(',')
        )
          error('worktree_assets_invalid');
        for (const name of assets)
          if (sha(readFileSync(join(directory, name))) !== manifest.files[name])
            error('worktree_assets_invalid');
        const hooks = join(directory, 'empty-hooks');
        if (
          !lstatSync(hooks).isDirectory() ||
          lstatSync(hooks).isSymbolicLink() ||
          readdirSync(hooks).length
        )
          error('worktree_assets_invalid');
      }
      if (item.bundledDependencies.length) {
        const notices = terminalBundledNotices({
          repositoryRoot: repository,
          workspaceRoot: item.source,
          names: item.bundledDependencies,
        });
        writeFileSync(
          join(item.destination, 'BUNDLED-DEPENDENCIES.json'),
          JSON.stringify(
            {
              ...notices,
              packages: notices.packages.map((pkg) => ({
                ...pkg,
                notices: pkg.notices.map(({ text: _, ...notice }) => notice),
              })),
            },
            null,
            2,
          ),
        );
        writeFileSync(
          join(item.destination, 'THIRD_PARTY_BUNDLED.txt'),
          notices.packages
            .map(
              (pkg) =>
                `${pkg.name} ${pkg.version}\n${pkg.manifestText}\n${pkg.notices.map((notice) => `${notice.name}\n${notice.text}`).join('\n\n')}`,
            )
            .join('\n\n'),
        );
      }
      for (const path of Object.values(item.exports))
        if (!existsSync(join(item.destination, path))) error('workspace_export_missing');
      if (desktop) return;
      writeFileSync(
        join(item.destination, 'package.json'),
        JSON.stringify(
          {
            name: item.name,
            version: item.manifest.version,
            type: 'module',
            exports: item.exports,
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
    };
    // Each workspace reads source and writes its own output. Keep that package's
    // segments ordered, and wait for every original child before failure cleanup.
    let nextWorkspace = 0,
      buildFailed = false;
    const builds = await Promise.allSettled(
      Array.from({ length: process.platform === 'win32' ? 2 : 1 }, async () => {
        while (!buildFailed) {
          const item = packages[nextWorkspace++];
          if (!item) return;
          try {
            await buildWorkspace(item);
          } catch (cause) {
            buildFailed = true;
            throw cause;
          }
        }
      }),
    );
    const unconfirmed = builds.find(
      (build) =>
        build.status === 'rejected' &&
        build.reason instanceof AggregateError &&
        build.reason.message === 'terminal_build_close_unconfirmed',
    );
    if (unconfirmed?.status === 'rejected') throw unconfirmed.reason;
    const failed = builds.find((build) => build.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    // Standalone Service lifetimes outlive the launching CLI and retain the same candidate.
    for (const [entry, run] of [
      ['main', 'runServiceProcess'],
      ['daemon-main', 'runDaemonProcess'],
    ] as const) {
      if (desktop && entry === 'daemon-main') continue;
      const folder = dirname(join(root, entries.service));
      renameSync(join(folder, `${entry}.js`), join(folder, `${entry}-implementation.js`));
      const fixture = entry === 'main' ? input.processHostFixture : undefined;
      const fixtureEntry =
        fixture === 'native-mcp-loopback'
          ? 'main-native-mcp-fixture'
          : 'main-native-extension-fixture';
      if (fixture) {
        const built = await bundle({
          entrypoints: [
            join(
              repository,
              fixture === 'native-mcp-loopback'
                ? 'apps/service/test/native-mcp-process.fixture.ts'
                : 'tests/fixtures/unified-agent/native-extension-process.ts',
            ),
          ],
          target: 'node',
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
      const artifactAccess = '@kite-ai/agent/artifact-access';
      writeFileSync(
        join(folder, `${entry}.js`),
        `import {resolve} from 'node:path';
import {Console} from 'node:console';
import {acquireArtifactAccess} from '${desktop ? desktopModuleSpecifier(artifactAccess) : artifactAccess}';
import {${run}} from './${fixture ? fixtureEntry : `${entry}-implementation`}.js';
export {${run}};
if(import.meta.main){globalThis.console=new Console(process.stderr,process.stderr);const lease=acquireArtifactAccess({root:resolve(import.meta.dirname,'../../..'),mode:'shared'});try{await ${run}();}finally{lease.release();}}
`,
      );
    }
    if (desktopModules) {
      await buildDesktopRuntime(
        repository,
        root,
        packages.map((item) => item.destination),
        desktopModules,
        'node',
      );
    } else {
      copyTerminalDependencies({
        repositoryRoot: repository,
        destination: join(root, 'node_modules'),
        workspacePackages: packages,
        ...(process.platform === 'win32' ? { dependencyLayout: 'materialized' as const } : {}),
      });
    }
    if (process.platform === 'win32') {
      privateDirectory(join(root, 'runtime'));
      copyWindowsSystemExecutable(runtime, join(root, entries.runtime));
    } else {
      mkdirSync(join(root, 'runtime'), { mode: 0o700 });
      copyFileSync(runtime, join(root, entries.runtime));
    }
    copyFileSync(distribution.license, join(root, 'runtime/LICENSE.node'));
    const executable = join(root, entries.runtime);
    chmodSync(executable, 0o755);
    if (input.macosSigning) {
      const agent = join(root, desktop ? 'code' : 'node_modules', '@kite-ai/agent');
      signMacosTerminalCode(root, executable, agent, input.macosSigning, signedRuntimeAddonSha256);
    }
    const sqliteLibrary =
      input.sqliteLibrary ??
      (process.platform === 'darwin'
        ? [
            '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
            '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
          ].find((path) => existsSync(path))
        : undefined) ??
      compileSqlite(sqliteSource, join(nodeWork, sqliteLibraryBasename(process.platform)));
    const sqlite = await buildTerminalSqliteEngine({
      root,
      executable,
      library: sqliteLibrary,
      ...(desktop ? { desktopOnly: true as const } : {}),
      ...(input.macosSigning ? { macosSigning: input.macosSigning } : {}),
    });
    rmSync(nodeWork, { recursive: true });
    if (!desktop) {
      mkdirSync(join(root, 'entrypoints'), { mode: 0o700 });
      for (const name of ['cli', 'tui']) {
        const build = await bundle({
          entrypoints: [join(repository, `scripts/release/entrypoints/terminal-${name}.ts`)],
          target: 'node',
          packages: 'external',
          outdir: join(root, 'entrypoints'),
          naming: `${name}.js`,
        });
        if (!build.success)
          throw new AggregateError(build.logs, 'terminal_entrypoint_build_failed');
      }
      for (const name of ['standard-cli', 'standard-tui', 'native-cli', 'native-tui']) {
        const build = await bundle({
          entrypoints: [join(repository, `scripts/release/entrypoints/${name}.ts`)],
          target: 'node',
          packages: 'external',
          outdir: join(root, 'entrypoints'),
          naming: `${name}.js`,
        });
        if (!build.success)
          throw new AggregateError(build.logs, 'terminal_entrypoint_build_failed');
      }
      {
        writeFileSync(join(root, 'entrypoints/package.json'), '{"type":"module"}\n');
        const maintenance = await bundle({
          entrypoints: [join(repository, 'scripts/release/entrypoints/native-maintenance.ts')],
          target: 'node',
          packages: 'external',
          outdir: dirname(join(root, nodeNativeMaintenancePath)),
          naming: 'native-maintenance.mjs',
        });
        if (!maintenance.success)
          throw new AggregateError(maintenance.logs, 'terminal_native_maintenance_build_failed');
        copyFileSync(
          join(repository, 'scripts/release/entrypoints/kite-install.command'),
          join(root, nodeNativeInstallerPath),
        );
        chmodSync(join(root, nodeNativeInstallerPath), 0o755);
      }
      if (process.platform === 'win32') {
        const folder = join(root, 'windows-frontdoor');
        privateDirectory(folder);
        const verifierPath = join(root, windowsTerminalVerifierPath);
        const addonPath = join(root, 'node_modules/@kite-ai/agent/runtime-native.node');
        const addonBytes = readFileSync(addonPath);
        const verifierAddon = { sha256: sha(addonBytes), size: addonBytes.length };
        defaultWindowsPathSecurity()!.writePrivateFile(
          join(folder, 'runtime-native.node'),
          addonBytes,
        );
        const compileRoot = join(root, `.windows-verifier-${randomUUID()}`);
        privateDirectory(compileRoot);
        const compiledPath = join(compileRoot, 'terminal-verifier.exe');
        await compileWindowsNodeVerifier({
          runtime: join(root, entries.runtime),
          addonSha256: verifierAddon.sha256,
          entrypoint: join(repository, 'scripts/release/entrypoints/windows-verifier-main.ts'),
          outfile: compiledPath,
        });
        copyWindowsSystemExecutable(compiledPath, verifierPath);
        rmSync(compileRoot, { recursive: true, force: false });
        const bytes = readFileSync(verifierPath);
        const verifierSha256 = sha(bytes);
        defaultWindowsPathSecurity()!.writePrivateFile(
          join(root, windowsNativeVerifierChecksumPath),
          Buffer.from(`${verifierSha256}\n`),
        );
        const launchers = await buildWindowsTerminalLauncher({
          outdir: join(root, `.windows-launcher-${randomUUID()}`),
          verifierPath,
          verifierSha256,
          verifierSize: bytes.length,
          verifierAddon,
        });
        for (const name of launchers.launchers)
          defaultWindowsPathSecurity()!.copyPrivateFile(
            join(launchers.root, name),
            join(folder, name),
          );
        rmSync(launchers.root, { recursive: true, force: false });
      }
      const web = await bundle({
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
    }
    if (existsSync(join(repository, 'LICENSE')))
      copyFileSync(join(repository, 'LICENSE'), join(root, 'LICENSE'));
    const source = {
      commit: await run('git', ['rev-parse', 'HEAD'], repository),
      dirty: !!(await run('git', ['status', '--porcelain'], repository)),
    };
    const productVersion = (
      JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { version: string }
    ).version;
    const manifest = {
      version: 1 as const,
      apiMajor: 1 as const,
      target: { platform: process.platform, arch: process.arch },
      nodeVersion: distribution.version,
      sqlite,
      productVersion,
      source,
      entries,
      ...(await inventory(root)),
    };
    if (terminalEmptyAssetDirectories(manifest).length !== 1) error('worktree_assets_invalid');
    writeFileSync(join(root, 'terminal-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
      mode: 0o644,
    });
    return desktop ? verifyEmbeddedRuntimeBundle(root) : verifyTerminalBundle(root);
  } catch (cause) {
    if (
      !(
        cause instanceof AggregateError &&
        ['terminal_inventory_close_unconfirmed', 'terminal_build_close_unconfirmed'].includes(
          cause.message,
        )
      )
    )
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
function launcher(name: 'cli' | 'tui', bundledNode = false) {
  return `#!/bin/sh\nset -eu\nunset NODE_PATH NODE_OPTIONS BUN_OPTIONS ELECTRON_RUN_AS_NODE\nroot=$(CDPATH= cd -P -- "\${0%/*}/.." && pwd)\nIFS= read -r candidate < "$root/active"\ncase "$candidate" in ''|*[!0-9a-f]*) echo terminal_active_invalid >&2; exit 1;; esac\n[ "\${#candidate}" -eq 64 ] || exit 1\n${bundledNode ? `unset NODE_COMPILE_CACHE NODE_V8_COVERAGE\nif [ -x "$root/releases/$candidate/runtime/node" ]; then\n  exec "$root/releases/$candidate/runtime/node" "$root/releases/$candidate/entrypoints/standard-${name}.js" "$@"\nfi\n` : ''}exec "$root/releases/$candidate/runtime/bun" "$root/releases/$candidate/entrypoints/standard-${name}.js" "$@"\n`;
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
      const path = join(bin, file);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o755))
        error('launcher_changed');
      const previousBody = stat ? readFileSync(path, 'utf8') : undefined;
      const legacyBody = launcher(name);
      const nodeBody = launcher(name, true);
      if (previousBody !== undefined && ![legacyBody, nodeBody].includes(previousBody))
        error('launcher_changed');
      const body = bundle.manifest.nodeVersion || previousBody === nodeBody ? nodeBody : legacyBody;
      if (previousBody !== body) durable(path, body, 0o755);
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
      if (
        ![launcher(name), launcher(name, true)].includes(readFileSync(path, 'utf8')) ||
        (lstatSync(path).mode & 0o777) !== 0o755
      )
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

/** Real old source/builders only. Source validation is not native Windows qualification. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  startWindowsOwnedChild,
  type WindowsOwnedChild,
  WindowsOwnedChildStartError,
} from '../../../packages/agent/src/platform/process/windows-owned-child';
import {
  assertCompatiblePredecessorInputPaths,
  assertCompatiblePredecessorLockedInput,
  COMPATIBLE_PREDECESSOR_COMMIT,
  COMPATIBLE_PREDECESSOR_MIGRATIONS,
} from './compatible-predecessor-input';
import { matchPredecessorShellParserInput } from './predecessor-shell-parser-input';
import { matchPredecessorStdioInput } from './predecessor-stdio-input';
import { refinePredecessorWorkspaceDeclarations } from './predecessor-workspace-declarations';
import { matchTerminalPredecessorInput } from './terminal-predecessor';

export const COMPATIBLE_WINDOWS_PREDECESSOR_COMMIT = COMPATIBLE_PREDECESSOR_COMMIT;
export const WINDOWS_PREDECESSOR_COMMIT = '837a2b8cde946d70d00920941a1a3e5e7c684f5d';
const workspaces = [
  'packages/ai',
  'packages/agent',
  'packages/client',
  'packages/ui',
  'apps/service',
  'apps/cli',
  'apps/desktop',
  'apps/web',
] as const;
const baseline = 'packages/agent/src/storage/migrations/0001-baseline.sql';
const baselineSha = '92773869c4d4e68947e9721d5bb6d28e10567c6dc3a82b56726b1a0fb7adee42';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pending = new Set<WindowsOwnedChild>();
export function windowsPredecessorLockedInputPaths(manifest: {
  patchedDependencies?: Record<string, string>;
}): string[] {
  const patches = Object.values(manifest.patchedDependencies ?? {});
  if (patches.some((path) => !/^patches\/[a-zA-Z0-9@._+-]+\.patch$/.test(path)))
    throw Error('windows_predecessor_patch_path_invalid');
  return [
    'bun.lock',
    'package.json',
    ...workspaces.map((path) => `${path}/package.json`),
    ...patches,
  ];
}
export function assertWindowsPredecessorLockedInput(
  path: string,
  previous: Uint8Array,
  current: Uint8Array,
) {
  const match =
    matchPredecessorStdioInput(path, previous, current) ??
    matchPredecessorShellParserInput(path, previous, current) ??
    (['bun.lock', 'package.json', 'packages/ui/package.json'].includes(path)
      ? matchTerminalPredecessorInput(path, previous, current)
      : undefined);
  if (!match) throw Error(`windows_predecessor_dependency_input_changed:${path}`);
  return { path, sha256: sha(previous), currentSha256: sha(current), match };
}
const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
};
function absoluteFile(path: string) {
  if (!win32.isAbsolute(path)) throw Error('windows_predecessor_tool_absolute_required');
  const resolved = realpathSync(path);
  if (!lstatSync(resolved).isFile()) throw Error('windows_predecessor_tool_file_required');
  return resolved;
}
function buildEnvironment(bun: string) {
  const supplied = Object.fromEntries(
    Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]),
  );
  const systemRoot = supplied.SYSTEMROOT;
  if (!systemRoot || !win32.isAbsolute(systemRoot))
    throw Error('windows_predecessor_system_root_required');
  const system = realpathSync(systemRoot),
    compiler = absoluteFile(supplied.KITE_WINDOWS_MSVC ?? '');
  if (win32.basename(compiler).toLowerCase() !== 'cl.exe')
    throw Error('windows_predecessor_compiler_invalid');
  const gitPath = (supplied.PATH ?? '')
    .split(';')
    .filter((path) => win32.isAbsolute(path))
    .map((path) => join(path, 'git.exe'))
    .find(existsSync);
  if (!gitPath) throw Error('windows_predecessor_git_required');
  const git = absoluteFile(gitPath);
  const env: Record<string, string> = {
    SYSTEMROOT: system,
    WINDIR: system,
    KITE_WINDOWS_MSVC: compiler,
    PATH: [dirname(bun), dirname(git), dirname(compiler), join(system, 'System32')].join(';'),
    LANG: 'C.UTF-8',
  };
  for (const key of [
    'INCLUDE',
    'LIB',
    'LIBPATH',
    'VCTOOLSINSTALLDIR',
    'VCINSTALLDIR',
    'WINDOWSSDKDIR',
    'WINDOWSSDKVERSION',
    'UNIVERSALCRTSDKDIR',
    'UCRTVERSION',
  ]) {
    const value = supplied[key];
    if (!value) continue;
    if (['WINDOWSSDKVERSION', 'UCRTVERSION'].includes(key)) {
      if (!/^[0-9.]+[\\/]?$/.test(value)) throw Error('windows_predecessor_sdk_version_invalid');
    } else if (
      value
        .split(';')
        .filter(Boolean)
        .some((path) => !win32.isAbsolute(path))
    )
      throw Error('windows_predecessor_msvc_path_invalid');
    env[key] = value;
  }
  return { env, git };
}
type WindowsPredecessorInput = {
  root: string;
  repositoryRoot: string;
  bunExecutable?: string;
  nativeElectronDist: string;
  deadline: number;
};
export function materializeWindowsPredecessor(input: WindowsPredecessorInput) {
  return materializeWindowsPredecessorVersion(input, false);
}
export function materializeCompatibleWindowsPredecessor(input: WindowsPredecessorInput) {
  return materializeWindowsPredecessorVersion(input, true);
}
async function materializeWindowsPredecessorVersion(
  input: WindowsPredecessorInput,
  compatible: boolean,
) {
  const predecessorCommit = compatible
    ? COMPATIBLE_WINDOWS_PREDECESSOR_COMMIT
    : WINDOWS_PREDECESSOR_COMMIT;
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('windows_predecessor_platform_required');
  const remainingInput = input.deadline - Date.now();
  if (!Number.isFinite(input.deadline) || remainingInput <= 0 || remainingInput > 180000)
    throw Error('windows_predecessor_deadline_invalid');
  const end = performance.now() + remainingInput;
  const remaining = () => {
    const value = Math.min(end - performance.now(), input.deadline - Date.now());
    if (value <= 0) throw Error('windows_predecessor_deadline');
    return Math.ceil(value);
  };
  const root = realpathSync(input.root),
    repository = realpathSync(input.repositoryRoot);
  if (inside(repository, root) || inside(root, repository) || !lstatSync(root).isDirectory())
    throw Error('windows_predecessor_root_invalid');
  const bun = absoluteFile(input.bunExecutable ?? process.execPath),
    electron = realpathSync(input.nativeElectronDist);
  const { env, git } = buildEnvironment(bun);
  // Isolate compiler/Git HOME and temp without inheriting preload or arbitrary process options.
  Object.assign(env, { HOME: root, USERPROFILE: root, TEMP: root, TMP: root });
  const source = join(root, 'predecessor-source'),
    terminal = join(root, 'predecessor-terminal'),
    native = join(root, 'predecessor-native');
  const mirror = join(root, 'predecessor-dependencies.mjs'),
    build = join(root, 'predecessor-build.ts'),
    config = join(root, 'predecessor-bunfig.toml');
  if ([source, terminal, native, mirror, build, config].some(existsSync))
    throw Error('windows_predecessor_destination_exists');
  const { privateDirectory } = await import(
    '../../../packages/agent/src/platform/windows-path-security'
  );
  privateDirectory(root);
  const within = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('windows_predecessor_command_deadline')), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const command = async (
    executable: string,
    argv: string[],
    cwd: string,
    gitCommand = false,
  ): Promise<Buffer> => {
    const budget = Math.min(remaining(), gitCommand ? 10000 : remaining());
    const commandEnd = performance.now() + budget;
    const commandRemaining = () => {
      const value = Math.min(remaining(), commandEnd - performance.now());
      if (value <= 0) throw Error('windows_predecessor_command_deadline');
      return Math.ceil(value);
    };
    let owner: WindowsOwnedChild;
    try {
      owner = startWindowsOwnedChild({ executable, argv, cwd, env, stdin: 'ignore' });
    } catch (error) {
      if (error instanceof WindowsOwnedChildStartError) {
        try {
          await within(error.cleanup, Math.min(remaining(), 5000));
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'windows_predecessor_start_cleanup_unknown');
        }
      }
      throw error;
    }
    const chunks: Buffer[] = [];
    let bytes = 0,
      stderr = Buffer.alloc(0),
      failure: unknown;
    const stdout = (async () => {
      for await (const chunk of owner.stdout) {
        bytes += chunk.length;
        if (bytes <= 8 * 1024 * 1024) chunks.push(Buffer.from(chunk));
      }
      if (bytes > 8 * 1024 * 1024) throw Error('windows_predecessor_stdout_capacity');
    })();
    const errors = (async () => {
      for await (const chunk of owner.stderr)
        stderr = Buffer.concat([stderr, chunk]).subarray(-16384);
    })();
    const completed = Promise.all([owner.exited, stdout, errors]);
    void completed.catch(() => {});
    try {
      const [code] = await within(completed, commandRemaining());
      if (code !== 0)
        throw Error(
          `windows_predecessor_command_failed:${win32.basename(executable)}:${code}:${stderr.toString('utf8')}`,
        );
      const evidence = await within(owner.stop({ graceMs: 0 }), Math.min(commandRemaining(), 5000));
      if (
        !evidence.root.waitConfirmed ||
        evidence.root.exitCode !== 0 ||
        !evidence.job.treeStopped ||
        evidence.job.activeProcesses !== 0 ||
        evidence.job.terminationRequested
      )
        throw Error('windows_predecessor_natural_exit_unconfirmed');
      await within(owner.close(), Math.min(commandRemaining(), 5000));
      if (!owner.readEvidence().closed || owner.readEvidence().closeUnknown)
        throw Error('windows_predecessor_close_unknown');
      return Buffer.concat(chunks);
    } catch (error) {
      failure = error;
    }
    // A failed native Close is never retried through a second consumer cleanup path.
    if (owner.readEvidence().closeUnknown) {
      pending.add(owner);
      throw failure;
    }
    try {
      await within(
        (async () => {
          await owner.stop({ graceMs: 0 });
          await owner.close();
          await Promise.allSettled([stdout, errors]);
        })(),
        Math.max(1, Math.min(5000, end - performance.now())),
      );
    } catch (cleanup) {
      pending.add(owner);
      throw new AggregateError([failure, cleanup], 'windows_predecessor_cleanup_unknown');
    }
    throw failure;
  };
  const currentManifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as {
    patchedDependencies?: Record<string, string>;
  };
  const lockedInputs = [];
  const reviewedDeclarations = [];
  const inputs = windowsPredecessorLockedInputPaths(currentManifest);
  if (compatible) assertCompatiblePredecessorInputPaths(inputs);
  for (const path of inputs) {
    const previous = await command(git, ['show', `${predecessorCommit}:${path}`], repository, true);
    const current = readFileSync(join(repository, path));
    lockedInputs.push(
      compatible
        ? assertCompatiblePredecessorLockedInput(path, previous, current)
        : assertWindowsPredecessorLockedInput(path, previous, current),
    );
    const refinement = compatible
      ? undefined
      : refinePredecessorWorkspaceDeclarations(path, current);
    if (refinement)
      reviewedDeclarations.push({
        path,
        kind: refinement.kind,
        commits: refinement.commits,
        projectedSha256: sha(refinement.bytes),
      });
  }
  const migrations = compatible
    ? COMPATIBLE_PREDECESSOR_MIGRATIONS
    : [{ path: baseline, sha256: baselineSha }];
  for (const migration of migrations) {
    const previous = await command(
      git,
      ['show', `${predecessorCommit}:${migration.path}`],
      repository,
      true,
    );
    const current = readFileSync(join(repository, migration.path));
    if (compatible) assertCompatiblePredecessorLockedInput(migration.path, previous, current);
    else if (sha(previous) !== migration.sha256 || sha(current) !== migration.sha256)
      throw Error('windows_predecessor_baseline_changed');
  }
  await command(git, ['clone', '--shared', '--no-checkout', '--', repository, source], root, true);
  await command(git, ['checkout', '--detach', predecessorCommit], source, true);
  const identity = async () => ({
    commit: (await command(git, ['rev-parse', 'HEAD'], source, true)).toString().trim(),
    dirty: (await command(git, ['status', '--porcelain'], source, true)).length !== 0,
  });
  const before = await identity();
  if (before.commit !== predecessorCommit || before.dirty)
    throw Error('windows_predecessor_source_identity_invalid');
  writeFileSync(config, '');
  writeFileSync(mirror, MIRROR_DEPENDENCIES);
  await command(
    bun,
    [
      '--no-env-file',
      '--no-install',
      '--config',
      config,
      mirror,
      realpathSync(join(repository, 'node_modules')),
      join(source, 'node_modules'),
      source,
      JSON.stringify(workspaces),
      repository,
    ],
    root,
  );
  writeFileSync(
    build,
    `import {buildTerminalBundle} from ${JSON.stringify(pathToFileURL(join(source, 'scripts/release/terminal-bundle.ts')).href)};
import {buildNativeCandidate} from ${JSON.stringify(pathToFileURL(join(source, 'apps/desktop/scripts/build-native.ts')).href)};
import {windowsNativeCandidateBuildPort} from ${JSON.stringify(pathToFileURL(join(source, 'scripts/release/windows-native-build.ts')).href)};
await buildTerminalBundle(${JSON.stringify({ destination: terminal, repositoryRoot: source, bunExecutable: bun })});
await buildNativeCandidate({terminalRoot:${JSON.stringify(terminal)},electronDist:${JSON.stringify(electron)},outdir:${JSON.stringify(native)},windowsBuildPort:windowsNativeCandidateBuildPort});
`,
  );
  await command(bun, ['--no-env-file', '--no-install', '--config', config, build], source);
  const after = await identity();
  if (after.commit !== before.commit || after.dirty)
    throw Error('windows_predecessor_source_changed');
  const { verifyTerminalRuntimeBundle } = await import('../../../apps/service/src/runtime-assets');
  const { verifyNativeRuntimeBundle } = await import(
    '../../../apps/service/src/native-runtime-assets'
  );
  const productVersion = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
  const terminalProof = verifyTerminalRuntimeBundle(terminal),
    nativeProof = verifyNativeRuntimeBundle(native);
  if (
    terminalProof.manifest.source.commit !== predecessorCommit ||
    terminalProof.manifest.source.dirty ||
    terminalProof.manifest.productVersion !== productVersion ||
    nativeProof.terminal.digest !== terminalProof.digest
  )
    throw Error('windows_predecessor_candidate_provenance_invalid');
  remaining();
  rmSync(source, { recursive: true });
  rmSync(mirror);
  rmSync(build);
  rmSync(config);
  if (existsSync(source)) throw Error('windows_predecessor_source_removal_unconfirmed');
  if (
    verifyTerminalRuntimeBundle(terminal).digest !== terminalProof.digest ||
    verifyNativeRuntimeBundle(native).digest !== nativeProof.digest
  )
    throw Error('windows_predecessor_candidate_changed');
  remaining();
  return {
    terminal,
    native,
    sourceCommit: predecessorCommit,
    lockedInputs,
    reviewedDeclarations,
    schemaCapability: compatible ? ('recovery-audit-v1' as const) : ('baseline-v1' as const),
    migrations,
  };
}

const MIRROR_DEPENDENCIES =
  "\nimport {\n  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,\n  readlinkSync, realpathSync, rmSync, symlinkSync,\n} from 'node:fs';\nimport { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';\nconst [installed, target, source, workspaceJSON, repository] = process.argv.slice(2);\nconst inside = (root, path) => {\n  const part = relative(root, path);\n  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));\n};\ncpSync(installed, target, {\n  recursive: true,\n  verbatimSymlinks: true,\n  filter: path => {\n    if (relative(installed, path).split(sep).includes('@kite-ai')) return false;\n    if (!lstatSync(path).isSymbolicLink()) return true;\n    // Installed history may retain renamed workspace scopes. Determine their targets\n    // without following the link during traversal; no current repository source is copied.\n    const declared = resolve(dirname(path), readlinkSync(path));\n    const resolved = existsSync(path) ? realpathSync(path) : declared;\n    return !(inside(repository, resolved) && !inside(installed, resolved));\n  },\n});\nfunction walk(folder) {\n  for (const name of readdirSync(folder)) {\n    const path = join(folder, name), stat = lstatSync(path);\n    if (stat.isDirectory()) walk(path);\n    else if (stat.isSymbolicLink()) {\n      const link = readlinkSync(path);\n      const original = resolve(dirname(join(installed, relative(target, path))), link);\n      if (!inside(installed, original))\n        throw Error('terminal_predecessor_dependency_link_escape:' + path);\n      if (isAbsolute(link)) {\n        rmSync(path);\n        const mapped = join(target, relative(installed, original));\n        if (lstatSync(mapped).isDirectory()) symlinkSync(mapped, path, 'junction');\n        else cpSync(mapped, path);\n      }\n      if (existsSync(path) && !inside(target, realpathSync(path)))\n        throw Error('terminal_predecessor_dependency_realpath_escape:' + path);\n    }\n  }\n}\nwalk(target);\nfunction mirrorLocal(installedFolder, oldFolder) {\n  mkdirSync(oldFolder, { recursive: true });\n  for (const name of readdirSync(installedFolder)) {\n    const path = join(installedFolder, name), oldPath = join(oldFolder, name);\n    const stat = lstatSync(path);\n    // The renderer's owned Vite cache is generated output, not an installed dependency.\n    if (path === join(repository, 'apps/desktop/node_modules/.vite-desktop-dev') && stat.isDirectory()) continue;\n    if (stat.isSymbolicLink()) {\n      const declared = resolve(dirname(path), readlinkSync(path));\n      const resolved = existsSync(path) ? realpathSync(path) : declared;\n      if (inside(repository, resolved) && !inside(installed, resolved)) continue;\n      if (!inside(installed, resolved))\n        throw Error('terminal_predecessor_local_dependency_escape:' + path);\n      const mapped = join(target, relative(installed, resolved));\n      if (!existsSync(mapped) || !inside(target, realpathSync(mapped)))\n        throw Error('terminal_predecessor_local_dependency_missing:' + path);\n      if (lstatSync(mapped).isDirectory()) symlinkSync(mapped, oldPath, 'junction');\n      else cpSync(mapped, oldPath);\n    } else if (stat.isDirectory()) {\n      if (existsSync(join(path, 'package.json')))\n        throw Error('terminal_predecessor_local_dependency_not_link:' + path);\n      mirrorLocal(path, oldPath);\n    } else throw Error('terminal_predecessor_local_dependency_not_link:' + path);\n  }\n}\nfor (const path of JSON.parse(workspaceJSON)) {\n  const local = join(repository, path, 'node_modules');\n  if (existsSync(local)) mirrorLocal(local, join(source, path, 'node_modules'));\n}\nfor (const path of JSON.parse(workspaceJSON)) {\n  const pkg = JSON.parse(readFileSync(join(source, path, 'package.json'), 'utf8'));\n  const link = join(target, pkg.name);\n  mkdirSync(dirname(link), { recursive: true });\n  symlinkSync(join(source, path), link, 'junction');\n  if (realpathSync(link) !== realpathSync(join(source, path)))\n    throw Error('terminal_predecessor_workspace_resolution_mismatch');\n}\n";

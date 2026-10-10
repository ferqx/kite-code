import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { JobContext } from '../extensions';
import {
  type LaunchIdentity,
  launchIdentity,
  removeRuntimeTemp,
  verifyLaunchIdentities,
} from './launch-identity';

export interface LinuxPaths {
  readonly cwd: string;
  readonly workspaceRoot?: string;
  readonly bubblewrapPath: string;
  readonly protectedRoots: readonly string[];
  readonly readonlyAssets?: readonly string[];
  readonly runtimeReadOnlyRoots?: readonly string[];
  readonly temporaryRoot?: string;
  readonly filesystemScope:
    | 'workspace_write'
    | 'full_access'
    | ((context: JobContext) => 'workspace_write' | 'full_access');
  readonly mode: 'host' | 'confined';
}
export interface LinuxLaunch {
  cwd: string;
  temp: string;
  identities: LaunchIdentity[];
  runtimeTemp: LaunchIdentity;
  profileDigest: string;
  preserveHostHome: boolean;
  mode: 'workspace' | 'full' | 'confined';
  bubblewrapArgs: string[];
  noExecPaths: string[];
  bubblewrapPath: string;
  executablePaths: string[];
  trustedExecutableFiles: string[];
  maskedRoots: string[];
  cleanup(): void;
}
/** Preparation has no process, but its original temp must remain owned if cleanup is unknown. */
export class LinuxPreparationCleanupError extends Error {
  readonly cleanupError: unknown;
  readonly launch: LinuxLaunch;
  constructor(cause: unknown, cleanupError: unknown, launch: LinuxLaunch) {
    super('linux_shell_preparation_cleanup_failed', { cause });
    this.cleanupError = cleanupError;
    this.launch = launch;
  }
}
const within = (root: string, path: string) => {
  const value = relative(root, path);
  return !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`);
};
const depth = (path: string) => path.split(sep).length;
function ancestors(path: string): string[] {
  const paths: string[] = [];
  for (let current = dirname(path); current !== '/'; current = dirname(current))
    paths.push(current);
  return paths;
}
/** Trusted namespace layout only. The native init must seal mounts/capabilities and syscall policy before business starts. */
export function captureLinuxLaunch(options: LinuxPaths, binaries: readonly string[]) {
  if (process.platform !== 'linux') throw Error('linux_shell_platform_unsupported');
  if (options.mode !== 'host' && options.mode !== 'confined')
    throw Error('linux_shell_mode_invalid');
  if (
    [
      options.protectedRoots,
      options.readonlyAssets ?? [],
      options.runtimeReadOnlyRoots ?? [],
      binaries,
    ].some((paths) => paths.length > 128)
  )
    throw Error('linux_shell_paths_invalid');
  const cwd = launchIdentity(options.cwd);
  const workspace = launchIdentity(options.workspaceRoot ?? options.cwd);
  if (options.mode === 'confined' && cwd.canonical !== workspace.canonical)
    throw Error('linux_shell_cwd_outside_workspace');
  const tempBase = launchIdentity(options.temporaryRoot ?? tmpdir());
  const protectedRoots = [...new Set(options.protectedRoots)].map((path) => launchIdentity(path));
  const readonly = [...new Set(options.runtimeReadOnlyRoots ?? [])].map((path) =>
    launchIdentity(path),
  );
  const assets = [
    ...new Set([options.bubblewrapPath, ...binaries, ...(options.readonlyAssets ?? [])]),
  ].map((path) => launchIdentity(path, !lstatSync(realpathSync.native(path)).isDirectory()));
  const launcher = launchIdentity(options.bubblewrapPath, true);
  const executablePaths = binaries.map((path) => launchIdentity(path, true).canonical);
  const trustedExecutableFiles = [...new Set([launcher.canonical, ...executablePaths])];
  // An outer 000 mount already protects every nested root. Only visible masks
  // enter the native protocol; every original identity is still revalidated.
  const maskedRoots = [...new Set(protectedRoots.map((fact) => fact.canonical))].filter(
    (path, _index, all) => !all.some((other) => other !== path && within(other, path)),
  );
  // Compensation exposes only these fixed OS roots, the declared runtime and Workspace.
  const system =
    options.mode === 'confined'
      ? [
          '/usr/bin',
          '/usr/sbin',
          '/usr/lib',
          '/usr/lib64',
          '/usr/libexec',
          '/usr/share',
          '/bin',
          '/sbin',
          '/lib',
          '/lib64',
        ]
          .filter(existsSync)
          .map((path) => launchIdentity(path))
      : [];
  if (
    workspace.canonical === '/' ||
    within(workspace.canonical, tempBase.canonical) ||
    protectedRoots.some(
      (root) =>
        root.canonical === '/' ||
        within(root.canonical, workspace.canonical) ||
        within(root.canonical, cwd.canonical) ||
        within(root.canonical, tempBase.canonical),
    )
  )
    throw Error('linux_shell_workspace_protected');
  if (
    [...readonly, ...assets, ...system].some((fact) =>
      protectedRoots.some((root) => within(root.canonical, fact.canonical)),
    )
  )
    throw Error('linux_shell_asset_protected');
  const parentPaths = [
    ...new Set(
      [workspace, tempBase, ...protectedRoots, ...readonly, ...assets].flatMap((fact) =>
        ancestors(fact.canonical),
      ),
    ),
  ];
  const parents = parentPaths.map((path) => launchIdentity(path));
  const bindings = [
    cwd,
    workspace,
    tempBase,
    ...protectedRoots,
    ...readonly,
    ...assets,
    ...system,
    ...parents,
  ];
  if (bindings.length > 198) throw Error('linux_shell_paths_invalid');
  return (_command: string, shell: string, context: JobContext): LinuxLaunch => {
    verifyLaunchIdentities(bindings);
    const executable = launchIdentity(shell, true);
    if (
      !assets.some(
        (fact) => fact.canonical === executable.canonical && fact.digest === executable.digest,
      )
    )
      throw Error('linux_shell_executable_unbound');
    const scope =
      typeof options.filesystemScope === 'function'
        ? options.filesystemScope(context)
        : options.filesystemScope;
    if (scope !== 'workspace_write' && scope !== 'full_access')
      throw Error('linux_shell_scope_unavailable');
    const mode =
      options.mode === 'confined' ? 'confined' : scope === 'full_access' ? 'full' : 'workspace';
    const temp = realpathSync.native(mkdtempSync(join(tempBase.canonical, 'kite-linux-job-')));
    chmodSync(temp, 0o700);
    const runtimeTemp = launchIdentity(temp);
    const cleanup = () => removeRuntimeTemp(runtimeTemp);
    let args: string[] = [];
    let noExecPaths: string[] = [];
    const capturedLaunch = (): LinuxLaunch => ({
      cwd: cwd.canonical,
      temp,
      identities: [...bindings, runtimeTemp],
      runtimeTemp,
      profileDigest: createHash('sha256')
        .update(
          JSON.stringify({
            mode,
            args,
            noExecPaths,
            trustedExecutableFiles,
            maskedRoots,
            launcher: launcher.digest,
          }),
        )
        .digest('hex'),
      preserveHostHome: mode !== 'confined',
      mode,
      bubblewrapArgs: [...args],
      noExecPaths: [...noExecPaths],
      bubblewrapPath: launcher.canonical,
      executablePaths: [...executablePaths],
      trustedExecutableFiles: [...trustedExecutableFiles],
      maskedRoots: [...maskedRoots],
      cleanup,
    });
    try {
      args = [
        '--unshare-user',
        '--unshare-pid',
        '--as-pid-1',
        '--new-session',
        // Crash-only kernel fallback; normal close requires cooperative cancellation and original wait/EOF proof.
        '--die-with-parent',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'CAP_SYS_ADMIN',
      ];
      if (mode === 'confined') args.push('--unshare-net');
      if (mode !== 'confined') {
        args.push(mode === 'full' ? '--bind' : '--ro-bind', '/', '/');
        // Separate mountpoints prevent deleting/renaming protected ancestors without making sibling trees readonly in Full.
        for (const fact of [...parents, workspace, tempBase].sort(
          (a, b) => depth(a.canonical) - depth(b.canonical),
        ))
          args.push(
            mode === 'full' || within(workspace.canonical, fact.canonical) ? '--bind' : '--ro-bind',
            fact.canonical,
            fact.canonical,
          );
      }
      const mounts = [
        ...system,
        ...readonly,
        ...assets.filter((fact) => fact.digest === null),
      ].sort((a, b) => depth(a.path) - depth(b.path));
      if (mode === 'confined')
        for (const fact of mounts) {
          args.push('--ro-bind', fact.canonical, fact.canonical);
          if (fact.path !== fact.canonical) args.push('--ro-bind', fact.canonical, fact.path);
        }
      if (mode === 'confined') {
        args.push('--bind', workspace.canonical, workspace.canonical);
        for (const fact of parents
          .filter((fact) => within(workspace.canonical, fact.canonical))
          .sort((a, b) => depth(a.canonical) - depth(b.canonical)))
          args.push('--bind', fact.canonical, fact.canonical);
      }
      if (mode !== 'confined')
        for (const fact of mounts) args.push('--ro-bind', fact.canonical, fact.canonical);
      args.push('--bind', temp, temp, '--proc', '/proc', '--dev', '/dev');
      // Exact trusted binaries remain separate mountpoints after readonly data directories.
      for (const fact of assets.filter((fact) => fact.digest !== null)) {
        args.push('--ro-bind', fact.canonical, fact.canonical);
      }
      noExecPaths = [
        ...new Set([
          temp,
          ...(mode === 'confined'
            ? [
                workspace.canonical,
                ...parents
                  .filter((fact) => within(workspace.canonical, fact.canonical))
                  .map((fact) => fact.canonical),
                ...[...readonly, ...assets]
                  .filter((fact) => fact.digest === null)
                  .flatMap((fact) => [fact.canonical, fact.path]),
              ]
            : []),
        ]),
      ];
      // Apply masks last: a broad runtime bind must never reveal a protected child.
      for (const path of maskedRoots)
        args.push('--perms', '000', '--tmpfs', path, '--remount-ro', path);
      if (mode === 'confined') args.push('--remount-ro', '/');
      args.push('--chdir', cwd.canonical);
      if (Buffer.byteLength(JSON.stringify(args)) > 128 * 1024)
        throw Error('linux_shell_profile_too_large');
      if (noExecPaths.length + trustedExecutableFiles.length + maskedRoots.length > 200)
        throw Error('linux_shell_paths_invalid');
      verifyLaunchIdentities([...bindings, runtimeTemp]);
      return capturedLaunch();
    } catch (error) {
      try {
        cleanup();
      } catch (cleanupError) {
        throw new LinuxPreparationCleanupError(error, cleanupError, capturedLaunch());
      }
      throw error;
    }
  };
}

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { JobContext } from '../extensions';
import {
  type LaunchIdentity,
  launchIdentity,
  removeRuntimeTemp,
  verifyLaunchIdentities,
} from './launch-identity';
import { prepareLinuxPrivateDirectory } from './linux-private-directory';
import { captureProtectedFiles } from './protected-files';
import { captureReadOnlySource } from './read-only-source';
import {
  type HostShellExecutionScope,
  type HostShellExecutionScopeResolver,
  resolveHostShellExecutionScope,
} from './shell-scope';

export interface LinuxPaths {
  readonly cwd: string;
  readonly workspaceRoot?: string;
  readonly controlBase?: string;
  readonly readOnlySourceRoot?: string;
  readonly bubblewrapPath: string;
  readonly protectedRoots: readonly string[];
  readonly protectedFiles?: readonly string[];
  readonly readonlyAssets?: readonly string[];
  readonly runtimeReadOnlyRoots?: readonly string[];
  readonly temporaryRoot?: string;
  readonly executionScope?: HostShellExecutionScope | HostShellExecutionScopeResolver;
  readonly filesystemScope:
    | 'workspace_write'
    | 'full_access'
    | ((context: JobContext) => 'workspace_write' | 'full_access');
  readonly mode: 'host' | 'confined';
}
export interface LinuxSourceProjection {
  root: string;
  device: string;
  inode: string;
  scaffolds: string[];
}
export interface LinuxLaunch {
  sourceProjection?: LinuxSourceProjection;
  cwd: string;
  temp: string;
  identities: LaunchIdentity[];
  runtimeTemp: LaunchIdentity;
  profileDigest: string;
  preserveHostHome: boolean;
  mode: 'workspace' | 'full' | 'confined';
  networkScope: 'none' | 'internet';
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
export function captureLinuxLaunch(
  options: LinuxPaths,
  binaries: readonly string[],
  hostHome = homedir(),
) {
  if (process.platform !== 'linux') throw Error('linux_shell_platform_unsupported');
  if (options.mode !== 'host' && options.mode !== 'confined')
    throw Error('linux_shell_mode_invalid');
  if (
    [
      options.protectedRoots,
      options.protectedFiles ?? [],
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
  const control = options.controlBase ? launchIdentity(options.controlBase) : undefined;
  const protectedRoots = [
    ...new Set([...options.protectedRoots, ...(control ? [control.path] : [])]),
  ].map((path) => launchIdentity(path));
  // Denied private names are not executable assets. Freeze only parent metadata;
  // missing names must not prevent a Model Run from being prepared.
  const privateFiles = captureProtectedFiles(options.protectedFiles ?? []);
  // A final credential symlink may have an independently reachable target.
  // Freeze every denied alias without opening or hashing its content.
  const privateAliases = privateFiles.deniedPaths.map((path) => captureProtectedFiles([path]));
  const privateNames = {
    files: privateAliases.flatMap((aliases) => aliases.files),
    verify() {
      for (const aliases of privateAliases) aliases.verify();
    },
  };
  const projection = captureReadOnlySource({
    cwd,
    workspace,
    control,
    protectedRoots,
    readOnlySourceRoot: options.readOnlySourceRoot,
    mode: options.mode,
  });
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
  const visibleMasks = [...new Set(protectedRoots.map((fact) => fact.canonical))].filter(
    (path, _index, all) => !all.some((other) => other !== path && within(other, path)),
  );
  const outerSourceMask =
    projection && visibleMasks.find((root) => within(root, projection.source.canonical));
  const sourceProjection: LinuxSourceProjection | undefined =
    projection && outerSourceMask
      ? {
          root: projection.source.canonical,
          device: projection.source.device,
          inode: projection.source.inode,
          scaffolds: projection.ancestors
            .filter((fact) => within(outerSourceMask, fact.canonical))
            .map((fact) => fact.canonical)
            .reverse(),
        }
      : undefined;
  const maskedRoots = visibleMasks.filter((root) => root !== outerSourceMask);
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
        (!projection && within(root.canonical, cwd.canonical)) ||
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
  // An outer private view already removes every descendant from the business
  // filesystem. Retain their host identities, but never leave hidden child
  // bind mounts for native init to mistake for visible undeclared submounts.
  const visibleParents = parents.filter(
    (fact) => !visibleMasks.some((root) => root !== fact.canonical && within(root, fact.canonical)),
  );
  const bindings = [
    cwd,
    workspace,
    tempBase,
    ...protectedRoots,
    ...readonly,
    ...assets,
    ...system,
    ...parents,
    ...(projection ? [projection.source, ...projection.ancestors] : []),
  ];
  if (bindings.length > 198) throw Error('linux_shell_paths_invalid');
  const privateOptions: LinuxPaths = {
    ...options,
    cwd: cwd.path,
    workspaceRoot: workspace.path,
    bubblewrapPath: launcher.path,
    protectedRoots: protectedRoots.map((fact) => fact.path),
    protectedFiles: [],
    readonlyAssets: assets.map((fact) => fact.path),
    runtimeReadOnlyRoots: readonly.map((fact) => fact.path),
    temporaryRoot: tempBase.path,
    ...(control ? { controlBase: control.path } : {}),
    ...(projection ? { readOnlySourceRoot: projection.source.path } : {}),
  };
  const privateBinaries = [...binaries];
  return (command: string, shell: string, context: JobContext): LinuxLaunch => {
    verifyLaunchIdentities(bindings);
    if (privateFiles.files.length) {
      context.signal.throwIfAborted();
      privateFiles.verify();
      privateNames.verify();
      const homes = [...new Set([hostHome, homedir()])].map((home) => {
        if (!isAbsolute(home) || home.includes('\0'))
          throw Error('linux_shell_private_file_layout_invalid');
        try {
          return realpathSync.native(home);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw Error('linux_shell_private_file_layout_invalid', { cause: error });
          return resolve(home);
        }
      });
      const directories = [
        ...new Map(
          privateNames.files.map((file) => [dirname(file.canonical), file.parent]),
        ).entries(),
      ];
      // A private subdirectory can live in the Workspace; a broad private root
      // cannot replace the Workspace, HOME, temp or a fixed executable source.
      const publicPaths = [
        ...homes,
        ...(!projection ? [cwd.canonical] : []),
        workspace.canonical,
        tempBase.canonical,
        ...readonly.map((fact) => fact.canonical),
        ...assets.map((fact) => fact.canonical),
        ...system.map((fact) => fact.canonical),
      ];
      if (
        // A canonical directory mask cannot prevent unlinking a separately
        // writable symlink spelling. Its alias must already be inside an
        // original protected tree (or its verified readonly source view).
        privateNames.files.some(
          (file) =>
            dirname(file.path) !== dirname(file.canonical) &&
            !protectedRoots.some((root) => within(root.canonical, dirname(file.path))),
        ) ||
        directories.some(
          ([path]) =>
            path === '/' ||
            publicPaths.some((publicPath) => within(path, publicPath)) ||
            (projection && within(projection.source.canonical, path)),
        )
      )
        throw Error('linux_shell_private_file_layout_invalid');
      if (
        new Set([...privateOptions.protectedRoots, ...directories.map(([path]) => path)]).size > 128
      )
        throw Error('linux_shell_paths_invalid');
      const roots = directories.map(([path, parent]) =>
        prepareLinuxPrivateDirectory(path, parent, context.signal),
      );
      context.signal.throwIfAborted();
      const prepare = captureLinuxLaunch(
        {
          ...privateOptions,
          protectedRoots: [...privateOptions.protectedRoots, ...roots.map((fact) => fact.path)],
        },
        privateBinaries,
        hostHome,
      );
      const launch = prepare(command, shell, context);
      try {
        verifyLaunchIdentities(bindings);
        verifyLaunchIdentities(roots);
        privateFiles.verify();
        privateNames.verify();
        context.signal.throwIfAborted();
        return launch;
      } catch (error) {
        try {
          launch.cleanup();
        } catch (cleanupError) {
          throw new LinuxPreparationCleanupError(error, cleanupError, launch);
        }
        throw error;
      }
    }
    const executable = launchIdentity(shell, true);
    if (
      !assets.some(
        (fact) => fact.canonical === executable.canonical && fact.digest === executable.digest,
      )
    )
      throw Error('linux_shell_executable_unbound');
    const scope = resolveHostShellExecutionScope(
      options.executionScope,
      options.filesystemScope,
      context,
    );
    const mode =
      options.mode === 'confined'
        ? 'confined'
        : scope.filesystem === 'full_access'
          ? 'full'
          : 'workspace';
    const networkScope = mode === 'confined' ? 'none' : scope.network;
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
            networkScope,
            args,
            noExecPaths,
            trustedExecutableFiles,
            maskedRoots,
            sourceProjection,
            launcher: launcher.digest,
          }),
        )
        .digest('hex'),
      preserveHostHome: mode !== 'confined',
      mode,
      networkScope,
      bubblewrapArgs: [...args],
      noExecPaths: [...noExecPaths],
      bubblewrapPath: launcher.canonical,
      executablePaths: [...executablePaths],
      trustedExecutableFiles: [...trustedExecutableFiles],
      maskedRoots: [...maskedRoots],
      sourceProjection: sourceProjection && {
        ...sourceProjection,
        scaffolds: [...sourceProjection.scaffolds],
      },
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
      if (networkScope === 'none') args.push('--unshare-net');
      if (mode !== 'confined') {
        args.push(mode === 'full' ? '--bind' : '--ro-bind', '/', '/');
        // Separate mountpoints prevent deleting/renaming protected ancestors without making sibling trees readonly in Full.
        for (const fact of [
          ...new Map(
            [...visibleParents, workspace, tempBase].map((fact) => [fact.canonical, fact]),
          ).values(),
        ].sort((a, b) => depth(a.canonical) - depth(b.canonical)))
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
        for (const fact of visibleParents
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
          ...(sourceProjection ? [...sourceProjection.scaffolds, sourceProjection.root] : []),
          ...(mode === 'confined'
            ? [
                workspace.canonical,
                ...visibleParents
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
      if (sourceProjection) {
        // Only the trusted init can read these synthetic 0700 directories. It
        // checks their exact child chain, chmods 0111 and seals every mount
        // before dropping capabilities and opening the business fork gate.
        for (const path of sourceProjection.scaffolds) args.push('--perms', '700', '--tmpfs', path);
        args.push('--ro-bind', sourceProjection.root, sourceProjection.root);
      }
      if (mode === 'confined') args.push('--remount-ro', '/');
      args.push('--chdir', cwd.canonical);
      if (Buffer.byteLength(JSON.stringify(args)) > 128 * 1024)
        throw Error('linux_shell_profile_too_large');
      if (
        noExecPaths.length +
          trustedExecutableFiles.length +
          maskedRoots.length +
          (sourceProjection ? 1 + sourceProjection.scaffolds.length : 0) >
        200
      )
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

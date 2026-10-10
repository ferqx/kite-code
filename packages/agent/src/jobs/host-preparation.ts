import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { JobContext } from '../extensions';
import type { ConfinedLaunch } from './confined-preparation';
import { launchIdentity, removeRuntimeTemp, verifyLaunchIdentities } from './launch-identity';
import { SEATBELT_BASE_POLICY } from './seatbelt';

export interface MacosHostPaths {
  readonly cwd: string;
  readonly workspaceRoot?: string;
  readonly controlBase: string;
  readonly protectedRoots: readonly string[];
  readonly readonlyAssets?: readonly string[];
  readonly runtimeReadOnlyRoots?: readonly string[];
  readonly temporaryRoot?: string;
  /** Trusted host selection from the actual dispatched authorization, never command JSON. */
  readonly filesystemScope:
    | 'workspace_write'
    | 'full_access'
    | ((context: JobContext) => 'workspace_write' | 'full_access');
}
const quote = (path: string) => `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const subpath = (path: string) => `(subpath ${quote(path)})`;
const literal = (path: string) => `(literal ${quote(path)})`;
const within = (root: string, path: string) => {
  const value = relative(root, path);
  return !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`);
};
function ancestors(path: string) {
  const result: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    result.push(current);
    if (dirname(current) === current) return result;
  }
}

export function captureMacosHostLaunch(options: MacosHostPaths, binaries: readonly string[]) {
  if (process.platform !== 'darwin') throw Error('host_shell_platform_unsupported');
  if (
    [options.protectedRoots, options.readonlyAssets ?? [], options.runtimeReadOnlyRoots ?? []].some(
      (paths) => paths.length > 128,
    )
  )
    throw Error('host_shell_paths_invalid');
  const cwd = launchIdentity(options.cwd);
  const workspace = launchIdentity(options.workspaceRoot ?? options.cwd);
  const control = launchIdentity(options.controlBase);
  const protectedRoots = [...new Set([options.controlBase, ...options.protectedRoots])].map(
    (path) => launchIdentity(path),
  );
  const tempBase = launchIdentity(options.temporaryRoot ?? tmpdir());
  if (
    within(workspace.canonical, tempBase.canonical) ||
    protectedRoots.some(
      (root) =>
        within(root.canonical, workspace.canonical) || within(root.canonical, cwd.canonical),
    )
  )
    throw Error('host_shell_workspace_protected');
  const readonly = (options.runtimeReadOnlyRoots ?? []).map((path) => launchIdentity(path));
  const assets = [
    ...new Set([...binaries, '/usr/bin/sandbox-exec', ...(options.readonlyAssets ?? [])]),
  ].map((path) => launchIdentity(path, !lstatSync(realpathSync.native(path)).isDirectory()));
  const bindings = [cwd, workspace, control, tempBase, ...protectedRoots, ...readonly, ...assets];
  if (bindings.length > 190) throw Error('host_shell_paths_invalid');
  // A protected child can live inside the Workspace. Protect its actual ancestor
  // identities from rename/unlink as well, without denying writes to siblings.
  const renameProtected = [
    ...new Set(
      [control, tempBase, ...protectedRoots, ...readonly, ...assets].flatMap((fact) =>
        ancestors(fact.digest === null ? fact.canonical : dirname(fact.canonical)),
      ),
    ),
  ];
  const system = [
    '/System',
    '/bin',
    '/sbin',
    '/usr/bin',
    '/usr/sbin',
    '/usr/lib',
    '/usr/libexec',
    '/Library/Developer',
    '/Applications/Xcode.app',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/opt/homebrew/Cellar',
    '/opt/homebrew/opt',
    '/opt/homebrew/lib',
    '/opt/local/bin',
    '/opt/local/sbin',
    '/opt/local/lib',
  ]
    .filter(existsSync)
    .map((path) => realpathSync.native(path));
  return (command: string, shell: string, context: JobContext): ConfinedLaunch => {
    verifyLaunchIdentities(bindings);
    const filesystem =
      typeof options.filesystemScope === 'function'
        ? options.filesystemScope(context)
        : options.filesystemScope;
    if (filesystem !== 'workspace_write' && filesystem !== 'full_access')
      throw Error('host_shell_scope_unavailable');
    const temp = realpathSync.native(mkdtempSync(join(tempBase.canonical, 'kite-host-job-')));
    chmodSync(temp, 0o700);
    const runtimeTemp = launchIdentity(temp);
    const cleanup = () => removeRuntimeTemp(runtimeTemp);
    try {
      const assetFilters = assets.map((asset) =>
        asset.digest === null ? subpath(asset.canonical) : literal(asset.canonical),
      );
      const profile = [
        SEATBELT_BASE_POLICY.replace('(deny process-fork)', '(allow process-fork)'),
        '(allow file-read* file-read-metadata)',
        filesystem === 'full_access'
          ? '(allow file-map-executable)'
          : `(allow file-map-executable ${[workspace.canonical, ...system, ...readonly.map((root) => root.canonical)].map(subpath).join(' ')} ${assetFilters.join(' ')})`,
        filesystem === 'full_access'
          ? '(allow file-write* file-write-create file-write-unlink file-ioctl)'
          : `(allow file-write* file-write-create file-write-unlink file-ioctl ${[workspace.canonical, temp].map(subpath).join(' ')})`,
        `(deny file-write* file-write-create file-write-unlink file-ioctl ${assetFilters.join(' ')} ${readonly.map((root) => subpath(root.canonical)).join(' ')})`,
        `(deny file-read* file-read-metadata file-map-executable file-write* file-write-create file-write-unlink file-ioctl ${protectedRoots.map((root) => subpath(root.canonical)).join(' ')})`,
        `(deny file-write-unlink ${renameProtected.map(literal).join(' ')})`,
        `(deny process-exec file-map-executable ${subpath(temp)})`,
        '(allow network*)',
        ...(filesystem === 'full_access'
          ? []
          : [
              '(deny network-bind (local unix-socket))',
              '(deny network-outbound (remote unix-socket))',
            ]),
      ].join('\n');
      if (Buffer.byteLength(profile) > 128 * 1024) throw Error('host_shell_profile_too_large');
      return {
        executable: '/usr/bin/sandbox-exec',
        argv: ['-p', profile, realpathSync.native(shell), '-c', command],
        cwd: cwd.canonical,
        temp,
        identities: [...bindings, runtimeTemp],
        runtimeTemp,
        profileDigest: createHash('sha256').update(profile).digest('hex'),
        preserveHostHome: true,
        cleanup,
      };
    } catch (error) {
      cleanup();
      throw error;
    }
  };
}

import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { launchIdentity, removeRuntimeTemp, verifyLaunchIdentities } from './launch-identity';
import { confinedProfile } from './seatbelt';

export interface ConfinedPaths {
  readonly cwd: string;
  readonly runtimeReadOnlyRoots?: readonly string[];
  readonly protectedRoots: readonly string[];
  readonly temporaryRoot?: string;
}
/** Host-only capture. Revalidated after ordinary authorization/resources, at the actual Job start. */
export function captureConfinedLaunch(options: ConfinedPaths, binaries: readonly string[]) {
  if (process.platform !== 'darwin') throw Error('confined_shell_platform_unsupported');
  if (
    (options.runtimeReadOnlyRoots && options.runtimeReadOnlyRoots.length > 64) ||
    options.protectedRoots.length > 64
  )
    throw Error('invalid_confined_path');
  const workspace = launchIdentity(options.cwd);
  const readonly = (options.runtimeReadOnlyRoots ?? []).map((path) => launchIdentity(path));
  const protectedPaths = options.protectedRoots.map((path) => launchIdentity(path));
  const tempBase = launchIdentity(options.temporaryRoot ?? tmpdir());
  const tempScope = relative(workspace.canonical, tempBase.canonical);
  if (!isAbsolute(tempScope) && tempScope !== '..' && !tempScope.startsWith(`..${sep}`))
    throw Error('confined_temp_overlaps_workspace');
  const executable = binaries.map((path) => launchIdentity(path, true));
  const launcher = launchIdentity('/usr/bin/sandbox-exec', true);
  const bindings = [workspace, ...readonly, ...protectedPaths, tempBase, ...executable, launcher];
  return (command: string, shell: string) => {
    verifyLaunchIdentities(bindings);
    const temp = realpathSync.native(mkdtempSync(join(tempBase.canonical, 'kite-confined-job-')));
    chmodSync(temp, 0o700);
    const runtimeTemp = launchIdentity(temp);
    const cleanup = () => removeRuntimeTemp(runtimeTemp);
    try {
      const profile = confinedProfile(
        workspace.canonical,
        temp,
        readonly.map((path) => path.canonical),
        executable.map((path) => path.canonical),
        protectedPaths.map((path) => path.canonical),
      );
      if (Buffer.byteLength(profile) > 128 * 1024) throw Error('confined_profile_too_large');
      return {
        executable: launcher.canonical,
        argv: ['-p', profile, realpathSync.native(shell), '-c', command],
        cwd: workspace.canonical,
        temp,
        identities: [...bindings, runtimeTemp],
        runtimeTemp,
        profileDigest: createHash('sha256').update(profile).digest('hex'),
        cleanup,
      };
    } catch (error) {
      cleanup();
      throw error;
    }
  };
}

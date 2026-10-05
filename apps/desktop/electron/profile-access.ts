import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { verifyNativeAsset } from './native-assets';
import { loadWindowsAccess, type WindowsAccessLease } from './windows-access';

export type DesktopProfileAccess = Readonly<{ close(): void }>;
type LeaseState = {
  fd?: number;
  native?: WindowsAccessLease;
  profilePath: string;
  attached: boolean;
  closed: boolean;
};
const leases = new WeakMap<DesktopProfileAccess, LeaseState>();
/** Fixed native UI paths are derived from the original attached Profile lease. */
export function prepareWindowsPrivateUi(lease: DesktopProfileAccess): void {
  const state = leases.get(lease);
  if (!state?.native || state.closed || !state.attached) throw Error('profile_access_unavailable');
  state.native.preparePrivateUi();
}
export function verifyWindowsPrivateUi(lease: DesktopProfileAccess): void {
  const state = leases.get(lease);
  if (!state?.native || state.closed || !state.attached) throw Error('profile_access_unavailable');
  state.native.verifyPrivateUi();
}
/** A one-shot trusted Bun helper obtains flock on Node's original open file description. */
export async function acquireDesktopProfileAccess(input: {
  profile: { dataRoot: string; profile: string };
  bunExecutable: string;
  bunSha256: string;
  helperPath: string;
  helperSha256: string;
  windowsAsset?: { path: string; sha256: string };
}): Promise<DesktopProfileAccess> {
  verifyNativeAsset(input.bunExecutable, input.bunSha256);
  verifyNativeAsset(input.helperPath, input.helperSha256);
  const profile = selectProfile(input.profile),
    path = join(profile.coordinationPath, 'profile-use.lock');
  if (process.platform === 'win32') {
    if (!input.windowsAsset) throw Error('windows_access_asset_unavailable');
    const native = loadWindowsAccess(input.windowsAsset).profileShared(
      profile.dataRoot,
      profile.profile,
    );
    try {
      native.verify();
    } catch (error) {
      native.release();
      throw error;
    }
    const state: LeaseState = {
      native,
      profilePath: profile.profilePath,
      attached: false,
      closed: false,
    };
    const lease = Object.freeze({
      close() {
        if (state.attached) throw Error('profile_access_in_use');
        if (!state.closed) {
          native.release();
          state.closed = true;
        }
      },
    });
    leases.set(lease, state);
    return lease;
  }
  // The Service or explicit host initialization owns this namespace. Never create a replacement lock.
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  const close = () => closeSync(fd);
  try {
    const original = fstatSync(fd),
      current = lstatSync(path);
    if (
      !original.isFile() ||
      original.nlink !== 1 ||
      original.uid !== process.getuid?.() ||
      (original.mode & 0o077) !== 0 ||
      original.dev !== current.dev ||
      original.ino !== current.ino
    )
      throw Error('profile_access_unavailable');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        input.bunExecutable,
        [
          input.helperPath,
          JSON.stringify({ dataRoot: profile.dataRoot, profile: profile.profile }),
        ],
        { stdio: ['ignore', 'pipe', 'pipe', fd], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } },
      );
      let output = '',
        failure: string | undefined;
      const timer = setTimeout(() => {
        failure = 'profile_access_timeout';
        child.kill('SIGKILL');
      }, 10000);
      child.stdout!.on('data', (chunk) => {
        output += String(chunk);
        if (output.length > 4096) {
          failure = 'profile_access_unavailable';
          child.kill('SIGKILL');
        }
      });
      // Helper diagnostics never propagate paths or user data to the renderer.
      child.stderr!.on('data', () => {});
      child.once('error', () => {
        failure = 'profile_access_unavailable';
        child.kill('SIGKILL');
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (failure) {
          reject(Error(failure));
          return;
        }
        if (code === 0 && output.trim() === 'profile-access-acquired') resolve();
        else
          reject(
            Error(
              output.trim() === 'restore_reconciliation_required'
                ? 'restore_reconciliation_required'
                : output.trim() === 'owner_busy'
                  ? 'owner_busy'
                  : 'profile_access_unavailable',
            ),
          );
      });
    });
    const held = fstatSync(fd),
      published = lstatSync(path);
    if (held.dev !== published.dev || held.ino !== published.ino)
      throw Error('profile_access_unavailable');
    const state: LeaseState = {
      fd,
      profilePath: profile.profilePath,
      attached: false,
      closed: false,
    };
    const lease: DesktopProfileAccess = Object.freeze({
      close() {
        if (state.attached) throw Error('profile_access_in_use');
        if (!state.closed) {
          close();
          state.closed = true;
        }
      },
    });
    leases.set(lease, state);
    return lease;
  } catch (error) {
    close();
    throw error;
  }
}
/** Only this module's live lease can authorize a single private SQLite lifetime. */
export function attachDesktopProfileAccess(
  lease: DesktopProfileAccess,
  profilePath: string,
): () => void {
  const state = leases.get(lease);
  if (!state || state.closed || state.attached || state.profilePath !== profilePath)
    throw Error('profile_access_unavailable');
  state.native?.verify();
  state.attached = true;
  return () => {
    if (state.closed) return;
    if (state.native) state.native.release();
    else closeSync(state.fd!);
    state.closed = true;
    state.attached = false;
  };
}

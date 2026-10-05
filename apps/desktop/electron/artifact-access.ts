import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { verifyNativeAsset } from './native-assets';
import { loadWindowsAccess } from './windows-access';
/** Main retains its own access lease until the paired Service has closed. */
export async function acquireNodeArtifactAccess(input: {
  root: string;
  bunExecutable: string;
  bunSha256: string;
  helperPath: string;
  helperSha256: string;
  windowsAsset?: { path: string; sha256: string };
}): Promise<{ close(): void }> {
  verifyNativeAsset(input.bunExecutable, input.bunSha256);
  verifyNativeAsset(input.helperPath, input.helperSha256);
  if (!isAbsolute(input.root) || realpathSync(input.root) !== input.root)
    throw Error('artifact_access_unavailable');
  if (process.platform === 'win32') {
    if (!input.windowsAsset) throw Error('windows_access_asset_unavailable');
    const lease = loadWindowsAccess(input.windowsAsset).artifactShared(input.root);
    try {
      lease.verify();
    } catch (error) {
      lease.release();
      throw error;
    }
    return Object.freeze({ close: () => lease.release() });
  }
  for (const path of [input.root, dirname(input.root)]) {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o022) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw Error('artifact_access_unavailable');
  }
  const path = join(dirname(input.root), `.use-${basename(input.root)}.lock`),
    fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  function check() {
    const opened = fstatSync(fd),
      current = lstatSync(path);
    if (
      !opened.isFile() ||
      current.isSymbolicLink() ||
      opened.nlink !== 1 ||
      opened.uid !== process.getuid?.() ||
      (opened.mode & 0o077) !== 0 ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    )
      throw Error('artifact_access_unavailable');
  }
  try {
    check();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        input.bunExecutable,
        [input.helperPath, JSON.stringify({ root: input.root })],
        { stdio: ['ignore', 'pipe', 'pipe', fd], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } },
      );
      let output = '',
        failure = false;
      const timer = setTimeout(() => {
        failure = true;
        child.kill('SIGKILL');
      }, 10000);
      child.stdout!.on('data', (chunk) => {
        output += String(chunk);
        if (output.length > 4096) {
          failure = true;
          child.kill('SIGKILL');
        }
      });
      child.stderr!.on('data', () => {});
      child.once('error', () => {
        failure = true;
        child.kill('SIGKILL');
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (!failure && code === 0 && output.trim() === 'artifact-access-acquired') resolve();
        else reject(Error('artifact_access_unavailable'));
      });
    });
    check();
    let closed = false;
    return Object.freeze({
      close() {
        if (!closed) {
          closeSync(fd);
          closed = true;
        }
      },
    });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

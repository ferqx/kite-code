import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { type LaunchIdentity, launchIdentity } from './launch-identity';

/** Dispatch-only infrastructure. Never opens a credential leaf or changes an existing mode. */
export function prepareLinuxPrivateDirectory(
  path: string,
  parent: LaunchIdentity,
  signal: AbortSignal,
): LaunchIdentity {
  const suffix = relative(parent.canonical, path);
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`))
    throw Error('linux_shell_private_directory_unavailable');
  const parts = suffix ? suffix.split(sep) : [];
  if (parts.length > 128) throw Error('linux_shell_private_directory_unavailable');
  let fd: number | undefined;
  let current = parent.canonical;
  const same = (descriptor: number, original: LaunchIdentity) => {
    const stat = fstatSync(descriptor, { bigint: true });
    return (
      stat.isDirectory() &&
      stat.dev.toString() === original.device &&
      stat.ino.toString() === original.inode &&
      stat.mode.toString() === original.mode
    );
  };
  try {
    signal.throwIfAborted();
    fd = openSync(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!same(fd, parent)) throw Error('private_directory_changed');
    for (const part of parts) {
      signal.throwIfAborted();
      // Resolve every new name beneath the original parent object, never an
      // absolute pathname that could be redirected through a competing symlink.
      const child = `/proc/self/fd/${fd}/${part}`;
      try {
        mkdirSync(child, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const next = openSync(
        child,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const original = fd;
      fd = next;
      closeSync(original);
      current = join(current, part);
      const observed = launchIdentity(current);
      if (observed.canonical !== current || !same(fd, observed))
        throw Error('private_directory_changed');
      signal.throwIfAborted();
    }
    const result = launchIdentity(path);
    if (
      result.canonical !== path ||
      lstatSync(path).isSymbolicLink() ||
      realpathSync.native(path) !== path ||
      !same(fd, result)
    )
      throw Error('private_directory_changed');
    signal.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    throw Error('linux_shell_private_directory_unavailable', { cause: error });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

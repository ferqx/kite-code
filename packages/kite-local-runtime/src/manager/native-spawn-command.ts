import type { KiteServiceManagerExecutable } from './ports';

export interface NativeServiceSpawnCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** Windows cannot execute the repo-owned TypeScript source entry through a POSIX shebang. */
export function resolveNativeServiceSpawnCommand(
  executable: KiteServiceManagerExecutable,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  runtimeExecutable: string = process.execPath,
): NativeServiceSpawnCommand {
  if (platform === 'win32' && executable.mode === 'source') {
    return Object.freeze({
      command: runtimeExecutable,
      args: Object.freeze([executable.path, ...args]),
    });
  }
  return Object.freeze({ command: executable.path, args: Object.freeze([...args]) });
}

import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** Find an explicit host executable without launching a shell or resolving from cwd. */
export function findHostExecutable(name: string): string | undefined {
  if (!/^[a-zA-Z0-9_-]+(?:\.exe)?$/.test(name)) return undefined;
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const directory = process.platform === 'win32' ? entry.replace(/^"(.*)"$/, '$1') : entry;
    if (!isAbsolute(directory)) continue;
    try {
      const path = realpathSync.native(join(directory, name));
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // A missing or inaccessible executable cannot qualify this PATH entry.
    }
  }
  return undefined;
}

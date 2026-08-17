import { statSync } from 'node:fs';

/** Trusted-infrastructure accounting helper; never reads capability content. */
export function bestEffortRegularFileSizeV1(path: string): number {
  try {
    const stat = statSync(path);
    return stat.isFile() && Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : 0;
  } catch {
    return 0;
  }
}

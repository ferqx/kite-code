import { join } from 'node:path';

/** Pure path rule; tests must supply their owned home explicitly. */
export function userConfigurationPath(home: string): string {
  return join(home, '.kite-code', 'kite-code.jsonc');
}

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { BuildConfig } from '../../../scripts/tooling/build';

/** A nested standalone entry embeds only the selected Agent addon's relative identity. */
export function runtimeBuildOptions(
  destination: string,
  agentRoot = resolve(process.argv[2] ?? 'dist'),
): Pick<BuildConfig, 'target' | 'define'> {
  const addon = join(agentRoot, 'runtime-native.node');
  return {
    target: 'node',
    define: {
      __KITE_EMBEDDED_RUNTIME_NATIVE__: JSON.stringify({
        path: relative(destination, addon),
        sha256: createHash('sha256').update(readFileSync(addon)).digest('hex'),
      }),
    },
  };
}

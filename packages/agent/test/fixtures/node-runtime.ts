import { cpSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparedDevelopmentNode } from '../../../../scripts/release/node-inputs';
import { which as findExecutable } from '../../../../scripts/tooling/process';
import { runtimeBuildOptions } from '../../scripts/runtime-build-options';
import { runtimeNativeAsset } from '../../src/runtime-native';

export function fixtureNodeExecutable(): string {
  let executable = process.env.KITE_TEST_NODE_EXECUTABLE;
  if (!executable) {
    try {
      executable = preparedDevelopmentNode(resolve(import.meta.dirname, '../../../..'));
    } catch {
      executable = findExecutable('node') ?? undefined;
    }
  }
  if (!executable) throw Error('fixture_node_unavailable');
  return realpathSync.native(executable);
}

/** Keep a disposable program's native dependency inside its own package. */
export function fixtureRuntimeBuild(root: string, destination = root) {
  mkdirSync(root, { recursive: true });
  cpSync(runtimeNativeAsset(), join(root, 'runtime-native.node'));
  return runtimeBuildOptions(destination, root);
}

export const fixtureNodeLoader = fileURLToPath(
  new URL('../../../../scripts/development/node-loader.mjs', import.meta.url),
);

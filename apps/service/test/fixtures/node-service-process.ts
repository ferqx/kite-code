import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { preparedDevelopmentNode } from '../../../../scripts/release/node-inputs';
import { which as findExecutable } from '../../../../scripts/tooling/process';
import { testRuntimeFlags } from '../../../../scripts/tooling/test-command';
import { pairedNodeChild } from '../../src/node-process';
import type { PairedServiceOptions, PairedServiceSpawner } from '../../src/paired';

export function fixtureNodeExecutable(): string {
  const requested = process.env.KITE_TEST_NODE_EXECUTABLE;
  let executable = requested;
  if (!executable) {
    try {
      executable = preparedDevelopmentNode(resolve(import.meta.dirname, '../../../..'));
    } catch {
      executable = findExecutable('node') ?? undefined;
    }
  }
  if (!executable || !isAbsolute(executable)) throw Error('fixture_node_executable_unavailable');
  const path = realpathSync.native(executable);
  accessSync(path, constants.X_OK);
  return path;
}

export function spawnFixtureNodeService(args: readonly string[], env: NodeJS.ProcessEnv) {
  const childEnv = { ...env };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS', 'ELECTRON_RUN_AS_NODE'])
    delete childEnv[key];
  return spawn(fixtureNodeExecutable(), [...testRuntimeFlags, ...args], {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform === 'win32',
    windowsHide: true,
  });
}

export const spawnNodeServiceFixture: PairedServiceSpawner = (command, { env }) => {
  const [_, entrypoint] = command;
  if (command.length !== 2 || !entrypoint || !isAbsolute(entrypoint))
    throw Error('fixture_service_entrypoint_invalid');
  return pairedNodeChild(spawnFixtureNodeService([entrypoint], { ...env }));
};

export const nodeServiceFixture = { spawnChild: spawnNodeServiceFixture } satisfies Pick<
  PairedServiceOptions,
  'spawnChild'
>;

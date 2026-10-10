import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  matchTerminalPredecessorInput,
  TERMINAL_PREDECESSOR_COMMIT,
} from '../../fixtures/unified-agent/terminal-predecessor';

const repository = resolve(import.meta.dir, '../../..'),
  path = 'packages/agent/package.json',
  original = Bun.spawnSync(['git', 'show', `${TERMINAL_PREDECESSOR_COMMIT}:${path}`], {
    cwd: repository,
  });
if (original.exitCode !== 0) throw Error('terminal_predecessor_original_manifest_missing');
const previous = original.stdout,
  current = readFileSync(resolve(repository, path)),
  bytes = (text: string) => Buffer.from(text);

test('predecessor accepts identical inputs and the exact owned-process source entry increment', () => {
  expect(matchTerminalPredecessorInput(path, previous, previous)).toBe('identical');
  expect(matchTerminalPredecessorInput(path, previous, current)).toBe(
    'process_observation_source_entry',
  );
  expect(matchTerminalPredecessorInput('bun.lock', previous, current)).toBeUndefined();
});

test('the source increment never permits dependency, extra export, or other build changes', () => {
  const text = current.toString('utf8');
  for (const changed of [
    text.replace('"@napi-rs/keyring": "1.3.0"', '"@napi-rs/keyring": "1.3.1"'),
    text.replace('"exports": {', '"exports": {\n    "./unknown": "./src/unknown.ts",'),
    text.replace('--target=bun', '--target=node'),
    text.replace('"./process-observation": "./src/process-observation.ts",\n', ''),
    text.replace(' ./src/process-observation.ts ', ' '),
  ]) {
    expect(changed).not.toBe(text);
    expect(matchTerminalPredecessorInput(path, previous, bytes(changed))).toBeUndefined();
  }
});

test('predecessor accepts only the exact Windows Native bootstrap source entry increment', () => {
  const servicePath = 'apps/service/package.json',
    originalService = Bun.spawnSync(
      ['git', 'show', `${TERMINAL_PREDECESSOR_COMMIT}:${servicePath}`],
      { cwd: repository },
    );
  expect(originalService.exitCode).toBe(0);
  const previousService = originalService.stdout,
    currentService = readFileSync(resolve(repository, servicePath)),
    text = currentService.toString('utf8');
  expect(matchTerminalPredecessorInput(servicePath, previousService, previousService)).toBe(
    'identical',
  );
  expect(matchTerminalPredecessorInput(servicePath, previousService, currentService)).toBe(
    'windows_native_bootstrap_source_entry',
  );
  expect(
    matchTerminalPredecessorInput('bun.lock', previousService, currentService),
  ).toBeUndefined();
  for (const changed of [
    text.replace('"hono": "4.13.12"', '"hono": "4.13.13"'),
    text.replace('"exports": {', '"exports": {\n    "./unknown": "./src/unknown.ts",'),
    text.replace('    "./windows-native-bootstrap": "./src/windows-native-bootstrap.ts",\n', ''),
    text.replace(' ./src/windows-native-bootstrap.ts ', ' '),
    text.replace('--target=bun', '--target=node'),
    text.replace('"version": "0.1.0"', '"version": "0.1.1"'),
  ]) {
    expect(changed).not.toBe(text);
    expect(
      matchTerminalPredecessorInput(servicePath, previousService, bytes(changed)),
    ).toBeUndefined();
  }
});

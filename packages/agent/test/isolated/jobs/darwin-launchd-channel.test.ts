import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Darwin startup closes every accepted socket when authentication crosses the original ready deadline', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./darwin-launchd-channel.fixture.ts', import.meta.url)),
      'shell',
      'auth-held-timeout',
    ],
    { encoding: 'utf8', timeout: 7000, maxBuffer: 1024 * 1024 },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain('"authenticationPending":true');
  expect(result.stdout).toContain('"closeCompleted":true');
  expect(result.stdout).toContain('"destroyed":[true,true,true]');
  expect(result.stdout).toContain('"noNativeSpawn":true');
  expect(result.stdout).toContain('"lateAuthenticationCompleted":true');
  expect(result.stdout).toContain('"businessWrites":0');
  expect(result.stdout).toContain('"unhandled":0');
}, 8000);

for (const kind of ['browser', 'mcp', 'shell']) {
  for (const mode of [
    'extra',
    'partial',
    'duplicate',
    'bad-json',
    'invalid-utf8',
    'error',
    'close-only',
    'no-terminal',
    'valid',
    'delayed-handler',
    'no-eof',
    'no-close',
    'eof-half-close',
    'split-utf8',
  ]) {
    test(`shared Darwin ${kind} channel requires one complete terminal and clean EOF (${mode})`, () => {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./darwin-launchd-channel.fixture.ts', import.meta.url)),
          kind,
          mode,
        ],
        { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('"noNativeSpawn":true');
    }, 6000);
  }
}

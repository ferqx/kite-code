import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runFixture(kind: string, mode: string, timeout = 5000) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./darwin-launchd-channel.fixture.ts', import.meta.url)), kind, mode],
    { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain('"noNativeSpawn":true');
  return result.stdout;
}

test.each([
  ['mcp', 'auth-held-timeout', 'launchd_guardian_start_timeout'],
  ['shell', 'auth-cancelled', 'launchd_start_cancelled'],
  ['shell', 'auth-cancel-cleanup-unconfirmed', 'launchd_start_cleanup_unconfirmed'],
])(
  'Darwin %s startup closes every accepted socket when authentication is interrupted (%s)',
  (kind, mode, cause) => {
    const output = runFixture(kind, mode, 7000);
    expect(output).toContain(`"error":"${cause}"`);
    expect(output).toContain('"authenticationPending":true');
    expect(output).toContain('"closeCompleted":true');
    expect(output).toContain('"destroyed":[true,true,true]');
    expect(output).toContain('"lateAuthenticationCompleted":true');
    expect(output).toContain('"businessWrites":0');
    expect(output).toContain('"unhandled":0');
  },
  8000,
);

test('Darwin Shell startup tolerates authentication beyond four seconds', () => {
  const output = runFixture('shell', 'auth-slow', 7000);
  expect(output).toContain('"terminalDelivered":true');
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
      runFixture(kind, mode);
    }, 6000);
  }
}

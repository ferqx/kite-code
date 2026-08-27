import { describe, expect, test } from 'bun:test';
import { resolveNativeServiceSpawnCommand } from '../../src/manager/native-spawn-command';

describe('Kite Service Native spawn command', () => {
  test('runs a Windows source entry through the current Bun runtime', () => {
    expect(
      resolveNativeServiceSpawnCommand(
        { path: String.raw`D:\repo\service.ts`, mode: 'source', buildId: 'dev:test' },
        ['service', 'run'],
        'win32',
        String.raw`C:\bun\bun.exe`,
      ),
    ).toEqual({
      command: String.raw`C:\bun\bun.exe`,
      args: [String.raw`D:\repo\service.ts`, 'service', 'run'],
    });
  });

  test.each([
    ['linux', 'source'],
    ['darwin', 'source'],
    ['win32', 'installed'],
  ] as const)('executes %s %s artifacts directly', (platform, mode) => {
    const path = mode === 'installed' ? String.raw`C:\kite\kite-service.exe` : '/repo/service.ts';
    expect(
      resolveNativeServiceSpawnCommand(
        { path, mode, buildId: 'build:test' },
        ['service', 'run'],
        platform,
        '/runtime/bun',
      ),
    ).toEqual({ command: path, args: ['service', 'run'] });
  });
});

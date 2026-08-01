import { describe, expect, test } from 'bun:test';
import {
  BUBBLEWRAP_USABILITY_PROBE_ARGS,
  selectSandboxBackend,
  usableBubblewrapPath,
} from '@/core/sandbox/platform';

describe('platform backend exclusion projection', () => {
  test.each([
    ['darwin', true, null, 'seatbelt'],
    ['darwin', false, '/usr/bin/bwrap', 'none'],
    ['linux', true, '/usr/bin/bwrap', 'bubblewrap'],
    ['linux', true, null, 'none'],
    ['win32', true, '/usr/bin/bwrap', 'none'],
  ] as const)('%s selects only its accepted candidate backend', (platform, seatbeltAvailable, bubblewrapPath, expected) => {
    expect(
      selectSandboxBackend({
        platform,
        seatbeltAvailable,
        usableBubblewrapPath: bubblewrapPath,
      }),
    ).toBe(expected);
  });

  test('binary discovery is not enough when the namespace probe fails', () => {
    const commands: readonly string[][] = [];
    const unavailable = usableBubblewrapPath('/usr/bin/bwrap', (command) => {
      (commands as string[][]).push([...command]);
      return 1;
    });

    expect(unavailable).toBeNull();
    expect(commands).toEqual([['/usr/bin/bwrap', ...BUBBLEWRAP_USABILITY_PROBE_ARGS]]);
  });

  test('a successful namespace probe retains the exact candidate path', () => {
    expect(usableBubblewrapPath('/custom/bwrap', () => 0)).toBe('/custom/bwrap');
    expect(usableBubblewrapPath(null, () => 0)).toBeNull();
  });
});

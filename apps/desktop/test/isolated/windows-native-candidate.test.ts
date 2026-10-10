import { expect, test } from 'bun:test';
import { parseWindowsNativeHandoff } from '../../electron/windows-native-candidate';

test('Main accepts one closed pair of private certificate addresses and rejects ambiguous or malformed admission', () => {
  const handoff = {
    launcherPipe: String.raw`\\.\pipe\kite-native-launch-${'a'.repeat(32)}`,
    mainPipe: String.raw`\\.\pipe\kite-native-main-${'b'.repeat(32)}`,
  };
  const parameter = `--kite-native-handoff=${JSON.stringify(handoff)}`;
  expect(parseWindowsNativeHandoff(['electron', 'app', parameter])).toEqual(handoff);
  expect(Object.isFrozen(parseWindowsNativeHandoff([parameter]))).toBe(true);
  for (const argv of [
    [],
    [parameter, parameter],
    ['--kite-native-handoff'],
    ['--kite-native-handoff={'],
    [`--kite-native-handoff=${JSON.stringify({ ...handoff, pid: 42 })}`],
    [`--kite-native-handoff=${JSON.stringify({ ...handoff, launcherPipe: handoff.mainPipe })}`],
    [`--kite-native-handoff=${JSON.stringify({ ...handoff, mainPipe: `${handoff.mainPipe}x` })}`],
  ])
    expect(() => parseWindowsNativeHandoff(argv)).toThrow('native_windows_bootstrap_unqualified');
});

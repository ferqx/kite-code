import { expect, test } from 'bun:test';
import {
  type NativeShellProcessIdentity,
  scanNativeShellOwned,
} from '../native-shell-observation.fixture';

test('an unreadable live candidate helper blocks scoped cleanup confirmation', () => {
  const identity: NativeShellProcessIdentity = {
    pid: 42,
    unique: 'original-helper',
    version: 1,
    coalition: 'owned',
    parent: 10,
    processGroup: 10,
    executable: '/owned/native/helper',
  };
  let readable = false,
    alive = true;
  const scan = () =>
    scanNativeShellOwned([42, 43, 44], [], ['/owned/native'], {
      uid: 501,
      incarnation: () => undefined,
      preExisting: new Map(),
      executable(pid) {
        return pid === 42 ? identity.executable : pid === 43 ? '/other/app' : undefined;
      },
      uidOf: () => 0,
      observe: () => (readable ? identity : undefined),
      mayBeAlive: () => alive,
    });
  expect(scan()).toEqual({ identities: [], unconfirmed: [42] });
  readable = true;
  expect(scan()).toEqual({ identities: [identity], unconfirmed: [] });
  readable = false;
  alive = false;
  expect(scan()).toEqual({ identities: [], unconfirmed: [] });
});

test('an unreadable path or UID stays unconfirmed until absence is independently established', () => {
  const scanned: number[] = [],
    result = scanNativeShellOwned([1, 50, 51, 52], [], ['/owned/native'], {
      uid: 501,
      incarnation: () => undefined,
      preExisting: new Map(),
      executable: () => undefined,
      uidOf: (pid) => (pid === 50 ? 501 : undefined),
      observe: () => undefined,
      mayBeAlive(pid) {
        scanned.push(pid);
        return pid !== 52;
      },
    });
  expect(result).toEqual({ identities: [], unconfirmed: [50, 51] });
  expect(scanned).toEqual([50, 51, 52]);
});

test('only the unchanged pre-existing kernel incarnation excludes an unreadable path', () => {
  const original = { pid: 60, unique: 'before-fixture', version: 1 };
  let current: typeof original | undefined = original;
  const scan = () =>
    scanNativeShellOwned([60], [], ['/owned/native'], {
      uid: 501,
      executable: () => undefined,
      uidOf: () => 501,
      incarnation: () => current,
      preExisting: new Map([[60, original]]),
      observe: () => undefined,
      mayBeAlive: () => true,
    });
  expect(scan()).toEqual({ identities: [], unconfirmed: [] });
  current = { ...original, unique: 'reused-pid' };
  expect(scan()).toEqual({ identities: [], unconfirmed: [60] });
  current = { ...original, version: 2 };
  expect(scan()).toEqual({ identities: [], unconfirmed: [60] });
  current = undefined;
  expect(scan()).toEqual({ identities: [], unconfirmed: [60] });
});

test('a readable owned path is never excluded by the pre-existing snapshot', () => {
  const identity: NativeShellProcessIdentity = {
    pid: 61,
    unique: 'before-fixture',
    version: 1,
    coalition: 'owned',
    parent: 10,
    processGroup: 10,
    executable: '/owned/native/helper',
  };
  expect(
    scanNativeShellOwned([61], [], ['/owned/native'], {
      uid: 501,
      executable: () => identity.executable,
      uidOf: () => 501,
      incarnation: () => identity,
      preExisting: new Map([[61, identity]]),
      observe: () => undefined,
      mayBeAlive: () => true,
    }),
  ).toEqual({ identities: [], unconfirmed: [61] });
});

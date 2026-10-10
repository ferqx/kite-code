import { expect, test } from 'bun:test';
import {
  decodeLinuxShellProcessEvidence,
  decodeShellProcessEvidence,
  type LinuxShellProcessEvidence,
  shellProcessEvidenceEnded,
} from '../../../src/jobs/shell';

function terminal(): LinuxShellProcessEvidence {
  return {
    version: 2,
    coverage: 'shell-owned-pid-namespace',
    binding: { sessionId: 'session', executionId: 'execution', nonce: 'original-nonce' },
    owner: {
      version: 1,
      coverage: 'linux-pid-namespace',
      ownerPid: 41000,
      admission: { nonce: 'original-nonce', mode: 'workspace' },
      wrapper: {
        pid: 41001,
        birth: '1001',
        parentPid: 41000,
        exit: { code: 0, signal: null, reaped: true },
        closed: true,
        stdoutEof: true,
        stderrEof: true,
      },
      namespace: {
        dev: '7',
        ino: '71',
        init: { pid: 41002, birth: '1002', parentPid: 41001, localPid: 1, dead: true },
        root: {
          pid: 41003,
          birth: '1003',
          parentPid: 41002,
          localPid: 2,
          dead: true,
          waitReceipt: {
            localPid: 2,
            code: 23,
            signal: null,
            rawStatus: 23 * 256,
            waitConfirmed: true,
            reaped: true,
          },
        },
        treeStopped: true,
      },
      phase: 'terminal',
      fdClosed: true,
      closeUnknown: false,
    },
  };
}
test('public cold decoder preserves the original Linux receipt in an independent frozen snapshot', () => {
  const original = terminal();
  const decoded = decodeShellProcessEvidence(original, original.binding, 41000);
  expect(decoded).toEqual(original);
  expect(decoded?.version).toBe(2);
  expect(shellProcessEvidenceEnded(decoded!)).toBe(true);
  expect(Object.isFrozen(decoded)).toBe(true);
  expect(
    Object.isFrozen((decoded as LinuxShellProcessEvidence).owner.namespace!.root!.waitReceipt),
  ).toBe(true);
  original.owner.namespace!.root!.waitReceipt!.code = 0;
  expect((decoded as LinuxShellProcessEvidence).owner.namespace!.root!.waitReceipt!.code).toBe(23);
});
test('a reaped business tree cannot replace init death, wrapper close, stream EOF or strict FD closure', () => {
  for (const change of [
    (value: LinuxShellProcessEvidence) => {
      value.owner.namespace!.init.dead = false;
    },
    (value: LinuxShellProcessEvidence) => {
      value.owner.wrapper.closed = false;
    },
    (value: LinuxShellProcessEvidence) => {
      value.owner.wrapper.stdoutEof = false;
      value.owner.wrapper.closed = false;
    },
    (value: LinuxShellProcessEvidence) => {
      value.owner.fdClosed = false;
      value.owner.closeUnknown = true;
    },
  ]) {
    const value = terminal();
    change(value);
    expect(decodeLinuxShellProcessEvidence(value, value.binding, 41000)).toBeUndefined();
    value.owner.phase = 'unknown';
    const decoded = decodeLinuxShellProcessEvidence(value, value.binding, 41000);
    expect(decoded).toBeDefined();
    expect(shellProcessEvidenceEnded(decoded!)).toBe(false);
  }
});
test('foreign bindings, extra fields and a mismatched raw wait status never become an ended receipt', () => {
  const value = terminal();
  expect(
    decodeShellProcessEvidence(value, { ...value.binding, nonce: 'foreign' }, 41000),
  ).toBeUndefined();
  expect(decodeShellProcessEvidence(value, value.binding, 41009)).toBeUndefined();
  expect(decodeShellProcessEvidence({ ...value, pid: 41003 }, value.binding)).toBeUndefined();
  value.owner.namespace!.root!.waitReceipt!.rawStatus |= 0x80;
  expect(decodeShellProcessEvidence(value, value.binding)).toBeUndefined();
  value.owner.namespace!.root!.waitReceipt = {
    localPid: 2,
    code: null,
    signal: 9,
    rawStatus: 9,
    waitConfirmed: true,
    reaped: true,
  };
  expect(decodeShellProcessEvidence(value, value.binding)).toBeDefined();
  value.owner.namespace!.root!.waitReceipt.rawStatus |= 0x100;
  expect(decodeShellProcessEvidence(value, value.binding)).toBeUndefined();
});

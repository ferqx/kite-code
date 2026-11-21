import { expect, test } from 'bun:test';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  configureMacosElectronResize,
  macosElectronResize,
  verifyMacosElectronFramework,
} from '../../electron/macos-electron-resize';

test('a null pairing proof is inert, including after app readiness', () => {
  const app = {
    isReady() {
      throw Error('must_not_observe_app');
    },
    commandLine: {
      getSwitchValue() {
        throw Error('must_not_observe_switch');
      },
      appendSwitch() {
        throw Error('must_not_write_switch');
      },
    },
  };
  expect(() => configureMacosElectronResize(app, null)).not.toThrow();
});

test('paired resize configuration refuses readiness before doing identity work', () => {
  const app = {
    isReady: () => true,
    commandLine: {
      getSwitchValue() {
        throw Error('must_not_observe_switch');
      },
      appendSwitch() {
        throw Error('must_not_write_switch');
      },
    },
  };
  expect(() => configureMacosElectronResize(app, { frameworkSha256: 'a'.repeat(64) })).toThrow(
    'macos_electron_resize_configuration_too_late',
  );
});

function identityFailure(data: Buffer, kind: 'patched' | 'patched-after-signing') {
  try {
    verifyMacosElectronFramework(data, kind);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error.message;
  }
  return undefined;
}

test('post-sign diagnostics reject truncated data with the first size check and no bytes', () => {
  const data = Buffer.from('private fixture data');
  expect(identityFailure(data, 'patched')).toBe('macos_electron_resize_identity_invalid');
  expect(identityFailure(data, 'patched-after-signing')).toBe(
    `macos_electron_resize_identity_invalid:post_sign_layout:framework_bytes_gt:expected=${macosElectronResize.signatureOffset}:actual=${data.length}`,
  );
});

test.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'fixed framework verifier rejects stock, partial patches, wrong UUID, payload drift and signature boundary drift',
  () => {
    const require = createRequire(import.meta.url);
    const dist = realpathSync(join(dirname(require.resolve('electron/package.json')), 'dist'));
    const data = readFileSync(join(dist, macosElectronResize.framework));
    expect(() => verifyMacosElectronFramework(data, 'original')).not.toThrow();
    expect(() => verifyMacosElectronFramework(data, 'patched')).toThrow('identity_invalid');
    const first = macosElectronResize.patches[0]!;
    Buffer.from(first.patched, 'hex').copy(data, first.offset);
    expect(() => verifyMacosElectronFramework(data, 'patched')).toThrow('identity_invalid');
    const second = macosElectronResize.patches[1]!;
    Buffer.from(second.patched, 'hex').copy(data, second.offset);
    expect(() => verifyMacosElectronFramework(data, 'patched')).not.toThrow();
    // Every unapproved header and __LINKEDIT payload byte remains covered.
    for (const offset of [4, 0xe20, macosElectronResize.signatureOffset - 1]) {
      data[offset] = data[offset]! ^ 1;
      expect(identityFailure(data, 'patched')).toBe('macos_electron_resize_identity_invalid');
      expect(identityFailure(data, 'patched-after-signing')).toBe(
        'macos_electron_resize_identity_invalid',
      );
      data[offset] = data[offset]! ^ 1;
    }
    const signatureSize = data.readUInt32LE(0x274c);
    const linkeditSize = data.readBigUInt64LE(0xd00);
    data.writeUInt32LE(signatureSize - 1, 0x274c);
    data.writeBigUInt64LE(linkeditSize - 1n, 0xd00);
    expect(identityFailure(data, 'patched')).toBe('macos_electron_resize_identity_invalid');
    expect(identityFailure(data, 'patched-after-signing')).toBe(
      `macos_electron_resize_identity_invalid:post_sign_layout:signature_bytes:expected=${signatureSize}:actual=${signatureSize - 1}`,
    );
    data.writeUInt32LE(signatureSize, 0x274c);
    expect(identityFailure(data, 'patched-after-signing')).toBe(
      `macos_electron_resize_identity_invalid:post_sign_layout:linkedit_file_bytes:expected=${linkeditSize}:actual=${linkeditSize - 1n}`,
    );
    data.writeBigUInt64LE(linkeditSize, 0xd00);
    const vmSize = data.readBigUInt64LE(0xcf0);
    data.writeBigUInt64LE(vmSize - 1n, 0xcf0);
    expect(identityFailure(data, 'patched-after-signing')).toBe(
      `macos_electron_resize_identity_invalid:post_sign_layout:linkedit_vm_bytes:expected=${vmSize}:actual=${vmSize - 1n}`,
    );
    data.writeBigUInt64LE(vmSize, 0xcf0);
    expect(() => verifyMacosElectronFramework(data, 'patched')).not.toThrow();
    expect(() => verifyMacosElectronFramework(data, 'patched-after-signing')).not.toThrow();
  },
);

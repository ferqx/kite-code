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
      expect(() => verifyMacosElectronFramework(data, 'patched')).toThrow('identity_invalid');
      data[offset] = data[offset]! ^ 1;
    }
    const signatureSize = data.readUInt32LE(0x274c);
    data.writeUInt32LE(signatureSize - 1, 0x274c);
    expect(() => verifyMacosElectronFramework(data, 'patched')).toThrow('identity_invalid');
    data.writeUInt32LE(signatureSize, 0x274c);
    expect(() => verifyMacosElectronFramework(data, 'patched')).not.toThrow();
  },
);

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export type MacosElectronResize = { readonly frameworkSha256: string };

export const macosElectronResize = Object.freeze({
  version: '44.3.0',
  framework:
    'Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
  executable: 'Electron.app/Contents/MacOS/Electron',
  originalSha256: '8c8ba438c3b55fab5a1f5d0d43a9d149a504936eccc1cadb17b90b534faff74f',
  originalBytes: 201596784,
  signatureOffset: 200033856,
  // Original payload includes all load commands and __LINKEDIT up to the signature.
  originalPayloadSha256: '79474043a869ab80769c3aad80af2c51598275ec72432fca6171b9d7533b9cab',
  patches: Object.freeze([
    Object.freeze({ offset: 0x4d5186c, original: '091440f9', patched: '05f75c17' }),
    Object.freeze({ offset: 0x6bd6d64, original: 'e0000035', patched: '01000014' }),
  ]),
});

const signatureFields = [
  { offset: 0xcf0, bytes: 8, original: 3702784 }, // __LINKEDIT vmsize
  { offset: 0xd00, bytes: 8, original: 3694448 }, // __LINKEDIT filesize
  { offset: 0x274c, bytes: 4, original: 1562928 }, // LC_CODE_SIGNATURE datasize
] as const;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fail(): never {
  throw Error('macos_electron_resize_identity_invalid');
}

/** Validate the entire reviewed payload, including __LINKEDIT, not just two instructions.
 * Only codesign's three size fields and existing signature allocation may vary. */
export function verifyMacosElectronFramework(data: Buffer, kind: 'original' | 'patched'): void {
  if (kind === 'original') {
    if (
      data.length !== macosElectronResize.originalBytes ||
      sha(data) !== macosElectronResize.originalSha256
    )
      fail();
    return;
  }
  const signatureOffset = macosElectronResize.signatureOffset;
  if (
    data.length <= signatureOffset ||
    data.length > macosElectronResize.originalBytes ||
    data.readUInt32LE(0x2740) !== 0x1d ||
    data.readUInt32LE(0x2744) !== 16 ||
    data.readUInt32LE(0x2748) !== signatureOffset ||
    data.readUInt32LE(0x274c) !== data.length - signatureOffset ||
    data.readBigUInt64LE(0xd00) !== BigInt(data.length - 197902336) ||
    data.readBigUInt64LE(0xcf0) !== BigInt(Math.ceil((data.length - 197902336) / 16384) * 16384)
  )
    fail();
  for (const patch of macosElectronResize.patches)
    if (data.subarray(patch.offset, patch.offset + 4).toString('hex') !== patch.patched) fail();
  const replacements = [
    ...signatureFields.map((field) => {
      const bytes = Buffer.alloc(field.bytes);
      if (field.bytes === 8) bytes.writeBigUInt64LE(BigInt(field.original));
      else bytes.writeUInt32LE(field.original);
      return { offset: field.offset, bytes };
    }),
    ...macosElectronResize.patches.map((patch) => ({
      offset: patch.offset,
      bytes: Buffer.from(patch.original, 'hex'),
    })),
  ].sort((a, b) => a.offset - b.offset);
  const hash = createHash('sha256');
  let cursor = 0;
  for (const replacement of replacements) {
    hash.update(data.subarray(cursor, replacement.offset));
    hash.update(replacement.bytes);
    cursor = replacement.offset + replacement.bytes.length;
  }
  hash.update(data.subarray(cursor, signatureOffset));
  if (hash.digest('hex') !== macosElectronResize.originalPayloadSha256) fail();
}

export function macosElectronFrameworkPath(executable: string): string {
  const actual = realpathSync(executable);
  if (
    actual !== resolve(executable) ||
    basename(actual) !== 'Electron' ||
    basename(dirname(actual)) !== 'MacOS' ||
    basename(dirname(dirname(actual))) !== 'Contents'
  )
    fail();
  const framework = join(
    dirname(actual),
    '../Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
  );
  const stat = lstatSync(framework);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    realpathSync(framework) !== framework
  )
    fail();
  return framework;
}

interface ResizeApp {
  isReady(): boolean;
  commandLine: {
    getSwitchValue(name: string): string;
    appendSwitch(name: string, value: string): void;
  };
}
const featureName = (value: string) => value.trim().split(/[:<]/u, 1)[0];

/** A null proof is deliberately inert for generic app-only test builds. */
export function configureMacosElectronResize(
  app: ResizeApp,
  proof: MacosElectronResize | null,
): void {
  if (proof === null) return;
  if (app.isReady()) throw Error('macos_electron_resize_configuration_too_late');
  if (
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
    process.versions.electron !== macosElectronResize.version ||
    !proof ||
    Object.keys(proof).length !== 1 ||
    !/^[a-f0-9]{64}$/u.test(proof.frameworkSha256)
  )
    fail();
  const framework = macosElectronFrameworkPath(process.execPath);
  // Node's read-only report provides dyld's actual loaded paths without a native addon.
  // Never serialize the report: it also contains unrelated process/environment data.
  const report = process.report?.getReport();
  const sharedObjects =
    report && typeof report === 'object' && 'sharedObjects' in report
      ? report.sharedObjects
      : undefined;
  if (!Array.isArray(sharedObjects)) fail();
  const loaded = [
    ...new Set(
      sharedObjects
        .filter(
          (path): path is string =>
            typeof path === 'string' && basename(path) === 'Electron Framework',
        )
        .map((path) => realpathSync(path)),
    ),
  ];
  if (loaded.length !== 1 || loaded[0] !== framework) fail();
  const data = readFileSync(framework);
  if (sha(data) !== proof.frameworkSha256) fail();
  verifyMacosElectronFramework(data, 'patched');
  const disabled = app.commandLine.getSwitchValue('disable-features').split(',');
  if (disabled.some((value) => featureName(value) === 'CATransactionV2'))
    throw Error('macos_electron_resize_feature_conflict');
  const enabled = app.commandLine
    .getSwitchValue('enable-features')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!enabled.some((value) => featureName(value) === 'CATransactionV2'))
    enabled.push('CATransactionV2');
  app.commandLine.appendSwitch('enable-features', enabled.join(','));
}

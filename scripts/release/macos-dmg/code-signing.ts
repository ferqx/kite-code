import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';

const codesign = '/usr/bin/codesign';
const machOMagic = new Set([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcafebabf]);
const jitEntitlements = join(import.meta.dirname, 'jit.entitlements');

function run(executable: string, args: string[]) {
  return execFileSync(executable, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

export function assertDeveloperIdIdentity(identity: string) {
  if (!/^[a-fA-F0-9]{40}$/u.test(identity)) throw Error('macos_dmg_signing_identity_invalid');
  const identities = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  if (
    !identities.split('\n').some((line) => {
      const match = /^\s*\d+\) ([A-F0-9]{40}) "Developer ID Application: /u.exec(line);
      return match?.[1] === identity.toUpperCase();
    })
  )
    throw Error('macos_dmg_developer_id_unavailable');
}

function isMachO(path: string) {
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(4);
    return (
      readSync(fd, header, 0, header.length, 0) === header.length &&
      (machOMagic.has(header.readUInt32LE()) || machOMagic.has(header.readUInt32BE()))
    );
  } finally {
    closeSync(fd);
  }
}

export function createMacosCodeSigner(identity: string, entitlements = jitEntitlements) {
  const signature = [
    '--force',
    '--sign',
    identity,
    identity === '-' ? '--timestamp=none' : '--timestamp',
  ];
  function sign(path: string, role: 'runtime' | 'code' | 'electron') {
    run(codesign, [
      ...signature,
      ...(role === 'runtime' ? ['--identifier', 'com.kitecode.desktop.service-runtime'] : []),
      '--options',
      'runtime',
      ...(role === 'code' ? [] : ['--entitlements', entitlements]),
      path,
    ]);
  }
  function verifyApp(path: string) {
    run(codesign, ['--verify', '--deep', '--strict', path]);
  }
  function signElectron(app: string) {
    const bundles: { path: string; executable: string; role: 'code' | 'electron' }[] = [];
    const files: string[] = [];
    function scan(directory: string) {
      for (const name of readdirSync(directory).sort()) {
        const path = join(directory, name);
        const stat = lstatSync(path);
        if (stat.isDirectory()) scan(path);
        else if (stat.isFile() && stat.size >= 4 && isMachO(path)) files.push(path);
      }
      if (directory.endsWith('.app')) {
        const plist = join(directory, 'Contents/Info.plist');
        const metadata = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]));
        const name: unknown = metadata.CFBundleExecutable ?? basename(directory, '.app');
        if (typeof name !== 'string' || !name || name !== basename(name))
          throw Error('macos_dmg_bundle_executable_invalid');
        const executable = realpathSync(join(directory, 'Contents/MacOS', name));
        if (metadata.CFBundleExecutable === undefined)
          run('/usr/bin/plutil', ['-insert', 'CFBundleExecutable', '-string', name, plist]);
        bundles.push({
          path: directory,
          executable,
          role: 'electron',
        });
      } else if (directory.endsWith('.framework')) {
        const name = basename(directory, '.framework');
        bundles.push({
          path: directory,
          executable: realpathSync(join(directory, name)),
          role: 'code',
        });
      }
    }
    scan(app);
    const bundleExecutables = new Set(bundles.map(({ executable }) => executable));
    for (const file of files) if (!bundleExecutables.has(file)) sign(file, 'code');
    for (const bundle of bundles) sign(bundle.path, bundle.role);
    verifyApp(app);
  }
  function signImage(path: string) {
    run(codesign, [...signature, '--identifier', 'com.kitecode.desktop.dmg', path]);
  }
  return { sign, signElectron, signImage, verifyApp };
}

export type MacosCodeSigner = ReturnType<typeof createMacosCodeSigner>;

export function notarizeMacosImage(path: string, profile: string): string {
  const options = ['--keychain-profile', profile, '--output-format', 'json'];
  const receipt = JSON.parse(run('/usr/bin/xcrun', ['notarytool', 'submit', path, ...options]));
  const id: unknown = receipt.id;
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/iu.test(id))
    throw Error('macos_dmg_notary_receipt_invalid');
  process.stderr.write(`Apple notarization submission ${id}\n`);
  const result = JSON.parse(
    run('/usr/bin/xcrun', ['notarytool', 'wait', id, '--timeout', '30m', ...options]),
  );
  if (result.id !== id || result.status !== 'Accepted') {
    process.stderr.write(`Apple notarization status for ${id}: ${String(result.status)}\n`);
    throw Error('macos_dmg_notarization_not_accepted');
  }
  run('/usr/bin/xcrun', ['stapler', 'staple', path]);
  run('/usr/bin/xcrun', ['stapler', 'validate', path]);
  run(codesign, ['--verify', '--strict', path]);
  run('/usr/sbin/spctl', [
    '--assess',
    '--type',
    'open',
    '--context',
    'context:primary-signature',
    path,
  ]);
  return id;
}

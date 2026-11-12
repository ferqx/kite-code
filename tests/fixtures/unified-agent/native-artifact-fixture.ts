/** Small integrity-only fixture, never executable/product/Electron qualification. */
import { createHash } from 'node:crypto';
import { symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type NativeBundleManifest,
  nativeBundleEntries,
  windowsNativeElectronResources,
} from '@kite-ai/service/native-runtime-assets';
import {
  type TerminalBundleManifest,
  terminalBundleEntries,
} from '@kite-ai/service/runtime-assets';
import {
  windowsNativeVerifierChecksumPath,
  windowsTerminalVerifierPath,
} from '../../../scripts/release/windows-verifier-assets';
import { privateDirectory } from '../test-filesystem';

import { fixtureNativeSqlite, fixtureTerminalSqlite } from './sqlite-engine-fixture';
export const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function finiteNativeFixture(
  parent: string,
  name = 'candidate',
  windowsVerifier: 'legacy' | 'shared' | 'bad-checksum' = 'legacy',
) {
  const root = join(parent, name),
    terminal = join(root, 'terminal');
  privateDirectory(terminal);
  const innerEntries = terminalBundleEntries(process.platform),
    innerFiles: TerminalBundleManifest['files'][number][] = [];
  for (const path of Object.values(innerEntries)) {
    const bytes = Buffer.from(path),
      mode = path === innerEntries.runtime ? 493 : 420;
    privateDirectory(dirname(join(terminal, path)));
    writeFileSync(join(terminal, path), bytes, { mode });
    innerFiles.push({ path, size: bytes.length, sha256: hash(bytes), mode });
  }
  const sqlite = fixtureTerminalSqlite(terminal, innerFiles);
  if (process.platform === 'win32' && windowsVerifier !== 'legacy') {
    const verifier = innerFiles.find((file) => file.path === windowsTerminalVerifierPath)!;
    const path = windowsNativeVerifierChecksumPath;
    const bytes = Buffer.from(
      `${windowsVerifier === 'shared' ? verifier.sha256 : '0'.repeat(64)}\n`,
    );
    writeFileSync(join(terminal, path), bytes);
    innerFiles.push({ path, size: bytes.length, sha256: hash(bytes), mode: 420 });
  }
  const inner: TerminalBundleManifest = {
    version: 1,
    apiMajor: 1,
    target: { platform: process.platform, arch: process.arch },
    bunVersion: Bun.version,
    sqlite,
    productVersion: '0.1.0',
    source: { commit: 'a'.repeat(40), dirty: true },
    entries: innerEntries,
    files: innerFiles,
    links: [],
  };
  const terminalBytes = Buffer.from(JSON.stringify(inner));
  writeFileSync(join(terminal, 'terminal-manifest.json'), terminalBytes, { mode: 0o644 });
  const entries = nativeBundleEntries(process.platform),
    files: NativeBundleManifest['files'][number][] = [];
  for (const path of [
    ...Object.values(entries),
    'electron/version',
    '.use-terminal.lock',
    'electron/framework/actual',
    ...(process.platform === 'win32'
      ? [
          'app/kite.exe',
          'app/kite-tui.exe',
          'app/kite-desktop.exe',
          ...(windowsVerifier === 'legacy' ? ['app/native-verifier.exe'] : []),
          ...windowsNativeElectronResources,
        ]
      : []),
  ]) {
    const bytes = Buffer.from(
        path === '.use-terminal.lock'
          ? ''
          : path === 'electron/version'
            ? '44.3.0'
            : path === entries.package
              ? JSON.stringify({ name: 'kite-native', version: '0.1.0', main: 'main.cjs' })
              : path,
      ),
      mode =
        path === '.use-terminal.lock'
          ? 384
          : path === entries.electron || path.endsWith('.exe')
            ? 493
            : 420;
    privateDirectory(dirname(join(root, path)));
    writeFileSync(join(root, path), bytes, { mode });
    files.push({ path, size: bytes.length, sha256: hash(bytes), mode });
  }
  if (process.platform !== 'win32') symlinkSync('framework', join(root, 'electron/current'));
  privateDirectory(join(root, 'electron/empty-locale'));
  const manifest: NativeBundleManifest = {
    version: 1,
    apiMajor: 1,
    target: { platform: process.platform, arch: process.arch },
    electronVersion: '44.3.0',
    sqlite: fixtureNativeSqlite,
    terminalRoot: 'terminal',
    terminalManifestSha256: hash(terminalBytes),
    entries,
    files,
    links: process.platform === 'win32' ? [] : [{ path: 'electron/current', target: 'framework' }],
    directories: ['electron/empty-locale'],
  };
  writeFileSync(join(root, 'native-manifest.json'), JSON.stringify(manifest), { mode: 0o644 });
  return root;
}

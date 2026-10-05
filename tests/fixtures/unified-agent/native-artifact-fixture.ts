/** Small integrity-only fixture, never executable/product/Electron qualification. */
import { createHash } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type NativeBundleManifest,
  nativeBundleEntries,
} from '@kite-ai/service/native-runtime-assets';
import {
  type TerminalBundleManifest,
  terminalBundleEntries,
} from '@kite-ai/service/runtime-assets';
import { fixtureNativeSqlite, fixtureTerminalSqlite } from './sqlite-engine-fixture';
export const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function finiteNativeFixture(parent: string, name = 'candidate') {
  const root = join(parent, name),
    terminal = join(root, 'terminal');
  mkdirSync(terminal, { recursive: true, mode: 0o700 });
  const innerEntries = terminalBundleEntries(process.platform),
    innerFiles: TerminalBundleManifest['files'][number][] = [];
  for (const path of Object.values(innerEntries)) {
    const bytes = Buffer.from(path),
      mode = path === innerEntries.runtime ? 493 : 420;
    mkdirSync(dirname(join(terminal, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(terminal, path), bytes, { mode });
    innerFiles.push({ path, size: bytes.length, sha256: hash(bytes), mode });
  }
  const inner: TerminalBundleManifest = {
    version: 1,
    apiMajor: 1,
    target: { platform: process.platform, arch: process.arch },
    bunVersion: Bun.version,
    sqlite: fixtureTerminalSqlite(terminal, innerFiles),
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
      mode = path === '.use-terminal.lock' ? 384 : path === entries.electron ? 493 : 420;
    mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, path), bytes, { mode });
    files.push({ path, size: bytes.length, sha256: hash(bytes), mode });
  }
  symlinkSync('framework', join(root, 'electron/current'));
  mkdirSync(join(root, 'electron/empty-locale'), { mode: 0o700 });
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
    links: [{ path: 'electron/current', target: 'framework' }],
    directories: ['electron/empty-locale'],
  };
  writeFileSync(join(root, 'native-manifest.json'), JSON.stringify(manifest), { mode: 0o644 });
  return root;
}

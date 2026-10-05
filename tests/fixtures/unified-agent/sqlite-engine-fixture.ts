/** Integrity-only metadata. Fake library bytes never qualify an executable SQLite engine. */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type TerminalBundleManifest,
  terminalHostEntrypoints,
} from '@kite-ai/service/runtime-assets';
import {
  reviewedSqliteSources,
  terminalSqliteEngineRoot,
} from '@kite-ai/service/sqlite-release-assets';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function fixtureTerminalSqlite(
  root: string,
  files: TerminalBundleManifest['files'][number][],
): TerminalBundleManifest['sqlite'] {
  const directory = join(root, terminalSqliteEngineRoot);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'entrypoints'), { recursive: true, mode: 0o700 });
  for (const path of terminalHostEntrypoints) {
    const bytes = Buffer.from(`integrity-only inert entry ${path}`);
    writeFileSync(join(root, path), bytes, { mode: 0o644 });
    chmodSync(join(root, path), 0o644);
    files.push({ path, size: bytes.length, sha256: sha(bytes), mode: 420 });
  }
  const sqlite = { version: '3.51.3', sourceId: reviewedSqliteSources['3.51.3'] };
  const library = Buffer.from('integrity-only fake SQLite library');
  const manifest = Buffer.from(
    JSON.stringify({
      version: 1,
      driver: 'bun:sqlite',
      target: { platform: process.platform, arch: process.arch },
      ...(process.platform === 'darwin'
        ? { library: 'libsqlite3.dylib', size: library.length, sha256: sha(library) }
        : { linkage: 'builtin' }),
      sqlite,
    }),
  );
  const manifestSha256 = sha(manifest);
  for (const [name, bytes] of [
    ['engine-manifest.json', manifest],
    ['engine-selection.json', Buffer.from(JSON.stringify({ version: 1, manifestSha256 }))],
    ...(process.platform === 'darwin' ? [['libsqlite3.dylib', library] as const] : []),
  ] as const) {
    const path = `${terminalSqliteEngineRoot}/${name}`;
    writeFileSync(join(root, path), bytes, { mode: 0o644 });
    chmodSync(join(root, path), 0o644);
    files.push({ path, size: bytes.length, sha256: sha(bytes), mode: 420 });
  }
  return {
    driver: 'bun:sqlite',
    linkage: process.platform === 'darwin' ? 'dynamic' : 'builtin',
    ...sqlite,
    manifestSha256,
  };
}

export const fixtureNativeSqlite = Object.freeze({
  driver: 'node:sqlite' as const,
  linkage: 'builtin' as const,
  version: '3.53.4',
  sourceId: reviewedSqliteSources['3.53.4'],
});

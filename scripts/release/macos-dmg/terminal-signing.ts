import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMachO } from './mach-o';

export interface MacosTerminalSigning {
  sign(path: string, role: 'bun' | 'code'): void;
}

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Sign only physical files in the new Terminal tree, before SQLite exists. */
export function signMacosTerminalCode(
  root: string,
  executable: string,
  agent: string,
  signing: MacosTerminalSigning,
) {
  const files = join(agent, 'native/files');
  const search = join(agent, 'platform/process/tools');
  const filesManifest = join(files, 'manifest.json');
  const searchManifest = join(search, 'manifest.json');
  const filesBinary = join(files, 'files.node');
  const searchBinary = join(search, 'rg');
  const filesMetadata = JSON.parse(readFileSync(filesManifest, 'utf8')) as { sha256: string };
  const searchMetadata = JSON.parse(readFileSync(searchManifest, 'utf8')) as {
    rg: { sha256: string };
  };
  if (
    filesMetadata?.sha256 !== sha(filesBinary) ||
    searchMetadata?.rg?.sha256 !== sha(searchBinary)
  )
    throw Error('terminal_macos_signing_asset_changed');

  const required = new Set([executable, filesBinary, searchBinary]);
  function walk(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && isMachO(path, stat.size)) {
        if (stat.nlink !== 1) throw Error('terminal_macos_signing_asset_changed');
        signing.sign(path, path === executable ? 'bun' : 'code');
        required.delete(path);
      }
    }
  }
  walk(root);
  if (required.size) throw Error('terminal_macos_signing_asset_missing');

  filesMetadata.sha256 = sha(filesBinary);
  searchMetadata.rg.sha256 = sha(searchBinary);
  writeFileSync(filesManifest, JSON.stringify(filesMetadata));
  writeFileSync(searchManifest, `${JSON.stringify(searchMetadata, null, 2)}\n`);
}

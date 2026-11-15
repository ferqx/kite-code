import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { officeBinaryAssets } from '../../../packages/agent/src/tools/documents/office-assets-lock';
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
  const office = join(agent, 'tools/documents/office-assets');
  const officeBinary = join(office, 'officecli');
  const officeManifest = join(office, 'manifest.json');
  const officeMetadata = JSON.parse(readFileSync(officeManifest, 'utf8')) as {
    files: { path: string; size: number; sha256: string }[];
    signedOfficeSha256?: string;
  };
  const officeEntry = officeMetadata.files.find(({ path }) => path === 'officecli');
  const filesMetadata = JSON.parse(readFileSync(filesManifest, 'utf8')) as { sha256: string };
  const searchMetadata = JSON.parse(readFileSync(searchManifest, 'utf8')) as {
    rg: { sha256: string };
  };
  if (
    filesMetadata?.sha256 !== sha(filesBinary) ||
    searchMetadata?.rg?.sha256 !== sha(searchBinary) ||
    !officeEntry ||
    officeEntry.sha256 !== officeBinaryAssets['darwin-arm64']?.sha256 ||
    officeEntry.sha256 !== sha(officeBinary)
  )
    throw Error('terminal_macos_signing_asset_changed');

  const required = new Set([executable, filesBinary, searchBinary, officeBinary]);
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
  // The enclosing candidate inventory seals this manifest and the re-signed binary.
  officeMetadata.signedOfficeSha256 = officeEntry.sha256 = sha(officeBinary);
  officeEntry.size = lstatSync(officeBinary).size;
  writeFileSync(filesManifest, JSON.stringify(filesMetadata));
  writeFileSync(searchManifest, `${JSON.stringify(searchMetadata, null, 2)}\n`);
  writeFileSync(officeManifest, JSON.stringify(officeMetadata));
}

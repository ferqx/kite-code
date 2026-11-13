import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseNativeBundleManifest } from '@kite-ai/service/native-runtime-assets';
import {
  parseTerminalBundleManifest,
  windowsDesktopRuntimeEntries,
} from '@kite-ai/service/runtime-assets';
import { readCandidateArchiveFiles } from '../terminal-archive';

const [archive, sha256, license, work] = process.argv.slice(2);
assert(archive?.toLowerCase().endsWith('.tar.zst') && sha256 && license && work);
assert(process.platform === 'win32' && process.arch === 'x64');
const files = readCandidateArchiveFiles({ archivePath: archive, sha256 });
const runtime = files.get('terminal/runtime/bun.exe');
const terminalManifestBytes = files.get('terminal/terminal-manifest.json');
const nativeManifestBytes = files.get('native-manifest.json');
assert(runtime && terminalManifestBytes && nativeManifestBytes);

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const parse = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));
const nativeManifest = parseNativeBundleManifest(parse(nativeManifestBytes));
const terminalManifest = parseTerminalBundleManifest(parse(terminalManifestBytes), true);
assert(
  terminalManifest.entries.service === windowsDesktopRuntimeEntries.service,
  'Windows desktop setup requires the bundled desktop runtime',
);
assert(
  ![...files.keys(), ...nativeManifest.directories].some((path) =>
    /(?:^|\/)node_modules(?:\/|$)/iu.test(path),
  ),
);
assert.deepEqual(
  [...files.keys()].filter((path) =>
    /(?:^|\/)(?:bun\.exe|native-verifier\.exe|terminal-verifier\.exe|kite\.exe|kite-tui\.exe)$/iu.test(
      path,
    ),
  ),
  ['terminal/runtime/bun.exe'],
);
assert(nativeManifest.target.platform === 'win32' && nativeManifest.target.arch === 'x64');
assert(terminalManifest.target.platform === 'win32' && terminalManifest.target.arch === 'x64');
assert.equal(nativeManifest.terminalManifestSha256, hash(terminalManifestBytes));
const metadata = terminalManifest.files.find((file) => file.path === 'runtime/bun.exe');
assert(metadata && metadata.size === runtime.length && metadata.sha256 === hash(runtime));

// Archive entries are views of the decoded tar. Check the fixed USTAR entry before
// storing the byte range used by the bootstrap's streaming decoder.
const tar = Buffer.from(runtime.buffer);
const offset = runtime.byteOffset;
assert(offset >= 512 && offset % 512 === 0);
assert.equal(tar.toString('ascii', offset - 512, offset - 488), 'terminal/runtime/bun.exe');
assert.equal(Number.parseInt(tar.toString('ascii', offset - 388, offset - 376), 8), runtime.length);

const candidateId = hash(nativeManifestBytes);
const entry = await Bun.build({
  entrypoints: [join(import.meta.dir, 'install.ts'), join(import.meta.dir, 'uninstall.ts')],
  outdir: work,
  target: 'bun',
  format: 'esm',
  naming: '[name].js',
  define: { __KITE_SETUP_CANDIDATE__: JSON.stringify(candidateId) },
  minify: true,
});
assert(entry.success && entry.outputs.length === 2, String(entry.logs));
const script = join(work, 'install.js');
const uninstall = join(work, 'uninstall.js');
const version = terminalManifest.productVersion;
assert(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/u.test(version));
writeFileSync(
  join(work, 'payload.h'),
  [
    '#pragma once',
    `constexpr wchar_t uninstallHash[] = L"${hash(readFileSync(uninstall))}";`,
    `constexpr wchar_t productVersion[] = L"${version}";`,
    `constexpr wchar_t archiveHash[] = L"${sha256}";`,
    `constexpr wchar_t runtimeHash[] = L"${metadata.sha256}";`,
    `constexpr wchar_t scriptHash[] = L"${hash(readFileSync(script))}";`,
    `constexpr wchar_t expectedCandidate[] = L"${candidateId}";`,
    `constexpr size_t runtimeOffset = ${offset};`,
    `constexpr size_t runtimeSize = ${runtime.length};`,
    `constexpr uint64_t installedPayloadBytes = ${[...files.values()].reduce((size, file) => size + file.byteLength, 0)}ULL;`,
    '',
  ].join('\n'),
);

const versionFields = [...version.split('.').map(Number), 0];
assert(versionFields.every((part) => part <= 65535));
const versionResource = versionFields.join(',');
const icon = resolve(import.meta.dir, '../../../apps/desktop/app-icon.ico');
writeFileSync(
  join(work, 'maintenance.rc'),
  [
    '#pragma code_page(65001)',
    '#include "location-dialog.rc"',
    `1 RT_MANIFEST ${JSON.stringify(join(import.meta.dir, 'setup.manifest'))}`,
    `10 ICON ${JSON.stringify(icon)}`,
    `105 RCDATA ${JSON.stringify(uninstall)}`,
    '',
  ].join('\n'),
);
writeFileSync(
  join(work, 'setup.rc'),
  [
    '#pragma code_page(65001)',
    '#include "location-dialog.rc"',
    '104 RCDATA "maintenance.exe"',
    `1 RT_MANIFEST ${JSON.stringify(join(import.meta.dir, 'setup.manifest'))}`,
    `IDI_KITE ICON ${JSON.stringify(icon)}`,
    `101 RCDATA ${JSON.stringify(archive)}`,
    `102 RCDATA ${JSON.stringify(script)}`,
    `103 RCDATA ${JSON.stringify(license)}`,
    '1 VERSIONINFO',
    ` FILEVERSION ${versionResource}`,
    ` PRODUCTVERSION ${versionResource}`,
    ' FILEFLAGSMASK VS_FFI_FILEFLAGSMASK',
    ' FILEOS VOS_NT_WINDOWS32',
    ' FILETYPE VFT_APP',
    'BEGIN',
    ' BLOCK "StringFileInfo"',
    ' BEGIN',
    '  BLOCK "080404b0"',
    '  BEGIN',
    '   VALUE "FileDescription", "Kite Desktop Setup"',
    '   VALUE "ProductName", "Kite Desktop"',
    `   VALUE "FileVersion", "${version}"`,
    `   VALUE "ProductVersion", "${version}"`,
    '   VALUE "OriginalFilename", "KiteDesktopSetup.exe"',
    '  END',
    ' END',
    ' BLOCK "VarFileInfo"',
    ' BEGIN',
    '  VALUE "Translation", 0x0804, 1200',
    ' END',
    'END',
    '',
  ].join('\n'),
);
console.log(JSON.stringify({ archiveSha256: sha256, candidateId }));

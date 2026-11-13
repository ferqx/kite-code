import { createHash } from 'node:crypto';
import {
  cpSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { macosNodeDesktopRuntimeEntries } from '@kite-ai/service/runtime-assets';
import { spawn as spawnProcess } from '../../tooling/process';
import { runNativeRelease } from '../native';
import { cachedNodeDistribution } from '../node-inputs';
import { rejectBundleOutput } from '../terminal-paths';
import {
  assertDeveloperIdIdentity,
  createMacosCodeSigner,
  type MacosCodeSigner,
  notarizeMacosImage,
} from './code-signing';
import { launcherDeploymentTarget, macosMinimumSystemVersion } from './mach-o';

const appName = 'Kite Desktop';
const launcher = `#!/bin/sh
set -eu
unset NODE_PATH NODE_OPTIONS BUN_OPTIONS ELECTRON_RUN_AS_NODE
root=$(CDPATH= cd -P -- "\${0%/*}/../Resources/native" && pwd -P)
exec "$root/electron/Electron.app/Contents/MacOS/Electron" "$root/app" "$@"
`;

function bundlePlist(version: string, minimumSystemVersion: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>${appName}</string>
<key>CFBundleExecutable</key><string>KiteDesktop</string>
<key>CFBundleIconFile</key><string>KiteDesktop.icns</string>
<key>CFBundleIdentifier</key><string>com.kitecode.desktop</string>
<key>CFBundleName</key><string>${appName}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>${minimumSystemVersion}</string>
</dict></plist>
`;
}

async function imageDigest(image: string) {
  const checksum = createHash('sha256');
  for await (const bytes of createReadStream(image)) checksum.update(bytes);
  return checksum.digest('hex');
}

async function run(command: string[], failure: string) {
  const child = spawnProcess(command, { stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' });
  if ((await child.exited) !== 0) throw Error(failure);
}

type MacosDmgInputs = Readonly<
  Partial<Record<'directory' | 'native' | 'electron' | 'node-distribution', string>>
>;

export async function buildMacosDmg(
  root: string,
  values: MacosDmgInputs & Readonly<Partial<Record<'signing-identity' | 'notary-profile', string>>>,
) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw Error('macos_dmg_requires_macos_arm64');
  const identity = values['signing-identity'];
  const profile = values['notary-profile'];
  if (!identity && !profile) return buildMacosDmgCandidate(root, values);
  if (!identity || !profile || values.native) throw Error('release_arguments_invalid');
  assertDeveloperIdIdentity(identity);
  return buildMacosDmgCandidate(root, values, {
    code: createMacosCodeSigner(identity),
    notarize: (image) => notarizeMacosImage(image, profile),
  });
}

export async function buildMacosDmgCandidate(
  root: string,
  values: MacosDmgInputs,
  signing?: { code: MacosCodeSigner; notarize?: (image: string) => string },
) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw Error('macos_dmg_requires_macos_arm64');
  if (values.native && (values.electron || values['node-distribution'] || signing))
    throw Error('release_arguments_invalid');

  const requested = resolve(
    values.directory ??
      join(root, 'dist/macos-dmg', new Date().toISOString().replace(/[:.]/g, '-')),
  );
  const source = values.native ? realpathSync(resolve(values.native)) : undefined;
  if (source) rejectBundleOutput(source, requested);
  mkdirSync(dirname(requested), { recursive: true });
  const parent = realpathSync(dirname(requested));
  const output = join(parent, basename(requested));
  if (lstatSync(output, { throwIfNoEntry: false })) throw Error('macos_dmg_destination_exists');
  const work = mkdtempSync(join(parent, '.kite-dmg-'));
  try {
    const candidate = source ?? join(work, 'native');
    if (!source) {
      await runNativeRelease(
        [
          'build',
          '--directory',
          candidate,
          '--desktop-only',
          'true',
          '--node-distribution',
          resolve(values['node-distribution'] ?? cachedNodeDistribution(root)),
          ...(values.electron ? ['--electron', resolve(values.electron)] : []),
        ],
        root,
        signing
          ? {
              macosSignElectron: signing.code.signElectron,
              macosTerminalSigning: { sign: signing.code.sign },
            }
          : {},
      );
    }

    const volume = join(work, 'volume');
    const app = join(volume, `${appName}.app`);
    const contents = join(app, 'Contents');
    const resources = join(contents, 'Resources');
    const stagedNative = join(resources, 'native');
    mkdirSync(join(contents, 'MacOS'), { recursive: true });
    mkdirSync(resources);
    const executable = join(contents, 'MacOS/KiteDesktop');
    if (signing) {
      await run(
        [
          '/usr/bin/xcrun',
          'clang',
          '-arch',
          'arm64',
          `-mmacosx-version-min=${launcherDeploymentTarget}`,
          '-O2',
          join(import.meta.dirname, 'launcher.c'),
          '-o',
          executable,
        ],
        'macos_dmg_launcher_build_failed',
      );
    } else writeFileSync(executable, launcher, { mode: 0o755 });
    writeFileSync(join(resources, '.use-native.lock'), '', { mode: 0o600 });
    symlinkSync('/Applications', join(volume, 'Applications'));

    const outer = acquireArtifactAccess({ root: candidate, mode: 'shared' });
    const bundle = (() => {
      try {
        const inner = acquireArtifactAccess({ root: join(candidate, 'terminal'), mode: 'shared' });
        try {
          const original = verifyNativeRuntimeBundle(candidate);
          const { files, links, directories } = original.manifest;
          const { entries } = original.terminal.manifest;
          if (
            entries.service !== macosNodeDesktopRuntimeEntries.service ||
            entries.runtime !== macosNodeDesktopRuntimeEntries.runtime ||
            [
              ...files.map(({ path }) => path),
              ...links.map(({ path }) => path),
              ...directories,
            ].some((path) => path.split('/').some((part) => part.toLowerCase() === 'node_modules'))
          )
            throw Error('macos_dmg_requires_desktop_runtime');
          cpSync(candidate, stagedNative, { recursive: true, verbatimSymlinks: true });
          const copied = verifyNativeRuntimeBundle(stagedNative);
          if (copied.digest !== original.digest) throw Error('macos_dmg_candidate_changed');
          return copied;
        } finally {
          inner.release();
        }
      } finally {
        outer.release();
      }
    })();

    const version = bundle.terminal.manifest.productVersion;
    if (!/^\d+\.\d+\.\d+$/u.test(version)) throw Error('macos_dmg_product_version_invalid');
    const minimumSystemVersion = macosMinimumSystemVersion(stagedNative, [
      ...bundle.manifest.files,
      ...bundle.terminal.manifest.files.map(({ path, size }) => ({
        path: `terminal/${path}`,
        size,
      })),
    ]);
    writeFileSync(join(contents, 'Info.plist'), bundlePlist(version, minimumSystemVersion));
    await run(
      [
        '/usr/bin/sips',
        '-s',
        'format',
        'icns',
        join(root, 'apps/desktop/app-icon.ico'),
        '--out',
        join(resources, 'KiteDesktop.icns'),
      ],
      'macos_dmg_icon_build_failed',
    );
    await run(
      ['/usr/bin/python3', join(import.meta.dirname, 'finder-layout.py'), volume],
      'macos_dmg_finder_layout_failed',
    );
    if (signing) {
      signing.code.sign(app, 'code');
      signing.code.verifyApp(app);
      if (verifyNativeRuntimeBundle(stagedNative).digest !== bundle.digest)
        throw Error('macos_dmg_candidate_changed');
    }

    const published = join(work, 'output');
    mkdirSync(published);
    const filename = 'KiteDesktop-arm64.dmg';
    const image = join(published, filename);
    await run(
      [
        '/usr/bin/hdiutil',
        'create',
        '-srcfolder',
        volume,
        '-volname',
        'Kite Desktop',
        '-fs',
        'HFS+',
        '-format',
        'UDZO',
        image,
      ],
      'macos_dmg_image_build_failed',
    );
    signing?.code.signImage(image);
    const notarizationId = signing?.notarize?.(image);
    await run(['/usr/bin/hdiutil', 'verify', image], 'macos_dmg_image_verification_failed');
    const sha256 = await imageDigest(image);
    writeFileSync(`${image}.sha256`, `${sha256}  ${filename}\n`);
    if (lstatSync(output, { throwIfNoEntry: false })) throw Error('macos_dmg_destination_exists');
    renameSync(published, output);
    const installer = join(output, filename);
    return {
      installer,
      checksum: `${installer}.sha256`,
      sha256,
      candidateId: bundle.digest,
      source: bundle.terminal.manifest.source,
      ...(notarizationId ? { notarizationId } : {}),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

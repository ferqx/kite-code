import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { retainWindowsCandidateFiles } from '@kite-ai/agent/artifact-access';
import { defaultWindowsPathSecurity, privateDirectory } from '@kite-ai/agent/windows-path-security';
import type {
  WindowsNativeBuildResource,
  WindowsNativeCandidateBuildPort,
} from '../../apps/desktop/scripts/build-native';
import type {
  EmbeddedRuntimeManifest,
  VerifiedTerminalRuntimeBundle,
} from '../../apps/service/src/runtime-assets';
import {
  buildWindowsTerminalLauncher,
  compileWindowsVerifier,
  copyWindowsSystemExecutable,
} from './build-windows-terminal-launcher';
import { sharedWindowsNativeVerifier } from './windows-verifier-assets';

async function compileLegacyNativeVerifier(
  root: string,
  runtime: string,
  pins: WindowsNativeBuildResource[],
) {
  const compileRoot = join(root, `.windows-native-verifier-${randomUUID()}`);
  privateDirectory(compileRoot);
  const compiledPath = join(compileRoot, 'native-verifier.exe');
  await compileWindowsVerifier({
    runtime,
    entrypoint: resolve(import.meta.dir, 'entrypoints/windows-native-verifier-main.ts'),
    outfile: compiledPath,
  });
  const verifierPath = join(root, 'app', 'native-verifier.exe');
  const compiledPin = retainWindowsCandidateFiles(compileRoot, ['native-verifier.exe']);
  pins.push(compiledPin);
  copyWindowsSystemExecutable(compiledPath, verifierPath);
  compiledPin.verify();
  compiledPin.release();
  pins.pop();
  rmSync(compileRoot, { recursive: true, force: false });
  const bytes = readFileSync(verifierPath);
  return {
    path: verifierPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

async function buildFrontdoors(
  root: string,
  terminal: VerifiedTerminalRuntimeBundle<EmbeddedRuntimeManifest>,
  resources: { pins: WindowsNativeBuildResource[]; locks: WindowsNativeBuildResource[] },
) {
  const security = defaultWindowsPathSecurity()!;
  const app = join(root, 'app');
  const desktop = !('cli' in terminal.manifest.entries);
  let verifier: { path: string; sha256: string; size: number };
  if (desktop) {
    const path = join(app, 'native-verifier.js');
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, 'entrypoints/windows-native-verifier.ts')],
      target: 'bun',
      outdir: app,
      naming: 'native-verifier.js',
      minify: true,
    });
    if (!build.success)
      throw new AggregateError(build.logs, 'windows_native_verifier_build_failed');
    const bytes = readFileSync(path);
    verifier = {
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    };
  } else {
    const shared = sharedWindowsNativeVerifier(terminal.manifest);
    verifier = shared
      ? { ...shared, path: join(terminal.root, shared.path) }
      : await compileLegacyNativeVerifier(
          root,
          join(terminal.root, terminal.manifest.entries.runtime),
          resources.pins,
        );
  }
  const runtime = terminal.manifest.files.find(
    (file) => file.path === terminal.manifest.entries.runtime,
  );
  if (!runtime) throw Error('windows_native_runtime_unavailable');
  const launchers = await buildWindowsTerminalLauncher({
    kind: desktop ? 'desktop' : 'native',
    ...(desktop ? { desktopRuntime: runtime } : {}),
    outdir: join(root, `.windows-native-launcher-${randomUUID()}`),
    verifierPath: verifier.path,
    verifierSha256: verifier.sha256,
    verifierSize: verifier.size,
  });
  const pin = retainWindowsCandidateFiles(launchers.root, launchers.launchers);
  resources.pins.push(pin);
  for (const name of launchers.launchers)
    security.copyPrivateFile(join(launchers.root, name), join(app, name));
  pin.verify();
  pin.release();
  resources.pins.pop();
  rmSync(launchers.root, { recursive: true, force: false });
}
/** Release-build-only fixed source; installed callers never compile or select these sources. */
export const windowsNativeCandidateBuildPort: WindowsNativeCandidateBuildPort = Object.freeze({
  copyElectronExecutable(source: string, target: string) {
    copyWindowsSystemExecutable(source, target, 'electron');
  },
  buildFrontdoors,
});

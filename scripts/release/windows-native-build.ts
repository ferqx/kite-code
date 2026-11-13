import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { retainWindowsCandidateFiles } from '@kite-ai/agent/artifact-access';
import { defaultWindowsPathSecurity } from '@kite-ai/agent/windows-path-security';
import type {
  WindowsNativeBuildResource,
  WindowsNativeCandidateBuildPort,
} from '../../apps/desktop/scripts/build-native';
import type {
  EmbeddedRuntimeManifest,
  VerifiedTerminalRuntimeBundle,
} from '../../apps/service/src/runtime-assets';
import {
  windowsNodeDesktopRuntimeEntries,
  windowsTerminalVerifierAddonPath,
} from '../../apps/service/src/runtime-assets';
import { windowsNodeDesktopFrontdoorNames } from '../../packages/agent/src/platform/windows-native-frontdoors';
import { build as bundle } from '../tooling/bun-build';
import {
  buildWindowsTerminalLauncher,
  copyWindowsSystemExecutable,
} from './build-windows-terminal-launcher';
import { sharedWindowsNativeVerifier } from './windows-verifier-assets';

async function buildFrontdoors(
  root: string,
  terminal: VerifiedTerminalRuntimeBundle<EmbeddedRuntimeManifest>,
  resources: { pins: WindowsNativeBuildResource[]; locks: WindowsNativeBuildResource[] },
) {
  const security = defaultWindowsPathSecurity()!;
  const app = join(root, 'app');
  const desktop = !('cli' in terminal.manifest.entries);
  if (!terminal.manifest.nodeVersion) throw Error('windows_native_node_runtime_required');
  const addon = terminal.manifest.files.find(
    (file) =>
      file.path ===
      (desktop ? 'code/@kite-ai/agent/runtime-native.node' : windowsTerminalVerifierAddonPath),
  );
  if (
    addon?.mode !== 493 ||
    (desktop && terminal.manifest.entries.runtime !== windowsNodeDesktopRuntimeEntries.runtime)
  )
    throw Error('windows_native_runtime_unavailable');
  let verifier: { path: string; sha256: string; size: number };
  if (desktop) {
    const filename = windowsNodeDesktopFrontdoorNames[1];
    const path = join(app, filename);
    const build = await bundle({
      entrypoints: [resolve(import.meta.dirname, 'entrypoints/windows-native-verifier.ts')],
      target: 'node',
      format: 'esm',
      outdir: app,
      naming: filename,
      ...(addon
        ? { define: { __KITE_WINDOWS_DESKTOP_ADDON_SHA256__: JSON.stringify(addon.sha256) } }
        : {}),
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
    if (!shared) throw Error('windows_native_runtime_unavailable');
    verifier = { ...shared, path: join(terminal.root, shared.path) };
  }
  const runtime = terminal.manifest.files.find(
    (file) => file.path === terminal.manifest.entries.runtime,
  );
  if (runtime?.mode !== 493) throw Error('windows_native_runtime_unavailable');
  const launchers = await buildWindowsTerminalLauncher({
    kind: desktop ? 'desktop' : 'native',
    ...(desktop
      ? {
          desktopRuntime: {
            ...runtime,
            runtimeKind: 'node',
            ...(addon ? { addonSha256: addon.sha256, addonSize: addon.size } : {}),
          },
        }
      : addon
        ? { verifierAddon: { sha256: addon.sha256, size: addon.size } }
        : {}),
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

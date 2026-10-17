import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { retainWindowsCandidateFiles } from '@kite-ai/agent/artifact-access';
import { defaultWindowsPathSecurity, privateDirectory } from '@kite-ai/agent/windows-path-security';
import type {
  WindowsNativeBuildResource,
  WindowsNativeCandidateBuildPort,
} from '../../apps/desktop/scripts/build-native';
import {
  buildWindowsTerminalLauncher,
  compileWindowsVerifier,
  copyWindowsSystemExecutable,
} from './build-windows-terminal-launcher';

async function buildFrontdoors(
  root: string,
  runtime: string,
  resources: { pins: WindowsNativeBuildResource[]; locks: WindowsNativeBuildResource[] },
) {
  const security = defaultWindowsPathSecurity()!;
  const app = join(root, 'app');
  const compileRoot = join(root, `.windows-native-verifier-${randomUUID()}`);
  privateDirectory(compileRoot);
  const compiledPath = join(compileRoot, 'native-verifier.exe');
  await compileWindowsVerifier({
    runtime,
    entrypoint: resolve(import.meta.dir, 'entrypoints/windows-native-verifier-main.ts'),
    outfile: compiledPath,
  });
  const verifierPath = join(app, 'native-verifier.exe');
  const compiledPin = retainWindowsCandidateFiles(compileRoot, ['native-verifier.exe']);
  resources.pins.push(compiledPin);
  copyWindowsSystemExecutable(compiledPath, verifierPath);
  compiledPin.verify();
  compiledPin.release();
  resources.pins.pop();
  rmSync(compileRoot, { recursive: true, force: false });
  const bytes = readFileSync(verifierPath);
  const launchers = await buildWindowsTerminalLauncher({
    kind: 'native',
    outdir: join(root, `.windows-native-launcher-${randomUUID()}`),
    verifierPath,
    verifierSha256: createHash('sha256').update(bytes).digest('hex'),
    verifierSize: bytes.length,
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

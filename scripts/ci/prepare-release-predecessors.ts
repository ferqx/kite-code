import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { verifyTerminalRuntimeBundle } from '@kite-ai/service/runtime-assets';
import { removeTemporaryDirectory, temporaryDirectory } from '../../tests/fixtures/test-filesystem';
import { RELEASE_PREDECESSORS } from '../../tests/fixtures/unified-agent/terminal-predecessor';
import { which } from '../tooling/process';

// Run each fixed revision's builder with its own frozen dependencies, outside the candidate checkout.
export function prepareReleasePredecessors() {
  const environment = process.env.GITHUB_ENV;
  const bun = which('bun');
  const git = which('git');
  if (!environment || !bun || !git) throw Error('release_predecessor_build_environment_missing');
  const repository = realpathSync.native(process.cwd());
  const root = temporaryDirectory('kite-release-predecessors-');
  const entries: string[] = [];
  try {
    for (const [name, policy] of Object.entries(RELEASE_PREDECESSORS)) {
      if (process.platform === 'win32' && name === 'legacy') continue;
      const source = temporaryDirectory('kite-predecessor-source-');
      const terminal = join(root, `${name}-terminal`);
      const native = join(root, `${name}-native`);
      const run = (file: string, args: string[]) =>
        execFileSync(file, args, { cwd: source, stdio: 'inherit', windowsHide: true });
      run(git, ['init', '--quiet']);
      run(git, ['fetch', '--quiet', '--depth=1', '--no-tags', repository, policy.commit]);
      run(git, ['checkout', '--quiet', '--detach', policy.commit]);
      run(bun, ['install', '--frozen-lockfile', '--ignore-scripts']);
      run(process.execPath, [join('apps', 'desktop', 'node_modules', 'electron', 'install.js')]);
      if (process.platform === 'win32' || name === 'legacy') {
        run(bun, ['run', 'release:build', '--directory', terminal]);
        run(bun, [
          'run',
          'release:build',
          '--product',
          'native',
          '--directory',
          native,
          '--terminal',
          terminal,
        ]);
      } else {
        run(bun, [
          '--no-env-file',
          '-e',
          `
import { buildNativeCandidate } from './apps/desktop/scripts/build-native.ts';
import { buildTerminalBundle } from './scripts/release/terminal-bundle.ts';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const [terminalRoot, outdir] = process.argv.slice(1);
const require = createRequire(join(process.cwd(), 'apps/desktop/package.json'));
const electronDist = join(dirname(require.resolve('electron/package.json')), 'dist');
await buildTerminalBundle({
  destination: terminalRoot,
  processHostFixture: process.platform === 'darwin' ? 'native-extension-reference' : undefined,
});
await buildNativeCandidate({ terminalRoot, outdir, electronDist, testDiagnostics: true });
`,
          terminal,
          native,
        ]);
      }
      const oldTerminal = verifyTerminalRuntimeBundle(terminal);
      const oldNative = verifyNativeRuntimeBundle(native);
      if (
        oldTerminal.manifest.source.commit !== policy.commit ||
        oldTerminal.manifest.source.dirty ||
        oldTerminal.manifest.nodeVersion !== undefined ||
        oldNative.terminal.digest !== oldTerminal.digest
      )
        throw Error('release_predecessor_build_identity_invalid');
      entries.push(
        `${policy.variablePrefix}_TERMINAL=${oldTerminal.root}`,
        `${policy.variablePrefix}_TERMINAL_SHA256=${oldTerminal.digest}`,
        `${policy.variablePrefix}_NATIVE=${oldNative.root}`,
        `${policy.variablePrefix}_NATIVE_SHA256=${oldNative.digest}`,
      );
      removeTemporaryDirectory(source);
    }
    appendFileSync(environment, `${entries.join('\n')}\n`, 'utf8');
  } catch (error) {
    try {
      removeTemporaryDirectory(root);
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'release_predecessor_build_failed');
    }
    throw error;
  }
}

if (import.meta.main) prepareReleasePredecessors();

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { verifyTerminalRuntimeBundle } from '@kite-ai/service/runtime-assets';
import { qualifyWindowsNativeInstallation } from './windows-native-installation.qualification';
import {
  COMPATIBLE_WINDOWS_PREDECESSOR_COMMIT,
  materializeCompatibleWindowsPredecessor,
} from './windows-predecessor';
import { qualifyWindowsTerminalCrossVersion } from './windows-terminal-cross-version.qualification';

/** One old-source build feeds both installed families; no candidate is relabelled. */
export async function qualifyWindowsCrossVersion(input: { terminal: string; native: string }) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('windows_cross_version_platform_required');
  const started = performance.now();
  const wholeBudgetMs = 1140000;
  const wholeDeadline = Date.now() + wholeBudgetMs;
  const remaining = () => {
    const ms = Math.min(wholeDeadline - Date.now(), wholeBudgetMs - (performance.now() - started));
    assert(ms > 0, 'windows_cross_version_whole_deadline');
    return ms;
  };
  for (const path of [input.terminal, input.native]) assert(isAbsolute(path));
  const terminal = verifyTerminalRuntimeBundle(realpathSync(input.terminal));
  const native = verifyNativeRuntimeBundle(realpathSync(input.native));
  assert.deepEqual(terminal.manifest.target, { platform: 'win32', arch: 'x64' });
  assert.deepEqual(native.manifest.target, terminal.manifest.target);
  assert.equal(native.terminal.digest, terminal.digest);
  assert.equal(terminal.manifest.source.dirty, false);
  assert(/^[a-f0-9]{40}$/.test(terminal.manifest.source.commit));
  assert.notEqual(terminal.manifest.source.commit, COMPATIBLE_WINDOWS_PREDECESSOR_COMMIT);
  if (process.env.KITE_EXPECTED_CANDIDATE_COMMIT !== undefined)
    assert.equal(terminal.manifest.source.commit, process.env.KITE_EXPECTED_CANDIDATE_COMMIT);
  const root = join(realpathSync(tmpdir()), `kite-windows-cross-code-${randomUUID()}`);
  assert(!existsSync(root));
  privateDirectory(root);
  try {
    const old = await materializeCompatibleWindowsPredecessor({
      root,
      repositoryRoot: resolve(import.meta.dir, '../../..'),
      nativeElectronDist: join(native.root, 'electron'),
      deadline: Date.now() + Math.min(180000, remaining()),
    });
    assert.equal(old.sourceCommit, COMPATIBLE_WINDOWS_PREDECESSOR_COMMIT);
    assert(!existsSync(join(root, 'predecessor-source')));
    const terminalResult = await qualifyWindowsTerminalCrossVersion({
      candidate: terminal.root,
      predecessor: old.terminal,
      predecessorCommit: old.sourceCommit,
      wholeDeadline,
    });
    remaining();
    const nativeResult = await qualifyWindowsNativeInstallation(
      native.root,
      old.native,
      wholeDeadline,
    );
    remaining();
    assert.equal(verifyTerminalRuntimeBundle(terminal.root).digest, terminal.digest);
    assert.equal(verifyNativeRuntimeBundle(native.root).digest, native.digest);
    const result = {
      localUnpublishedComparison: true,
      sourceCommit: terminal.manifest.source.commit,
      predecessorCommit: old.sourceCommit,
      sourceRemoved: true,
      lockedInputs: old.lockedInputs,
      reviewedDeclarations: old.reviewedDeclarations,
      schemaCapability: old.schemaCapability,
      migrations: old.migrations,
      terminal: terminalResult,
      native: nativeResult,
      wholeBudgetMs,
      phaseBudgetsMs: {
        materialize: 180000,
        terminal: 360000,
        native: 420000,
        maintenance: 180000,
      },
      elapsedMs: Math.ceil(performance.now() - started),
    };
    remaining();
    console.log(`WINDOWS_INSTALLED_REAL_CODE_COMPLETE ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    console.error(`OWNED_WINDOWS_CROSS_CODE_FAILURE_ROOT ${root}`);
    throw error;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  assert.equal(args.length, 2, 'exact_terminal_and_native_arguments_required');
  assert(args[0]!.startsWith('--terminal='), 'exact_terminal_argument_required');
  assert(args[1]!.startsWith('--native='), 'exact_native_argument_required');
  try {
    await qualifyWindowsCrossVersion({
      terminal: args[0]!.slice('--terminal='.length),
      native: args[1]!.slice('--native='.length),
    });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

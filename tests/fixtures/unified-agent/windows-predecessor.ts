/** Real old source/builders only. Source validation is not native Windows qualification. */
import { createHash } from 'node:crypto';
import {
  COMPATIBLE_PREDECESSOR_COMMIT,
  COMPATIBLE_PREDECESSOR_INPUT_PATHS,
  COMPATIBLE_PREDECESSOR_MIGRATIONS,
} from './compatible-predecessor-input';
import { matchReviewedPredecessorInput } from './predecessor-reviewed-input';
import { matchPredecessorShellParserInput } from './predecessor-shell-parser-input';
import { matchPredecessorStdioInput } from './predecessor-stdio-input';
import { matchTerminalPredecessorInput, verifyPinnedPredecessor } from './terminal-predecessor';

export const COMPATIBLE_WINDOWS_PREDECESSOR_COMMIT = COMPATIBLE_PREDECESSOR_COMMIT;
export const WINDOWS_PREDECESSOR_COMMIT = '837a2b8cde946d70d00920941a1a3e5e7c684f5d';
const workspaces = [
  'packages/ai',
  'packages/agent',
  'packages/client',
  'packages/ui',
  'apps/service',
  'apps/cli',
  'apps/desktop',
  'apps/web',
] as const;
const baseline = 'packages/agent/src/storage/migrations/0001-baseline.sql';
const baselineSha = '92773869c4d4e68947e9721d5bb6d28e10567c6dc3a82b56726b1a0fb7adee42';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function windowsPredecessorLockedInputPaths(manifest: {
  patchedDependencies?: Record<string, string>;
}): string[] {
  const patches = Object.values(manifest.patchedDependencies ?? {});
  if (patches.some((path) => !/^patches\/(?:[a-zA-Z0-9@._+-]|%2F)+\.patch$/.test(path)))
    throw Error('windows_predecessor_patch_path_invalid');
  return [
    'bun.lock',
    'package.json',
    ...workspaces.map((path) => `${path}/package.json`),
    ...patches,
  ];
}
export function assertWindowsPredecessorLockedInput(
  path: string,
  previous: Uint8Array,
  current: Uint8Array,
) {
  if (!COMPATIBLE_PREDECESSOR_INPUT_PATHS.some((input) => input === path))
    throw Error(`windows_predecessor_dependency_input_changed:${path}`);
  const match =
    matchReviewedPredecessorInput('windows_legacy', path, previous, current)?.match ??
    matchPredecessorStdioInput(path, previous, current) ??
    matchPredecessorShellParserInput(path, previous, current) ??
    (['bun.lock', 'package.json', 'packages/ui/package.json'].includes(path)
      ? matchTerminalPredecessorInput(path, previous, current)
      : undefined);
  if (!match) throw Error(`windows_predecessor_dependency_input_changed:${path}`);
  return { path, sha256: sha(previous), currentSha256: sha(current), match };
}
type WindowsPredecessorInput = {
  root: string;
  repositoryRoot: string;
  deadline: number;
};
export function materializeWindowsPredecessor(input: WindowsPredecessorInput) {
  return materializeWindowsPredecessorVersion(input, false);
}
export function materializeCompatibleWindowsPredecessor(input: WindowsPredecessorInput) {
  return materializeWindowsPredecessorVersion(input, true);
}
async function materializeWindowsPredecessorVersion(
  input: WindowsPredecessorInput,
  compatible: boolean,
) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('windows_predecessor_platform_required');
  const remaining = input.deadline - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 180000)
    throw Error('windows_predecessor_deadline_invalid');
  const old = await verifyPinnedPredecessor(
    { ...input, native: true },
    {
      commit: compatible ? COMPATIBLE_WINDOWS_PREDECESSOR_COMMIT : WINDOWS_PREDECESSOR_COMMIT,
      variablePrefix: compatible
        ? 'KITE_PREDECESSOR_WINDOWS_COMPATIBLE'
        : 'KITE_PREDECESSOR_WINDOWS_LEGACY',
      migrations: compatible
        ? COMPATIBLE_PREDECESSOR_MIGRATIONS
        : [{ path: baseline, sha256: baselineSha }],
      schemaCapability: compatible ? 'recovery-audit-v1' : 'baseline-v1',
      inputInventory: COMPATIBLE_PREDECESSOR_INPUT_PATHS,
    },
  );
  if (!old.nativeCandidate) throw Error('windows_predecessor_native_required');
  if (Date.now() >= input.deadline) throw Error('windows_predecessor_deadline');
  return {
    terminal: old.candidate.root,
    native: old.nativeCandidate.root,
    sourceCommit: old.provenance.commit,
    provenance: old.provenance,
  };
}

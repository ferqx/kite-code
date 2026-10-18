import { createHash } from 'node:crypto';
import { matchReviewedPredecessorInput } from './predecessor-reviewed-input';

/** First merged real code with both reviewed workspace declarations and recovery-audit schema. */
export const COMPATIBLE_PREDECESSOR_COMMIT = '4a4c0e440b2098e5b4ec58c5831452773b39228f';
export const COMPATIBLE_PREDECESSOR_INPUT_PATHS = [
  'bun.lock',
  'package.json',
  'packages/ai/package.json',
  'packages/agent/package.json',
  'packages/client/package.json',
  'packages/ui/package.json',
  'apps/service/package.json',
  'apps/cli/package.json',
  'apps/desktop/package.json',
  'apps/web/package.json',
  'patches/ink-virtual-list@0.2.3.patch',
] as const;
export const COMPATIBLE_PREDECESSOR_MIGRATIONS = [
  {
    path: 'packages/agent/src/storage/migrations/0001-baseline.sql',
    sha256: '92773869c4d4e68947e9721d5bb6d28e10567c6dc3a82b56726b1a0fb7adee42',
  },
  {
    path: 'packages/agent/src/storage/migrations/0002-recovery-audit.sql',
    sha256: '61a50a0150fae5a9d8c136827716ed6fb832b4bd3d7be13ddabb683c648e2a19',
  },
] as const;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Raw identity or one closed, explicitly reviewed raw pair; SQL never receives an exception. */
export function assertCompatiblePredecessorLockedInput(
  path: string,
  previous: Uint8Array,
  current: Uint8Array,
) {
  const migration = COMPATIBLE_PREDECESSOR_MIGRATIONS.find((item) => item.path === path);
  const allowed = COMPATIBLE_PREDECESSOR_INPUT_PATHS.some((input) => input === path);
  const identical = Buffer.from(previous).equals(Buffer.from(current));
  const reviewed =
    allowed && !identical
      ? matchReviewedPredecessorInput('compatible', path, previous, current)
      : undefined;
  if (
    (!allowed && !migration) ||
    (!identical && !reviewed) ||
    (migration && sha256(previous) !== migration.sha256)
  )
    throw Error(`compatible_predecessor_input_changed:${path}`);
  return {
    path,
    sha256: sha256(previous),
    currentSha256: sha256(current),
    match: reviewed?.match ?? ('identical' as const),
  };
}
export function assertCompatiblePredecessorInputPaths(paths: readonly string[]) {
  if (JSON.stringify(paths) !== JSON.stringify(COMPATIBLE_PREDECESSOR_INPUT_PATHS))
    throw Error('compatible_predecessor_input_inventory_changed');
}

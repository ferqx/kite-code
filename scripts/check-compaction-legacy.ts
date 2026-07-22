import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const repoRoot = join(import.meta.dir, '..');
const roots = [
  'src/core/model',
  'src/core/controllers/model-controller.ts',
  'src/core/runtime/context-compaction.ts',
];
const forbidden = [
  'StructuredContextSummary',
  'compaction-fact-ledger',
  'createStructuredContextCompactor',
  'chunkCompactionMessages',
  "mode: 'repair' | 'chunk' | 'merge'",
  'manual_recovery',
  'overflow_recovery',
  'overflow_recovery_failed',
  'overflowRecoveryTurnId',
  'auto_soft',
  'auto_hard',
  'ProviderContextOverflowError',
  'isProviderContextOverflow',
  'recoverLegacySyntheticTurns',
  'BUILTIN_MODEL_CAPABILITIES',
  'lastPreflight',
  'softRatio',
  'recentWindowSize',
  'shouldCompact(',
];

function sourceFiles(path: string): string[] {
  const absolute = join(repoRoot, path);
  if (extname(absolute)) return [absolute];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative(repoRoot, child));
    return /\.[cm]?[tj]sx?$/.test(entry.name) ? [child] : [];
  });
}

const violations = roots.flatMap(sourceFiles).flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  return forbidden
    .filter((symbol) => source.includes(symbol))
    .map(
      (symbol) => `${relative(repoRoot, file)}: forbidden legacy symbol ${JSON.stringify(symbol)}`,
    );
});

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log('Compaction legacy symbol check passed.');

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const violations: string[] = [];
const productionRoots = ['apps/kite/src', 'packages', 'native']
  .map((path) => join(root, path))
  .filter(existsSync);
const versionedPath = /(?:^|[/_.-])(v\d+|state\d+|store\d+|rmv\d+|rav\d+)(?:[/_.-]|$)/i;

function visit(path: string): void {
  const entry = statSync(path);
  if (entry.isDirectory()) {
    for (const child of readdirSync(path)) {
      if (child === 'node_modules' || child === 'dist') continue;
      visit(join(path, child));
    }
    return;
  }
  const relativePath = relative(root, path);
  if (versionedPath.test(relativePath)) {
    violations.push(`${relativePath}: versioned production path`);
  }
  if (!/\.(?:ts|tsx|js|jsx|rs)$/.test(path)) return;
  const source = readFileSync(path, 'utf8');
  // TUI-boundary imports are checked by the dedicated core-boundary gate; this
  // gate remains focused on production naming and composition identity.
  if (
    relativePath === 'apps/kite/src/bootstrap.ts' &&
    /legacyStore|createKiteRuntimeStorageViewV1/.test(source)
  ) {
    violations.push(`${relativePath}: legacy storage view name`);
  }
}

for (const path of productionRoots) visit(path);
const compositionRoots = ['apps/kite/src/bootstrap.ts'].filter((path) =>
  existsSync(join(root, path)),
);
if (compositionRoots.length !== 1) violations.push('composition root count is not exactly one');

if (violations.length > 0) {
  console.error('pre-release architecture gate failed');
  for (const violation of violations) console.error(`[ARCHITECTURE] ${violation}`);
  process.exit(1);
}
console.log('pre-release architecture gate passed');

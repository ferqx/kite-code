#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = resolve(packageRoot, 'src/app/cli/index.ts');
const result = spawnSync('bun', ['run', entrypoint, ...process.argv.slice(2)], {
  cwd: packageRoot,
  stdio: 'inherit',
});

if (result.error?.code === 'ENOENT') {
  console.error('Kite Code requires Bun. Install Bun from https://bun.sh before running kite-code.');
  process.exit(1);
}
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);

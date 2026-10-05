import { resolve } from 'node:path';
import { runUnifiedTests } from './unified-test-plan';

if (import.meta.main) {
  process.exitCode = await runUnifiedTests(resolve(import.meta.dir, '..'), process.argv.slice(2));
}

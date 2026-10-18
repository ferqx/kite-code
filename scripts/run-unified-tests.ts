import { resolve } from 'node:path';
import { withTestRuntime } from './test-environment';
import { runUnifiedTests } from './unified-test-plan';

if (import.meta.main) {
  const args = process.argv.slice(2);
  const run = () => runUnifiedTests(resolve(import.meta.dir, '..'), args);
  process.exitCode =
    args.length === 0 ? await withTestRuntime(import.meta.filename, args, run) : await run();
}

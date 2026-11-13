import { describe } from 'node:test';
import { pathToFileURL } from 'node:url';

const [preload, file, count] = process.argv.slice(2);
const repeats = Number(count);
if (!preload || !file || !Number.isSafeInteger(repeats) || repeats < 1)
  throw Error('invalid fault soak iteration arguments');

// Register all suites before the first can finish. Node runs these suites in
// order, so each iteration owns its hooks and shares the original process.
const runs: Promise<void>[] = [];
for (let iteration = 1; iteration <= repeats; iteration++) {
  runs.push(
    describe(`fault soak iteration ${iteration}`, async () => {
      const preloadURL = pathToFileURL(preload);
      const fileURL = pathToFileURL(file);
      preloadURL.searchParams.set('faultSoakIteration', String(iteration));
      fileURL.searchParams.set('faultSoakIteration', String(iteration));
      await import(preloadURL.href);
      await import(fileURL.href);
    }),
  );
}
await Promise.all(runs);

import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';

function readOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readOptions(args: readonly string[], name: string): string[] {
  return args.flatMap((argument, index) => (argument === name ? [args[index + 1] ?? ''] : []));
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 0) throw new Error('fault soak test case requires -- before test files');
const preload = readOption(args.slice(0, separator), '--preload');
if (!preload) throw new Error('fault soak test case requires --preload');
const repeatCount = positiveInteger(
  readOption(args.slice(0, separator), '--repeat-count') ?? '1',
  '--repeat-count',
);
const repeatedFiles = new Set(
  readOptions(args.slice(0, separator), '--repeat-file').filter(Boolean),
);
const prewarmFiles = new Set(
  readOptions(args.slice(0, separator), '--prewarm-file').filter(Boolean),
);
const prewarmCount = prewarmFiles.size
  ? positiveInteger(
      readOption(args.slice(0, separator), '--prewarm-count') ?? '1',
      '--prewarm-count',
    )
  : 0;
if (prewarmFiles.size === 0 && readOption(args.slice(0, separator), '--prewarm-count')) {
  throw new Error('--prewarm-count requires at least one --prewarm-file');
}
for (const file of prewarmFiles) {
  if (!repeatedFiles.has(file)) {
    throw new Error(`--prewarm-file must also be declared as --repeat-file: ${file}`);
  }
}
const testArgs = args.slice(separator + 1);
const patternIndex = testArgs.indexOf('-t');
const files = (patternIndex >= 0 ? testArgs.slice(0, patternIndex) : testArgs).filter(Boolean);
const testNameArgs = patternIndex >= 0 ? testArgs.slice(patternIndex) : [];
if (files.length === 0) throw new Error('fault soak test case requires at least one test file');

for (const file of files) {
  const absoluteFile = resolve(file);
  const lifecycleGroupNonce = randomUUID();
  const fileName = basename(file);
  const fileRepeatCount = repeatedFiles.has(fileName)
    ? repeatCount + (prewarmFiles.has(fileName) ? prewarmCount : 0)
    : 1;
  console.log(`[fault-soak-case] ${file}`);
  const proc = Bun.spawn(
    [
      process.execPath,
      'test',
      '--preload',
      resolve(preload),
      '--max-concurrency=1',
      ...(fileRepeatCount > 1 ? [`--rerun-each=${fileRepeatCount}`] : []),
      absoluteFile,
      ...testNameArgs,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        KITE_FAULT_SOAK_LIFECYCLE_ID: basename(file),
        KITE_FAULT_SOAK_LIFECYCLE_GROUP_NONCE: lifecycleGroupNonce,
        KITE_FAULT_SOAK_REPEAT_COUNT: String(fileRepeatCount),
      },
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

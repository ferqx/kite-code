import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { collectTestFiles } from './test-suite';
import { testRuntimeFlags } from './tooling/test-command';

export function parseTestFilesArgs(args: readonly string[]) {
  let concurrency = 1;
  let timeout = 5000;
  let name: string | undefined;
  let reporter = 'spec';
  let coverage = false;
  let allOptions = true;
  const preload: string[] = [];
  const files = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (allOptions && arg === '--') {
      allOptions = false;
      continue;
    }
    if (allOptions && arg.startsWith('-')) {
      const [flag, inline] = arg.split(/=(.*)/s, 2);
      if (flag === '--coverage' || flag === '--only-failures') {
        if (inline !== undefined) throw Error(`Unexpected value for ${flag}`);
        if (flag === '--coverage') coverage = true;
        else reporter = 'dot';
        continue;
      }
      if (
        ![
          '--parallel',
          '--max-concurrency',
          '--timeout',
          '--preload',
          '--test-name-pattern',
          '-t',
        ].includes(flag!)
      )
        throw Error(`Unknown test option: ${arg}`);
      const value = inline ?? args[++i];
      if (!value) throw Error(`Missing value for ${flag}`);
      if (flag === '--preload') preload.push(resolve(value));
      else if (flag === '--test-name-pattern' || flag === '-t') {
        if (name !== undefined) throw Error('Test name pattern repeated');
        name = value;
      } else {
        const number = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1)
          throw Error(`Invalid value for ${flag}`);
        if (flag === '--parallel') concurrency = number;
        if (flag === '--timeout') timeout = number;
        if (flag === '--max-concurrency' && number !== 1)
          throw Error('--max-concurrency must be 1; use --parallel for file-level workers');
      }
      continue;
    }
    const found = collectTestFiles(resolve(arg));
    if (!found.length) throw Error(`No test files at exact path: ${arg}`);
    for (const file of found) files.add(file);
  }
  if (!files.size) throw Error('Pass at least one exact test file or directory');
  return { files: [...files], concurrency, timeout, name, preload, reporter, coverage };
}

async function main(args: readonly string[]): Promise<number> {
  const options = parseTestFilesArgs(args);
  const env = { ...process.env, KITE_TEST_TIMEOUT_MS: String(options.timeout) };
  delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT;
  delete (env as NodeJS.ProcessEnv).NODE_TEST_WORKER_ID;
  const child = spawn(
    process.execPath,
    [
      ...testRuntimeFlags,
      ...options.preload.flatMap((path) => ['--import', path]),
      ...(options.files.length === 1
        ? []
        : ['--test', `--test-concurrency=${options.concurrency}`]),
      `--test-reporter=${options.reporter}`,
      ...(options.name === undefined ? [] : [`--test-name-pattern=${options.name}`]),
      ...(options.coverage ? ['--experimental-test-coverage'] : []),
      ...options.files,
    ],
    {
      stdio: 'inherit',
      env,
    },
  );
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (!stopping) {
      stopping = true;
      child.kill(signal);
    }
  };
  const onTerm = () => stop('SIGTERM');
  const onInt = () => stop('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)));
    });
  } finally {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  }
}
if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}

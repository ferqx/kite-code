import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

export interface TestJob {
  label: string;
  files: string[];
  command?: string[];
  maxConcurrency?: number;
  drainOnFailure?: boolean;
}

export interface TestPartition {
  parallel: string[];
  isolated: string[];
  exclusive: string[];
}

export function testParallelism(): number {
  const platformLimit = process.platform === 'linux' ? 2 : 4;
  return Math.max(1, Math.min(platformLimit, availableParallelism()));
}

export function collectTestFiles(path: string): string[] {
  const absolute = resolve(path);
  try {
    return readdirSync(absolute, { withFileTypes: true })
      .flatMap((entry) => {
        const child = join(absolute, entry.name);
        return entry.isDirectory()
          ? collectTestFiles(child)
          : TEST_FILE_PATTERN.test(entry.name)
            ? [child]
            : [];
      })
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function testIsolationClass(path: string): 'parallel' | 'isolated' | 'exclusive' {
  const normalized = path.split(sep).join('/');
  if (normalized.includes('/isolated/exclusive/')) return 'exclusive';
  if (normalized.includes('/isolated/')) return 'isolated';
  return testSourceRequiresProcessIsolation(readFileSync(path, 'utf8')) ? 'exclusive' : 'parallel';
}

export function testSourceRequiresProcessIsolation(source: string): boolean {
  const file = ts.createSourceFile('test-isolation.ts', source, ts.ScriptTarget.Latest, true);
  let required = false;
  const visit = (node: ts.Node): void => {
    if (required) return;
    if (ts.isCallExpression(node)) {
      const target = node.expression.getText(file);
      if (
        target === 'process.chdir' ||
        target === 'Bun.spawn' ||
        target === 'Bun.spawnSync' ||
        target === 'spawnSync' ||
        target === 'ServiceProcess.start'
      ) {
        required = true;
        return;
      }
    }
    if (ts.isBinaryExpression(node)) {
      const target = node.left.getText(file);
      if (/^process\.env\.(?:HOME|KITE_CODE_HOME|USERPROFILE)$/u.test(target)) {
        required = true;
        return;
      }
    }
    if (
      ts.isDeleteExpression(node) &&
      /^process\.env\.(?:HOME|KITE_CODE_HOME|USERPROFILE)$/u.test(node.expression.getText(file))
    ) {
      required = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return required;
}

export function partitionTestFiles(files: readonly string[]): TestPartition {
  const parallel: string[] = [];
  const isolated: string[] = [];
  const exclusive: string[] = [];
  for (const file of files) {
    const mode = testIsolationClass(file);
    if (mode === 'parallel') parallel.push(file);
    else if (mode === 'isolated') isolated.push(file);
    else exclusive.push(file);
  }
  return { parallel, isolated, exclusive };
}

export function shardTestFiles(files: readonly string[], requestedShards: number): string[][] {
  const shardCount = Math.min(Math.max(1, requestedShards), files.length);
  if (shardCount === 0) return [];
  const shards = Array.from({ length: shardCount }, () => ({ files: [] as string[], weight: 0 }));
  const weighted = files
    .map((file) => ({ file, weight: statSync(file).size }))
    .sort((left, right) => right.weight - left.weight || left.file.localeCompare(right.file));
  for (const entry of weighted) {
    const target = shards.reduce((lightest, shard) =>
      shard.weight < lightest.weight ? shard : lightest,
    );
    target.files.push(entry.file);
    target.weight += entry.weight;
  }
  return shards.map((shard) => shard.files.sort());
}

function testEnvironment(prefix: string): { env: Record<string, string>; dispose(): void } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const codeRoot = join(home, '.kite-code');
  return {
    env: {
      ...process.env,
      HOME: home,
      // KLSV1 Service contract: this is the exact code root, not an OS-home override.
      KITE_CODE_HOME: codeRoot,
      ...(process.platform === 'win32' ? { USERPROFILE: home } : {}),
    } as Record<string, string>,
    dispose: () => rmSync(home, { recursive: true, force: true }),
  };
}

export async function runTestJob(
  repositoryRoot: string,
  job: TestJob,
  options: { maxConcurrency?: number; signal?: AbortSignal } = {},
): Promise<number> {
  if (job.files.length === 0 && !job.command) return 0;
  if (options.signal?.aborted) return 130;
  const environment = testEnvironment('kite-test-v2-');
  const startedAt = performance.now();
  const displayFiles = job.files.map((file) => relative(repositoryRoot, file).split(sep).join('/'));
  const maxConcurrency = options.maxConcurrency ?? job.maxConcurrency;
  console.log(
    '\n[test:' +
      job.label +
      '] files=' +
      displayFiles.length +
      (maxConcurrency ? ` maxConcurrency=${maxConcurrency}` : ''),
  );
  const args = job.command ?? [
    process.execPath,
    'test',
    '--no-orphans',
    '--only-failures',
    ...(process.platform === 'win32' ? ['--timeout=30000'] : []),
    ...(maxConcurrency ? [`--max-concurrency=${maxConcurrency}`] : []),
    ...displayFiles,
  ];
  try {
    const child = Bun.spawn(args, {
      cwd: repositoryRoot,
      env: environment.env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const abort = (): void => {
      try {
        child.kill();
      } catch {
        // The process may have exited between the abort signal and this callback.
      }
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const exitCode = await child.exited;
    options.signal?.removeEventListener('abort', abort);
    console.log(
      '[test:' +
        job.label +
        '] ' +
        (exitCode === 0 ? 'passed' : `failed(${exitCode})`) +
        ' durationMs=' +
        Math.round(performance.now() - startedAt),
    );
    return exitCode;
  } finally {
    environment.dispose();
  }
}

export async function runTestJobs(
  repositoryRoot: string,
  jobs: readonly TestJob[],
  concurrency: number,
): Promise<number> {
  let nextIndex = 0;
  let failure = 0;
  const controller = new AbortController();
  const worker = async (): Promise<void> => {
    while (failure === 0) {
      const index = nextIndex++;
      const job = jobs[index];
      if (!job) return;
      const exitCode = await runTestJob(repositoryRoot, job, {
        signal: job.drainOnFailure ? undefined : controller.signal,
      });
      if (exitCode !== 0 && failure === 0) {
        failure = exitCode;
        controller.abort();
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), jobs.length) }, () => worker()),
  );
  return failure;
}

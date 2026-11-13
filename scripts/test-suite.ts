import { readdirSync, readFileSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import ts from 'typescript';
import {
  startWindowsOwnedChild,
  WindowsOwnedChildStartError,
} from '../packages/agent/src/platform/process/windows-owned-child';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../tests/fixtures/test-filesystem';
import { testToolchainEnvironment } from './test-environment';
import { spawn } from './tooling/process';
import { testFileCommand } from './tooling/test-command';

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
    if (statSync(absolute).isFile()) return TEST_FILE_PATTERN.test(absolute) ? [absolute] : [];
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
  const processStarts = new Set(['spawn', 'spawnSync']);
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !/^(?:node:child_process|.*[/\\]tooling[/\\]process)$/u.test(statement.moduleSpecifier.text)
    )
      continue;
    const imports = statement.importClause?.namedBindings;
    if (!imports || !ts.isNamedImports(imports)) continue;
    for (const entry of imports.elements) {
      if (
        /^(?:spawn|spawnSync|exec|execFile|execSync|execFileSync|fork)$/u.test(
          (entry.propertyName ?? entry.name).text,
        )
      )
        processStarts.add(entry.name.text);
    }
  }
  let required = false;
  const visit = (node: ts.Node): void => {
    if (required) return;
    if (ts.isCallExpression(node)) {
      const target = node.expression.getText(file);
      if (
        target === 'process.chdir' ||
        processStarts.has(target) ||
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
  const home = temporaryDirectory(prefix);
  const codeRoot = join(home, '.kite-code');
  const temporary = join(home, 'tmp');
  if (process.platform === 'win32') privateDirectory(temporary);
  return {
    env: {
      ...process.env,
      ...testToolchainEnvironment(),
      HOME: home,
      // KLSV1 Service contract: this is the exact code root, not an OS-home override.
      KITE_CODE_HOME: codeRoot,
      ...(process.platform === 'win32'
        ? { USERPROFILE: home, TEMP: temporary, TMP: temporary }
        : {}),
    } as Record<string, string>,
    dispose: () => removeTemporaryDirectory(home),
  };
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function runPosixTestChild(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<number> {
  const child = spawn(command, {
    cwd,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    detached: true,
  });
  let escalation: NodeJS.Timeout | undefined;
  let deliveryError: unknown;
  const deliver = (signal: NodeJS.Signals) => {
    try {
      signalGroup(child.pid, signal);
    } catch (error) {
      deliveryError ??= error;
      // The ChildProcess still identifies the direct child, even if macOS
      // denies a group kill through the enclosing sandbox.
      try {
        child.kill(signal);
      } catch (fallbackError) {
        deliveryError = new AggregateError(
          [deliveryError, fallbackError],
          'test_process_signal_failed',
        );
      }
    }
  };
  const abort = () => {
    deliver('SIGTERM');
    escalation ??= setTimeout(() => deliver('SIGKILL'), 2000);
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const [result] = await Promise.allSettled([child.exited]);
  signal?.removeEventListener('abort', abort);
  clearTimeout(escalation);
  // The exit status is complete only after the exact detached group drains.
  const deadline = performance.now() + 5000;
  for (;;) {
    try {
      // Absence is authoritative. EPERM is not absence and macOS can
      // report it briefly while the last sandboxed child is exiting.
      if (!signalGroup(child.pid, 'SIGKILL')) break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      deliveryError ??= error;
    }
    if (performance.now() >= deadline)
      throw Error('test_process_group_cleanup_unknown', { cause: deliveryError });
    await sleep(50);
  }
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

async function runWindowsTestChild(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<number> {
  const [entry, ...argv] = command;
  if (!entry || !isAbsolute(entry)) throw Error('test_child_executable_must_be_absolute');
  let child: ReturnType<typeof startWindowsOwnedChild>;
  try {
    child = startWindowsOwnedChild({
      executable: entry,
      argv,
      cwd,
      env: Object.fromEntries(
        Object.entries(env).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
      ),
      stdin: 'ignore',
    });
  } catch (error) {
    if (error instanceof WindowsOwnedChildStartError) await error.cleanup;
    throw error;
  }
  const forward = async (source: AsyncIterable<Uint8Array>, output: NodeJS.WriteStream) => {
    for await (const chunk of source) {
      await new Promise<void>((resolve, reject) =>
        output.write(chunk, (error) => (error ? reject(error) : resolve())),
      );
    }
  };
  const abort = () => {
    void child.stop({ graceMs: 0 }).catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const exit = await Promise.all([
    child.exited,
    forward(child.stdout, process.stdout),
    forward(child.stderr, process.stderr),
  ]).then(
    ([code]) => ({ code }),
    (error: unknown) => ({ error }),
  );
  signal?.removeEventListener('abort', abort);
  await child.close();
  const evidence = child.readEvidence();
  if (
    !evidence.closed ||
    evidence.closeUnknown ||
    !evidence.job.treeStopped ||
    !evidence.root.waitConfirmed
  )
    throw Error('test_windows_job_cleanup_unknown');
  if ('error' in exit) throw exit.error;
  return exit.code;
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
  let succeeded = false;
  const displayFiles = job.files.map((file) => relative(repositoryRoot, file).split(sep).join('/'));
  const maxConcurrency = options.maxConcurrency ?? job.maxConcurrency;
  console.log(
    '\n[test:' +
      job.label +
      '] files=' +
      displayFiles.length +
      (maxConcurrency ? ` maxConcurrency=${maxConcurrency}` : ''),
  );
  const args =
    job.command ??
    testFileCommand([
      '--only-failures',
      ...(process.platform === 'darwin' ? [] : ['--timeout=30000']),
      ...(maxConcurrency ? [`--max-concurrency=${maxConcurrency}`] : []),
      ...job.files.map((file) => resolve(repositoryRoot, file)),
    ]);
  try {
    const execute = process.platform === 'win32' ? runWindowsTestChild : runPosixTestChild;
    const exitCode = await execute(args, repositoryRoot, environment.env, options.signal);
    succeeded = exitCode === 0;
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
    if (succeeded) environment.dispose();
    else console.error(`[test:${job.label}] retained failed environment: ${environment.env.HOME}`);
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
      let exitCode: number;
      try {
        exitCode = await runTestJob(repositoryRoot, job, {
          signal: job.drainOnFailure ? undefined : controller.signal,
        });
      } catch (error) {
        console.error(
          `[test:${job.label}] ${error instanceof Error ? error.message : String(error)}`,
        );
        exitCode = 1;
      }
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

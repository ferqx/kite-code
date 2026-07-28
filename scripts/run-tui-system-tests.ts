import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const DEFAULT_FILE_TIMEOUT_MS = 180_000;
const scenariosDir = join(process.cwd(), 'tests', 'tui-system', 'scenarios');
const reportDir = process.env.KITE_TUI_TEST_REPORT_DIR;

interface ScenarioResult {
  file: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  junitPath?: string;
  testCount?: number;
  skippedCount?: number;
  failureCount?: number;
  lastTestCase?: string;
}

function parseJunit(
  path: string,
): Pick<ScenarioResult, 'testCount' | 'skippedCount' | 'failureCount' | 'lastTestCase'> {
  const xml = readFileSync(path, 'utf8');
  const suites = xml.match(/<testsuites\b[^>]*>/)?.[0] ?? '';
  const numberAttribute = (name: string) =>
    Number(suites.match(new RegExp(`${name}="(\\d+)"`))?.[1] ?? 0);
  const cases = Array.from(xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"/g), (match) => match[1]!);
  return {
    testCount: numberAttribute('tests'),
    skippedCount: numberAttribute('skipped'),
    failureCount: numberAttribute('failures') + numberAttribute('errors'),
    ...(cases.length > 0 ? { lastTestCase: cases.at(-1) } : {}),
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function scenarioFiles(): string[] {
  const available = readdirSync(scenariosDir)
    .filter((name) => name.endsWith('.test.ts'))
    .sort();
  const requested = process.argv.slice(2);
  const selected =
    requested.length === 0
      ? available
      : available.filter((name) =>
          requested.some((query) => name === query || name === `${query}.test.ts`),
        );
  if (selected.length === 0) {
    throw new Error(`No TUI system scenarios matched: ${requested.join(', ')}`);
  }
  return selected.map((name) => join(scenariosDir, name));
}

function terminateProcessTree(proc: ReturnType<typeof Bun.spawn>): void {
  if (process.platform === 'win32') {
    Bun.spawnSync(['taskkill.exe', '/pid', String(proc.pid), '/t', '/f'], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return;
  }
  const listing = Bun.spawnSync(['ps', '-Ao', 'pid=,ppid='], {
    stdout: 'pipe',
    stderr: 'ignore',
  }).stdout.toString();
  const children = new Map<number, number[]>();
  for (const line of listing.split('\n')) {
    const [pidText, parentText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const descendants: number[] = [];
  const visit = (parent: number) => {
    for (const child of children.get(parent) ?? []) {
      visit(child);
      descendants.push(child);
    }
  };
  visit(proc.pid);
  for (const pid of descendants) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The child may have exited between the process snapshot and the kill.
    }
  }
  proc.kill('SIGKILL');
}

async function runFile(file: string, timeoutMs: number): Promise<ScenarioResult> {
  console.log(`\n[tui-system] ${file}`);
  const startedAt = Date.now();
  const junitPath = reportDir
    ? join(reportDir, `${basename(file, '.test.ts')}.junit.xml`)
    : undefined;
  const command = [process.execPath, 'test', '--parallel=1', '--max-concurrency=1'];
  if (junitPath) {
    command.push('--reporter=junit', `--reporter-outfile=${junitPath}`);
  }
  command.push(file);
  const proc = Bun.spawn(command, {
    cwd: process.cwd(),
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const result = await Promise.race([proc.exited, timeout]);
  if (timer) clearTimeout(timer);

  if (result === 'timeout') {
    console.error(`[tui-system] timed out after ${timeoutMs}ms: ${file}`);
    terminateProcessTree(proc);
    await proc.exited.catch(() => {});
    return {
      file,
      exitCode: 124,
      durationMs: Date.now() - startedAt,
      timedOut: true,
      ...(junitPath ? { junitPath } : {}),
    };
  }
  return {
    file,
    exitCode: result,
    durationMs: Date.now() - startedAt,
    timedOut: false,
    ...(junitPath ? { junitPath } : {}),
    ...(junitPath ? parseJunit(junitPath) : {}),
  };
}

const timeoutMs = positiveInteger(
  process.env.KITE_TUI_TEST_FILE_TIMEOUT_MS,
  DEFAULT_FILE_TIMEOUT_MS,
);
const files = scenarioFiles();
if (reportDir) mkdirSync(reportDir, { recursive: true });
const results: ScenarioResult[] = [];

for (const file of files) {
  const result = await runFile(file, timeoutMs);
  results.push(result);
  if (result.exitCode !== 0) {
    console.error(`[tui-system] failed with exit code ${result.exitCode}: ${file}`);
    if (reportDir) {
      writeFileSync(
        join(reportDir, 'summary.json'),
        `${JSON.stringify({ timeoutMs, totalFiles: files.length, completedFiles: results.length, results }, null, 2)}\n`,
      );
    }
    process.exit(result.exitCode);
  }
}

if (reportDir) {
  writeFileSync(
    join(reportDir, 'summary.json'),
    `${JSON.stringify({ timeoutMs, totalFiles: files.length, completedFiles: results.length, results }, null, 2)}\n`,
  );
}
console.log(`\n[tui-system] passed ${files.length} scenario files`);

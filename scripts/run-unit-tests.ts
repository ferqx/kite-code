import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_SUITE_TIMEOUT_MS = 600_000;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function terminateProcessTree(proc: ReturnType<typeof Bun.spawn>): void {
  if (process.platform === 'win32') {
    Bun.spawnSync(['taskkill.exe', '/pid', String(proc.pid), '/t', '/f'], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return;
  }
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    proc.kill('SIGKILL');
  }
}

const timeoutMs = positiveInteger(process.env.KITE_UNIT_TEST_TIMEOUT_MS, DEFAULT_SUITE_TIMEOUT_MS);
const reportDir = process.env.KITE_UNIT_TEST_REPORT_DIR;
if (reportDir) mkdirSync(reportDir, { recursive: true });

const command = [
  process.execPath,
  'test',
  '--path-ignore-patterns=tests/tui-system/**',
  '--path-ignore-patterns=tests/pty-spike/**',
];
const junitPath = reportDir ? join(reportDir, 'unit.junit.xml') : undefined;
if (junitPath) command.push('--reporter=junit', `--reporter-outfile=${junitPath}`);
command.push(...process.argv.slice(2));

const startedAt = Date.now();
const proc = Bun.spawn(command, {
  cwd: process.cwd(),
  env: process.env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
  ...(process.platform === 'win32' ? {} : { detached: true }),
});
let timer: ReturnType<typeof setTimeout> | undefined;
const timeout = new Promise<'timeout'>((resolve) => {
  timer = setTimeout(() => resolve('timeout'), timeoutMs);
});
const result = await Promise.race([proc.exited, timeout]);
if (timer) clearTimeout(timer);

const timedOut = result === 'timeout';
if (timedOut) {
  console.error(`[unit] timed out after ${timeoutMs}ms`);
  terminateProcessTree(proc);
  await proc.exited.catch(() => {});
}
const exitCode = timedOut ? 124 : result;
const junit = (() => {
  if (!junitPath || timedOut) return {};
  const xml = readFileSync(junitPath, 'utf8');
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
})();
if (reportDir) {
  writeFileSync(
    join(reportDir, 'summary.json'),
    `${JSON.stringify(
      {
        timeoutMs,
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
        ...(junitPath ? { junitPath } : {}),
        ...junit,
      },
      null,
      2,
    )}\n`,
  );
}
process.exit(exitCode);

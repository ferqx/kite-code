import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  resourceTrendFailures,
  type TuiSystemResourceSample,
} from '../tests/tui-system/harness/resource-trend';

const DEFAULT_FILE_TIMEOUT_MS = 180_000;
const harnessDir = join(process.cwd(), 'tests', 'tui-system', 'harness');
const scenariosDir = join(process.cwd(), 'tests', 'tui-system', 'scenarios');

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

function harnessTestFiles(): string[] {
  return readdirSync(harnessDir)
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => join(harnessDir, name));
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

async function runFile(file: string, timeoutMs: number): Promise<number> {
  console.log(`\n[tui-system] ${file}`);
  const proc = Bun.spawn([process.execPath, 'test', '--parallel=1', '--max-concurrency=1', file], {
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
    return 124;
  }
  return result;
}

function fileDescriptorCount(): number | undefined {
  if (process.platform === 'win32') return undefined;
  const directory = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
  try {
    return readdirSync(directory).length;
  } catch {
    return undefined;
  }
}

function sampleResources(): TuiSystemResourceSample {
  return {
    rssBytes: process.memoryUsage.rss(),
    activeResourceCount: process.getActiveResourcesInfo().length,
    fdCount: fileDescriptorCount(),
  };
}

function formatDelta(first: number | undefined, last: number | undefined): string {
  if (first == null || last == null) return 'unsupported';
  const delta = last - first;
  return `${first}->${last} (${delta >= 0 ? '+' : ''}${delta})`;
}

const timeoutMs = positiveInteger(
  process.env.KITE_TUI_TEST_FILE_TIMEOUT_MS,
  DEFAULT_FILE_TIMEOUT_MS,
);
const harnessFiles = harnessTestFiles();
const scenarios = scenarioFiles();
const files = [...harnessFiles, ...scenarios];
const resourceSamples: TuiSystemResourceSample[] = [sampleResources()];

for (const file of files) {
  const exitCode = await runFile(file, timeoutMs);
  if (exitCode !== 0) {
    console.error(`[tui-system] failed with exit code ${exitCode}: ${file}`);
    process.exit(exitCode);
  }
  await Bun.sleep(0);
  resourceSamples.push(sampleResources());
}

const firstSample = resourceSamples[0]!;
const lastSample = resourceSamples.at(-1)!;
console.log(
  `[tui-system] resource trend: rss=${formatDelta(
    Math.round(firstSample.rssBytes / 1024 / 1024),
    Math.round(lastSample.rssBytes / 1024 / 1024),
  )}MiB active=${formatDelta(
    firstSample.activeResourceCount,
    lastSample.activeResourceCount,
  )} fd=${formatDelta(firstSample.fdCount, lastSample.fdCount)}`,
);
const trendFailures = resourceTrendFailures(resourceSamples);
if (trendFailures.length > 0) {
  console.error(`[tui-system] sustained positive resource slope: ${trendFailures.join(', ')}`);
  process.exit(1);
}

console.log(
  `\n[tui-system] passed ${harnessFiles.length} harness files and ${scenarios.length} scenario files`,
);

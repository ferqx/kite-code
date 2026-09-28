import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTestPlan } from '../../../scripts/test-plan';
import { runTestJob, runTestJobs } from '../../../scripts/test-suite';

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'kite-runner-fixture-'));
  roots.push(root);
  mkdirSync(join(root, 'tests'), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('layered test runner', () => {
  test('gives concurrent child processes unique disposable homes', async () => {
    const root = fixture();
    const firstOutput = join(root, 'first-home.txt');
    const secondOutput = join(root, 'second-home.txt');
    const first = join(root, 'tests', 'first.test.ts');
    const second = join(root, 'tests', 'second.test.ts');
    writeFileSync(
      first,
      "import { expect, test } from 'bun:test'; import { writeFileSync } from 'node:fs'; import { join } from 'node:path';" +
        "test('home', () => { writeFileSync(" +
        JSON.stringify(firstOutput) +
        ", process.env.HOME!); expect(process.env.KITE_CODE_HOME).toBe(join(process.env.HOME!, '.kite-code')); });",
    );
    writeFileSync(
      second,
      "import { expect, test } from 'bun:test'; import { writeFileSync } from 'node:fs'; import { join } from 'node:path';" +
        "test('home', () => { writeFileSync(" +
        JSON.stringify(secondOutput) +
        ", process.env.HOME!); expect(process.env.KITE_CODE_HOME).toBe(join(process.env.HOME!, '.kite-code')); });",
    );
    expect(
      await runTestJobs(
        root,
        [
          { label: 'first', files: [first] },
          { label: 'second', files: [second] },
        ],
        2,
      ),
    ).toBe(0);
    const firstHome = readFileSync(firstOutput, 'utf8');
    const secondHome = readFileSync(secondOutput, 'utf8');
    expect(firstHome).not.toBe(secondHome);
    expect(existsSync(firstHome)).toBe(false);
    expect(existsSync(secondHome)).toBe(false);
  });

  test('propagates a child test failure', async () => {
    const root = fixture();
    const failure = join(root, 'tests', 'failure.test.ts');
    writeFileSync(
      failure,
      "import { expect, test } from 'bun:test'; test('failure', () => expect(false).toBe(true));",
    );
    expect(await runTestJob(root, { label: 'expected-failure', files: [failure] })).not.toBe(0);
  });

  test('stops scheduling and terminates an owned sibling process after failure', async () => {
    const root = fixture();
    const completed = join(root, 'completed.txt');
    const failure = join(root, 'tests', 'failure.test.ts');
    const slow = join(root, 'tests', 'slow.test.ts');
    const neverScheduled = join(root, 'tests', 'never-scheduled.test.ts');
    writeFileSync(
      failure,
      "import { expect, test } from 'bun:test'; test('failure', async () => { await Bun.sleep(250); expect(false).toBe(true); });",
    );
    writeFileSync(
      slow,
      "import { test } from 'bun:test'; import { writeFileSync } from 'node:fs'; test('slow', async () => { await Bun.sleep(30000); writeFileSync(" +
        JSON.stringify(completed) +
        ", 'slow'); });",
    );
    writeFileSync(
      neverScheduled,
      "import { test } from 'bun:test'; import { writeFileSync } from 'node:fs'; test('never', () => writeFileSync(" +
        JSON.stringify(completed) +
        ", 'never'));",
    );
    const startedAt = performance.now();
    expect(
      await runTestJobs(
        root,
        [
          { label: 'failure', files: [failure] },
          { label: 'slow', files: [slow] },
          { label: 'never', files: [neverScheduled] },
        ],
        2,
      ),
    ).not.toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(existsSync(completed)).toBe(false);
  });

  test('bounds the number of active child processes to the global worker count', async () => {
    const root = fixture();
    const jobs = Array.from({ length: 4 }, (_, index) => {
      const file = join(root, 'tests', `concurrent-${index}.test.ts`);
      const started = join(root, `started-${index}.txt`);
      const ended = join(root, `ended-${index}.txt`);
      writeFileSync(
        file,
        `import { test } from 'bun:test'; import { writeFileSync } from 'node:fs';
test('bounded', async () => {
  writeFileSync(${JSON.stringify(started)}, String(Date.now()));
  await Bun.sleep(400);
  writeFileSync(${JSON.stringify(ended)}, String(Date.now()));
});`,
      );
      return { label: `concurrent-${index}`, files: [file], started, ended };
    });
    expect(await runTestJobs(root, jobs, 2)).toBe(0);
    const intervals = jobs.map(({ started, ended }) => ({
      started: Number(readFileSync(started, 'utf8')),
      ended: Number(readFileSync(ended, 'utf8')),
    }));
    const peak = Math.max(
      ...intervals.map(
        ({ started }) =>
          intervals.filter((interval) => interval.started <= started && interval.ended > started)
            .length,
      ),
    );
    expect(peak).toBe(2);
  });

  test('drains an in-flight isolated file after failure without scheduling the next file', async () => {
    const root = fixture();
    const completed = join(root, 'completed.txt');
    const neverStarted = join(root, 'never-started.txt');
    const failure = join(root, 'tests', 'failure.test.ts');
    const cleanup = join(root, 'tests', 'cleanup.test.ts');
    const queued = join(root, 'tests', 'queued.test.ts');
    writeFileSync(
      failure,
      "import { expect, test } from 'bun:test'; test('failure', async () => { await Bun.sleep(150); expect(false).toBe(true); });",
    );
    writeFileSync(
      cleanup,
      `import { test } from 'bun:test'; import { writeFileSync } from 'node:fs';
test('cleanup', async () => { await Bun.sleep(450); writeFileSync(${JSON.stringify(completed)}, process.env.HOME!); });`,
    );
    writeFileSync(
      queued,
      `import { test } from 'bun:test'; import { writeFileSync } from 'node:fs';
test('queued', () => writeFileSync(${JSON.stringify(neverStarted)}, 'started'));`,
    );
    expect(
      await runTestJobs(
        root,
        [
          { label: 'failure', files: [failure], maxConcurrency: 1, drainOnFailure: true },
          { label: 'cleanup', files: [cleanup], maxConcurrency: 1, drainOnFailure: true },
          { label: 'queued', files: [queued], maxConcurrency: 1, drainOnFailure: true },
        ],
        2,
      ),
    ).not.toBe(0);
    const home = readFileSync(completed, 'utf8');
    expect(existsSync(home)).toBe(false);
    expect(existsSync(neverStarted)).toBe(false);
  });

  test('runs exclusive files only after all concurrent work has exited', async () => {
    const root = fixture();
    const marker = join(root, 'concurrent-active.txt');
    const concurrent = join(root, 'tests', 'concurrent.test.ts');
    const exclusive = join(root, 'tests', 'exclusive.test.ts');
    writeFileSync(
      concurrent,
      `import { test } from 'bun:test'; import { writeFileSync, rmSync } from 'node:fs';
test('concurrent', async () => {
  writeFileSync(${JSON.stringify(marker)}, 'active');
  await Bun.sleep(400);
  rmSync(${JSON.stringify(marker)});
});`,
    );
    writeFileSync(
      exclusive,
      `import { expect, test } from 'bun:test'; import { existsSync } from 'node:fs';
test('exclusive', () => expect(existsSync(${JSON.stringify(marker)})).toBe(false));`,
    );
    expect(
      await runTestPlan(
        root,
        {
          concurrent: [{ label: 'concurrent', files: [concurrent] }],
          exclusive: [{ label: 'exclusive', files: [exclusive], maxConcurrency: 1 }],
          counts: { parallel: 1, isolated: 0, exclusive: 1 },
        },
        2,
      ),
    ).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});

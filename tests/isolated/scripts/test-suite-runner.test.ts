import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      "import { expect, test } from 'bun:test'; import { writeFileSync } from 'node:fs';" +
        "test('home', () => { writeFileSync(" +
        JSON.stringify(firstOutput) +
        ', process.env.HOME!); expect(process.env.KITE_CODE_HOME).toBe(process.env.HOME); });',
    );
    writeFileSync(
      second,
      "import { expect, test } from 'bun:test'; import { writeFileSync } from 'node:fs';" +
        "test('home', () => { writeFileSync(" +
        JSON.stringify(secondOutput) +
        ', process.env.HOME!); expect(process.env.KITE_CODE_HOME).toBe(process.env.HOME); });',
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
});

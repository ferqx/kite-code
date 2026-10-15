import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  parseUnifiedTuiShard,
  runUnifiedTuiSystemTests,
  selectUnifiedTuiTests,
  unifiedTuiInventory,
  unifiedTuiTestPlan,
} from '../../../scripts/run-unified-tui-system-tests';
import { collectTestFiles } from '../../../scripts/test-suite';

const root = resolve(import.meta.dir, '../../..');
const formal = 'tests/isolated/unified-agent/formal-terminal-entrypoints.test.ts';
const startup = 'tests/isolated/unified-agent/tui-startup-wait.test.ts';
test('four exact deterministic shards cover every original terminal scenario, current CLI owner and formal wrapper once', () => {
  const inventory = unifiedTuiInventory(root);
  const expected = collectTestFiles(join(root, 'apps/cli/test'))
    .filter((file) => /\/tui[^/]*\.test\.ts$/.test(file.replaceAll('\\', '/')))
    .map((file) => file.slice(root.length + 1).replaceAll('\\', '/'));
  const original = collectTestFiles(join(root, 'tests/tui-system/scenarios')).map((file) =>
    file.slice(root.length + 1).replaceAll('\\', '/'),
  );
  expect(original).toHaveLength(52);
  expect(inventory).toEqual([...expected, ...original, formal, startup].sort());
  expect(inventory.length).toBeGreaterThan(20);
  expect(
    inventory.every(
      (file) =>
        file.startsWith('apps/cli/test/') ||
        file.startsWith('tests/tui-system/scenarios/') ||
        file === formal ||
        file === startup,
    ),
  ).toBe(true);
  const plan = unifiedTuiTestPlan(root, inventory, 4);
  const originalJobs = plan.concurrent.filter((job) => job.label.startsWith('original-tui:'));
  expect(originalJobs).toHaveLength(original.length);
  for (const job of originalJobs) {
    expect(job.files).toHaveLength(1);
    expect(job.drainOnFailure).toBe(true);
    expect(job.command).toEqual([
      process.execPath,
      join(root, 'scripts/run-tui-system-tests.ts'),
      job.files[0]!.split('/').at(-1)!,
    ]);
  }
  const shards = Array.from(
    { length: 4 },
    (_, index) => selectUnifiedTuiTests(root, [], `${index}/4`).files,
  );
  expect(shards.flat().sort()).toEqual(inventory);
  expect(new Set(shards.flat()).size).toBe(inventory.length);
  for (let index = 0; index < 4; index++) {
    expect(selectUnifiedTuiTests(root, ['--list'], `${index}/4`).files).toEqual(shards[index]!);
    expect(shards[index]).toEqual(inventory.filter((_, position) => position % 4 === index));
  }
});

test('closed argv and four-shard grammar reject before any test inventory access', async () => {
  const missing = join(tmpdir(), 'kite-unified-tui-inventory-does-not-exist');
  for (const value of [
    '',
    ' ',
    '4/4',
    '-1/4',
    '0/3',
    '0/04',
    '00/4',
    ' 0/4',
    '0/4 ',
    '0/4\n',
    '0/4/1',
  ])
    expect(() => selectUnifiedTuiTests(missing, ['--list'], value)).toThrow('must be exactly');
  for (const args of [
    ['--help'],
    ['--list', '--list'],
    ['legacy-scenario'],
    ['--with-lifecycle-harness'],
  ]) {
    expect(() => selectUnifiedTuiTests(missing, args, undefined)).toThrow('usage:');
    expect(await runUnifiedTuiSystemTests(missing, args, undefined)).toBe(2);
  }
  expect(parseUnifiedTuiShard(undefined)).toBeUndefined();
  expect(() => selectUnifiedTuiTests(missing, [], undefined)).toThrow('inventory_unavailable');
});

test('actual runner argv lists four shards without HOME publication and rejects invalid env before test execution', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kite-unified-tui-list-'));
  try {
    const invoke = async (args: string[], shard: string) => {
      const child = Bun.spawn(
        [process.execPath, join(root, 'scripts/run-unified-tui-system-tests.ts'), ...args],
        {
          cwd: home,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            APPDATA: home,
            LOCALAPPDATA: home,
            XDG_CONFIG_HOME: home,
            XDG_DATA_HOME: home,
            KITE_CODE_HOME: join(home, '.kite-code'),
            KITE_TUI_SYSTEM_SHARD: shard,
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
          },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };
    const outputs = await Promise.all(
      Array.from({ length: 4 }, (_, index) => invoke(['--list'], `${index}/4`)),
    );
    const files: string[] = [];
    for (let index = 0; index < 4; index++) {
      const output = outputs[index]!;
      expect(output.code).toBe(0);
      expect(output.stderr).toBe('');
      const parsed = JSON.parse(output.stdout);
      expect(parsed.shard).toBe(`${index}/4`);
      files.push(...parsed.files);
    }
    expect(files.sort()).toEqual(unifiedTuiInventory(root));
    expect(readdirSync(home)).toEqual([]);
    const invalid = await invoke([], '4/4');
    expect(invalid.code).toBe(2);
    expect(invalid.stdout).toBe('');
    expect(invalid.stderr).toContain('must be exactly');
    const badArgs = await invoke(['--with-lifecycle-harness'], '0/4');
    expect(badArgs.code).toBe(2);
    expect(badArgs.stdout).toBe('');
    expect(readdirSync(home)).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'list executes zero test bodies; actual shared runner propagates failure, drains isolated sibling and never starts exclusive job',
  async () => {
    const owned = mkdtempSync(join(tmpdir(), 'kite-unified-tui-runner-'));
    const marker = (name: string) => join(owned, name);
    const add = (path: string, body: string) => {
      const file = join(owned, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
    };
    try {
      add(
        'apps/cli/test/isolated/tui-a-failure.test.ts',
        `import {test} from 'bun:test'; import {writeFileSync} from 'node:fs'; test('actual failure',()=>{writeFileSync(${JSON.stringify(marker('failure-home'))},process.env.HOME!); process.exit(7)});`,
      );
      add(
        'apps/cli/test/isolated/tui-b-drain.test.ts',
        `import {test} from 'bun:test'; import {writeFileSync} from 'node:fs'; test('actual drain',async()=>{await new Promise(r=>setTimeout(r,150));writeFileSync(${JSON.stringify(marker('drained'))},process.env.HOME!)});`,
      );
      add(
        'apps/cli/test/isolated/exclusive/tui-c-exclusive.test.ts',
        `import {test} from 'bun:test'; import {writeFileSync} from 'node:fs'; test('exclusive must not run',()=>writeFileSync(${JSON.stringify(marker('exclusive'))},'unexpected'));`,
      );
      add(formal, "import {test} from 'bun:test'; test('finite formal selection only',()=>{});");
      add(startup, "import {test} from 'bun:test'; test('finite startup selection only',()=>{});");
      add(
        'tests/tui-system/scenarios/runner-fixture.test.ts',
        "import {test} from 'bun:test'; test('finite original selection only',()=>{});",
      );
      add('scripts/run-tui-system-tests.ts', 'process.exitCode=0;');
      const selected = unifiedTuiInventory(owned);
      const plan = unifiedTuiTestPlan(owned, selected, 4);
      expect(plan.counts).toEqual({ parallel: 0, isolated: 5, exclusive: 1 });
      expect(
        plan.concurrent.every((job) => job.maxConcurrency === 1 && job.drainOnFailure === true),
      ).toBe(true);
      expect(await runUnifiedTuiSystemTests(owned, ['--list'], undefined)).toBe(0);
      expect(existsSync(marker('failure-home'))).toBe(false);
      expect(existsSync(marker('drained'))).toBe(false);
      expect(existsSync(marker('exclusive'))).toBe(false);
      expect(await runUnifiedTuiSystemTests(owned, [], undefined)).toBe(7);
      expect(existsSync(marker('drained'))).toBe(true);
      expect(existsSync(marker('exclusive'))).toBe(false);
      const failureHome = readFileSync(marker('failure-home'), 'utf8');
      const drainedHome = readFileSync(marker('drained'), 'utf8');
      expect(failureHome).not.toBe(process.env.HOME);
      expect(drainedHome).not.toBe(failureHome);
      expect(existsSync(failureHome)).toBe(false);
      expect(existsSync(drainedHome)).toBe(false);
    } finally {
      rmSync(owned, { recursive: true, force: true });
    }
  },
);

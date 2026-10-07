import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkUnifiedAgentBoundary } from '../../../scripts/check-unified-agent-boundary';
import {
  checkUnifiedFormalConsumers,
  UNIFIED_WORKSPACES,
} from '../../../scripts/check-unified-workspaces';

const roots: string[] = [];
function put(root: string, path: string, value: unknown) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function fixture(command = 'bun run extra') {
  const root = mkdtempSync(join(tmpdir(), 'kite-unified-ci-'));
  roots.push(root);
  put(root, 'package.json', { scripts: { extra: 'bun run scripts/extra.ts' } });
  for (const workspace of UNIFIED_WORKSPACES)
    put(root, `${workspace}/package.json`, { scripts: {} });
  put(root, 'scripts/extra.ts', 'export {};');
  put(
    root,
    '.github/workflows/probe.yml',
    `name: probe\non: workflow_dispatch\njobs:\n  probe:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${'a'.repeat(40)}\n      - run: ${command}\n`,
  );
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test('actual ten workflows and all recursive eight-workspace script consumers remain new; historical files do not imply execution', () => {
  const root = resolve(import.meta.dir, '../../..');
  const report = checkUnifiedFormalConsumers(root);
  expect(report.violations).toEqual([]);
  expect(report.entrypoints).toContain('scripts/release/unified.ts');
  const local = fixture();
  put(local, 'apps/kite-service/src/executable.ts', 'export {};');
  expect(checkUnifiedFormalConsumers(local).violations).toEqual([]);
});
test('unlisted aliases, cwd and CI direct old source are rejected before execution; computed fixture qualification stays pending', () => {
  for (const command of [
    'bun run --cwd apps/kite-service build',
    'bun apps/kite-service/src/executable.ts',
    'node apps/kite-cli/src/index.js',
    'bun run hidden',
  ]) {
    const root = fixture(command);
    put(root, 'package.json', {
      scripts: {
        extra: 'bun run scripts/extra.ts',
        hidden: 'bun run apps/kite-service/src/executable.ts',
      },
    });
    expect(
      checkUnifiedFormalConsumers(root).violations.some((v) => v.code === 'formal-legacy-command'),
    ).toBe(true);
  }
  const root = fixture('node scripts/extra.ts');
  put(root, 'scripts/extra.ts', 'export * from "./bridge";');
  put(root, 'scripts/bridge.ts', 'type Old=import("../packages/runtime-host/src/index").Old;');
  put(root, 'packages/runtime-host/src/index.ts', 'export type Old=unknown;');
  const report = checkUnifiedFormalConsumers(root);
  expect(
    checkUnifiedAgentBoundary(root, report.entrypoints).violations.some(
      (v) => v.rule === 'target-no-legacy-engine',
    ),
  ).toBe(true);
});
test('YAML duplicate or unknown primary keys, mutable actions and quiet qualification failures cannot be treated as a passing guard', () => {
  for (const suffix of ['name: duplicate\n', 'unexpected: true\n']) {
    const root = fixture();
    const file = join(root, '.github/workflows/probe.yml');
    writeFileSync(file, readFileSync(file, 'utf8') + suffix);
    expect(
      checkUnifiedFormalConsumers(root).violations.some((v) => v.code === 'formal-ci-invalid'),
    ).toBe(true);
  }
  for (const mutation of [
    (s: string) => s.replace('a'.repeat(40), 'main'),
    (s: string) => s.replace('run: bun run extra', 'run: bun run extra || true'),
    (s: string) =>
      s.replace('runs-on: ubuntu-latest', 'continue-on-error: true\n    runs-on: ubuntu-latest'),
  ]) {
    const root = fixture(),
      file = join(root, '.github/workflows/probe.yml');
    writeFileSync(file, mutation(readFileSync(file, 'utf8')));
    expect(checkUnifiedFormalConsumers(root).violations.length).toBeGreaterThan(0);
  }
});
test('release source binding and three-platform matrix cannot silently shrink', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../../../.github/workflows/release-candidate.yml'),
    'utf8',
  );
  for (const mutate of [
    (s: string) => s.replace(`ref: \${{ env.KITE_EXPECTED_CANDIDATE_COMMIT }}`, 'ref: main'),
    (s: string) => s.replace('windows-2025', 'ubuntu-24.04'),
  ]) {
    const root = fixture();
    put(root, '.github/workflows/release-candidate.yml', mutate(source));
    const codes = checkUnifiedFormalConsumers(root).violations.map((v) => v.code);
    expect(
      codes.some((code) =>
        ['formal-ci-source-unpinned', 'formal-ci-platform-matrix'].includes(code),
      ),
    ).toBe(true);
  }
});

test('Windows Native environment precedes both consumers and transport results stay on the original PR head', () => {
  const actual = resolve(import.meta.dir, '../../..');
  for (const workflow of ['release-candidate.yml', 'runtime-transport-qualification.yml']) {
    const source = readFileSync(resolve(actual, '.github/workflows', workflow), 'utf8');
    for (const mutate of [
      (s: string) =>
        s.replace(
          'run: bun run scripts/release/prepare-windows-native-ci.ts',
          'run: bun run extra',
        ),
      (s: string) => s.replace(`ref: \${{ env.KITE_EXPECTED_CANDIDATE_COMMIT }}`, 'ref: main'),
      (s: string) => s.replace('fetch-depth: 0', 'fetch-depth: 1'),
      (s: string) => s.replace('persist-credentials: false', 'persist-credentials: true'),
    ]) {
      const root = fixture();
      put(root, 'scripts/release/prepare-windows-native-ci.ts', 'export {};');
      put(root, `.github/workflows/${workflow}`, mutate(source));
      const codes = checkUnifiedFormalConsumers(root).violations.map((v) => v.code);
      expect(
        codes.some((code) =>
          ['formal-ci-native-build-environment-missing', 'formal-ci-source-unpinned'].includes(
            code,
          ),
        ),
      ).toBe(true);
    }
    const missing = fixture();
    put(missing, `.github/workflows/${workflow}`, source);
    expect(
      checkUnifiedFormalConsumers(missing).violations.some(
        (v) => v.code === 'formal-ci-native-build-environment-missing',
      ),
    ).toBe(true);
  }
  const root = fixture();
  put(root, 'scripts/release/prepare-windows-native-ci.ts', 'export {};');
  const transport = readFileSync(
    resolve(actual, '.github/workflows/runtime-transport-qualification.yml'),
    'utf8',
  );
  put(
    root,
    '.github/workflows/runtime-transport-qualification.yml',
    transport.replace(
      'apps/desktop/test/isolated/windows-node-access.test.ts',
      'packages/agent/test/isolated/windows-path-security/default.test.ts',
    ),
  );
  expect(
    checkUnifiedFormalConsumers(root).violations.some(
      (v) => v.code === 'formal-ci-native-build-environment-missing',
    ),
  ).toBe(true);
  for (const replacement of [
    'echo apps/desktop/test/isolated/windows-node-access.test.ts',
    'bun test --test-name-pattern=never-match apps/desktop/test/isolated/windows-node-access.test.ts',
  ]) {
    const filtered = fixture();
    put(filtered, 'scripts/release/prepare-windows-native-ci.ts', 'export {};');
    put(
      filtered,
      '.github/workflows/runtime-transport-qualification.yml',
      transport.replace(
        /bun test --parallel=1 --max-concurrency=1\s+packages\/agent\/test\/isolated\/windows-path-security\/default.test.ts\s+packages\/agent\/test\/isolated\/config\/mcp-selection-windows.test.ts\s+apps\/desktop\/test\/isolated\/windows-node-access.test.ts/,
        replacement,
      ),
    );
    expect(
      checkUnifiedFormalConsumers(filtered).violations.some(
        (v) => v.code === 'formal-ci-native-build-environment-missing',
      ),
    ).toBe(true);
  }
});

test('release candidate must execute the complete installed Terminal lifecycle on both POSIX platforms', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../../../.github/workflows/release-candidate.yml'),
    'utf8',
  );
  for (const mutate of [
    (s: string) =>
      s.replace("runner.os == 'macOS' || runner.os == 'Linux'", "runner.os == 'macOS'"),
    (s: string) =>
      s.replace(
        'run: bun test --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/terminal-bundle.test.ts',
        'run: echo tests/isolated/unified-agent/terminal-bundle.test.ts',
      ),
    (s: string) =>
      s.replace(
        'run: bun test --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/terminal-bundle.test.ts',
        'run: bun test --parallel=1 --max-concurrency=1 --test-name-pattern=never-match tests/isolated/unified-agent/terminal-bundle.test.ts',
      ),
  ]) {
    const root = fixture();
    put(root, '.github/workflows/release-candidate.yml', mutate(source));
    expect(
      checkUnifiedFormalConsumers(root).violations.some(
        (v) => v.code === 'formal-ci-terminal-lifecycle-missing',
      ),
    ).toBe(true);
  }
});

test('Linux release must execute the whole installed Native lifecycle in an actual display', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../../../.github/workflows/release-candidate.yml'),
    'utf8',
  );
  const command =
    'run: xvfb-run -a bun test --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/native-install-lifecycle.test.ts';
  for (const mutate of [
    (s: string) =>
      s.replace(
        "- if: runner.os == 'Linux'\n        name: Actual source-free Linux Native Main",
        "- if: runner.os == 'macOS'\n        name: Actual source-free Linux Native Main",
      ),
    (s: string) => s.replace(command, 'run: echo native-install-lifecycle.test.ts'),
    (s: string) =>
      s.replace(command, command.replace('bun test', 'bun test --test-name-pattern=never-match')),
    (s: string) => s.replace(command, command.replace('xvfb-run -a ', '')),
  ]) {
    const root = fixture();
    put(root, '.github/workflows/release-candidate.yml', mutate(source));
    expect(
      checkUnifiedFormalConsumers(root).violations.some(
        (v) => v.code === 'formal-ci-linux-native-lifecycle-missing',
      ),
    ).toBe(true);
  }
});

test('release must execute complete real-code Terminal and Native comparisons on the selected platforms', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../../../.github/workflows/release-candidate.yml'),
    'utf8',
  );
  for (const [platform, name, command, code] of [
    [
      "runner.os == 'macOS' || runner.os == 'Linux'",
      'Actual installed Terminal real code upgrade and cold rollback',
      'bun test --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/terminal-cross-version.test.ts',
      'formal-ci-terminal-real-code-missing',
    ],
    [
      "runner.os == 'macOS'",
      'Actual installed macOS Native real code upgrade and cold rollback',
      'bun test --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/native-cross-version.test.ts',
      'formal-ci-macos-native-real-code-missing',
    ],
    [
      "runner.os == 'Linux'",
      'Actual installed Linux Native real code upgrade and cold rollback',
      'xvfb-run -a bun test --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/native-cross-version.test.ts',
      'formal-ci-linux-native-real-code-missing',
    ],
  ] as const) {
    const step = `- if: ${platform}\n        name: ${name}`;
    const mutations = [
      (s: string) => s.replace(step, `- if: false\n        name: ${name}`),
      (s: string) => s.replace(step, `- if: runner.os == 'Windows'\n        name: ${name}`),
      (s: string) => s.replace(`run: ${command}`, `run: echo ${command}`),
      (s: string) =>
        s.replace(
          `run: ${command}`,
          `run: ${command.replace('bun test', 'bun test --test-name-pattern=never-match')}`,
        ),
    ];
    if (command.startsWith('xvfb-run'))
      mutations.push((s) => s.replace(`run: ${command}`, `run: ${command.slice(12)}`));
    for (const mutate of mutations) {
      const root = fixture();
      put(root, '.github/workflows/release-candidate.yml', mutate(source));
      expect(
        checkUnifiedFormalConsumers(root).violations.some((value) => value.code === code),
      ).toBe(true);
    }
  }
});

test('Required unit gives the whole Linux default graph an actual display', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../../../.github/workflows/required.yml'),
    'utf8',
  );
  for (const replacement of [
    'run: bun run test',
    'run: echo xvfb-run -a bun run test',
    'if: false\n        run: xvfb-run -a bun run test',
  ]) {
    const root = fixture();
    put(
      root,
      '.github/workflows/required.yml',
      source.replace('run: xvfb-run -a bun run test', replacement),
    );
    expect(
      checkUnifiedFormalConsumers(root).violations.some(
        (v) => v.code === 'formal-ci-linux-unit-display-missing',
      ),
    ).toBe(true);
  }
});

test('a platform slice must retain the formal verifier, not only a diagnostic report', () => {
  const root = fixture('bun run scripts/release/unified-platform-probe.ts --output=owned.json');
  expect(
    checkUnifiedFormalConsumers(root).violations.some(
      (v) => v.code === 'formal-ci-qualification-gate-missing',
    ),
  ).toBe(true);
  const file = join(root, '.github/workflows/probe.yml');
  writeFileSync(
    file,
    readFileSync(file, 'utf8') +
      '      - run: bun run scripts/release/unified-platform-verify.ts --report=owned.json --mode=formal\n',
  );
  expect(checkUnifiedFormalConsumers(root).violations).toEqual([]);
});

test('CI working-directory and command indirection cannot resolve an undeclared legacy workspace', () => {
  const root = fixture(),
    file = join(root, '.github/workflows/probe.yml');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace(
      'run: bun run extra',
      'working-directory: apps/kite-service\n        run: bun run build',
    ),
  );
  expect(
    checkUnifiedFormalConsumers(root).violations.some((v) => v.code === 'formal-legacy-command'),
  ).toBe(true);
  const dynamic = fixture(`\${{ env.RUN }}`);
  expect(
    checkUnifiedFormalConsumers(dynamic).violations.some(
      (v) => v.code === 'formal-command-unresolved',
    ),
  ).toBe(true);
});

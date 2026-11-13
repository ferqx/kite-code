import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { afterEach, expect, test } from '#kite-test';
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
  put(root, 'package.json', {
    scripts: { extra: 'node --import ./scripts/tooling/register.mjs scripts/extra.ts' },
  });
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

test('quality prepares Web exports without install scripts and retains every quality gate', () => {
  const root = resolve(import.meta.dirname, '../../..');
  const workflow = parse(readFileSync(join(root, '.github/workflows/required.yml'), 'utf8'));
  const commands = (workflow.jobs.quality.steps as { run?: string }[])
    .map((step) => step.run)
    .filter(Boolean);
  expect(commands).toEqual([
    `printf 'BUN_INSTALL_CACHE_DIR=%s/kite-bun-install-cache\\n' "$RUNNER_TEMP" >> "$GITHUB_ENV"`,
    'bun install --frozen-lockfile --ignore-scripts',
    'bun run build',
    'bun run typecheck',
    'bun run format:check',
    'bun run check:runtime-packages',
    'bun run check:unified-api',
    'bun run check:test-ownership',
    'bun run check:docs',
    'bun run check:plan-evidence',
    'bun run check:docs-impact --scope=range',
  ]);
  expect(
    workflow.jobs.quality.steps.find((step: { run?: string }) => step.run === 'bun run build')[
      'working-directory'
    ],
  ).toBe('apps/web');
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === 'quality') continue;
    const installs = (job as { steps: { run?: string }[] }).steps
      .map((step) => step.run)
      .filter((command) => command?.startsWith('bun install'));
    for (const install of installs) expect(install).toBe('bun install --frozen-lockfile');
  }
});

test('quality caches only Bun downloads by exact platform, runtime and dependency inputs', () => {
  const root = resolve(import.meta.dirname, '../../..');
  const workflow = parse(readFileSync(join(root, '.github/workflows/required.yml'), 'utf8'));
  const quality = workflow.jobs.quality;
  expect(quality.env?.BUN_INSTALL_CACHE_DIR).toBeUndefined();
  const setCache = quality.steps.findIndex((step: { run?: string }) =>
    step.run?.includes('BUN_INSTALL_CACHE_DIR=%s/kite-bun-install-cache'),
  );
  expect(setCache).toBeGreaterThanOrEqual(0);
  expect(quality.steps[setCache].run).toContain('"$RUNNER_TEMP" >> "$GITHUB_ENV"');
  const caches = quality.steps.filter((step: { uses?: string }) =>
    step.uses?.startsWith('actions/cache@'),
  );
  expect(caches).toHaveLength(1);
  const cache = caches[0];
  expect(setCache).toBeLessThan(quality.steps.indexOf(cache));
  expect(cache.with.path).toBe(`\${{ env.BUN_INSTALL_CACHE_DIR }}`);
  expect(cache.with.key).toStartWith(
    `quality-bun-\${{ runner.os }}-\${{ runner.arch }}-26.13.1-1.4.4-`,
  );
  for (const path of [
    'bun.lock',
    'package.json',
    'bunfig.toml',
    '.npmrc',
    'patches/**',
    ...UNIFIED_WORKSPACES.map((path) => `${path}/package.json`),
  ])
    expect(cache.with.key).toContain(`'${path}'`);
  expect(cache.with['restore-keys']).toBeUndefined();
  expect(cache.if).toBeUndefined();
  const install = quality.steps.find((step: { run?: string }) =>
    step.run?.startsWith('bun install --frozen-lockfile --ignore-scripts'),
  );
  expect(install.if).toBeUndefined();
  expect(quality.steps.indexOf(cache)).toBeLessThan(quality.steps.indexOf(install));
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === 'quality') continue;
    expect(
      (job as { steps: { uses?: string }[] }).steps.some((step) =>
        step.uses?.startsWith('actions/cache@'),
      ),
    ).toBe(false);
  }
});

test('unit assigns the browser cache in a runner step before installation and tests', () => {
  const root = resolve(import.meta.dirname, '../../..');
  const { unit } = parse(readFileSync(join(root, '.github/workflows/required.yml'), 'utf8')).jobs;
  expect(unit.env?.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
  const commands = (unit.steps as { run?: string }[]).map((step) => step.run);
  const setup = commands.findIndex((run) =>
    run?.includes('PLAYWRIGHT_BROWSERS_PATH=%s/kite-playwright-browsers'),
  );
  expect(setup).toBeGreaterThanOrEqual(0);
  expect(commands[setup]).toContain('"$RUNNER_TEMP" >> "$GITHUB_ENV"');
  expect(
    commands.findIndex((run) => run?.includes('cli.js install --with-deps chromium')),
  ).toBeGreaterThan(setup);
  expect(commands.indexOf('xvfb-run -a bun run test')).toBeGreaterThan(setup);
});

test('quality and local gates retain one combined boundary check and independent diagnostic aliases', () => {
  const root = resolve(import.meta.dirname, '../../..');
  const workflow = parse(readFileSync(join(root, '.github/workflows/required.yml'), 'utf8'));
  const commands = (workflow.jobs.quality.steps as { run?: string }[]).map((step) => step.run);
  expect(commands.filter((command) => command === 'bun run check:runtime-packages')).toHaveLength(
    1,
  );
  expect(commands).not.toContain('bun run check:unified-agent-boundary');
  const hook = parse(readFileSync(join(root, 'lefthook.yml'), 'utf8'));
  expect(hook['pre-commit'].commands['unified-boundary'].run).toBe(
    'bun run check:runtime-packages',
  );
  expect(hook['pre-commit'].commands.typecheck.run).toBe(
    'node node_modules/typescript/bin/tsc -p tsconfig.json',
  );
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
  expect(scripts['check:pre-release-architecture']).toBe(
    'node --import ./scripts/tooling/register.mjs scripts/check-unified-workspaces.ts && node --import ./scripts/tooling/register.mjs scripts/generate-unified-api.ts --check',
  );
  expect(scripts['check:unified-agent-boundary']).toBe(
    'node --import ./scripts/tooling/register.mjs scripts/check-unified-agent-boundary.ts',
  );
  expect(scripts['check:core-boundary']).toBe(
    'node --import ./scripts/tooling/register.mjs scripts/check-unified-agent-boundary.ts',
  );
});
test('actual ten workflows and all recursive ten-workspace script consumers remain new; historical files do not imply execution', () => {
  const root = resolve(import.meta.dirname, '../../..');
  const report = checkUnifiedFormalConsumers(root);
  expect(report.violations).toEqual([]);
  expect(report.entrypoints).toContain('scripts/release/unified.ts');
  const local = fixture();
  put(local, 'apps/kite-service/src/executable.ts', 'export {};');
  expect(checkUnifiedFormalConsumers(local).violations).toEqual([]);
});
test('explicit test files must exist without treating generated build outputs as test inputs', () => {
  for (const [command, file] of [
    [
      'node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 ./tests/isolated/current.test.ts',
      'tests/isolated/current.test.ts',
    ],
    ['bun --cwd=packages/agent run test', 'packages/agent/test/current.test.ts'],
  ] as const) {
    const root = fixture(command);
    put(root, 'packages/agent/package.json', {
      scripts: {
        test: 'node --import ../../scripts/tooling/register.mjs ../../scripts/run-test-files.ts ./test/current.test.ts',
      },
    });
    if (!command.startsWith('bun --cwd='))
      put(root, 'packages/agent/package.json', { scripts: {} });
    expect(checkUnifiedFormalConsumers(root).violations).toContainEqual({
      code: 'formal-test-file-missing',
      path: file,
      message: 'explicit test file must exist',
    });
    put(root, file, 'export {};');
    expect(checkUnifiedFormalConsumers(root).violations).toEqual([]);
  }
  const root = fixture(
    'node --import ./scripts/tooling/register.mjs scripts/tooling/build-command.ts src/entry.ts --outfile dist/generated.test.ts',
  );
  put(root, 'src/entry.ts', 'export {};');
  expect(checkUnifiedFormalConsumers(root).violations).toEqual([]);
});
test('unlisted aliases, cwd and CI direct old source are rejected before execution; computed fixture qualification stays pending', () => {
  for (const command of [
    'bun --cwd=apps/kite-service run build',
    'bun apps/kite-service/src/executable.ts',
    'node apps/kite-cli/src/index.js',
    'bun run hidden',
  ]) {
    const root = fixture(command);
    put(root, 'package.json', {
      scripts: {
        extra: 'node --import ./scripts/tooling/register.mjs scripts/extra.ts',
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
    resolve(import.meta.dirname, '../../../.github/workflows/release-candidate.yml'),
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

test('release matrix prepares the pinned historical bundles before requiring real-code qualification', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../../.github/workflows/release-candidate.yml'),
    'utf8',
  );
  const path = 'scripts/ci/prepare-release-predecessors.ts';
  const command = `run: node --import ./scripts/tooling/register.mjs ${path}`;
  const code = 'formal-ci-historical-predecessors-missing';
  const check = (workflow: string, scriptExists: boolean) => {
    const root = fixture();
    if (scriptExists) put(root, path, 'export {};');
    put(root, '.github/workflows/release-candidate.yml', workflow);
    return checkUnifiedFormalConsumers(root).violations.some(
      (violation) => violation.code === code,
    );
  };
  expect(source).toContain(command);
  expect(check(source, true)).toBe(false);
  expect(check(source, false)).toBe(true);
  expect(check(source.replace(command, 'run: echo no-old-bundles'), true)).toBe(true);
  expect(check(source.replace(command, `${command}\n        continue-on-error: true`), true)).toBe(
    true,
  );
});

test('shared TUI caller tests run whole on every OS after the current build', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../../.github/workflows/runtime-transport-qualification.yml'),
    'utf8',
  );
  const command =
    'node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1\n          apps/cli/test/file-recovery-pty.test.ts\n          apps/cli/test/isolated/tui-drafts-host.test.ts\n          apps/cli/test/isolated/file-recovery-argv.test.ts\n          apps/cli/test/isolated/tui-file-recovery.test.ts\n          apps/cli/test/isolated/tui-file-recovery-lost-replies.test.ts\n          apps/cli/test/isolated/tui-file-recovery-scopes.test.ts\n          apps/cli/test/isolated/tui-file-recovery-crash.test.ts\n          apps/cli/test/isolated/tui-recovery-host.test.ts\n          apps/cli/test/isolated/tui-preferences-host.test.ts\n          apps/cli/test/isolated/tui-mcp-connection-pty.test.ts\n          apps/cli/test/isolated/tui-composer-host.test.ts\n          apps/cli/test/isolated/tui-planning-host.test.ts\n          tests/isolated/unified-agent/extension-upgrade.test.ts';
  for (const mutate of [
    (s: string) => s.replace('run: bun run build', 'run: bun run extra'),
    (s: string) =>
      s
        .replace('      - run: bun run test:runtime:transport\n', '')
        .replace(
          '      - name: Complete MCP Tools caller',
          '      - run: bun run test:runtime:transport\n      - name: Complete MCP Tools caller',
        ),
    (s: string) => s.replace(command, 'echo shared caller'),
    (s: string) => {
      const candidates =
        '      - name: Complete Workspace file candidates and original draft completion\n        run: node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 apps/cli/test/isolated/tui-file-candidates-host.test.ts\n';
      return s
        .replace(candidates, '')
        .replace(
          '      - run: bun run test:runtime:transport\n',
          `${candidates}      - run: bun run test:runtime:transport\n`,
        );
    },
    ...[
      'apps/cli/test/isolated/tui-mcp-tools-pty.test.ts',
      'apps/cli/test/isolated/tui-mcp-source-mutation-pty.test.ts',
      'apps/cli/test/isolated/tui-mcp-source-approval-pty.test.ts',
      'apps/cli/test/isolated/tui-mcp-reconnection-pty.test.ts',
      'apps/cli/test/isolated/tui-mcp-auth-pty.test.ts',
      'apps/cli/test/isolated/tui-mcp-pty.test.ts',
      'apps/cli/test/isolated/tui-mcp-cold-pty.test.ts',
      'apps/cli/test/isolated/tui-skills-host.test.ts',
      'apps/cli/test/isolated/tui-permissions-host.test.ts',
      'apps/cli/test/isolated/tui-file-candidates-host.test.ts',
      'apps/cli/test/file-candidate-windows-records.test.ts',
      'apps/cli/test/isolated/file-candidate-windows-native.test.ts',
      'apps/cli/test/isolated/tui-export-host.test.ts',
      'apps/cli/test/isolated/tui-question-pty.test.ts',
      'apps/cli/test/isolated/tui-caller-intents-host.test.ts',
      'apps/cli/test/isolated/tui-caller-job-stop.test.ts',
      'apps/cli/test/isolated/cli-caller-library.test.ts',
      'apps/cli/test/isolated/cli-caller-host.test.ts',
      'apps/cli/test/isolated/cli-caller-kinds.test.ts',
      'apps/cli/test/isolated/caller-kind-crash.test.ts',
      'apps/cli/test/isolated/tui-management-host.test.ts',
      'apps/cli/test/isolated/tui-models-host.test.ts',
      'apps/cli/test/isolated/tui-status-host.test.ts',
      'apps/cli/test/isolated/tui-scrollback-pty.test.ts',
      'apps/service/test/isolated/run-resume.test.ts',
      'apps/service/test/isolated/job-report-resume.test.ts',
      'apps/service/test/isolated/job-reconcile.test.ts',
      'apps/service/test/isolated/recovery-preparation-ownership.test.ts',
    ].flatMap((file) => {
      const run = `run: node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 ${file}`;
      return [
        (s: string) => s.replace(run, 'run: echo MCP caller'),
        (s: string) =>
          s.replace(
            run,
            run.replace(
              'scripts/run-test-files.ts ',
              'scripts/run-test-files.ts --test-name-pattern=never-match ',
            ),
          ),
        (s: string) => s.replace(run, `if: runner.os != 'Windows'\n        ${run}`),
      ];
    }),
    (s: string) =>
      s
        .replace(
          'run: node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 apps/cli/test/isolated/tui-mcp-tools-pty.test.ts',
          'run: node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 apps/cli/test/isolated/tui-mcp-tools-pty.test.ts apps/cli/test/isolated/tui-mcp-source-mutation-pty.test.ts',
        )
        .replace(
          'run: node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 apps/cli/test/isolated/tui-mcp-source-mutation-pty.test.ts',
          'run: echo combined caller',
        ),
    ...[
      'apps/cli/test/isolated/tui-mcp-source-approval-pty.test.ts',
      'apps/cli/test/isolated/tui-mcp-reconnection-pty.test.ts',
      'apps/cli/test/isolated/tui-mcp-auth-pty.test.ts',
      'apps/cli/test/isolated/tui-mcp-pty.test.ts',
      'apps/cli/test/isolated/tui-mcp-cold-pty.test.ts',
      'apps/cli/test/isolated/tui-skills-host.test.ts',
      'apps/cli/test/isolated/tui-permissions-host.test.ts',
      'apps/cli/test/isolated/tui-file-candidates-host.test.ts',
      'apps/cli/test/file-candidate-windows-records.test.ts',
      'apps/cli/test/isolated/file-candidate-windows-native.test.ts',
      'apps/cli/test/isolated/tui-export-host.test.ts',
      'apps/cli/test/isolated/tui-question-pty.test.ts',
      'apps/cli/test/isolated/tui-caller-intents-host.test.ts',
      'apps/cli/test/isolated/tui-caller-job-stop.test.ts',
      'apps/cli/test/isolated/cli-caller-library.test.ts',
      'apps/cli/test/isolated/cli-caller-host.test.ts',
      'apps/cli/test/isolated/cli-caller-kinds.test.ts',
      'apps/cli/test/isolated/caller-kind-crash.test.ts',
      'apps/cli/test/isolated/tui-management-host.test.ts',
      'apps/cli/test/isolated/tui-models-host.test.ts',
      'apps/cli/test/isolated/tui-status-host.test.ts',
      'apps/cli/test/isolated/tui-scrollback-pty.test.ts',
      'apps/service/test/isolated/run-resume.test.ts',
      'apps/service/test/isolated/job-report-resume.test.ts',
      'apps/service/test/isolated/job-reconcile.test.ts',
      'apps/service/test/isolated/recovery-preparation-ownership.test.ts',
    ].map(
      (file) => (s: string) =>
        s
          .replace(
            'run: node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 apps/cli/test/isolated/tui-mcp-tools-pty.test.ts',
            `run: node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 apps/cli/test/isolated/tui-mcp-tools-pty.test.ts ${file}`,
          )
          .replace(
            `run: node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 ${file}`,
            'run: echo combined caller',
          ),
    ),
    (s: string) =>
      s.replace(
        command,
        command.replace(
          'scripts/run-test-files.ts ',
          'scripts/run-test-files.ts --test-name-pattern=never-match ',
        ),
      ),
    (s: string) => s.replace('          apps/cli/test/isolated/file-recovery-argv.test.ts', ''),
    ...[
      'apps/cli/test/file-recovery-pty.test.ts',
      'apps/cli/test/isolated/tui-file-recovery.test.ts',
      'apps/cli/test/isolated/tui-file-recovery-lost-replies.test.ts',
      'apps/cli/test/isolated/tui-file-recovery-scopes.test.ts',
      'apps/cli/test/isolated/tui-file-recovery-crash.test.ts',
      'apps/cli/test/isolated/tui-recovery-host.test.ts',
      'apps/cli/test/isolated/tui-preferences-host.test.ts',
      'apps/cli/test/isolated/tui-mcp-connection-pty.test.ts',
      'apps/cli/test/isolated/tui-composer-host.test.ts',
      'apps/cli/test/isolated/tui-planning-host.test.ts',
    ].map((file) => (s: string) => s.replace(`          ${file}`, '')),
    (s: string) =>
      s.replace('          tests/isolated/unified-agent/extension-upgrade.test.ts', ''),
    (s: string) =>
      s.replace(
        '      - name: Shared TUI drafts',
        '      - if: false\n        name: Shared TUI drafts',
      ),
    (s: string) =>
      s.replace('conformance:\n', 'conformance:\n    if: "runner.os != \'Windows\'"\n'),
    ...['macos-15', 'ubuntu-24.04', 'windows-2025'].map(
      (os) => (s: string) => s.replace(os, 'unsupported-runner'),
    ),
  ]) {
    const root = fixture();
    put(root, 'scripts/release/prepare-windows-native-ci.ts', 'export {};');
    const changed = mutate(source);
    expect(changed).not.toBe(source);
    put(root, '.github/workflows/runtime-transport-qualification.yml', changed);
    expect(
      checkUnifiedFormalConsumers(root).violations.some(
        (v) => v.code === 'formal-ci-shared-caller-tests-missing',
      ),
    ).toBe(true);
  }
});

test('Windows Native environment precedes both consumers and transport results stay on the original PR head', () => {
  const actual = resolve(import.meta.dirname, '../../..');
  for (const workflow of ['release-candidate.yml', 'runtime-transport-qualification.yml']) {
    const source = readFileSync(resolve(actual, '.github/workflows', workflow), 'utf8');
    for (const mutate of [
      (s: string) =>
        s.replace(
          'run: node --import ./scripts/tooling/register.mjs scripts/release/prepare-windows-native-ci.ts',
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
    'node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --test-name-pattern=never-match apps/desktop/test/isolated/windows-node-access.test.ts',
  ]) {
    const filtered = fixture();
    put(filtered, 'scripts/release/prepare-windows-native-ci.ts', 'export {};');
    put(
      filtered,
      '.github/workflows/runtime-transport-qualification.yml',
      transport.replace(
        /node --import \.\/scripts\/tooling\/register\.mjs scripts\/run-test-files\.ts --parallel=1 --max-concurrency=1\s+packages\/agent\/test\/isolated\/windows-path-security\/default.test.ts\s+packages\/agent\/test\/isolated\/config\/mcp-selection-windows.test.ts\s+apps\/desktop\/test\/isolated\/windows-node-access.test.ts/,
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
    resolve(import.meta.dirname, '../../../.github/workflows/release-candidate.yml'),
    'utf8',
  );
  for (const mutate of [
    (s: string) =>
      s.replace("runner.os == 'macOS' || runner.os == 'Linux'", "runner.os == 'macOS'"),
    (s: string) =>
      s.replace(
        'run: node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/terminal-bundle.test.ts',
        'run: echo tests/isolated/unified-agent/terminal-bundle.test.ts',
      ),
    (s: string) =>
      s.replace(
        'run: node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/terminal-bundle.test.ts',
        'run: node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 --test-name-pattern=never-match tests/isolated/unified-agent/terminal-bundle.test.ts',
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
    resolve(import.meta.dirname, '../../../.github/workflows/release-candidate.yml'),
    'utf8',
  );
  const command =
    'run: xvfb-run -a node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/native-install-lifecycle.test.ts';
  for (const mutate of [
    (s: string) =>
      s.replace(
        "- if: runner.os == 'Linux'\n        name: Actual source-free Linux Native Main",
        "- if: runner.os == 'macOS'\n        name: Actual source-free Linux Native Main",
      ),
    (s: string) => s.replace(command, 'run: echo native-install-lifecycle.test.ts'),
    (s: string) =>
      s.replace(
        command,
        command.replace(
          'scripts/run-test-files.ts',
          'scripts/run-test-files.ts --test-name-pattern=never-match',
        ),
      ),
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
    resolve(import.meta.dirname, '../../../.github/workflows/release-candidate.yml'),
    'utf8',
  );
  for (const [platform, name, command, code] of [
    [
      "runner.os == 'macOS' || runner.os == 'Linux'",
      'Actual installed Terminal real code upgrade and cold rollback',
      'node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/terminal-cross-version.test.ts',
      'formal-ci-terminal-real-code-missing',
    ],
    [
      "runner.os == 'macOS'",
      'Actual installed macOS Native real code upgrade and cold rollback',
      'node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/native-cross-version.test.ts',
      'formal-ci-macos-native-real-code-missing',
    ],
    [
      "runner.os == 'Linux'",
      'Actual installed Linux Native real code upgrade and cold rollback',
      'xvfb-run -a node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/native-cross-version.test.ts',
      'formal-ci-linux-native-real-code-missing',
    ],
  ] as const) {
    const step = `- if: ${platform}\n        name: ${name}`;
    const mutations = [
      (s: string) => s.replace(step, `- if: false\n        name: ${name}`),
      (s: string) =>
        s.replace(
          `name: ${name}\n        env:\n          KITE_REQUIRE_HISTORICAL_PREDECESSOR: '1'`,
          `name: ${name}\n        env:\n          KITE_REQUIRE_HISTORICAL_PREDECESSOR: '0'`,
        ),
      (s: string) => s.replace(step, `- if: runner.os == 'Windows'\n        name: ${name}`),
      (s: string) => s.replace(`run: ${command}`, `run: echo ${command}`),
      (s: string) =>
        s.replace(
          `run: ${command}`,
          `run: ${command.replace('scripts/run-test-files.ts', 'scripts/run-test-files.ts --test-name-pattern=never-match')}`,
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
    resolve(import.meta.dirname, '../../../.github/workflows/required.yml'),
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
  const root = fixture(
    'node --import ./scripts/tooling/register.mjs scripts/release/unified-platform-probe.ts --output=owned.json',
  );
  expect(
    checkUnifiedFormalConsumers(root).violations.some(
      (v) => v.code === 'formal-ci-qualification-gate-missing',
    ),
  ).toBe(true);
  const file = join(root, '.github/workflows/probe.yml');
  writeFileSync(
    file,
    readFileSync(file, 'utf8') +
      '      - run: node --import ./scripts/tooling/register.mjs scripts/release/unified-platform-verify.ts --report=owned.json --mode=formal\n',
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

test('Windows release must prepare the compiler before building and execute the exact installed paired consumer qualification', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../../.github/workflows/release-candidate.yml'),
    'utf8',
  );
  const prepare =
    "- if: runner.os == 'Windows'\n        name: Prepare installed Windows x64 Native compiler\n        run: node --import ./scripts/tooling/register.mjs scripts/release/prepare-windows-native-ci.ts";
  const step =
    "- if: runner.os == 'Windows'\n        name: Actual installed Windows Terminal paired version selection and data retention";
  const command = `node --import ./scripts/tooling/register.mjs tests/fixtures/unified-agent/windows-terminal-installation.qualification.ts "--candidate=\${{ github.workspace }}/dist/unified-terminal"`;
  const build =
    'bun run release:build --directory dist/unified-terminal --archive dist/unified-terminal.tar.gz';
  const codes = [
    'formal-ci-windows-terminal-installation-missing',
    'formal-ci-windows-terminal-build-environment-missing',
  ];
  const original = fixture();
  put(original, 'scripts/release/prepare-windows-native-ci.ts', 'export {};');
  put(original, '.github/workflows/release-candidate.yml', source);
  expect(
    checkUnifiedFormalConsumers(original).violations.filter((v) => codes.includes(v.code)),
  ).toEqual([]);
  for (const mutate of [
    (s: string) => s.replace(step, step.replace("runner.os == 'Windows'", 'false')),
    (s: string) => s.replace(step, step.replace("runner.os == 'Windows'", "runner.os == 'Linux'")),
    (s: string) => s.replace(`run: ${command}`, `run: echo ${command}`),
    (s: string) => s.replace(`run: ${command}`, `run: ${command} --test-name-pattern=never-match`),
    (s: string) =>
      s.replace(
        `run: ${command}`,
        `run: ${command.replace(`\${{ github.workspace }}/dist/unified-terminal`, 'dist/unified-terminal')}`,
      ),
    (s: string) =>
      s.replace(
        `run: ${command}`,
        `run: ${command.replace('dist/unified-terminal', 'dist/another-candidate')}`,
      ),
    (s: string) => s.replace(step, `${step}\n        continue-on-error: true`),
    (s: string) =>
      s.replace(prepare, prepare.replace("runner.os == 'Windows'", "runner.os == 'Linux'")),
    (s: string) =>
      s.replace(prepare, '').replace(`run: ${build}`, `run: ${build}\n      ${prepare}`),
    (s: string) => s.replace(`run: ${build}`, 'run: echo build-terminal'),
    (s: string) =>
      s
        .replace(`run: ${command}`, '')
        .replace(`run: ${build}`, `run: ${command}\n      - run: ${build}`),
  ]) {
    const root = fixture();
    put(root, 'scripts/release/prepare-windows-native-ci.ts', 'export {};');
    put(root, '.github/workflows/release-candidate.yml', mutate(source));
    expect(checkUnifiedFormalConsumers(root).violations.some((v) => codes.includes(v.code))).toBe(
      true,
    );
  }
});

test('Windows Native release executes its complete installed caller after unconditional build verify and smoke', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../../.github/workflows/release-candidate.yml'),
    'utf8',
  );
  const path = 'tests/fixtures/unified-agent/windows-native-installation.qualification.ts';
  const command = `node --import ./scripts/tooling/register.mjs ${path} "--candidate=\${{ github.workspace }}/dist/unified-native"`;
  const lines = source.split('\n');
  const commandIndex = lines.findIndex((line) => line.trim() === `run: ${command}`);
  expect(commandIndex).toBeGreaterThan(0);
  let start = commandIndex;
  while (start > 0 && !lines[start]!.startsWith('      - ')) start--;
  const block = lines.slice(start, commandIndex + 1).join('\n');
  const anchors = [
    '      - name: Build complete Native candidate and archive',
    '      - name: Verify complete Native source and physical closure',
    '      - name: Verify embedded Electron and independent SQLite engine',
  ];
  const code = 'formal-ci-windows-native-installation-missing';
  const check = (workflow: string, exists = true) => {
    const root = fixture();
    if (exists) put(root, path, 'export {};');
    put(root, 'scripts/release/prepare-windows-native-ci.ts', 'export {};');
    put(root, '.github/workflows/release-candidate.yml', workflow);
    return checkUnifiedFormalConsumers(root).violations.filter((v) => v.code === code);
  };
  expect(check(source)).toEqual([]);
  expect(check(source, false).some((v) => v.code === code)).toBe(true);
  for (const mutate of [
    (s: string) => s.replace(block, ''),
    (s: string) =>
      s.replace(block, block.replace("runner.os == 'Windows'", "runner.os == 'Linux'")),
    (s: string) => s.replace(block, block.replace("runner.os == 'Windows'", 'false')),
    (s: string) => s.replace(`run: ${command}`, `run: echo ${command}`),
    (s: string) => s.replace(`run: ${command}`, `run: ${command} --test-name-pattern=never-match`),
    (s: string) => s.replace(block, `${block}\n        continue-on-error: true`),
    (s: string) =>
      s.replace(
        `run: ${command}`,
        `run: ${command.replace('dist/unified-native', 'dist/unified-terminal')}`,
      ),
    (s: string) => s.replace(`runs-on: \${{ matrix.os }}`, 'runs-on: ubuntu-latest'),
    ...anchors.map(
      (anchor) => (s: string) => s.replace(block, '').replace(anchor, `${block}\n${anchor}`),
    ),
  ])
    expect(check(mutate(source)).some((v) => v.code === code)).toBe(true);
});

test('Windows installed TUI requires both admitted candidates and the preceding Native installed caller', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../../.github/workflows/release-candidate.yml'),
    'utf8',
  );
  const path = 'tests/fixtures/unified-agent/windows-installed-tui.qualification.ts';
  const nativePath = 'tests/fixtures/unified-agent/windows-native-installation.qualification.ts';
  const command = `node --import ./scripts/tooling/register.mjs ${path} "--terminal=\${{ github.workspace }}/dist/unified-terminal" "--native=\${{ github.workspace }}/dist/unified-native"`;
  const lines = source.split('\n');
  const commandIndex = lines.findIndex((line) => line.trim() === `run: ${command}`);
  expect(commandIndex).toBeGreaterThan(0);
  let start = commandIndex;
  while (start > 0 && !lines[start]!.startsWith('      - ')) start--;
  const block = lines.slice(start, commandIndex + 1).join('\n');
  const prerequisites = [
    'bun run release:build --directory dist/unified-terminal --archive dist/unified-terminal.tar.gz',
    `bun run release:verify --directory dist/unified-terminal --source-commit "\${{ env.KITE_EXPECTED_CANDIDATE_COMMIT }}" --clean-source true`,
    'bun run release:smoke --directory dist/unified-terminal',
    'bun run release:build --product native --directory dist/unified-native --terminal dist/unified-terminal --archive dist/unified-native.tar.gz',
    `bun run release:verify --product native --directory dist/unified-native --source-commit "\${{ env.KITE_EXPECTED_CANDIDATE_COMMIT }}" --clean-source true`,
    'bun run release:smoke --product native --directory dist/unified-native',
    `node --import ./scripts/tooling/register.mjs ${nativePath} "--candidate=\${{ github.workspace }}/dist/unified-native"`,
  ];
  const code = 'formal-ci-windows-installed-tui-missing';
  const check = (workflow: string, exists = true) => {
    const root = fixture();
    if (exists) put(root, path, 'export {};');
    put(root, nativePath, 'export {};');
    put(root, 'scripts/release/prepare-windows-native-ci.ts', 'export {};');
    put(root, '.github/workflows/release-candidate.yml', workflow);
    return checkUnifiedFormalConsumers(root).violations.filter((v) => v.code === code);
  };
  expect(check(source)).toEqual([]);
  expect(check(source, false).some((v) => v.code === code)).toBe(true);
  for (const mutate of [
    (s: string) => s.replace(block, ''),
    (s: string) => s.replace(block, block.replace("runner.os == 'Windows'", 'false')),
    (s: string) =>
      s.replace(block, block.replace("runner.os == 'Windows'", "runner.os == 'Linux'")),
    (s: string) => s.replace(`run: ${command}`, `run: echo ${command}`),
    (s: string) => s.replace(`run: ${command}`, `run: ${command} --test-name-pattern=never-match`),
    (s: string) => s.replace(block, `${block}\n        continue-on-error: true`),
    (s: string) => s.replace(`runs-on: \${{ matrix.os }}`, 'runs-on: ubuntu-latest'),
    ...['terminal', 'native'].map(
      (candidate) => (s: string) =>
        s.replace(
          `--${candidate}=\${{ github.workspace }}/dist/unified-${candidate}`,
          `--${candidate}=dist/unified-${candidate}`,
        ),
    ),
    ...prerequisites.map(
      (prerequisite) => (s: string) =>
        s.replace(`run: ${prerequisite}`, `run: echo ${prerequisite}`),
    ),
    ...[
      '      - name: Build source-bound Terminal candidate and archive',
      '      - name: Verify complete Native source and physical closure',
      "      - if: runner.os == 'Windows'\n        name: Actual installed Windows Native windows, version selection and maintenance restore",
    ].map((anchor) => (s: string) => s.replace(block, '').replace(anchor, `${block}\n${anchor}`)),
  ])
    expect(check(mutate(source)).some((v) => v.code === code)).toBe(true);
});

test('desktop-only release qualification follows both candidate builds on macOS and Windows', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../../.github/workflows/release-candidate.yml'),
    'utf8',
  );
  const path = 'tests/fixtures/unified-agent/native-terminal-split.qualification.ts';
  const build = 'run: bun run release:build --product native --directory dist/unified-desktop';
  const command = [
    `          node --import ./scripts/tooling/register.mjs ${path}`,
    '          "--terminal=${{ github.workspace }}/dist/unified-terminal"',
    '          "--native=${{ github.workspace }}/dist/unified-native"',
    '          "--desktop=${{ github.workspace }}/dist/unified-desktop"',
  ].join('\n');
  const check = (workflow: string, hasFixture = true) => {
    const root = fixture();
    if (hasFixture) put(root, path, 'export {};');
    put(root, '.github/workflows/release-candidate.yml', workflow);
    return checkUnifiedFormalConsumers(root).violations.map((violation) => violation.code);
  };
  const code = 'formal-ci-native-terminal-split-missing';
  expect(source).toContain(build);
  expect(source).toContain(command);
  expect(check(source)).not.toContain(code);
  expect(check(source, false)).toContain(code);
  expect(check(source.replace(build, 'run: echo skip-desktop-build'))).toContain(code);
  expect(
    check(source.replace(command, command.replace('dist/unified-desktop', 'dist/other'))),
  ).toContain(code);
  expect(check(source.replace(command, `${command}\n        continue-on-error: true`))).toContain(
    code,
  );
  expect(
    check(source.replace('dist/unified-evidence/native-terminal-split.log', '../wrong.log')),
  ).toContain('formal-ci-qualification-log-missing');
});

test('Windows real code qualification retains both candidates and every preceding installed consumer', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../../.github/workflows/release-candidate.yml'),
    'utf8',
  );
  const path = 'tests/fixtures/unified-agent/windows-cross-version.qualification.ts';
  const command = `node --import ./scripts/tooling/register.mjs ${path} "--terminal=\${{ github.workspace }}/dist/unified-terminal" "--native=\${{ github.workspace }}/dist/unified-native"`;
  const lines = source.split('\n');
  const commandIndex = lines.findIndex((line) => line.trim() === `run: ${command}`);
  expect(commandIndex).toBeGreaterThan(0);
  let start = commandIndex;
  while (start > 0 && !lines[start]!.startsWith('      - ')) start--;
  const block = lines.slice(start, commandIndex + 1).join('\n');
  const requiredFiles = [
    'scripts/release/prepare-windows-native-ci.ts',
    'tests/fixtures/unified-agent/windows-terminal-installation.qualification.ts',
    'tests/fixtures/unified-agent/windows-native-installation.qualification.ts',
    'tests/fixtures/unified-agent/windows-installed-tui.qualification.ts',
    path,
  ];
  const prerequisites = [
    'node --import ./scripts/tooling/register.mjs scripts/release/prepare-windows-native-ci.ts',
    'bun run release:build --directory dist/unified-terminal --archive dist/unified-terminal.tar.gz',
    `bun run release:verify --directory dist/unified-terminal --source-commit "\${{ env.KITE_EXPECTED_CANDIDATE_COMMIT }}" --clean-source true`,
    'bun run release:smoke --directory dist/unified-terminal',
    `node --import ./scripts/tooling/register.mjs ${requiredFiles[1]} "--candidate=\${{ github.workspace }}/dist/unified-terminal"`,
    'bun run release:build --product native --directory dist/unified-native --terminal dist/unified-terminal --archive dist/unified-native.tar.gz',
    `bun run release:verify --product native --directory dist/unified-native --source-commit "\${{ env.KITE_EXPECTED_CANDIDATE_COMMIT }}" --clean-source true`,
    'bun run release:smoke --product native --directory dist/unified-native',
    `node --import ./scripts/tooling/register.mjs ${requiredFiles[2]} "--candidate=\${{ github.workspace }}/dist/unified-native"`,
    `node --import ./scripts/tooling/register.mjs ${requiredFiles[3]} "--terminal=\${{ github.workspace }}/dist/unified-terminal" "--native=\${{ github.workspace }}/dist/unified-native"`,
  ];
  const code = 'formal-ci-windows-real-code-missing';
  const check = (workflow: string, missing?: string) => {
    const root = fixture();
    for (const file of requiredFiles) if (file !== missing) put(root, file, 'export {};');
    put(root, '.github/workflows/release-candidate.yml', workflow);
    return checkUnifiedFormalConsumers(root).violations.filter((v) => v.code === code);
  };
  expect(check(source)).toEqual([]);
  for (const missing of requiredFiles) expect(check(source, missing)).not.toEqual([]);
  for (const mutate of [
    (s: string) => s.replace(block, ''),
    (s: string) => s.replace(block, block.replace("runner.os == 'Windows'", 'false')),
    (s: string) =>
      s.replace(block, block.replace("runner.os == 'Windows'", "runner.os == 'Linux'")),
    (s: string) => s.replace(`run: ${command}`, `run: echo ${command}`),
    (s: string) => s.replace(`run: ${command}`, `run: ${command} --test-name-pattern=never-match`),
    (s: string) => s.replace(block, `${block}\n        continue-on-error: true`),
    (s: string) => s.replace(`runs-on: \${{ matrix.os }}`, 'runs-on: ubuntu-latest'),
    ...['terminal', 'native'].map(
      (candidate) => (s: string) =>
        s.replace(
          block,
          block.replace(
            `--${candidate}=\${{ github.workspace }}/dist/unified-${candidate}`,
            `--${candidate}=dist/unified-${candidate}`,
          ),
        ),
    ),
    ...prerequisites.map(
      (prerequisite) => (s: string) =>
        s.replace(`run: ${prerequisite}`, `run: echo ${prerequisite}`),
    ),
    ...[
      '      - name: Build source-bound Terminal candidate and archive',
      "      - if: runner.os == 'Windows'\n        name: Actual installed Windows Terminal paired version selection and data retention",
      '      - name: Verify embedded Electron and independent SQLite engine',
      "      - if: runner.os == 'Windows'\n        name: Actual installed Windows Native windows, version selection and maintenance restore",
      "      - if: runner.os == 'Windows'\n        name: Actual installed Windows Terminal and Native complete TUI caller",
    ].map((anchor) => (s: string) => s.replace(block, '').replace(anchor, `${block}\n${anchor}`)),
  ])
    expect(check(mutate(source))).not.toEqual([]);
});

function nativeStdioFixture(source?: string) {
  const actual = resolve(import.meta.dirname, '../../..');
  const command = JSON.parse(readFileSync(join(actual, 'package.json'), 'utf8')).scripts[
    'test:runtime:stdio'
  ] as string;
  const root = fixture();
  put(root, 'package.json', {
    scripts: {
      extra: 'node --import ./scripts/tooling/register.mjs scripts/extra.ts',
      'test:runtime:stdio': command,
    },
  });
  put(root, 'packages/agent/package.json', {
    scripts: { build: 'node --import ../../scripts/tooling/register.mjs ../../scripts/extra.ts' },
  });
  for (const path of command.split(' ').filter((token) => token.endsWith('.test.ts')))
    put(root, path, 'export {};');
  for (const path of [
    'scripts/ci/logged-shell.ts',
    'scripts/release/prepare-windows-native-ci.ts',
    'tests/isolated/scripts/ci-logged-shell.test.ts',
  ])
    put(root, path, 'export {};');
  put(
    root,
    '.github/workflows/runtime-stdio-smoke.yml',
    source ?? readFileSync(join(actual, '.github/workflows/runtime-stdio-smoke.yml'), 'utf8'),
  );
  return { root, command };
}

test('native stdio retains every complete MCP suite and the original unfiltered paired caller', () => {
  const code = 'formal-ci-mcp-stdio-missing';
  const { root, command } = nativeStdioFixture();
  expect(checkUnifiedFormalConsumers(root).violations).toEqual([]);
  for (const path of [
    'packages/agent/test/isolated/mcp/linux-stdio-port.test.ts',
    'packages/agent/test/isolated/mcp/linux-owned-program.test.ts',
    'packages/agent/test/isolated/mcp/windows-stdio-port.test.ts',
    'apps/service/test/isolated/mcp-source-packaged-default.test.ts',
  ]) {
    expect(command.split(' ')).toContain(path);
    const missingAlias = nativeStdioFixture();
    put(missingAlias.root, 'package.json', {
      scripts: { 'test:runtime:stdio': command.replace(` ${path}`, '') },
    });
    expect(
      checkUnifiedFormalConsumers(missingAlias.root).violations.some((v) => v.code === code),
    ).toBe(true);
    const missingFile = nativeStdioFixture();
    rmSync(join(missingFile.root, path));
    expect(
      checkUnifiedFormalConsumers(missingFile.root).violations.some((v) => v.code === code),
    ).toBe(true);
  }
  const filtered = nativeStdioFixture();
  put(filtered.root, 'package.json', {
    scripts: { 'test:runtime:stdio': `${command} --test-name-pattern=never-match` },
  });
  expect(checkUnifiedFormalConsumers(filtered.root).violations.some((v) => v.code === code)).toBe(
    true,
  );
  const sharedProcess = nativeStdioFixture();
  put(sharedProcess.root, 'package.json', {
    scripts: {
      'test:runtime:stdio': command.replace(
        ' && node --import ./scripts/tooling/register.mjs ./scripts/run-test-files.ts --parallel=1 --max-concurrency=1',
        '',
      ),
    },
  });
  expect(
    checkUnifiedFormalConsumers(sharedProcess.root).violations.some((v) => v.code === code),
  ).toBe(true);
});

test('native stdio binds original PR source and actual three runners without suppressing its full caller', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../../.github/workflows/runtime-stdio-smoke.yml'),
    'utf8',
  );
  for (const [before, after, code] of [
    [`ref: \${{ env.KITE_EXPECTED_CANDIDATE_COMMIT }}`, 'ref: main', 'formal-ci-source-unpinned'],
    [
      `repository: \${{ env.KITE_CANDIDATE_REPOSITORY }}`,
      'repository: other/repo',
      'formal-ci-source-unpinned',
    ],
    ['fetch-depth: 0', 'fetch-depth: 1', 'formal-ci-source-unpinned'],
    ['persist-credentials: false', 'persist-credentials: true', 'formal-ci-source-unpinned'],
    ['windows-2025', 'ubuntu-24.04', 'formal-ci-platform-matrix'],
    [`runs-on: \${{ matrix.os }}`, 'runs-on: ubuntu-latest', 'formal-ci-mcp-stdio-missing'],
    [
      'run: bun run test:runtime:stdio',
      'run: echo bun run test:runtime:stdio',
      'formal-ci-mcp-stdio-missing',
    ],
    [
      'run: bun run test:runtime:stdio',
      'run: bun run test:runtime:stdio --test-name-pattern=never-match',
      'formal-ci-mcp-stdio-missing',
    ],
  ] as const) {
    const { root } = nativeStdioFixture(source.replace(before, after));
    expect(checkUnifiedFormalConsumers(root).violations.some((v) => v.code === code)).toBe(true);
  }
});

test('current native CI consumers prepare Linux isolation and display plus the Windows compiler before execution', () => {
  const actual = resolve(import.meta.dirname, '../../..');
  for (const name of [
    'release-candidate.yml',
    'runtime-stdio-smoke.yml',
    'platform-capability-probe.yml',
    'runtime-transport-qualification.yml',
    'required.yml',
  ]) {
    const source = readFileSync(join(actual, '.github/workflows', name), 'utf8');
    const check = (value: string) => {
      const { root } = nativeStdioFixture();
      put(root, `.github/workflows/${name}`, value);
      return checkUnifiedFormalConsumers(root).violations.filter(
        (v) =>
          v.path === `.github/workflows/${name}` &&
          v.code === 'formal-ci-linux-native-dependencies-missing',
      );
    };
    expect(check(source)).toEqual([]);
    expect(check(source.replace('libffi-dev bubblewrap', 'libffi-dev')).length).toBeGreaterThan(0);
    expect(check(source.replace('pkg-config libffi-dev', 'pkg-config')).length).toBeGreaterThan(0);
    if (name === 'release-candidate.yml' || name === 'required.yml')
      expect(check(source.replace('bubblewrap xvfb', 'bubblewrap')).length).toBeGreaterThan(0);
    if (name !== 'required.yml')
      expect(
        check(source.replace("if: runner.os == 'Linux'", "if: runner.os == 'Windows'")).length,
      ).toBeGreaterThan(0);
  }
  for (const name of ['runtime-stdio-smoke.yml', 'platform-capability-probe.yml']) {
    const source = readFileSync(join(actual, '.github/workflows', name), 'utf8');
    const { root } = nativeStdioFixture();
    put(
      root,
      `.github/workflows/${name}`,
      source.replace(
        'run: node --import ./scripts/tooling/register.mjs scripts/release/prepare-windows-native-ci.ts',
        'run: echo unavailable',
      ),
    );
    expect(
      checkUnifiedFormalConsumers(root).violations.some(
        (v) =>
          v.path === `.github/workflows/${name}` &&
          v.code === 'formal-ci-native-build-environment-missing',
      ),
    ).toBe(true);
  }
});

test('complete qualification logs keep one literal script argument, distinct paths and always-upload on failure', () => {
  const actual = resolve(import.meta.dirname, '../../..');
  for (const name of ['release-candidate.yml', 'runtime-stdio-smoke.yml']) {
    const source = readFileSync(join(actual, '.github/workflows', name), 'utf8');
    const shells = [
      ...source.matchAll(
        /shell: (node --import \.\/scripts\/tooling\/register\.mjs scripts\/ci\/logged-shell\.ts --log=dist\/unified-evidence\/[a-z0-9-]+\.log "\{0\}")/g,
      ),
    ];
    expect(shells.length).toBeGreaterThan(1);
    const check = (value: string, missing = false) => {
      const { root } = nativeStdioFixture();
      if (missing) rmSync(join(root, 'scripts/ci/logged-shell.ts'));
      put(root, `.github/workflows/${name}`, value);
      return checkUnifiedFormalConsumers(root).violations.filter(
        (v) =>
          v.path === `.github/workflows/${name}` &&
          v.code.startsWith('formal-ci-qualification-log-'),
      );
    };
    expect(check(source)).toEqual([]);
    expect(check(source, true).length).toBeGreaterThan(0);
    if (name === 'release-candidate.yml') {
      const windows = shells.find((match) => match[1]!.includes('/windows-native-installed.log'));
      expect(windows).toBeDefined();
      expect(check(source.replace(windows![0], 'shell: pwsh')).length).toBeGreaterThan(0);
    }
    for (const mutation of [
      source.replace(shells[0]![0], 'shell: bash'),
      source.replace(shells[0]![0], shells[0]![0].replace('"{0}"', '{0}')),
      source.replace(shells[1]![0], shells[0]![0]),
      source.replace('if-no-files-found: error', 'if-no-files-found: ignore'),
      source.replace('path: |', 'path: unrelated\n          ignored: |'),
      source.replace(/if: always\(\)/g, "if: runner.os == 'macOS'"),
    ])
      expect(check(mutation).length).toBeGreaterThan(0);
  }
  expect(checkUnifiedFormalConsumers(actual).entrypoints).toContain('scripts/ci/logged-shell.ts');
});

test('native stdio schedules the real host logged-shell tests before the complete MCP caller', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../../.github/workflows/runtime-stdio-smoke.yml'),
    'utf8',
  );
  const command =
    'node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 tests/isolated/scripts/ci-logged-shell.test.ts';
  for (const mutation of [
    source.replace(`run: ${command}`, `run: echo ${command}`),
    source.replace(`run: ${command}`, `if: runner.os == 'macOS'\n        run: ${command}`),
  ]) {
    const { root } = nativeStdioFixture(mutation);
    expect(
      checkUnifiedFormalConsumers(root).violations.some(
        (v) => v.code === 'formal-ci-qualification-shell-test-missing',
      ),
    ).toBe(true);
  }
});

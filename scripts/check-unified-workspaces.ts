import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import {
  checkUnifiedAgentBoundary,
  type UnifiedBoundaryReport,
} from './check-unified-agent-boundary';

export const UNIFIED_WORKSPACES = Object.freeze([
  'packages/trajectory',
  'packages/trace-extension-sdk',
  'packages/ai',
  'packages/agent',
  'packages/client',
  'packages/ui',
  'apps/service',
  'apps/cli',
  'apps/desktop',
  'apps/web',
] as const);
export interface UnifiedWorkspaceViolation {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}
export interface UnifiedWorkspaceReport {
  readonly violations: readonly UnifiedWorkspaceViolation[];
  readonly checked: readonly string[];
  readonly boundary: UnifiedBoundaryReport;
}
const names = new Map(UNIFIED_WORKSPACES.map((path) => [`@kite-ai/${path.split('/')[1]}`, path]));
const formalScripts: Readonly<Record<string, string>> = {
  build:
    'node --import ./scripts/tooling/register.mjs scripts/run-runtime-workspace-script.ts build',
  test: 'node --import ./scripts/tooling/register.mjs scripts/run-default-tests.ts',
  'test:all': 'bun run test',
  typecheck: 'node node_modules/typescript/bin/tsc -b tsconfig.typecheck.json',
  agent: 'node --import ./scripts/tooling/register.mjs scripts/release/entrypoints/cli.ts',
  tui: 'node --import ./scripts/tooling/register.mjs scripts/release/entrypoints/tui.ts',
  'prod:tui':
    'node --import ./scripts/tooling/register.mjs scripts/release/entrypoints/production-tui.ts',
  server: 'node --import ./scripts/tooling/register.mjs scripts/development/ensure-web.ts',
  desktop: 'node --import ./scripts/tooling/register.mjs scripts/release/native.ts launch',
  'release:terminal': 'node --import ./scripts/tooling/register.mjs scripts/release/terminal.ts',
  'release:build': 'node --import ./scripts/tooling/register.mjs scripts/release/unified.ts build',
  'release:verify':
    'node --import ./scripts/tooling/register.mjs scripts/release/unified.ts verify',
  'release:smoke': 'node --import ./scripts/tooling/register.mjs scripts/release/unified.ts smoke',
  'release:install':
    'node --import ./scripts/tooling/register.mjs scripts/release/unified.ts install',
  'release:native': 'node --import ./scripts/tooling/register.mjs scripts/release/native.ts',
  'check:runtime-packages':
    'node --import ./scripts/tooling/register.mjs scripts/check-unified-workspaces.ts',
};
const legacyConsumer =
  /(?:@kite-ai\/|packages\/|#)(?:agent-api-(?:contract|client)|agent-kernel|builtin-runtime|runtime-(?:host|spi|contract|protocol|server|client|storage-sqlite)|kite-(?:app-contract|local-runtime|client-ui|cli|service|web|desktop))(?:\/|\b)|(?:^|[\s'"/])apps\/kite-(?:cli|service|web|desktop)(?:\/|\b)|scripts\/(?:run-tui-system-tests|runtime\/(?:run-fault-soak|verify-fault-soak-qualification)|release\/(?:oss-candidate|build-oss-candidate|build-artifact|verify-artifact|bootstrap-verifier|prepare-desktop-service|platform-capability-probe|session-log-acl-smoke))\.ts/;
const stdioSuites = [
  'packages/agent/test/isolated/mcp/stdio-port.test.ts',
  'apps/service/test/isolated/paired.test.ts',
  'apps/service/test/isolated/startup-frame.test.ts',
  'apps/service/test/isolated/lifecycle.test.ts',
  'apps/cli/test/stdio-grants.test.ts',
  'apps/cli/test/stdio-interactions.test.ts',
  'packages/agent/test/isolated/mcp/linux-stdio-port.test.ts',
  'packages/agent/test/isolated/mcp/linux-owned-program.test.ts',
  'packages/agent/test/isolated/mcp/windows-stdio-port.test.ts',
  'apps/service/test/isolated/mcp-source-packaged-default.test.ts',
] as const;
export function checkUnifiedFormalConsumers(root: string): {
  violations: UnifiedWorkspaceViolation[];
  entrypoints: string[];
} {
  const violations: UnifiedWorkspaceViolation[] = [],
    entrypoints = new Set<string>(),
    visited = new Set<string>();
  const add = (code: string, path: string, message: string) =>
    violations.push({ code, path, message });
  const packageAt = (cwd: string): Record<string, unknown> =>
    JSON.parse(readFileSync(resolve(root, cwd, 'package.json'), 'utf8'));
  const paths = (path: string, explicitTestFile = false): void => {
    path = path.replaceAll('\\', '/');
    if (!path || path === '.' || path === 'tests' || path === 'packages' || path === 'apps') {
      add('formal-discovery-too-wide', path, 'requires finite current suites/entrypoints');
      return;
    }
    if (relative(root, resolve(root, path)).startsWith('..')) {
      add('formal-command-escape', path, 'outside repository');
      return;
    }
    if (!existsSync(resolve(root, path))) {
      if (explicitTestFile) add('formal-test-file-missing', path, 'explicit test file must exist');
      return;
    }
    if (statSync(resolve(root, path)).isDirectory())
      for (const child of readdirSync(resolve(root, path))) paths(`${path}/${child}`);
    else if (/\.[cm]?[jt]sx?$/.test(path)) entrypoints.add(path.replaceAll('\\', '/'));
  };
  const inspect = (command: string, location: string, cwd = ''): void => {
    if (legacyConsumer.test(command) || legacyConsumer.test(cwd))
      add('formal-legacy-command', location, command);
    if (/^\s*\$/.test(command)) add('formal-command-unresolved', location, 'computed command head');
    for (const segment of command.split(/[;\n|&]+/u)) {
      const tokens =
        segment
          .match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/gu)
          ?.map((token) => token.replace(/^['"]|['"]$/gu, '')) ?? [];
      if (tokens[0] === 'xvfb-run' && tokens[1] === '-a') tokens.splice(0, 2);
      const tool = tokens.shift();
      if (tool === 'node') {
        while (tokens[0]?.startsWith('-')) {
          const option = tokens.shift();
          if (option === '--import' || option === '--require') {
            const preload = tokens.shift();
            if (preload?.startsWith('.')) paths(relative(root, resolve(root, cwd, preload)));
          }
        }
        const entry = tokens.shift();
        if (!entry || !/\.[cm]?[jt]sx?$/u.test(entry)) continue;
        const path = relative(root, resolve(root, cwd, entry));
        paths(path);
        if (/(?:^|\/)run-test-files\.ts$/u.test(path)) {
          for (const arg of tokens) {
            if (arg.startsWith('-')) continue;
            paths(
              relative(root, resolve(root, cwd, arg)),
              /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(arg),
            );
          }
        } else if (/(?:^|\/)build-command\.ts$/u.test(path)) {
          const firstOption = tokens.findIndex((token) => token.startsWith('-'));
          const entrypoints = firstOption < 0 ? tokens : tokens.slice(0, firstOption);
          for (const input of entrypoints) paths(relative(root, resolve(root, cwd, input)));
        }
        continue;
      }
      if (tool === 'pnpm') {
        add(
          'formal-runtime-forbidden',
          location,
          'use Bun for dependency installation and scripts',
        );
        continue;
      }
      if (tool !== 'bun') continue;
      let selected = cwd;
      const cwdOption = tokens[0]?.match(/^--cwd=(.+)$/u);
      if (cwdOption) {
        tokens.shift();
        selected = relative(root, resolve(root, cwd, cwdOption[1]!)).replaceAll('\\', '/');
      }
      const operation = tokens.shift();
      if (
        operation === 'install' &&
        !cwdOption &&
        tokens.includes('--frozen-lockfile') &&
        tokens.every((token) => token === '--frozen-lockfile' || token === '--ignore-scripts')
      )
        continue;
      if (operation !== 'run' || (tokens[0] && !/^\w[\w:-]*$/u.test(tokens[0]))) {
        add(
          'formal-runtime-forbidden',
          location,
          'Bun may install frozen dependencies or dispatch a manifest script',
        );
        continue;
      }
      if (selected && !UNIFIED_WORKSPACES.includes(selected as (typeof UNIFIED_WORKSPACES)[number]))
        add('formal-command-cwd-forbidden', location, selected);
      const target = tokens.shift();
      if (!target) {
        add('formal-command-invalid', location, command);
        continue;
      }
      const key = `${selected}:${target}`;
      if (visited.has(key)) continue;
      visited.add(key);
      try {
        const scripts = packageAt(selected).scripts as Record<string, unknown> | undefined;
        const value = scripts?.[target];
        if (typeof value !== 'string') add('formal-command-unresolved', location, key);
        else inspect(value, `${selected || '.'}/package.json#${target}`, selected);
      } catch (error) {
        add('formal-command-unresolved', location, String(error));
      }
    }
  };
  try {
    const top = packageAt('');
    for (const [name, value] of Object.entries((top.scripts ?? {}) as Record<string, unknown>))
      if (typeof value === 'string') inspect(value, `package.json#${name}`);
    for (const workspace of UNIFIED_WORKSPACES) {
      const manifest = packageAt(workspace);
      for (const [name, value] of Object.entries(
        (manifest.scripts ?? {}) as Record<string, unknown>,
      ))
        if (typeof value === 'string')
          inspect(value, `${workspace}/package.json#${name}`, workspace);
    }
  } catch (error) {
    add('formal-manifest-unavailable', 'package.json', String(error));
  }
  const directory = resolve(root, '.github/workflows');
  if (existsSync(directory))
    for (const name of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
      const location = `.github/workflows/${name}`;
      try {
        const doc = parseDocument(readFileSync(resolve(root, location), 'utf8'), {
          uniqueKeys: true,
        });
        if (doc.errors.length) throw Error(doc.errors.map((e) => e.message).join(';'));
        const value = doc.toJS() as Record<string, unknown>;
        if (
          !value ||
          Array.isArray(value) ||
          Object.keys(value).some(
            (key) =>
              ![
                'name',
                'run-name',
                'on',
                'permissions',
                'concurrency',
                'jobs',
                'env',
                'defaults',
              ].includes(key),
          )
        )
          throw Error('workflow primary keys');
        const jobs = value.jobs as Record<string, Record<string, unknown>>;
        if (!jobs || Array.isArray(jobs)) throw Error('workflow jobs');
        const platforms = new Set<string>();
        for (const [jobName, job] of Object.entries(jobs)) {
          if (
            !job ||
            Array.isArray(job) ||
            Object.keys(job).some(
              (key) =>
                ![
                  'name',
                  'runs-on',
                  'strategy',
                  'timeout-minutes',
                  'steps',
                  'needs',
                  'if',
                  'env',
                  'permissions',
                  'concurrency',
                  'continue-on-error',
                  'defaults',
                  'environment',
                  'outputs',
                  'container',
                  'services',
                ].includes(key),
            )
          )
            throw Error('workflow job keys');
          const matrix = (
            job.strategy as { matrix?: { os?: unknown; include?: unknown } } | undefined
          )?.matrix;
          for (const os of [
            ...(Array.isArray(matrix?.os) ? matrix.os : []),
            ...(Array.isArray(matrix?.include)
              ? matrix.include.map((value) => (value as { os?: unknown }).os)
              : []),
          ])
            if (typeof os === 'string') platforms.add(os.split('-')[0]!);
          if (
            [
              'release-candidate.yml',
              'runtime-transport-qualification.yml',
              'runtime-stdio-smoke.yml',
            ].includes(name)
          ) {
            const checkout = (job.steps as Record<string, unknown>[] | undefined)?.find(
              (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
            );
            const withValue = checkout?.with as Record<string, unknown> | undefined;
            if (
              withValue?.ref !== `\${{ env.KITE_EXPECTED_CANDIDATE_COMMIT }}` ||
              withValue?.repository !== `\${{ env.KITE_CANDIDATE_REPOSITORY }}` ||
              withValue?.['persist-credentials'] !== false ||
              withValue?.['fetch-depth'] !== 0 ||
              (job.env as Record<string, unknown> | undefined)?.KITE_EXPECTED_CANDIDATE_COMMIT !==
                `\${{ github.event.pull_request.head.sha || github.sha }}` ||
              (job.env as Record<string, unknown> | undefined)?.KITE_CANDIDATE_REPOSITORY !==
                `\${{ github.event.pull_request.head.repo.full_name || github.repository }}`
            )
              add('formal-ci-source-unpinned', location, jobName);
          }
          if (job['continue-on-error'] !== undefined && job['continue-on-error'] !== false)
            add('formal-ci-quiet-failure', location, jobName);
          if (job.if === false || job.if === 'false')
            add('formal-ci-quiet-failure', location, jobName);
          const steps = job.steps;
          if (!Array.isArray(steps)) throw Error('workflow steps');
          const runs = (steps as Record<string, unknown>[]).flatMap((step) =>
            typeof step.run === 'string' ? [step.run] : [],
          );
          if (name === 'runtime-transport-qualification.yml') {
            const required =
              'node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 apps/cli/test/file-recovery-pty.test.ts apps/cli/test/isolated/tui-drafts-host.test.ts apps/cli/test/isolated/file-recovery-argv.test.ts apps/cli/test/isolated/tui-file-recovery.test.ts apps/cli/test/isolated/tui-file-recovery-lost-replies.test.ts apps/cli/test/isolated/tui-file-recovery-scopes.test.ts apps/cli/test/isolated/tui-file-recovery-crash.test.ts apps/cli/test/isolated/tui-recovery-host.test.ts apps/cli/test/isolated/tui-preferences-host.test.ts apps/cli/test/isolated/tui-mcp-connection-pty.test.ts apps/cli/test/isolated/tui-composer-host.test.ts apps/cli/test/isolated/tui-planning-host.test.ts tests/isolated/unified-agent/extension-upgrade.test.ts';
            const unfiltered = (step: Record<string, unknown>) =>
              step.if === undefined &&
              step['working-directory'] === undefined &&
              (step['continue-on-error'] === undefined || step['continue-on-error'] === false);
            const build = steps.findIndex(
              (step) => step.run === 'bun run build' && unfiltered(step),
            );
            const caller = steps.findIndex(
              (step) =>
                typeof step.run === 'string' &&
                step.run.trim().replace(/\s+/g, ' ') === required &&
                unfiltered(step),
            );
            const callerIndex = (file: string) =>
              steps.findIndex(
                (step) =>
                  step.run ===
                    `node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 ${file}` &&
                  unfiltered(step),
              );
            const candidateFiles = [
              'apps/cli/test/isolated/tui-file-candidates-host.test.ts',
              'apps/cli/test/file-candidate-windows-records.test.ts',
              'apps/cli/test/isolated/file-candidate-windows-native.test.ts',
            ];
            const completeCallers = [
              'apps/cli/test/isolated/tui-mcp-tools-pty.test.ts',
              'apps/cli/test/isolated/tui-mcp-source-mutation-pty.test.ts',
              'apps/cli/test/isolated/tui-mcp-source-approval-pty.test.ts',
              'apps/cli/test/isolated/tui-mcp-reconnection-pty.test.ts',
              'apps/cli/test/isolated/tui-mcp-auth-pty.test.ts',
              'apps/cli/test/isolated/tui-mcp-pty.test.ts',
              'apps/cli/test/isolated/tui-mcp-cold-pty.test.ts',
              'apps/cli/test/isolated/tui-skills-host.test.ts',
              'apps/cli/test/isolated/tui-permissions-host.test.ts',
              ...candidateFiles,
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
            ].map(callerIndex);
            const transport = steps.findIndex(
              (step) => step.run === 'bun run test:runtime:transport' && unfiltered(step),
            );
            const recoveryCallers = [
              'apps/service/test/isolated/run-resume.test.ts',
              'apps/service/test/isolated/job-report-resume.test.ts',
              'apps/service/test/isolated/job-reconcile.test.ts',
              'apps/service/test/isolated/recovery-preparation-ownership.test.ts',
            ].map(callerIndex);
            const prepare = steps.findIndex(
              (step) =>
                step.if === "runner.os == 'Windows'" &&
                step.run ===
                  'node --import ./scripts/tooling/register.mjs scripts/release/prepare-windows-native-ci.ts',
            );
            if (
              build <= prepare ||
              caller <= build ||
              caller < 0 ||
              completeCallers.some((index) => index <= build || index >= caller) ||
              completeCallers.some((index) => index >= transport) ||
              recoveryCallers.some((index) => index <= transport || index >= caller) ||
              candidateFiles.some(
                (file) =>
                  callerIndex(file) >=
                  callerIndex('apps/cli/test/isolated/tui-permissions-host.test.ts'),
              ) ||
              job.if !== undefined ||
              job['runs-on'] !== `\${{ matrix.os }}` ||
              !['macos-15', 'ubuntu-24.04', 'windows-2025'].every(
                (os) => Array.isArray(matrix?.os) && matrix.os.includes(os),
              )
            )
              add('formal-ci-shared-caller-tests-missing', location, jobName);
          }
          if (
            [
              'release-candidate.yml',
              'runtime-stdio-smoke.yml',
              'platform-capability-probe.yml',
              'runtime-transport-qualification.yml',
            ].includes(name) ||
            (name === 'required.yml' && jobName === 'unit')
          ) {
            const display = name === 'release-candidate.yml' || name === 'required.yml';
            const prepare = steps.findIndex(
              (step) =>
                step.if === (name === 'required.yml' ? undefined : "runner.os == 'Linux'") &&
                step.run ===
                  `sudo apt-get update && sudo apt-get install --no-install-recommends -y build-essential pkg-config libffi-dev bubblewrap${display ? ' xvfb' : ''}` &&
                (step['continue-on-error'] === undefined || step['continue-on-error'] === false),
            );
            const consumer = steps.findIndex(
              (step) =>
                typeof step.run === 'string' &&
                /\b(?:node --import \.\/scripts\/tooling\/register\.mjs \.?\/?scripts\/run-test-files\.ts|bun run (?:test(?::|\b)|release:build\b))/.test(
                  step.run,
                ),
            );
            if (prepare < 0 || consumer <= prepare)
              add('formal-ci-linux-native-dependencies-missing', location, jobName);
          }
          if (name === 'runtime-stdio-smoke.yml') {
            const qualify = steps.findIndex(
              (step) =>
                step.if === undefined &&
                step.run === 'bun run test:runtime:stdio' &&
                step['working-directory'] === undefined &&
                (step['continue-on-error'] === undefined || step['continue-on-error'] === false),
            );
            const scripts = packageAt('').scripts as Record<string, unknown> | undefined;
            if (
              qualify < 0 ||
              job['runs-on'] !== `\${{ matrix.os }}` ||
              scripts?.['test:runtime:stdio'] !==
                `node --import ./scripts/tooling/register.mjs ./scripts/run-test-files.ts --parallel=1 --max-concurrency=1 ${stdioSuites.slice(0, -1).join(' ')} && node --import ./scripts/tooling/register.mjs ./scripts/run-test-files.ts --parallel=1 --max-concurrency=1 ${stdioSuites.at(-1)}` ||
              !stdioSuites.every((path) => existsSync(resolve(root, path)))
            )
              add('formal-ci-mcp-stdio-missing', location, jobName);
            const prepare = steps.findIndex(
              (step) =>
                step.if === "runner.os == 'Windows'" &&
                step.run ===
                  'node --import ./scripts/tooling/register.mjs scripts/release/prepare-windows-native-ci.ts',
            );
            if (
              prepare < 0 ||
              qualify <= prepare ||
              !existsSync(resolve(root, 'scripts/release/prepare-windows-native-ci.ts'))
            )
              add('formal-ci-native-build-environment-missing', location, jobName);
            const shellTest = steps.findIndex(
              (step) =>
                step.if === undefined &&
                step.run ===
                  'node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 tests/isolated/scripts/ci-logged-shell.test.ts',
            );
            if (
              shellTest < 0 ||
              shellTest >= qualify ||
              !existsSync(resolve(root, 'tests/isolated/scripts/ci-logged-shell.test.ts'))
            )
              add('formal-ci-qualification-shell-test-missing', location, jobName);
          }
          if (['release-candidate.yml', 'runtime-stdio-smoke.yml'].includes(name)) {
            const logs = new Set<string>();
            for (const step of steps) {
              if (
                typeof step.run !== 'string' ||
                !/\b(?:bun run (?:test:runtime:stdio\b|release:)|node --import \.\/scripts\/tooling\/register\.mjs \.?\/?(?:scripts\/(?:run-test-files\.ts\b|ci\/prepare-release-predecessors\.ts\b|release\/unified-platform-)|tests\/fixtures\/unified-agent\/(?:native-terminal-split|windows-(?:terminal-installation|native-installation|installed-tui|cross-version))\.qualification\.ts\b))/.test(
                  step.run,
                )
              )
                continue;
              const match =
                typeof step.shell === 'string'
                  ? /^node --import \.\/scripts\/tooling\/register\.mjs scripts\/ci\/logged-shell\.ts --log=(dist\/unified-evidence\/[a-z0-9-]+\.log) "\{0\}"$/.exec(
                      step.shell,
                    )
                  : null;
              const log = match?.[1];
              if (
                !log ||
                logs.has(log) ||
                !existsSync(resolve(root, 'scripts/ci/logged-shell.ts'))
              ) {
                add('formal-ci-qualification-log-missing', location, String(step.name ?? step.run));
                continue;
              }
              logs.add(log);
            }
            if (
              logs.size === 0 ||
              !steps.some((step) => {
                const withValue = step.with as Record<string, unknown> | undefined;
                const paths =
                  typeof withValue?.path === 'string' ? withValue.path.trim().split(/\s+/) : [];
                return (
                  typeof step.uses === 'string' &&
                  step.uses.startsWith('actions/upload-artifact@') &&
                  step.if === 'always()' &&
                  withValue?.['if-no-files-found'] === 'error' &&
                  [...logs].every(
                    (log) => paths.includes(log) || paths.includes('dist/unified-evidence/'),
                  )
                );
              })
            )
              add('formal-ci-qualification-log-upload-missing', location, jobName);
          }
          if (
            name === 'required.yml' &&
            jobName === 'unit' &&
            !steps.some(
              (step) =>
                step.if === undefined &&
                typeof step.run === 'string' &&
                step.run.trim() === 'xvfb-run -a bun run test',
            )
          )
            add('formal-ci-linux-unit-display-missing', location, jobName);
          if (
            name === 'release-candidate.yml' &&
            !steps.some(
              (step) =>
                step.if === "runner.os == 'macOS' || runner.os == 'Linux'" &&
                typeof step.run === 'string' &&
                step.run.trim().replace(/\s+/g, ' ') ===
                  'node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/terminal-bundle.test.ts',
            )
          )
            add('formal-ci-terminal-lifecycle-missing', location, jobName);
          if (
            name === 'release-candidate.yml' &&
            !steps.some(
              (step) =>
                step.if === "runner.os == 'Linux'" &&
                typeof step.run === 'string' &&
                step.run.trim().replace(/\s+/g, ' ') ===
                  'xvfb-run -a node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/native-install-lifecycle.test.ts',
            )
          )
            add('formal-ci-linux-native-lifecycle-missing', location, jobName);
          if (name === 'release-candidate.yml') {
            const prepare = steps.findIndex(
              (step) =>
                step.if === "runner.os == 'Windows'" &&
                step.run ===
                  'node --import ./scripts/tooling/register.mjs scripts/release/prepare-windows-native-ci.ts' &&
                (step['continue-on-error'] === undefined || step['continue-on-error'] === false),
            );
            const build = steps.findIndex(
              (step) =>
                step.if === undefined &&
                typeof step.run === 'string' &&
                step.run.trim().replace(/\s+/g, ' ') ===
                  'bun run release:build --directory dist/unified-terminal --archive dist/unified-terminal.tar.gz' &&
                (step['continue-on-error'] === undefined || step['continue-on-error'] === false),
            );
            const qualify = steps.findIndex(
              (step) =>
                step.if === "runner.os == 'Windows'" &&
                typeof step.run === 'string' &&
                step.run.trim().replace(/\s+/g, ' ') ===
                  `node --import ./scripts/tooling/register.mjs tests/fixtures/unified-agent/windows-terminal-installation.qualification.ts "--candidate=\${{ github.workspace }}/dist/unified-terminal"` &&
                (step['continue-on-error'] === undefined || step['continue-on-error'] === false),
            );
            if (qualify < 0 || build < 0 || qualify <= build)
              add('formal-ci-windows-terminal-installation-missing', location, jobName);
            if (
              prepare < 0 ||
              build <= prepare ||
              !existsSync(resolve(root, 'scripts/release/prepare-windows-native-ci.ts'))
            )
              add('formal-ci-windows-terminal-build-environment-missing', location, jobName);
            const nativeCommands = [
              'bun run release:build --product native --directory dist/unified-native --terminal dist/unified-terminal --archive dist/unified-native.tar.gz',
              `bun run release:verify --product native --directory dist/unified-native --source-commit "\${{ env.KITE_EXPECTED_CANDIDATE_COMMIT }}" --clean-source true`,
              'bun run release:smoke --product native --directory dist/unified-native',
            ];
            const nativePrerequisites = nativeCommands.map((command) =>
              steps.findIndex(
                (step) =>
                  step.if === undefined &&
                  typeof step.run === 'string' &&
                  step.run.trim().replace(/\s+/g, ' ') === command &&
                  (step['continue-on-error'] === undefined || step['continue-on-error'] === false),
              ),
            );
            const nativeQualification = steps.findIndex(
              (step) =>
                step.if === "runner.os == 'Windows'" &&
                typeof step.run === 'string' &&
                step.run.trim().replace(/\s+/g, ' ') ===
                  `node --import ./scripts/tooling/register.mjs tests/fixtures/unified-agent/windows-native-installation.qualification.ts "--candidate=\${{ github.workspace }}/dist/unified-native"` &&
                (step['continue-on-error'] === undefined || step['continue-on-error'] === false),
            );
            const windowsRunner =
              job['runs-on'] === `\${{ matrix.os }}` &&
              [
                ...(Array.isArray(matrix?.os) ? matrix.os : []),
                ...(Array.isArray(matrix?.include)
                  ? matrix.include.map((row) => (row as { os?: unknown }).os)
                  : []),
              ].some((os) => typeof os === 'string' && /^windows(?:-|$)/.test(os));
            if (
              !windowsRunner ||
              nativeQualification < 0 ||
              nativePrerequisites.some((index) => index < 0 || index >= nativeQualification) ||
              !(
                nativePrerequisites[0]! < nativePrerequisites[1]! &&
                nativePrerequisites[1]! < nativePrerequisites[2]!
              ) ||
              !existsSync(
                resolve(
                  root,
                  'tests/fixtures/unified-agent/windows-native-installation.qualification.ts',
                ),
              )
            )
              add('formal-ci-windows-native-installation-missing', location, jobName);
            const terminalCommands = [
              'bun run release:build --directory dist/unified-terminal --archive dist/unified-terminal.tar.gz',
              `bun run release:verify --directory dist/unified-terminal --source-commit "\${{ env.KITE_EXPECTED_CANDIDATE_COMMIT }}" --clean-source true`,
              'bun run release:smoke --directory dist/unified-terminal',
            ];
            const terminalPrerequisites = terminalCommands.map((command) =>
              steps.findIndex(
                (step) =>
                  step.if === undefined &&
                  typeof step.run === 'string' &&
                  step.run.trim().replace(/\s+/g, ' ') === command &&
                  (step['continue-on-error'] === undefined || step['continue-on-error'] === false),
              ),
            );
            const tuiQualification = steps.findIndex(
              (step) =>
                step.if === "runner.os == 'Windows'" &&
                typeof step.run === 'string' &&
                step.run.trim().replace(/\s+/g, ' ') ===
                  `node --import ./scripts/tooling/register.mjs tests/fixtures/unified-agent/windows-installed-tui.qualification.ts "--terminal=\${{ github.workspace }}/dist/unified-terminal" "--native=\${{ github.workspace }}/dist/unified-native"` &&
                (step['continue-on-error'] === undefined || step['continue-on-error'] === false),
            );
            const tuiPrerequisites = [...terminalPrerequisites, ...nativePrerequisites];
            const splitQualificationPath =
              'tests/fixtures/unified-agent/native-terminal-split.qualification.ts';
            const splitStep = (command: string) =>
              steps.findIndex(
                (step) =>
                  step.if === "runner.os == 'macOS' || runner.os == 'Windows'" &&
                  (step['continue-on-error'] === undefined ||
                    step['continue-on-error'] === false) &&
                  step['working-directory'] === undefined &&
                  typeof step.run === 'string' &&
                  step.run.trim().replace(/\s+/g, ' ') === command,
              );
            const splitBuild = splitStep(
              'bun run release:build --product native --directory dist/unified-desktop',
            );
            const splitQualification = splitStep(
              `node --import ./scripts/tooling/register.mjs ${splitQualificationPath} "--terminal=\${{ github.workspace }}/dist/unified-terminal" "--native=\${{ github.workspace }}/dist/unified-native" "--desktop=\${{ github.workspace }}/dist/unified-desktop"`,
            );
            if (
              splitBuild < 0 ||
              splitQualification <= splitBuild ||
              tuiPrerequisites.some((index) => index < 0 || index >= splitQualification) ||
              !existsSync(resolve(root, splitQualificationPath))
            )
              add('formal-ci-native-terminal-split-missing', location, jobName);
            if (
              !windowsRunner ||
              tuiQualification < 0 ||
              nativeQualification < 0 ||
              nativeQualification >= tuiQualification ||
              tuiPrerequisites.some((index) => index < 0 || index >= nativeQualification) ||
              tuiPrerequisites.some(
                (index, position) => position > 0 && index <= tuiPrerequisites[position - 1]!,
              ) ||
              !existsSync(
                resolve(
                  root,
                  'tests/fixtures/unified-agent/windows-native-installation.qualification.ts',
                ),
              ) ||
              !existsSync(
                resolve(
                  root,
                  'tests/fixtures/unified-agent/windows-installed-tui.qualification.ts',
                ),
              )
            )
              add('formal-ci-windows-installed-tui-missing', location, jobName);
            const crossVersionQualification = steps.findIndex(
              (step) =>
                step.if === "runner.os == 'Windows'" &&
                typeof step.run === 'string' &&
                step.run.trim().replace(/\s+/g, ' ') ===
                  `node --import ./scripts/tooling/register.mjs tests/fixtures/unified-agent/windows-cross-version.qualification.ts "--terminal=\${{ github.workspace }}/dist/unified-terminal" "--native=\${{ github.workspace }}/dist/unified-native"` &&
                (step['continue-on-error'] === undefined || step['continue-on-error'] === false),
            );
            const historicalProducer = 'scripts/ci/prepare-release-predecessors.ts';
            const prepareHistory = steps.findIndex(
              (step) =>
                step.run === `node --import ./scripts/tooling/register.mjs ${historicalProducer}` &&
                step.if === undefined &&
                step['working-directory'] === undefined &&
                (step['continue-on-error'] === undefined || step['continue-on-error'] === false),
            );
            if (
              prepareHistory <= prepare ||
              prepareHistory >= crossVersionQualification ||
              !existsSync(resolve(root, historicalProducer))
            )
              add('formal-ci-historical-predecessors-missing', location, jobName);
            const crossVersionPrerequisites = [
              prepare,
              ...terminalPrerequisites,
              qualify,
              ...nativePrerequisites,
              nativeQualification,
              tuiQualification,
            ];
            if (
              !windowsRunner ||
              crossVersionQualification < 0 ||
              crossVersionPrerequisites.some(
                (index) => index < 0 || index >= crossVersionQualification,
              ) ||
              crossVersionPrerequisites.some(
                (index, position) =>
                  position > 0 && index <= crossVersionPrerequisites[position - 1]!,
              ) ||
              ![
                'scripts/release/prepare-windows-native-ci.ts',
                'tests/fixtures/unified-agent/windows-terminal-installation.qualification.ts',
                'tests/fixtures/unified-agent/windows-native-installation.qualification.ts',
                'tests/fixtures/unified-agent/windows-installed-tui.qualification.ts',
                'tests/fixtures/unified-agent/windows-cross-version.qualification.ts',
              ].every((path) => existsSync(resolve(root, path)))
            )
              add('formal-ci-windows-real-code-missing', location, jobName);
            for (const [platform, command, code] of [
              [
                "runner.os == 'macOS' || runner.os == 'Linux'",
                'node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/terminal-cross-version.test.ts',
                'formal-ci-terminal-real-code-missing',
              ],
              [
                "runner.os == 'macOS'",
                'node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/native-cross-version.test.ts',
                'formal-ci-macos-native-real-code-missing',
              ],
              [
                "runner.os == 'Linux'",
                'xvfb-run -a node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/native-cross-version.test.ts',
                'formal-ci-linux-native-real-code-missing',
              ],
            ] as const)
              if (
                !steps.some(
                  (step, index) =>
                    index > prepareHistory &&
                    step.if === platform &&
                    (step['continue-on-error'] === undefined ||
                      step['continue-on-error'] === false) &&
                    (step.env as Record<string, unknown> | undefined)
                      ?.KITE_REQUIRE_HISTORICAL_PREDECESSOR === '1' &&
                    typeof step.run === 'string' &&
                    step.run.trim().replace(/\s+/g, ' ') === command,
                )
              )
                add(code, location, jobName);
          }
          if (
            [
              'release-candidate.yml',
              'runtime-transport-qualification.yml',
              'platform-capability-probe.yml',
            ].includes(name)
          ) {
            const prepare = steps.findIndex(
              (step) =>
                step.if === "runner.os == 'Windows'" &&
                step.run ===
                  'node --import ./scripts/tooling/register.mjs scripts/release/prepare-windows-native-ci.ts',
            );
            const requiredConsumer =
              name === 'release-candidate.yml'
                ? 'bun run release:build --product native --directory dist/unified-native --terminal dist/unified-terminal --archive dist/unified-native.tar.gz'
                : name === 'platform-capability-probe.yml'
                  ? 'bun run release:build --directory dist/unified-terminal'
                  : 'node --import ./scripts/tooling/register.mjs scripts/run-test-files.ts --parallel=1 --max-concurrency=1 packages/agent/test/isolated/windows-path-security/default.test.ts packages/agent/test/isolated/config/mcp-selection-windows.test.ts apps/desktop/test/isolated/windows-node-access.test.ts';
            const consumer = steps.findIndex(
              (step) =>
                typeof step.run === 'string' &&
                step.run.trim().replace(/\s+/g, ' ') === requiredConsumer &&
                (name !== 'runtime-transport-qualification.yml' ||
                  step.if === "runner.os == 'Windows'"),
            );
            if (
              prepare < 0 ||
              consumer <= prepare ||
              !existsSync(resolve(root, 'scripts/release/prepare-windows-native-ci.ts'))
            )
              add('formal-ci-native-build-environment-missing', location, jobName);
          }
          if (
            runs.some((run) => run.includes('scripts/release/unified-platform-probe.ts')) &&
            !runs.some(
              (run) =>
                run.includes('scripts/release/unified-platform-verify.ts') &&
                run.includes('--mode=formal'),
            )
          )
            add('formal-ci-qualification-gate-missing', location, jobName);
          if (
            runs.some(
              (run) =>
                run.includes('scripts/runtime/unified-soak.ts') &&
                run.includes('--profile=qualification'),
            ) &&
            !runs.some((run) => run.includes('scripts/runtime/unified-soak-verify.ts'))
          )
            add('formal-ci-qualification-gate-missing', location, jobName);
          for (const step of steps as Record<string, unknown>[]) {
            if (
              !step ||
              Array.isArray(step) ||
              Object.keys(step).some(
                (key) =>
                  ![
                    'name',
                    'uses',
                    'run',
                    'with',
                    'env',
                    'if',
                    'shell',
                    'working-directory',
                    'id',
                    'timeout-minutes',
                    'continue-on-error',
                  ].includes(key),
              )
            )
              throw Error('workflow step keys');
            if (step.if === false || step.if === 'false')
              add('formal-ci-quiet-failure', location, jobName);
            if (step['continue-on-error'] !== undefined && step['continue-on-error'] !== false)
              add('formal-ci-quiet-failure', location, jobName);
            if (
              typeof step.uses === 'string' &&
              !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[a-f0-9]{40}$/.test(step.uses)
            )
              add('formal-ci-action-unpinned', location, step.uses);
            if (typeof step.run === 'string') {
              if (/\|\|\s*(?:true|exit\s+0)\b/.test(step.run))
                add('formal-ci-quiet-failure', location, step.run);
              inspect(
                step.run,
                `${location}#${jobName}`,
                typeof step['working-directory'] === 'string' ? step['working-directory'] : '',
              );
              if (typeof step.shell === 'string')
                inspect(step.shell, `${location}#${jobName}:shell`);
            }
          }
        }
        if (
          [
            'release-candidate.yml',
            'platform-capability-probe.yml',
            'execution-boundary-conformance.yml',
            'mcp-native-keyring-smoke.yml',
            'runtime-transport-qualification.yml',
            'runtime-stdio-smoke.yml',
          ].includes(name) &&
          !['macos', 'ubuntu', 'windows'].every((platform) => platforms.has(platform))
        )
          add('formal-ci-platform-matrix', location, 'requires actual three OS matrix');
      } catch (error) {
        add('formal-ci-invalid', location, String(error));
      }
    }
  return { violations, entrypoints: [...entrypoints] };
}
/** Static manifest/source boundary only: no installed node_modules or execution authority. */
export function checkUnifiedWorkspaces(repositoryRoot: string): UnifiedWorkspaceReport {
  const root = resolve(repositoryRoot),
    violations: UnifiedWorkspaceViolation[] = [],
    checked: string[] = [];
  const add = (code: string, path: string, message: string) =>
    violations.push({ code, path, message });
  const manifest = (path: string): Record<string, unknown> | undefined => {
    try {
      const value = JSON.parse(readFileSync(resolve(root, path), 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('not an object');
      return value;
    } catch (error) {
      add('manifest-unavailable', path, String(error));
      return undefined;
    }
  };
  const dependencies = (value: Record<string, unknown>, path: string) => {
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      const declared = value[field];
      if (declared === undefined) continue;
      if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
        add('dependencies-invalid', path, field);
        continue;
      }
      for (const [name, version] of Object.entries(declared))
        if (name.startsWith('@kite-ai/')) {
          if (!names.has(name)) add('workspace-dependency-forbidden', path, `${field}: ${name}`);
          else if (version !== 'workspace:*')
            add('workspace-dependency-version', path, `${field}: ${name} must use workspace:*`);
        }
    }
  };
  const top = manifest('package.json');
  if (top) {
    if (JSON.stringify(top.workspaces) !== JSON.stringify(UNIFIED_WORKSPACES))
      add(
        'workspaces-not-exact',
        'package.json',
        `must match ordered ${UNIFIED_WORKSPACES.join(', ')}`,
      );
    dependencies(top, 'package.json');
    if (top.module !== 'scripts/release/source-terminal.ts')
      add(
        'formal-module-invalid',
        'package.json',
        'module must be scripts/release/source-terminal.ts',
      );
    const scripts = top.scripts as Record<string, unknown> | undefined;
    for (const [name, expected] of Object.entries(formalScripts)) {
      if (scripts?.[name] !== expected)
        add('formal-script-invalid', 'package.json', `${name} must be ${expected}`);
      const entry = expected.match(/node --import \S+ (\S+\.ts)(?: |$)/)?.[1];
      if (entry && !existsSync(resolve(root, entry))) add('formal-entry-missing', entry, name);
    }
    if (!existsSync(resolve(root, 'scripts/release/source-terminal.ts')))
      add('formal-entry-missing', 'scripts/release/source-terminal.ts', 'root module');
  }
  const typecheck = manifest('tsconfig.typecheck.json');
  const references = ['.', ...UNIFIED_WORKSPACES].map((path) => ({
    path: path === '.' ? './tsconfig.json' : `./${path}/tsconfig.json`,
  }));
  if (
    typecheck &&
    (Object.keys(typecheck).length !== 2 ||
      !Array.isArray(typecheck.files) ||
      typecheck.files.length !== 0 ||
      JSON.stringify(typecheck.references) !== JSON.stringify(references))
  )
    add(
      'typecheck-projects-invalid',
      'tsconfig.typecheck.json',
      'requires root and exact eight projects',
    );
  for (const path of UNIFIED_WORKSPACES) {
    const location = `${path}/package.json`,
      value = manifest(location);
    if (!value) continue;
    checked.push(path);
    if (
      value.name !== `@kite-ai/${path.split('/')[1]}` ||
      value.type !== 'module' ||
      value.private !== true
    )
      add('workspace-identity-invalid', location, 'requires exact name, private ESM');
    dependencies(value, location);
    const scripts = value.scripts as Record<string, unknown> | undefined;
    for (const name of ['build', 'typecheck', 'test'])
      if (typeof scripts?.[name] !== 'string' || !(scripts[name] as string).trim())
        add('workspace-script-missing', location, name);
    const exports = value.exports;
    if (
      !exports ||
      typeof exports !== 'object' ||
      Array.isArray(exports) ||
      !Object.hasOwn(exports, '.')
    )
      add('workspace-exports-invalid', location, 'requires public root exports map');
    else {
      const checkExport = (key: string, target: unknown): void => {
        if (target && typeof target === 'object' && !Array.isArray(target)) {
          if (!Object.keys(target).length) add('workspace-export-invalid', location, key);
          for (const [condition, value] of Object.entries(target))
            checkExport(`${key}:${condition}`, value);
          return;
        }
        if (
          typeof target !== 'string' ||
          !target.startsWith('./') ||
          relative(resolve(root, path), resolve(root, path, target)).startsWith('..') ||
          !existsSync(resolve(root, path, target))
        )
          add('workspace-export-invalid', location, `${key}: ${String(target)}`);
      };
      for (const [key, target] of Object.entries(exports)) {
        if (key !== '.' && !key.startsWith('./')) add('workspace-export-invalid', location, key);
        checkExport(key, target);
      }
    }
  }
  const consumers = checkUnifiedFormalConsumers(root);
  violations.push(...consumers.violations);
  const boundary = checkUnifiedAgentBoundary(root, consumers.entrypoints);
  for (const violation of boundary.violations)
    add(
      'source-boundary',
      violation.file,
      `${violation.rule}:${violation.line} ${violation.detail}`,
    );
  return { violations, checked, boundary };
}
if (import.meta.main) {
  const report = checkUnifiedWorkspaces(process.argv[2] ?? process.cwd());
  for (const violation of report.violations)
    console.error(`${violation.code}: ${violation.path}: ${violation.message}`);
  for (const item of report.boundary.checked) console.log(`checked ${item}`);
  for (const item of report.boundary.pending) console.log(`pending ${item}`);
  console.log('Legacy retirement remains pending; this check does not certify final cutover.');
  console.log(
    `unified workspaces checked=${report.checked.length} violations=${report.violations.length}; static only, not install/runtime qualification`,
  );
  process.exitCode = report.violations.length ? 1 : 0;
}

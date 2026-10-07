import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { checkUnifiedAgentBoundary } from './check-unified-agent-boundary';

export const UNIFIED_WORKSPACES = Object.freeze([
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
}
const names = new Map(UNIFIED_WORKSPACES.map((path) => [`@kite-ai/${path.split('/')[1]}`, path]));
const formalScripts: Readonly<Record<string, string>> = {
  build: 'bun run scripts/run-runtime-workspace-script.ts build',
  test: 'bun run scripts/run-default-tests.ts',
  'test:all': 'bun run test',
  typecheck: 'tsc --noEmit && bun run scripts/run-runtime-workspace-script.ts typecheck',
  agent: 'bun run scripts/release/entrypoints/cli.ts',
  tui: 'bun run scripts/release/entrypoints/tui.ts',
  'prod:tui': 'NODE_ENV=production bun run scripts/release/entrypoints/tui.ts',
  server: 'bun run scripts/development/ensure-web.ts',
  desktop: 'bun run scripts/release/native.ts launch',
  'release:terminal': 'bun run scripts/release/terminal.ts',
  'release:build': 'bun run scripts/release/unified.ts build',
  'release:verify': 'bun run scripts/release/unified.ts verify',
  'release:smoke': 'bun run scripts/release/unified.ts smoke',
  'release:install': 'bun run scripts/release/unified.ts install',
  'release:native': 'bun run scripts/release/native.ts',
  'check:runtime-packages': 'bun run scripts/check-unified-workspaces.ts',
};
const legacyConsumer =
  /(?:@kite-ai\/|packages\/|#)(?:agent-api-(?:contract|client)|agent-kernel|builtin-runtime|runtime-(?:host|spi|contract|protocol|server|client|storage-sqlite)|kite-(?:app-contract|local-runtime|client-ui|cli|service|web|desktop))(?:\/|\b)|(?:^|[\s'"/])apps\/kite-(?:cli|service|web|desktop)(?:\/|\b)|scripts\/(?:run-tui-system-tests|runtime\/(?:run-fault-soak|verify-fault-soak-qualification)|release\/(?:oss-candidate|build-oss-candidate|build-artifact|verify-artifact|bootstrap-verifier|prepare-desktop-service|platform-capability-probe|session-log-acl-smoke))\.ts/;
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
  const paths = (path: string): void => {
    if (!path || path === '.' || path === 'tests' || path === 'packages' || path === 'apps') {
      add('formal-discovery-too-wide', path, 'requires finite current suites/entrypoints');
      return;
    }
    if (relative(root, resolve(root, path)).startsWith('..')) {
      add('formal-command-escape', path, 'outside repository');
      return;
    }
    if (!existsSync(resolve(root, path))) return;
    if (statSync(resolve(root, path)).isDirectory())
      for (const child of readdirSync(resolve(root, path))) paths(`${path}/${child}`);
    else if (/\.[cm]?[jt]sx?$/.test(path)) entrypoints.add(path.replaceAll('\\', '/'));
  };
  const inspect = (command: string, location: string, cwd = ''): void => {
    if (legacyConsumer.test(command) || legacyConsumer.test(cwd))
      add('formal-legacy-command', location, command);
    if (/^\s*\$/.test(command)) add('formal-command-unresolved', location, 'computed command head');
    for (const match of command.matchAll(/\b(?:bun|node)\s+([^\s;]+\.[cm]?[jt]sx?)(?=\s|$)/g))
      paths(relative(root, resolve(root, cwd, match[1]!)));
    for (const match of command.matchAll(
      /\bbun\s+((?:--cwd\s+[^\s;]+\s+)?(?:run|test|build))\s+([^;\n|&]+)/g,
    )) {
      const raw = `${match[1]} ${match[2]}`,
        tokens =
          raw
            .match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)
            ?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? [];
      const cwdIndex = tokens.indexOf('--cwd');
      let selected = cwd;
      if (cwdIndex !== -1) {
        selected = relative(root, resolve(root, cwd, tokens[cwdIndex + 1] ?? '')).replaceAll(
          '\\',
          '/',
        );
        tokens.splice(cwdIndex, 2);
      }
      if (selected && !UNIFIED_WORKSPACES.includes(selected as (typeof UNIFIED_WORKSPACES)[number]))
        add('formal-command-cwd-forbidden', location, selected);
      const kind = tokens.shift();
      const args = tokens.filter((token) => !token.startsWith('-'));
      if (kind === 'run') {
        const target = args[0];
        if (!target) {
          add('formal-command-invalid', location, command);
          continue;
        }
        if (/\.[cm]?[jt]sx?$/.test(target)) paths(relative(root, resolve(root, selected, target)));
        else {
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
      } else
        for (const arg of args)
          if (
            arg.includes('/') ||
            /\.[cm]?[jt]sx?$/.test(arg) ||
            existsSync(resolve(root, selected, arg))
          )
            paths(relative(root, resolve(root, selected, arg)));
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
          if (['release-candidate.yml', 'runtime-transport-qualification.yml'].includes(name)) {
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
          if (
            name === 'release-candidate.yml' &&
            !steps.some(
              (step) =>
                step.if === "runner.os == 'macOS' || runner.os == 'Linux'" &&
                typeof step.run === 'string' &&
                step.run.trim().replace(/\s+/g, ' ') ===
                  'bun test --parallel=1 --max-concurrency=1 tests/isolated/unified-agent/terminal-bundle.test.ts',
            )
          )
            add('formal-ci-terminal-lifecycle-missing', location, jobName);
          if (['release-candidate.yml', 'runtime-transport-qualification.yml'].includes(name)) {
            const prepare = steps.findIndex(
              (step) =>
                step.if === "runner.os == 'Windows'" &&
                step.run === 'bun run scripts/release/prepare-windows-native-ci.ts',
            );
            const requiredConsumer =
              name === 'release-candidate.yml'
                ? 'bun run release:build --product native --directory dist/unified-native --terminal dist/unified-terminal --archive dist/unified-native.tar.gz'
                : 'bun test --parallel=1 --max-concurrency=1 packages/agent/test/isolated/windows-path-security/default.test.ts packages/agent/test/isolated/config/mcp-selection-windows.test.ts apps/desktop/test/isolated/windows-node-access.test.ts';
            const consumer = steps.findIndex(
              (step) =>
                typeof step.run === 'string' &&
                step.run.trim().replace(/\s+/g, ' ') === requiredConsumer &&
                (name === 'release-candidate.yml' || step.if === "runner.os == 'Windows'"),
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
        'workspaces-not-exact-eight',
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
      const entry = expected.match(/bun run (\S+\.ts)(?: |$)/)?.[1];
      if (entry && !existsSync(resolve(root, entry))) add('formal-entry-missing', entry, name);
    }
    if (!existsSync(resolve(root, 'scripts/release/source-terminal.ts')))
      add('formal-entry-missing', 'scripts/release/source-terminal.ts', 'root module');
  }
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
  for (const violation of checkUnifiedAgentBoundary(root, consumers.entrypoints).violations)
    add(
      'source-boundary',
      violation.file,
      `${violation.rule}:${violation.line} ${violation.detail}`,
    );
  return { violations, checked };
}
if (import.meta.main) {
  const report = checkUnifiedWorkspaces(process.argv[2] ?? process.cwd());
  for (const violation of report.violations)
    console.error(`${violation.code}: ${violation.path}: ${violation.message}`);
  console.log(
    `unified workspaces checked=${report.checked.length} violations=${report.violations.length}; static only, not install/runtime qualification`,
  );
  process.exitCode = report.violations.length ? 1 : 0;
}

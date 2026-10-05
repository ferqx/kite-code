import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';

export interface UnifiedBoundaryViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
}

export interface UnifiedBoundaryReport {
  readonly violations: readonly UnifiedBoundaryViolation[];
  /** Missing source is unfinished delivery, not a boundary violation or a pass. */
  readonly pending: readonly string[];
  readonly checked: readonly string[];
  readonly legacyRetirement: 'pending';
}

const legacy =
  /(?:@kite-ai\/|packages\/|#)(?:agent-api-(?:contract|client)|agent-kernel|builtin-runtime|runtime-(?:host|spi|contract|protocol|server|client|storage-sqlite)|kite-(?:app-contract|local-runtime|client-ui|cli|service|web|desktop))(?:\/|$)|(?:^|\/)apps\/kite-(?:cli|service|web|desktop)(?:\/|$)/;
const workspacePaths: Readonly<Record<string, string>> = {
  ai: 'packages/ai',
  agent: 'packages/agent',
  client: 'packages/client',
  ui: 'packages/ui',
  service: 'apps/service',
  cli: 'apps/cli',
  desktop: 'apps/desktop',
  web: 'apps/web',
};
const serverDependency =
  /^(?:bun:sqlite|drizzle-orm(?:\/|$)|hono(?:\/|$)|@kite-ai\/agent(?:\/|$)|@ai-sdk\/|node:(?:fs|child_process|worker_threads|net|http|https)(?:\/|$))/;
const nativeDependency =
  /^(?:node:|bun(?::|$)|(?:fs|path|os|process|http|https|net|tls|child_process|worker_threads|sqlite3|better-sqlite3|electron|openai|@anthropic-ai\/sdk|@google\/genai|@modelcontextprotocol\/sdk|@libsql\/client|@kite-ai\/service)(?:\/|$))/;
const infrastructure =
  /^(?:bun:sqlite|drizzle-orm(?:\/|$)|hono(?:\/|$)|node:(?:fs|child_process|worker_threads|net|http|https)(?:\/|$))/;

function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.[cm]?[jt]sx?$/.test(path) ? [path] : [];
  });
}

function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const branches = Object.values(value).map(exportTargets);
  return branches.some((branch) => !branch.length) ? [] : branches.flat();
}
function localModules(root: string, file: string, specifier: string): string[] {
  let targets: string[] = [];
  if (specifier.startsWith('.') || isAbsolute(specifier))
    targets = [resolve(dirname(file), specifier)];
  const workspace = /^@kite-ai\/([^/]+)(?:\/(.*))?$/.exec(specifier);
  if (workspace && workspacePaths[workspace[1]!]) {
    const packageRoot = resolve(root, workspacePaths[workspace[1]!]!);
    try {
      const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
      const key = workspace[2] ? `./${workspace[2]}` : '.';
      const exported = exportTargets(manifest.exports?.[key]);
      if (
        manifest.name !== `@kite-ai/${workspace[1]}` ||
        !exported.length ||
        exported.some(
          (value) =>
            !value.startsWith('./') ||
            relative(packageRoot, resolve(packageRoot, value)).startsWith('..'),
        )
      )
        return [];
      targets = exported.map((value) => resolve(packageRoot, value));
    } catch {
      return [];
    }
  }
  return [
    ...new Set(
      targets.flatMap((target) => {
        if (relative(root, target).startsWith('..')) return [];
        const extensionless = target.replace(/\.[cm]?js$/, '');
        const found = [
          target,
          `${extensionless}.ts`,
          `${extensionless}.tsx`,
          resolve(target, 'index.ts'),
          resolve(target, 'index.tsx'),
        ].find((candidate) => existsSync(candidate) && /\.[cm]?[jt]sx?$/.test(candidate));
        if (!found) return [];
        const actual = realpathSync(found);
        return relative(root, actual).startsWith('..') ? [] : [actual];
      }),
    ),
  ];
}

/** Checks source dependencies, including local barrels; it does not certify runtime or release. */
export function checkUnifiedAgentBoundary(
  root: string,
  additionalEntrypoints: readonly string[] = [],
): UnifiedBoundaryReport {
  const violations: UnifiedBoundaryViolation[] = [];
  const pending: string[] = [];
  const checked: string[] = [];
  const imports = new Map<string, { specifier: string; line: number }[]>();
  const normalizedRoot = existsSync(root) ? realpathSync(resolve(root)) : resolve(root);
  const targets = [
    ...['ai', 'agent', 'client', 'ui'].map((owner) => ({
      owner,
      directory: `packages/${owner}/src`,
    })),
    { owner: 'cli', directory: 'apps/cli/src' },
    { owner: 'desktop', directory: 'apps/desktop/src' },
    { owner: 'web', directory: 'apps/web/src' },
    { owner: 'service-host', directory: 'apps/service/src' },
    { owner: 'cli-host', directory: 'apps/cli/host' },
    { owner: 'desktop-host', directory: 'apps/desktop/electron' },
  ];
  const sourceFiles = targets.flatMap(({ owner, directory }) => {
    const source = files(resolve(normalizedRoot, directory));
    if (source.length === 0) pending.push(`${owner}: no target source to check`);
    else checked.push(`${owner}: ${source.length} source files`);
    return source;
  });
  for (const name of [
    'scripts/release/source-terminal.ts',
    'scripts/release/entrypoints/cli.ts',
    'scripts/release/entrypoints/tui.ts',
    'scripts/release/entrypoints/terminal-cli.ts',
    'scripts/release/entrypoints/terminal-tui.ts',
    'scripts/release/entrypoints/standard-cli.ts',
    'scripts/release/entrypoints/standard-tui.ts',
    'scripts/release/entrypoints/native-cli.ts',
    'scripts/release/entrypoints/native-tui.ts',
    'scripts/release/entrypoints/registered-entry.ts',
    ...additionalEntrypoints,
    'scripts/development/ensure-web.ts',
    'scripts/development/unified-cli.ts',
    'scripts/development/unified-tui.ts',
    'scripts/development/unified-web.ts',
    'scripts/release/unified.ts',
    'scripts/release/native.ts',
  ]) {
    const file = resolve(normalizedRoot, name);
    if (existsSync(file)) sourceFiles.push(file);
    else pending.push(`${name}: no target source to check`);
  }
  const add = (file: string, line: number, rule: string, detail: string): void => {
    violations.push({
      file: relative(normalizedRoot, file).replaceAll('\\', '/'),
      line,
      rule,
      detail,
    });
  };
  const scan = (file: string): void => {
    if (imports.has(file)) return;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const refs: { specifier: string; line: number }[] = [];
    const path = relative(normalizedRoot, file).replaceAll('\\', '/');
    const core = /^packages\/agent\/src\/(?:loop(?:\/|\.)|runtime\.|session\/|execution\/)/.test(
      path,
    );
    const visit = (node: ts.Node): void => {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      let specifier: ts.Node | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        specifier = node.moduleSpecifier;
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
        specifier = node.argument.literal;
      else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      )
        specifier = node.arguments[0];
      if (specifier && !ts.isStringLiteralLike(specifier))
        refs.push({ specifier: '<computed module>', line });
      if (specifier && ts.isStringLiteralLike(specifier)) {
        refs.push({ specifier: specifier.text, line });
        const targets = localModules(normalizedRoot, file, specifier.text);
        const target = targets[0];
        const targetPath = target
          ? relative(normalizedRoot, target).replaceAll('\\', '/')
          : specifier.text;
        if (/^@kite-ai\//.test(specifier.text) && !legacy.test(specifier.text) && !target)
          add(file, line, 'target-unresolved-workspace-export', specifier.text);
        if (
          (specifier.text.startsWith('.') || isAbsolute(specifier.text)) &&
          relative(normalizedRoot, resolve(dirname(file), specifier.text)).startsWith('..')
        )
          add(file, line, 'target-outside-repository', specifier.text);
        if (
          legacy.test(specifier.text) ||
          legacy.test(targetPath) ||
          targets.some((value) =>
            legacy.test(relative(normalizedRoot, value).replaceAll('\\', '/')),
          )
        )
          add(file, line, 'target-no-legacy-engine', specifier.text);
      }
      if (
        core &&
        ((ts.isIdentifier(node) &&
          /^(?:CodingAgent|ResearchAgent|isCoding|codingMode|agentType|AgentState|PluginManager|WorkflowEngine|GraphRuntime)$/.test(
            node.text,
          )) ||
          (ts.isStringLiteralLike(node) && ['shell_execute', 'code_review'].includes(node.text)))
      ) {
        add(file, line, 'core-no-business-branch-or-whole-state', node.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    imports.set(file, refs);
  };
  for (const file of sourceFiles) scan(file);
  const closure = (
    entry: string,
    policy: 'loop' | 'ai' | 'portable' | 'host' | 'test-consumer',
  ): void => {
    const visited = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      scan(file);
      for (const ref of imports.get(file) ?? []) {
        const targets = localModules(normalizedRoot, file, ref.specifier);
        const target = targets[0];
        const targetPath = target
          ? relative(normalizedRoot, target).replaceAll('\\', '/')
          : ref.specifier;
        if (ref.specifier === '<computed module>') {
          if (policy === 'test-consumer') {
            pending.push(
              `${relative(normalizedRoot, file)}:${ref.line}: computed test fixture requires actual artifact qualification`,
            );
            continue;
          }
          add(
            file,
            ref.line,
            `${policy}-dependency`,
            `Unresolved module expression (from ${relative(normalizedRoot, entry)})`,
          );
          continue;
        }
        const invalid =
          policy === 'host' || policy === 'test-consumer'
            ? false
            : policy === 'loop'
              ? infrastructure.test(ref.specifier) ||
                /packages\/agent\/src\/(?:tools|skills|mcp|platform|storage\/(?:sqlite|worker))\//.test(
                  targetPath,
                ) ||
                /^@kite-ai\/agent\/(?:sqlite|tools)/.test(ref.specifier)
              : policy === 'ai'
                ? /^@kite-ai\/(?:agent|client|ui)(?:\/|$)/.test(ref.specifier) ||
                  /packages\/(?:agent|client|ui)\//.test(targetPath) ||
                  /(?:^|\/)session(?:\/|$)/.test(targetPath)
                : (/^@kite-ai\//.test(ref.specifier) &&
                    !/^@kite-ai\/(?:client|ui)(?:\/|$)/.test(ref.specifier)) ||
                  serverDependency.test(ref.specifier) ||
                  (nativeDependency.test(ref.specifier) &&
                    !(
                      relative(normalizedRoot, entry)
                        .replaceAll('\\', '/')
                        .startsWith('apps/cli/src/') &&
                      ['node:process', 'process'].includes(ref.specifier)
                    )) ||
                  /^(?:ai|@kite-ai\/ai)(?:\/|$)/.test(ref.specifier) ||
                  /(?:packages\/(?:agent|ai)\/|apps\/(?:service|kite-service)\/|native\/)/.test(
                    targetPath,
                  );
        if (invalid)
          add(
            file,
            ref.line,
            `${policy}-dependency`,
            `${ref.specifier} (from ${relative(normalizedRoot, entry)})`,
          );
        else queue.push(...targets);
      }
    }
  };
  for (const file of sourceFiles) {
    const path = relative(normalizedRoot, file).replaceAll('\\', '/');
    if (/^packages\/agent\/src\/loop(?:\.|\/)/.test(path)) closure(file, 'loop');
    else if (/^(?:tests\/|(?:packages|apps)\/[^/]+\/test\/)/.test(path))
      closure(file, 'test-consumer');
    else if (path.startsWith('packages/ai/')) closure(file, 'ai');
    else if (/^(?:packages\/(?:client|ui)\/|apps\/(?:cli|desktop|web)\/src\/)/.test(path))
      closure(file, 'portable');
    else closure(file, 'host');
  }
  if (
    !sourceFiles.some((file) =>
      /^packages\/agent\/src\/loop(?:\.|\/)/.test(
        relative(normalizedRoot, file).replaceAll('\\', '/'),
      ),
    )
  )
    pending.push('loop: no target source to check');
  const unique = [
    ...new Map(
      violations.map((item) => [
        `${item.file}:${item.line}:${item.rule}:${item.detail.split(' (from ')[0]}`,
        item,
      ]),
    ).values(),
  ];
  return { violations: unique, pending, checked, legacyRetirement: 'pending' };
}

if (import.meta.main) {
  const report = checkUnifiedAgentBoundary(process.argv[2] ?? process.cwd());
  for (const violation of report.violations)
    console.error(`${violation.rule}: ${violation.file}:${violation.line} ${violation.detail}`);
  for (const item of report.checked) console.log(`checked ${item}`);
  for (const item of report.pending) console.log(`pending ${item}`);
  console.log('Legacy retirement remains pending; this check does not certify final cutover.');
  process.exitCode = report.violations.length === 0 ? 0 : 1;
}

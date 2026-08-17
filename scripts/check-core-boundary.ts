import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import ts from 'typescript';

interface Violation {
  check: string;
  file: string;
  line: number;
  text: string;
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function find(
  check: string,
  root: string,
  pattern: RegExp,
  except: (file: string) => boolean = () => false,
): Violation[] {
  return sourceFiles(root).flatMap((file) => {
    if (except(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((text, index) =>
        pattern.test(text) ? [{ check, file, line: index + 1, text: text.trim() }] : [],
      );
  });
}

function parsedSource(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function importedFiles(root: string): Array<{ file: string; line: number; specifier: string }> {
  return sourceFiles(root).flatMap((file) => {
    const source = parsedSource(file);
    const imports: Array<{ file: string; line: number; specifier: string }> = [];
    const visit = (node: ts.Node): void => {
      let module: ts.Expression | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        module = node.moduleSpecifier;
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        module = node.arguments[0];
      }
      if (module && ts.isStringLiteralLike(module)) {
        imports.push({
          file,
          line: lineOf(source, node),
          specifier: module.text,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return imports;
  });
}

function resolveImport(file: string, specifier: string, sourceRoot: string): string | null {
  if (specifier.startsWith('@/')) return resolve(sourceRoot, specifier.slice(2));
  if (specifier.startsWith('.')) return resolve(dirname(file), specifier);
  return null;
}

function normalizedModulePath(path: string): string {
  return resolve(path).replace(/\.(?:[cm]?[jt]sx?)$/, '');
}

function resolveSourceModule(path: string): string | null {
  for (const candidate of [
    `${path}.ts`,
    `${path}.tsx`,
    `${path}.js`,
    `${path}.jsx`,
    join(path, 'index.ts'),
    join(path, 'index.tsx'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function importClosure(entry: string, sourceRoot: string): string[] {
  const pending = [entry];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    const normalized = normalizedModulePath(file);
    if (visited.has(normalized)) continue;
    visited.add(normalized);
    for (const specifier of runtimeImportedSpecifiers(file)) {
      const target = resolveImport(file, specifier, sourceRoot);
      if (!target) continue;
      const resolvedTarget = resolveSourceModule(target);
      if (resolvedTarget) pending.push(resolvedTarget);
    }
  }
  return [...visited].map((normalized) => resolveSourceModule(normalized) ?? normalized);
}

function runtimeImportedSpecifiers(file: string): string[] {
  const source = parsedSource(file);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.importClause
    ) {
      const clause = node.importClause;
      const named = clause.namedBindings;
      const typeOnly =
        clause.isTypeOnly ||
        (!clause.name &&
          named !== undefined &&
          ts.isNamedImports(named) &&
          named.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const typeOnly =
        node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.every((element) => element.isTypeOnly);
      if (!typeOnly) specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function isWithin(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

function forbiddenImports(
  check: string,
  root: string,
  sourceRoot: string,
  forbiddenRoots: string[],
): Violation[] {
  return importedFiles(root).flatMap(({ file, line, specifier }) => {
    const target = resolveImport(file, specifier, sourceRoot);
    if (!target) return [];
    const forbidden = forbiddenRoots.some(
      (forbiddenRoot) => target === forbiddenRoot || target.startsWith(`${forbiddenRoot}${sep}`),
    );
    return forbidden ? [{ check, file, line, text: specifier }] : [];
  });
}

function forbiddenToolSpecCalls(root: string, sourceRoot: string): Violation[] {
  const allowed = (file: string) =>
    file.endsWith(`${sep}harness${sep}tool-runner.ts`) ||
    file.endsWith(`${sep}tools${sep}registry${sep}dispatch.ts`);
  return sourceFiles(root).flatMap((file) => {
    if (allowed(file)) return [];
    const source = parsedSource(file);
    const dispatchNames = new Set(['dispatchRegisteredTool']);
    const concreteSpecNames = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const target = resolveImport(file, statement.moduleSpecifier.text, sourceRoot);
      const bindings = statement.importClause?.namedBindings;
      if (!target || !bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (
          target.endsWith(`${sep}tools${sep}registry${sep}dispatch`) &&
          imported === 'dispatchRegisteredTool'
        ) {
          dispatchNames.add(element.name.text);
        }
        if (
          target.includes(`${sep}tools${sep}registry${sep}builtins${sep}`) &&
          imported.endsWith('Spec')
        ) {
          concreteSpecNames.add(element.name.text);
        }
      }
    }

    const violations: Violation[] = [];
    const unwrap = (expression: ts.Expression): ts.Expression => {
      let current = expression;
      while (ts.isParenthesizedExpression(current)) current = current.expression;
      return current;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const expression = unwrap(node.expression);
        const directDispatch = ts.isIdentifier(expression) && dispatchNames.has(expression.text);
        const directSpecMethod =
          ts.isPropertyAccessExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          concreteSpecNames.has(expression.expression.text) &&
          ['execute', 'preExecute', 'projectResult'].includes(expression.name.text);
        if (directDispatch || directSpecMethod) {
          violations.push({
            check: 'ToolSpec dispatch must stay behind invokeGovernedTool',
            file,
            line: lineOf(source, node),
            text: node.getText(source),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return violations;
  });
}

function forbiddenModelDispatchImports(roots: string[], sourceRoot: string): Violation[] {
  const responseSource = resolve(sourceRoot, 'core/model/response-source');
  const transport = resolve(sourceRoot, 'core/model/transport');
  const legacyInvoke = resolve(sourceRoot, 'core/model/invoke');
  return roots.flatMap((root) =>
    importedFiles(root).flatMap(({ file, line, specifier }) => {
      const target = resolveImport(file, specifier, sourceRoot);
      if (!target) return [];
      if (target === transport && resolve(file).replace(/\.ts$/, '') !== responseSource) {
        return [
          {
            check: 'model transport must stay behind the Gateway-owned live ModelResponseSource',
            file,
            line,
            text: specifier,
          },
        ];
      }
      if (target === legacyInvoke) {
        return [
          {
            check: 'legacy model invocation bypass is forbidden',
            file,
            line,
            text: specifier,
          },
        ];
      }
      return [];
    }),
  );
}

function forbiddenToolProviderImports(roots: string[], sourceRoot: string): Violation[] {
  const dispatchAdapter = resolve(sourceRoot, 'core/execution/tool-pipeline/dispatch');
  const concreteProviderModules = [
    resolve(sourceRoot, 'core/harness/tool-runner'),
    resolve(sourceRoot, 'core/subagent/runner'),
    resolve(sourceRoot, 'core/subagent/task-tool'),
    resolve(sourceRoot, 'core/tools/registry/dispatch'),
  ];
  return roots.flatMap((root) =>
    importedFiles(root).flatMap(({ file, line, specifier }) => {
      if (resolve(file).replace(/\.(?:ts|tsx)$/, '') === dispatchAdapter) return [];
      const target = resolveImport(file, specifier, sourceRoot);
      const normalizedTarget = target?.replace(/\.(?:ts|tsx)$/, '');
      if (!normalizedTarget || !concreteProviderModules.includes(normalizedTarget)) return [];
      return [
        {
          check: 'concrete Tool Provider imports must stay behind Tool Pipeline dispatch adapter',
          file,
          line,
          text: specifier,
        },
      ];
    }),
  );
}

function forbiddenLocalFilesystemProviderDependencies(sourceRoot: string): Violation[] {
  const localProvider = normalizedModulePath(
    resolve(sourceRoot, 'core/execution/workspace-filesystem/local-provider'),
  );
  const localProviderBackendModules = new Set([
    localProvider,
    normalizedModulePath(
      resolve(sourceRoot, 'core/execution/workspace-filesystem/descriptor-relative'),
    ),
  ]);
  const forbiddenDirectories = [resolve(sourceRoot, 'core/policies'), resolve(sourceRoot, 'app')];
  const forbiddenModules = new Set(
    ['events', 'state', 'reducer', 'kernel', 'store'].map((module) =>
      normalizedModulePath(resolve(sourceRoot, `core/runtime/${module}`)),
    ),
  );

  return importedFiles(dirname(localProvider)).flatMap(({ file, line, specifier }) => {
    if (!localProviderBackendModules.has(normalizedModulePath(file))) return [];
    const target = resolveImport(file, specifier, sourceRoot);
    if (!target) return [];
    const forbidden =
      forbiddenDirectories.some((directory) => isWithin(target, directory)) ||
      forbiddenModules.has(normalizedModulePath(target));
    return forbidden
      ? [
          {
            check:
              'LocalFilesystemProvider must not own policy, approval, Runtime state, or App authority',
            file,
            line,
            text: specifier,
          },
        ]
      : [];
  });
}

function forbiddenSandboxProviderAuthority(sourceRoot: string): Violation[] {
  const providerRoot = resolve(sourceRoot, 'core/execution/sandbox-execution');
  const localProvider = normalizedModulePath(resolve(providerRoot, 'local-provider'));
  const forbiddenRoots = [
    resolve(sourceRoot, 'core/policies'),
    resolve(sourceRoot, 'core/runtime'),
    resolve(sourceRoot, 'app'),
  ];
  const importViolations = importedFiles(providerRoot).flatMap(({ file, line, specifier }) => {
    if (normalizedModulePath(file) !== localProvider) return [];
    const target = resolveImport(file, specifier, sourceRoot);
    if (!target || !forbiddenRoots.some((root) => isWithin(target, root))) return [];
    return [
      {
        check:
          'LocalSandboxExecutionProvider must not own policy, Runtime, App, or process authority',
        file,
        line,
        text: specifier,
      },
    ];
  });
  const localProviderFile = resolveSourceModule(resolve(providerRoot, 'local-provider'));
  const providerClosure = localProviderFile
    ? importClosure(localProviderFile, sourceRoot)
    : [resolve(providerRoot, 'local-provider.ts')];
  const closureViolations = providerClosure.flatMap((file) => {
    if (!existsSync(file)) return [];
    const source = readFileSync(file, 'utf8');
    const forbidden =
      /\b(?:Bun\.)?spawn(?:Sync)?\s*\(|from\s+['"]node:child_process['"]|require\(['"]node:child_process['"]\)/;
    const line = source.split('\n').findIndex((text) => forbidden.test(text));
    return line >= 0
      ? [
          {
            check: 'SandboxExecutionProvider dependency closure must not spawn processes',
            file,
            line: line + 1,
            text: source.split('\n')[line]!.trim(),
          },
        ]
      : [];
  });
  return [...importViolations, ...closureViolations];
}

function forbiddenSandboxProductionBypass(sourceRoot: string): Violation[] {
  const localProvider = normalizedModulePath(
    resolve(sourceRoot, 'core/execution/sandbox-execution/local-provider'),
  );
  const composition = normalizedModulePath(
    resolve(sourceRoot, 'core/execution/sandbox-execution/composition'),
  );
  const directLocalImports = importedFiles(sourceRoot).flatMap(({ file, line, specifier }) => {
    const target = resolveImport(file, specifier, sourceRoot);
    if (
      !target ||
      normalizedModulePath(target) !== localProvider ||
      normalizedModulePath(file) === composition
    ) {
      return [];
    }
    return [
      {
        check: 'Local Sandbox Provider production composition has one owner',
        file,
        line,
        text: specifier,
      },
    ];
  });
  return [
    ...directLocalImports,
    ...find(
      'legacy createSandboxExecutor production entry must not exist',
      sourceRoot,
      /\bcreateSandboxExecutor\b/,
    ),
    ...find(
      'production Shell authority must not import or call bare shellTool',
      sourceRoot,
      /\bshellTool\b/,
      (file) => file.endsWith(`${sep}core${sep}tools${sep}shell.ts`),
    ),
  ];
}

function forbiddenConcreteWorkspaceFilesystemImports(sourceRoot: string): Violation[] {
  const providerRoot = normalizedModulePath(
    resolve(sourceRoot, 'core/execution/workspace-filesystem'),
  );
  const allowed = new Set(
    [
      'core/model/invocation-composition',
      'core/execution/tool-pipeline/workspace-filesystem',
      'core/execution/workspace-filesystem/index',
      'core/execution/workspace-filesystem/local-provider',
      'core/execution/workspace-filesystem/grant-authority',
    ].map((path) => normalizedModulePath(resolve(sourceRoot, path))),
  );
  return importedFiles(sourceRoot).flatMap(({ file, line, specifier }) => {
    if (allowed.has(normalizedModulePath(file))) return [];
    const target = resolveImport(file, specifier, sourceRoot);
    if (!target || !isWithin(normalizedModulePath(target), providerRoot)) return [];
    return [
      {
        check:
          'concrete WorkspaceFilesystemProvider imports must stay inside composition and Tool Pipeline',
        file,
        line,
        text: specifier,
      },
    ];
  });
}

function forbiddenFilesystemObservationAuthorityImports(sourceRoot: string): Violation[] {
  const authorityModule = normalizedModulePath(
    resolve(sourceRoot, 'core/execution/tool-pipeline/filesystem-observation-authority'),
  );
  const allowed = new Set(
    ['workspace-filesystem', 'dispatch', 'receipt'].map((module) =>
      normalizedModulePath(resolve(sourceRoot, `core/execution/tool-pipeline/${module}`)),
    ),
  );
  return importedFiles(sourceRoot).flatMap(({ file, line, specifier }) => {
    const target = resolveImport(file, specifier, sourceRoot);
    if (
      !target ||
      normalizedModulePath(target) !== authorityModule ||
      allowed.has(normalizedModulePath(file))
    ) {
      return [];
    }
    return [
      {
        check:
          'filesystem observation authority must stay inside its Workspace Pipeline issuer and receipt verifier',
        file,
        line,
        text: specifier,
      },
    ];
  });
}

function forbiddenToolDispatchAuthorityImports(sourceRoot: string): Violation[] {
  const authorityModule = normalizedModulePath(
    resolve(sourceRoot, 'core/execution/tool-pipeline/dispatch-authority'),
  );
  const allowed = new Set(
    ['dispatch', 'receipt'].map((module) =>
      normalizedModulePath(resolve(sourceRoot, `core/execution/tool-pipeline/${module}`)),
    ),
  );
  return importedFiles(sourceRoot).flatMap(({ file, line, specifier }) => {
    const target = resolveImport(file, specifier, sourceRoot);
    if (
      !target ||
      normalizedModulePath(target) !== authorityModule ||
      allowed.has(normalizedModulePath(file))
    ) {
      return [];
    }
    return [
      {
        check: 'Tool dispatch stage authority must stay inside its issuer and receipt verifier',
        file,
        line,
        text: specifier,
      },
    ];
  });
}

function forbiddenLegacyFilesystemExecutionImports(
  sourceRoot: string,
  coreRoot: string,
): Violation[] {
  const legacyModules = new Set(
    ['file', 'search'].map((module) =>
      normalizedModulePath(resolve(sourceRoot, `core/tools/${module}`)),
    ),
  );
  const consumerRoots = [
    resolve(coreRoot, 'controllers'),
    resolve(coreRoot, 'harness'),
    resolve(coreRoot, 'execution/tool-pipeline'),
    resolve(coreRoot, 'execution/workspace-filesystem'),
    resolve(coreRoot, 'tools/registry'),
  ];

  return importedFiles(coreRoot).flatMap(({ file, line, specifier }) => {
    if (!consumerRoots.some((consumerRoot) => isWithin(file, consumerRoot))) return [];
    const target = resolveImport(file, specifier, sourceRoot);
    if (!target || !legacyModules.has(normalizedModulePath(target))) return [];
    return [
      {
        check:
          'workspace filesystem consumers must not import legacy concrete file or search tools',
        file,
        line,
        text: specifier,
      },
    ];
  });
}

function forbiddenCapabilityFilesystemNodeImports(
  sourceRoot: string,
  coreRoot: string,
): Violation[] {
  const localProviderBackendModules = new Set(
    ['local-provider', 'descriptor-relative'].map((module) =>
      normalizedModulePath(resolve(sourceRoot, `core/execution/workspace-filesystem/${module}`)),
    ),
  );
  const legacyModules = new Set(
    ['file', 'search'].map((module) =>
      normalizedModulePath(resolve(sourceRoot, `core/tools/${module}`)),
    ),
  );
  const consumerRoots = [
    resolve(coreRoot, 'controllers'),
    resolve(coreRoot, 'harness'),
    resolve(coreRoot, 'execution/tool-pipeline'),
    resolve(coreRoot, 'execution/workspace-filesystem'),
    resolve(coreRoot, 'tools/registry'),
  ];

  return importedFiles(coreRoot).flatMap(({ file, line, specifier }) => {
    const normalizedFile = normalizedModulePath(file);
    if (localProviderBackendModules.has(normalizedFile)) return [];
    const isCapabilityFilesystemExecution =
      legacyModules.has(normalizedFile) ||
      consumerRoots.some((consumerRoot) => isWithin(file, consumerRoot));
    if (!isCapabilityFilesystemExecution || !/^node:fs(?:\/promises)?$/.test(specifier)) {
      return [];
    }
    return [
      {
        check: 'capability filesystem Node fs access must stay inside LocalFilesystemProvider',
        file,
        line,
        text: specifier,
      },
    ];
  });
}

function forbiddenProductionTestHelperImports(
  projectRoot: string,
  sourceRoot: string,
): Violation[] {
  const testHelpersRoot = resolve(projectRoot, 'tests/helpers');
  return importedFiles(sourceRoot).flatMap(({ file, line, specifier }) => {
    const target = resolveImport(file, specifier, sourceRoot);
    if (!target || !isWithin(target, testHelpersRoot)) return [];
    return [
      {
        check: 'production source must not import test helper providers',
        file,
        line,
        text: specifier,
      },
    ];
  });
}

function forbiddenProviderSdkCalls(roots: string[]): Violation[] {
  const providerSdkDispatchNames = new Set([
    'generateObject',
    'generateText',
    'streamObject',
    'streamText',
  ]);
  return roots.flatMap((root) =>
    sourceFiles(root).flatMap((file) => {
      if (file.endsWith(`${sep}core${sep}model${sep}transport.ts`)) return [];
      const source = parsedSource(file);
      const violations: Violation[] = [];
      const namespaceBindings = new Set<string>();
      for (const statement of source.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          statement.moduleSpecifier.text !== 'ai'
        ) {
          continue;
        }
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          namespaceBindings.add(bindings.name.text);
          continue;
        }
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        for (const element of bindings.elements) {
          if (!providerSdkDispatchNames.has(element.propertyName?.text ?? element.name.text)) {
            continue;
          }
          violations.push({
            check: 'Provider SDK dispatch must stay behind ModelInvocationGateway transport',
            file,
            line: lineOf(source, element),
            text: element.getText(source),
          });
        }
      }
      const visit = (node: ts.Node): void => {
        if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
          ts.forEachChild(node, visit);
          return;
        }
        const directSdkDispatch =
          ts.isIdentifier(node.expression.expression) &&
          namespaceBindings.has(node.expression.expression.text) &&
          providerSdkDispatchNames.has(node.expression.name.text);
        const lowLevelModelDispatch = ['doGenerate', 'doStream'].includes(
          node.expression.name.text,
        );
        if (directSdkDispatch || lowLevelModelDispatch) {
          violations.push({
            check: 'Provider SDK dispatch must stay behind ModelInvocationGateway transport',
            file,
            line: lineOf(source, node),
            text: node.getText(source),
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return violations;
    }),
  );
}

const root = process.cwd();
const sourceRoot = join(root, 'src');
const coreRoot = join(sourceRoot, 'core');
const appRoot = join(sourceRoot, 'app');
const protocolRoot = join(sourceRoot, 'protocol');
const controllersRoot = join(coreRoot, 'controllers');
const toolPipelineRoot = join(coreRoot, 'execution', 'tool-pipeline');
const scriptsRoot = join(root, 'scripts');
const violations = [
  ...forbiddenImports('core must not import app', coreRoot, sourceRoot, [appRoot]),
  ...forbiddenImports('protocol must not import core or app', protocolRoot, sourceRoot, [
    coreRoot,
    appRoot,
  ]),
  ...forbiddenModelDispatchImports([sourceRoot, scriptsRoot], sourceRoot),
  ...forbiddenProviderSdkCalls([sourceRoot, scriptsRoot]),
  ...forbiddenToolProviderImports([controllersRoot, toolPipelineRoot], sourceRoot),
  ...forbiddenLocalFilesystemProviderDependencies(sourceRoot),
  ...forbiddenSandboxProviderAuthority(sourceRoot),
  ...forbiddenSandboxProductionBypass(sourceRoot),
  ...find(
    'legacy Windows sandbox executor entry must not exist after Provider cutover',
    sourceRoot,
    /\bcreateWindowsRestrictedTokenExecutor\b/,
  ),
  ...find(
    'Windows sandbox process adapters are Runtime-consumer-only',
    sourceRoot,
    /\b(?:executeWindowsRestrictedTokenPreparedV1|reconcileWindowsRestrictedTokenPreparedV1)\b/,
    (file) =>
      file.endsWith(`${sep}sandbox-execution${sep}windows-runtime.ts`) ||
      file.endsWith(`${sep}sandbox-execution${sep}consumer.ts`) ||
      file.endsWith(`${sep}sandbox-execution${sep}recovery.ts`),
  ),
  ...find(
    'Shell ToolSpec must fail closed without the Pipeline sandbox consumer',
    resolve(sourceRoot, 'core/tools/registry/builtins'),
    /\bshellTool\b/,
    (file) => !file.endsWith(`${sep}builtins${sep}shell-execute.ts`),
  ),
  ...forbiddenConcreteWorkspaceFilesystemImports(sourceRoot),
  ...forbiddenFilesystemObservationAuthorityImports(sourceRoot),
  ...forbiddenToolDispatchAuthorityImports(sourceRoot),
  ...find(
    'Tool dispatch stage authority issuers must only be called by the dispatch adapter',
    sourceRoot,
    /\b(?:issueAcknowledgedRecordedInvocationV1|issueAdapterDispatchedOutcomeV1|issueConfirmedFailureDispatchedOutcomeV1)\b/,
    (file) =>
      normalizedModulePath(file) ===
        normalizedModulePath(
          resolve(sourceRoot, 'core/execution/tool-pipeline/dispatch-authority'),
        ) ||
      normalizedModulePath(file) ===
        normalizedModulePath(resolve(sourceRoot, 'core/execution/tool-pipeline/dispatch')),
  ),
  ...find(
    'filesystem observation authority issuer must only be called by the Workspace Pipeline dispatcher',
    sourceRoot,
    /\bissueWorkspaceFilesystemObservationAuthorityV1\b/,
    (file) =>
      normalizedModulePath(file) ===
        normalizedModulePath(
          resolve(sourceRoot, 'core/execution/tool-pipeline/filesystem-observation-authority'),
        ) ||
      normalizedModulePath(file) ===
        normalizedModulePath(
          resolve(sourceRoot, 'core/execution/tool-pipeline/workspace-filesystem'),
        ),
  ),
  ...forbiddenLegacyFilesystemExecutionImports(sourceRoot, coreRoot),
  ...forbiddenCapabilityFilesystemNodeImports(sourceRoot, coreRoot),
  ...forbiddenProductionTestHelperImports(root, sourceRoot),
  ...forbiddenToolSpecCalls(coreRoot, sourceRoot),
  ...find(
    'planning state is reducer-owned',
    join(root, 'src/core'),
    /state\.planning\s*=/,
    (file) =>
      file.endsWith(`${sep}runtime${sep}reducer.ts`) ||
      file.endsWith(`${sep}runtime${sep}state.ts`),
  ),
];

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`${violation.check}: ${violation.file}:${violation.line} ${violation.text}`);
  }
  process.exitCode = 1;
} else {
  console.log('Core boundary checks passed.');
}

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export const RUNTIME_WORKSPACE_PACKAGES = Object.freeze([
  ['@kite-ai/agent-api-contract', 'packages/agent-api-contract'],
  ['@kite-ai/agent-api-client', 'packages/agent-api-client'],
  ['@kite-ai/runtime-contract', 'packages/runtime-contract'],
  ['@kite-ai/runtime-protocol', 'packages/runtime-protocol'],
  ['@kite-ai/runtime-server', 'packages/runtime-server'],
  ['@kite-ai/runtime-client', 'packages/runtime-client'],
  ['@kite-ai/kite-app-contract', 'packages/kite-app-contract'],
  ['@kite-ai/kite-local-runtime', 'packages/kite-local-runtime'],
  ['@kite-ai/agent-kernel', 'packages/agent-kernel'],
  ['@kite-ai/runtime-spi', 'packages/runtime-spi'],
  ['@kite-ai/runtime-host', 'packages/runtime-host'],
  ['@kite-ai/runtime-storage-sqlite', 'packages/runtime-storage-sqlite'],
  ['@kite-ai/builtin-runtime', 'packages/builtin-runtime'],
  ['@kite-ai/kite-cli', 'apps/kite-cli'],
  ['@kite-ai/kite-service', 'apps/kite-service'],
  ['@kite-ai/kite-web', 'apps/kite-web'],
] as const);

const EXPECTED_WORKSPACES = ['packages/*', 'apps/*'] as const;

const ALLOWED_DIRECT_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '@kite-ai/agent-api-contract': [],
  '@kite-ai/agent-api-client': ['@kite-ai/agent-api-contract'],
  '@kite-ai/runtime-contract': [],
  '@kite-ai/runtime-protocol': ['@kite-ai/runtime-contract'],
  '@kite-ai/runtime-server': ['@kite-ai/runtime-contract', '@kite-ai/runtime-protocol'],
  '@kite-ai/runtime-client': ['@kite-ai/runtime-contract', '@kite-ai/runtime-protocol'],
  '@kite-ai/kite-app-contract': ['@kite-ai/runtime-contract'],
  '@kite-ai/kite-local-runtime': [
    '@kite-ai/kite-app-contract',
    '@kite-ai/runtime-client',
    '@kite-ai/runtime-protocol',
  ],
  '@kite-ai/agent-kernel': [],
  '@kite-ai/runtime-spi': ['@kite-ai/runtime-contract'],
  '@kite-ai/runtime-host': [
    '@kite-ai/agent-kernel',
    '@kite-ai/runtime-contract',
    '@kite-ai/runtime-spi',
  ],
  '@kite-ai/runtime-storage-sqlite': ['@kite-ai/runtime-host'],
  '@kite-ai/builtin-runtime': ['@kite-ai/runtime-contract', '@kite-ai/runtime-spi'],
  '@kite-ai/kite-cli': [
    '@kite-ai/kite-app-contract',
    '@kite-ai/kite-local-runtime',
    '@kite-ai/runtime-client',
    '@kite-ai/runtime-contract',
  ],
  '@kite-ai/kite-service': [
    '@kite-ai/agent-api-contract',
    '@kite-ai/builtin-runtime',
    '@kite-ai/kite-app-contract',
    '@kite-ai/kite-local-runtime',
    '@kite-ai/runtime-client',
    '@kite-ai/runtime-contract',
    '@kite-ai/runtime-host',
    '@kite-ai/runtime-protocol',
    '@kite-ai/runtime-server',
    '@kite-ai/runtime-spi',
    '@kite-ai/runtime-storage-sqlite',
  ],
  // The Browser is a private presentation application. It consumes only the
  // typed HTTP client and public DTO contract; UI/tooling remains app-local.
  '@kite-ai/kite-web': ['@kite-ai/agent-api-client', '@kite-ai/agent-api-contract'],
});

const NON_EXPORTING_PRIVATE_APPS: ReadonlySet<string> = new Set(['@kite-ai/kite-web']);

const FORBIDDEN_PUBLIC_NAMES: Readonly<Record<string, readonly RegExp[]>> = Object.freeze({
  '@kite-ai/agent-api-contract': [
    /RuntimeHost/,
    /RuntimeServer/,
    /Sqlite/,
    /WorkspacePath/,
    /ControllerGeneration/,
    /BindingReference/,
  ],
  '@kite-ai/agent-api-client': [
    /RuntimeHost/,
    /RuntimeServer/,
    /Sqlite/,
    /WorkspacePath/,
    /ControllerGeneration/,
    /BindingReference/,
  ],
  '@kite-ai/runtime-contract': [
    /AgentState/,
    /KernelEvent/,
    /RuntimeEvent/,
    /RuntimeStore/,
    /Executor/,
    /EffectIntent/,
    /ExecutionGrant/,
  ],
  '@kite-ai/agent-kernel': [/RuntimeHost/, /RuntimeStore/, /Provider/, /Executor/, /Sqlite/i],
  '@kite-ai/runtime-spi': [/RuntimeHost/, /RuntimeStore/, /Sqlite/, /BuiltinRuntimeImplementation/],
  '@kite-ai/runtime-host': [/Sqlite/, /BuiltinRuntime/],
  '@kite-ai/runtime-protocol': [/RuntimeHost/, /Sqlite/, /BuiltinRuntime/],
  '@kite-ai/runtime-server': [/Sqlite/, /BuiltinRuntime/],
  '@kite-ai/runtime-client': [/RuntimeHost/, /Sqlite/, /BuiltinRuntime/],
  '@kite-ai/kite-app-contract': [
    /RuntimeHost/,
    /RuntimeServer/,
    /Sqlite/,
    /Credential/,
    /ServiceDescriptor/,
    /Process/,
  ],
  '@kite-ai/kite-local-runtime': [/RuntimeHost/, /RuntimeServer/, /Sqlite/, /BuiltinRuntime/],
  '@kite-ai/builtin-runtime': [/RuntimeHost/, /RuntimeStore/, /AgentState/, /KernelEvent/],
});

export interface RuntimePackageViolation {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface RuntimePackageFact {
  readonly name: string;
  readonly path: string;
  readonly exports: readonly string[];
  readonly dependencies: readonly string[];
  readonly sourceFiles: readonly string[];
  readonly testFiles: readonly string[];
}

export interface RuntimePackageAnalysis {
  readonly packages: readonly RuntimePackageFact[];
  readonly packageEdges: readonly { from: string; to: string }[];
  readonly compositionRoots: readonly string[];
  readonly violations: readonly RuntimePackageViolation[];
}

interface PackageJson {
  name?: string;
  private?: boolean;
  type?: string;
  module?: string;
  exports?: string | Record<string, string | Record<string, string>>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: string[];
}

interface PackageRecord {
  name: string;
  relativePath: string;
  absolutePath: string;
  manifest: PackageJson;
  exportTargets: Map<string, string>;
  sourceFiles: string[];
  testFiles: string[];
}

interface ImportEdge {
  owner: PackageRecord;
  source: string;
  specifier: string;
  kind: 'import' | 'type-import' | 're-export' | 'dynamic-import' | 'require';
  /** Original exported names imported as runtime values; `*` is fail-closed. */
  valueBindings: readonly string[];
  targetPackage?: PackageRecord;
  targetFile?: string;
}

export function analyzeRuntimePackages(repositoryRoot: string): RuntimePackageAnalysis {
  const root = realpathSync(resolve(repositoryRoot));
  const violations: RuntimePackageViolation[] = [];
  const rootManifest = readJson<PackageJson>(join(root, 'package.json'));
  if (JSON.stringify(rootManifest.workspaces ?? []) !== JSON.stringify(EXPECTED_WORKSPACES)) {
    addViolation(
      violations,
      'WORKSPACE_PATTERN_MISMATCH',
      `root workspaces must be exactly ${EXPECTED_WORKSPACES.join(', ')}`,
      'package.json',
    );
  }
  validateRootScripts(root, rootManifest, violations);
  validateRootPackageEntry(root, rootManifest, violations);

  const packages = loadPackages(root, violations);
  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  const imports = packages.flatMap((entry) =>
    entry.sourceFiles.flatMap((source) => collectImports(entry, source)),
  );

  validateImports(root, imports, byName, violations);
  validateAmbientAuthority(root, packages, violations);
  validatePublicExports(packages, violations);
  validateConsumers(packages, imports, violations);
  validateClientBoundary(root, packages, imports, violations);

  const packageEdges = uniqueEdges(
    imports
      .filter((edge): edge is ImportEdge & { targetPackage: PackageRecord } =>
        Boolean(edge.targetPackage),
      )
      .map((edge) => ({ from: edge.owner.name, to: edge.targetPackage.name })),
  );
  validateCycles(packageEdges, violations);
  validateTransitiveForbiddenEdges(packageEdges, violations);
  const compositionRoots = validateCompositionRoot(root, packages, imports, violations);

  return {
    packages: packages.map((entry) => ({
      name: entry.name,
      path: entry.relativePath,
      exports: [...entry.exportTargets.keys()].sort(),
      dependencies: Object.keys(entry.manifest.dependencies ?? {})
        .filter((name) => name.startsWith('@kite-ai/'))
        .sort(),
      sourceFiles: entry.sourceFiles.map((file) => normalizedRelative(root, file)),
      testFiles: entry.testFiles.map((file) => normalizedRelative(root, file)),
    })),
    packageEdges,
    compositionRoots,
    violations: sortViolations(violations),
  };
}

function loadPackages(root: string, violations: RuntimePackageViolation[]): PackageRecord[] {
  const packages: PackageRecord[] = [];
  for (const [expectedName, relativePath] of RUNTIME_WORKSPACE_PACKAGES) {
    const absolutePath = join(root, relativePath);
    const packageJsonPath = join(absolutePath, 'package.json');
    if (!isRegularFile(packageJsonPath)) {
      addViolation(violations, 'PACKAGE_FILE_MISSING', 'missing package.json', relativePath);
      continue;
    }
    const manifest = readJson<PackageJson>(packageJsonPath);
    if (manifest.name !== expectedName) {
      addViolation(
        violations,
        'PACKAGE_NAME_MISMATCH',
        `expected ${expectedName}, received ${manifest.name ?? '<missing>'}`,
        `${relativePath}/package.json`,
      );
    }
    if (manifest.private !== true) {
      addViolation(
        violations,
        'PACKAGE_NOT_PRIVATE',
        `${expectedName} must be private`,
        relativePath,
      );
    }
    if (manifest.type !== 'module') {
      addViolation(
        violations,
        'PACKAGE_NOT_ESM',
        `${expectedName} must use type=module`,
        relativePath,
      );
    }
    for (const required of ['README.md', 'tsconfig.json'] as const) {
      if (!isRegularFile(join(absolutePath, required))) {
        addViolation(violations, 'PACKAGE_FILE_MISSING', `missing ${required}`, relativePath);
      }
    }
    for (const script of ['build', 'typecheck', 'test'] as const) {
      if (!manifest.scripts?.[script]) {
        addViolation(
          violations,
          'PACKAGE_SCRIPT_MISSING',
          `${expectedName} is missing ${script}`,
          `${relativePath}/package.json`,
        );
      }
    }

    const sourceFiles = collectFiles(join(absolutePath, 'src'), /\.[cm]?[jt]sx?$/);
    const testFiles = collectFiles(join(absolutePath, 'test'), /\.(test|spec)\.[cm]?[jt]sx?$/);
    if (sourceFiles.length === 0) {
      addViolation(
        violations,
        'PACKAGE_SOURCE_MISSING',
        `${expectedName} has no source`,
        relativePath,
      );
    }
    if (testFiles.length === 0) {
      addViolation(
        violations,
        'PACKAGE_TEST_MISSING',
        `${expectedName} has no consumer test`,
        relativePath,
      );
    }

    const exportTargets = parseExportTargets(manifest.exports, relativePath, violations);
    if (exportTargets.size === 0 && !NON_EXPORTING_PRIVATE_APPS.has(expectedName)) {
      addViolation(
        violations,
        'PUBLIC_EXPORT_MISSING',
        `${expectedName} has no exports`,
        relativePath,
      );
    }

    const declaredInternal = Object.keys(manifest.dependencies ?? {})
      .filter((name) => name.startsWith('@kite-ai/'))
      .sort();
    for (const dependency of Object.keys(manifest.dependencies ?? {}).filter(
      (name) => !name.startsWith('@kite-ai/'),
    )) {
      validateExternalDependency(expectedName, dependency, relativePath, violations);
    }
    const allowed = [...(ALLOWED_DIRECT_DEPENDENCIES[expectedName] ?? [])].sort();
    for (const dependency of declaredInternal) {
      if (!allowed.includes(dependency)) {
        addViolation(
          violations,
          'FORBIDDEN_DIRECT_DEPENDENCY',
          `${expectedName} may not declare ${dependency}`,
          `${relativePath}/package.json`,
        );
      }
      if (manifest.dependencies?.[dependency] !== 'workspace:*') {
        addViolation(
          violations,
          'INTERNAL_DEPENDENCY_RANGE_INVALID',
          `${expectedName} must declare ${dependency} as workspace:*`,
          `${relativePath}/package.json`,
        );
      }
    }
    for (const dependency of allowed) {
      if (!declaredInternal.includes(dependency)) {
        addViolation(
          violations,
          'INTERNAL_DEPENDENCY_MISSING',
          `${expectedName} must declare ${dependency}`,
          `${relativePath}/package.json`,
        );
      }
    }

    packages.push({
      name: expectedName,
      relativePath,
      absolutePath,
      manifest,
      exportTargets,
      sourceFiles,
      testFiles,
    });
  }
  return packages;
}

function validateRootScripts(
  root: string,
  manifest: PackageJson,
  violations: RuntimePackageViolation[],
): void {
  const required: Readonly<Record<string, readonly string[]>> = {
    build: ['scripts/run-runtime-workspace-script.ts build'],
    typecheck: ['tsc --noEmit', 'scripts/run-runtime-workspace-script.ts typecheck'],
    test: ['scripts/run-default-tests.ts'],
    'check:runtime-packages': ['scripts/check-runtime-packages.ts'],
  };
  for (const [script, fragments] of Object.entries(required)) {
    const command = manifest.scripts?.[script] ?? '';
    for (const fragment of fragments) {
      if (!command.includes(fragment)) {
        addViolation(
          violations,
          'ROOT_WORKSPACE_SCRIPT_INCOMPLETE',
          `root ${script} must include ${fragment}`,
          'package.json',
        );
      }
    }
  }

  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (typeof command !== 'string') continue;
    for (const source of scriptSourcePaths(command)) {
      if (isRegularFile(join(root, source))) continue;
      addViolation(
        violations,
        'ROOT_SCRIPT_SOURCE_MISSING',
        `root ${name} executes missing source ${source}`,
        'package.json',
      );
    }
  }
}

function scriptSourcePaths(command: string): string[] {
  const sources = new Set<string>();
  const pattern = /(?:^|\s)(?:bun(?:\s+--watch)?\s+run|bun\s+test)\s+([^\s]+)/gu;
  for (const match of command.matchAll(pattern)) {
    const candidate = match[1]?.replace(/^['"]|['"]$/gu, '');
    if (candidate && /\.(?:ts|tsx|js|jsx)$/u.test(candidate)) sources.add(candidate);
  }
  return [...sources];
}

function validateRootPackageEntry(
  root: string,
  manifest: PackageJson,
  violations: RuntimePackageViolation[],
): void {
  if (manifest.module !== 'apps/kite-cli/src/index.ts') {
    addViolation(
      violations,
      'ROOT_PACKAGE_MODULE_INVALID',
      'root module must be exactly apps/kite-cli/src/index.ts',
      'package.json',
    );
  }

  const rootShim = join(root, 'src/index.ts');
  if (isRegularFile(rootShim)) {
    addViolation(
      violations,
      'ROOT_RUNTIME_SHIM_PRESENT',
      'the transitional src/index.ts Runtime shim must be absent',
      'src/index.ts',
    );
  }

  const appEntryPath = join(root, 'apps/kite-cli/src/index.ts');
  if (!isRegularFile(appEntryPath)) {
    addViolation(
      violations,
      'APP_PUBLIC_ENTRY_INVALID',
      'the App public entry apps/kite-cli/src/index.ts must exist',
      'apps/kite-cli/src/index.ts',
    );
    return;
  }

  const source = ts.createSourceFile(
    appEntryPath,
    readFileSync(appEntryPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const expected = new Map([
    ['runCli', './cli/executable'],
    ['runTui', './tui/executable'],
  ]);
  const actual = new Map<string, string>();
  let invalid = source.statements.length !== expected.size;
  for (const statement of source.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause) ||
      statement.exportClause.elements.length !== 1
    ) {
      invalid = true;
      continue;
    }
    const element = statement.exportClause.elements[0];
    if (!element || element.isTypeOnly || element.propertyName) {
      invalid = true;
      continue;
    }
    actual.set(element.name.text, statement.moduleSpecifier.text);
  }
  if (
    invalid ||
    actual.size !== expected.size ||
    [...expected].some(([name, specifier]) => actual.get(name) !== specifier)
  ) {
    addViolation(
      violations,
      'APP_PUBLIC_ENTRY_INVALID',
      'CLI public entry may only export runCli and runTui from their exact terminal modules',
      'apps/kite-cli/src/index.ts',
    );
  }
}

function collectImports(owner: PackageRecord, sourcePath: string): ImportEdge[] {
  const text = readFileSync(sourcePath, 'utf8');
  const source = ts.createSourceFile(
    sourcePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const edges: ImportEdge[] = [];
  const add = (
    specifier: ts.Expression | undefined,
    kind: ImportEdge['kind'],
    valueBindings: readonly string[],
  ): void => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return;
    edges.push({ owner, source: sourcePath, specifier: specifier.text, kind, valueBindings });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const typeOnly = clause?.isTypeOnly === true;
      const bindings: string[] = [];
      if (!clause) bindings.push('*');
      if (!typeOnly && clause?.name) bindings.push('default');
      if (!typeOnly && clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) bindings.push('*');
        else {
          for (const element of clause.namedBindings.elements) {
            if (!element.isTypeOnly) bindings.push(element.propertyName?.text ?? element.name.text);
          }
        }
      }
      add(node.moduleSpecifier, typeOnly ? 'type-import' : 'import', bindings);
    } else if (ts.isExportDeclaration(node)) {
      const bindings = node.isTypeOnly
        ? []
        : node.exportClause
          ? ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements
                .filter((element) => !element.isTypeOnly)
                .map((element) => element.propertyName?.text ?? element.name.text)
            : ['*']
          : ['*'];
      add(node.moduleSpecifier, node.isTypeOnly ? 'type-import' : 're-export', bindings);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        add(node.arguments[0], 'dynamic-import', ['*']);
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        add(node.arguments[0], 'require', ['*']);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}

function validateImports(
  root: string,
  imports: ImportEdge[],
  byName: ReadonlyMap<string, PackageRecord>,
  violations: RuntimePackageViolation[],
): void {
  for (const edge of imports) {
    const sourcePath = normalizedRelative(root, edge.source);
    if (edge.specifier.startsWith('.')) {
      const target = resolveSourceFile(dirname(edge.source), edge.specifier);
      if (!target) {
        addViolation(
          violations,
          'IMPORT_TARGET_MISSING',
          `cannot resolve ${edge.specifier}`,
          sourcePath,
        );
        continue;
      }
      edge.targetFile = target;
      if (!isInside(edge.owner.absolutePath, target)) {
        addViolation(
          violations,
          'CROSS_PACKAGE_RELATIVE_IMPORT',
          `relative import crosses ${edge.owner.name} boundary: ${edge.specifier}`,
          sourcePath,
        );
      }
      continue;
    }

    if (edge.specifier.startsWith('#kite-cli/')) {
      const app = byName.get('@kite-ai/kite-cli');
      if (!app || edge.owner.name !== app.name) {
        addViolation(
          violations,
          'FORBIDDEN_ROOT_ALIAS_IMPORT',
          `${edge.owner.name} may not import CLI source alias ${edge.specifier}`,
          sourcePath,
        );
        continue;
      }
      const target = resolveKiteCliAliasSourceFile(root, edge.specifier);
      if (!target) {
        addViolation(
          violations,
          'IMPORT_TARGET_MISSING',
          `cannot resolve CLI source alias ${edge.specifier}`,
          sourcePath,
        );
      } else if (!isInside(join(app.absolutePath, 'src'), target)) {
        addViolation(
          violations,
          'CROSS_PACKAGE_ALIAS_IMPORT',
          `CLI source alias escapes ${app.name} source boundary: ${edge.specifier}`,
          sourcePath,
        );
      } else {
        edge.targetFile = target;
      }
      continue;
    }

    if (edge.specifier.startsWith('#kite-service/')) {
      const service = byName.get('@kite-ai/kite-service');
      if (!service || edge.owner.name !== service.name) {
        addViolation(
          violations,
          'FORBIDDEN_ROOT_ALIAS_IMPORT',
          `${edge.owner.name} may not import Service source alias ${edge.specifier}`,
          sourcePath,
        );
        continue;
      }
      const target = resolveKiteServiceAliasSourceFile(root, edge.specifier);
      if (!target) {
        addViolation(
          violations,
          'IMPORT_TARGET_MISSING',
          `cannot resolve Service source alias ${edge.specifier}`,
          sourcePath,
        );
      } else if (!isInside(join(service.absolutePath, 'src'), target)) {
        addViolation(
          violations,
          'CROSS_PACKAGE_ALIAS_IMPORT',
          `Service source alias escapes ${service.name} source boundary: ${edge.specifier}`,
          sourcePath,
        );
      } else {
        edge.targetFile = target;
      }
      continue;
    }

    if (
      edge.specifier.startsWith('#app/') ||
      (edge.specifier.startsWith('@/app/') && edge.owner.name !== '@kite-ai/kite-web')
    ) {
      addViolation(
        violations,
        'RETIRED_APP_ALIAS_IMPORT',
        `retired App source alias is forbidden: ${edge.specifier}`,
        sourcePath,
      );
      continue;
    }

    if (edge.specifier.startsWith('@/')) {
      const aliasRoot =
        edge.owner.name === '@kite-ai/kite-cli'
          ? join(root, 'src')
          : edge.owner.name === '@kite-ai/kite-web'
            ? join(root, 'apps/kite-web/src')
            : undefined;
      if (!aliasRoot) {
        addViolation(
          violations,
          'FORBIDDEN_ROOT_ALIAS_IMPORT',
          `${edge.owner.name} may not import root alias ${edge.specifier}`,
          sourcePath,
        );
        continue;
      }
      const target = resolveSourceFile(aliasRoot, edge.specifier.slice(2));
      if (!target) {
        addViolation(
          violations,
          'IMPORT_TARGET_MISSING',
          `cannot resolve root alias ${edge.specifier}`,
          sourcePath,
        );
      } else {
        edge.targetFile = target;
      }
      continue;
    }

    const packageName = internalPackageName(edge.specifier);
    if (!packageName) {
      validateExternalImport(edge, sourcePath, violations);
      continue;
    }
    const targetPackage = byName.get(packageName);
    if (!targetPackage) {
      addViolation(
        violations,
        'INTERNAL_IMPORT_UNRESOLVED',
        `unknown internal package ${packageName}`,
        sourcePath,
      );
      continue;
    }
    edge.targetPackage = targetPackage;
    const subpath =
      edge.specifier === packageName ? '.' : `.${edge.specifier.slice(packageName.length)}`;
    const exportedTarget = targetPackage.exportTargets.get(subpath);
    if (!exportedTarget) {
      addViolation(
        violations,
        'DEEP_IMPORT_NOT_EXPORTED',
        `${edge.specifier} is not an explicit export of ${packageName}`,
        sourcePath,
      );
    } else {
      const target = resolve(targetPackage.absolutePath, exportedTarget);
      if (!isInside(targetPackage.absolutePath, target) || !isRegularFile(target)) {
        addViolation(
          violations,
          'EXPORT_TARGET_MISSING',
          `${edge.specifier} resolves to missing or escaped target ${exportedTarget}`,
          sourcePath,
        );
      } else {
        edge.targetFile = target;
      }
    }

    const declared = edge.owner.manifest.dependencies?.[packageName];
    if (!declared) {
      addViolation(
        violations,
        'UNDECLARED_INTERNAL_DEPENDENCY',
        `${edge.owner.name} imports undeclared ${packageName}`,
        sourcePath,
      );
    }
    const allowed = ALLOWED_DIRECT_DEPENDENCIES[edge.owner.name] ?? [];
    if (!allowed.includes(packageName)) {
      addViolation(
        violations,
        'FORBIDDEN_DIRECT_DEPENDENCY',
        `${edge.owner.name} may not import ${packageName} (${edge.kind})`,
        sourcePath,
      );
    }
    if (
      edge.owner.name === '@kite-ai/runtime-storage-sqlite' &&
      edge.specifier !== '@kite-ai/runtime-host/storage'
    ) {
      addViolation(
        violations,
        'FORBIDDEN_DIRECT_DEPENDENCY',
        'runtime-storage-sqlite may import only @kite-ai/runtime-host/storage',
        sourcePath,
      );
    }
  }
}

function validateExternalDependency(
  owner: string,
  dependency: string,
  path: string,
  violations: RuntimePackageViolation[],
): void {
  if (owner === '@kite-ai/agent-kernel' || owner === '@kite-ai/runtime-spi') {
    addViolation(
      violations,
      'FORBIDDEN_EXTERNAL_DEPENDENCY',
      `${owner} may not declare external dependency ${dependency}`,
      `${path}/package.json`,
    );
  }
  if (isUiPackage(dependency) && owner !== '@kite-ai/kite-cli' && owner !== '@kite-ai/kite-web') {
    addViolation(
      violations,
      'FORBIDDEN_UI_IMPORT',
      `${owner} may not declare UI dependency ${dependency}`,
      `${path}/package.json`,
    );
  }
  if (owner === '@kite-ai/runtime-host' && /sqlite/i.test(dependency)) {
    addViolation(
      violations,
      'FORBIDDEN_CONCRETE_PROVIDER_IMPORT',
      `runtime-host may not declare SQLite dependency ${dependency}`,
      `${path}/package.json`,
    );
  }
}

function validateExternalImport(
  edge: ImportEdge,
  sourcePath: string,
  violations: RuntimePackageViolation[],
): void {
  const owner = edge.owner.name;
  const specifier = edge.specifier;
  if (specifier.startsWith('node:') || specifier.startsWith('bun:')) {
    if (
      owner === '@kite-ai/runtime-contract' ||
      owner === '@kite-ai/runtime-protocol' ||
      owner === '@kite-ai/runtime-server' ||
      owner === '@kite-ai/runtime-client' ||
      owner === '@kite-ai/agent-api-client' ||
      owner === '@kite-ai/kite-app-contract' ||
      owner === '@kite-ai/agent-kernel' ||
      owner === '@kite-ai/runtime-spi' ||
      owner === '@kite-ai/kite-web'
    ) {
      addViolation(
        violations,
        specifier.startsWith('bun:') ? 'FORBIDDEN_BUN_IMPORT' : 'FORBIDDEN_NODE_IMPORT',
        `${owner} may not import ${specifier}`,
        sourcePath,
      );
    }
    if (owner === '@kite-ai/runtime-host' && specifier === 'bun:sqlite') {
      addViolation(
        violations,
        'FORBIDDEN_CONCRETE_PROVIDER_IMPORT',
        'runtime-host may not import bun:sqlite',
        sourcePath,
      );
    }
    return;
  }
  const dependency = externalPackageName(specifier);
  if (!dependency) return;
  if (!edge.owner.manifest.dependencies?.[dependency]) {
    addViolation(
      violations,
      'UNDECLARED_EXTERNAL_DEPENDENCY',
      `${owner} imports undeclared ${dependency}`,
      sourcePath,
    );
  }
  validateExternalDependency(owner, dependency, edge.owner.relativePath, violations);
}

function externalPackageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) {
    return undefined;
  }
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return scope && name ? `${scope}/${name}` : undefined;
  }
  return specifier.split('/')[0];
}

function isUiPackage(name: string): boolean {
  return (
    name === 'react' ||
    name === 'react-dom' ||
    name === 'lucide-react' ||
    name === 'vite' ||
    name === 'tailwindcss' ||
    name === '@tailwindcss/vite' ||
    name === '@vitejs/plugin-react' ||
    name.startsWith('@radix-ui/') ||
    name === 'ink' ||
    name.startsWith('@inkjs/')
  );
}

function validateAmbientAuthority(
  root: string,
  packages: PackageRecord[],
  violations: RuntimePackageViolation[],
): void {
  for (const entry of packages) {
    if (
      entry.name !== '@kite-ai/runtime-contract' &&
      entry.name !== '@kite-ai/runtime-protocol' &&
      entry.name !== '@kite-ai/runtime-server' &&
      entry.name !== '@kite-ai/runtime-client' &&
      entry.name !== '@kite-ai/agent-kernel'
    )
      continue;
    for (const path of entry.sourceFiles) {
      const sourcePath = normalizedRelative(root, path);
      const text = readFileSync(path, 'utf8');
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      for (const specifier of collectModuleSpecifiers(source)) {
        if (
          specifier.startsWith('node:') ||
          specifier.startsWith('bun:') ||
          ['react', 'ink', '@inkjs/ui'].includes(specifier)
        ) {
          addViolation(
            violations,
            specifier.startsWith('bun:')
              ? 'FORBIDDEN_BUN_IMPORT'
              : specifier.startsWith('node:')
                ? 'FORBIDDEN_NODE_IMPORT'
                : 'FORBIDDEN_UI_IMPORT',
            `${entry.name} may not import ${specifier}`,
            sourcePath,
          );
        }
      }
      if (containsIdentifier(source, 'process')) {
        addViolation(
          violations,
          'FORBIDDEN_PROCESS_GLOBAL',
          `${entry.name} may not use process`,
          sourcePath,
        );
      }
      if (containsIdentifier(source, 'Bun')) {
        addViolation(
          violations,
          'FORBIDDEN_BUN_IMPORT',
          `${entry.name} may not use Bun`,
          sourcePath,
        );
      }
      const ambientPatterns: Array<[RegExp, string, string]> = [];
      if (entry.name === '@kite-ai/agent-kernel') {
        ambientPatterns.push(
          [
            /\bDate\s*\.\s*now\s*\(/,
            'FORBIDDEN_KERNEL_CLOCK_RANDOM',
            'kernel may not use Date.now',
          ],
          [/\bnew\s+Date\s*\(/, 'FORBIDDEN_KERNEL_CLOCK_RANDOM', 'kernel may not construct Date'],
          [
            /\bMath\s*\.\s*random\s*\(/,
            'FORBIDDEN_KERNEL_CLOCK_RANDOM',
            'kernel may not use Math.random',
          ],
          [
            /\bcrypto\s*\.\s*randomUUID\s*\(/,
            'FORBIDDEN_KERNEL_CLOCK_RANDOM',
            'kernel may not use crypto.randomUUID',
          ],
        );
        for (const identifier of [
          'fetch',
          'setTimeout',
          'setInterval',
          'performance',
          'globalThis',
        ]) {
          if (containsIdentifier(source, identifier)) {
            addViolation(
              violations,
              'FORBIDDEN_KERNEL_AMBIENT_GLOBAL',
              `kernel may not use ambient global ${identifier}`,
              sourcePath,
            );
          }
        }
      }
      for (const [pattern, code, message] of ambientPatterns) {
        if (pattern.test(text)) addViolation(violations, code, message, sourcePath);
      }
    }
  }
}

function validatePublicExports(
  packages: PackageRecord[],
  violations: RuntimePackageViolation[],
): void {
  for (const entry of packages) {
    let hasRuntimeValue = false;
    const names = new Set<string>();
    for (const [subpath, target] of entry.exportTargets) {
      const absoluteTarget = resolve(entry.absolutePath, target);
      if (!isInside(entry.absolutePath, absoluteTarget) || !isRegularFile(absoluteTarget)) {
        addViolation(
          violations,
          'EXPORT_TARGET_MISSING',
          `${entry.name} export ${subpath} target does not exist: ${target}`,
          `${entry.relativePath}/package.json`,
        );
        continue;
      }
      const source = ts.createSourceFile(
        absoluteTarget,
        readFileSync(absoluteTarget, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const statement of source.statements) {
        if (ts.isExportDeclaration(statement) && statement.exportClause) {
          if (ts.isNamedExports(statement.exportClause)) {
            const reexportedNames = statement.moduleSpecifier
              ? exportedNamesFromModule(absoluteTarget, statement.moduleSpecifier)
              : undefined;
            for (const element of statement.exportClause.elements) {
              names.add(element.name.text);
              if (!statement.isTypeOnly && !element.isTypeOnly) hasRuntimeValue = true;
              const importedName = element.propertyName?.text ?? element.name.text;
              if (reexportedNames && !reexportedNames.has(importedName)) {
                addViolation(
                  violations,
                  'PUBLIC_EXPORT_SYMBOL_DRIFT',
                  `${entry.name} re-exports missing symbol ${importedName}`,
                  normalizedRelative(entry.absolutePath, absoluteTarget),
                );
              }
            }
          }
          continue;
        }
        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
        if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
          }
          hasRuntimeValue = true;
        } else if (
          (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name
        ) {
          names.add(statement.name.text);
          hasRuntimeValue = true;
        } else if (
          (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
          statement.name
        ) {
          names.add(statement.name.text);
        }
      }
    }
    if (!hasRuntimeValue && !NON_EXPORTING_PRIVATE_APPS.has(entry.name)) {
      addViolation(
        violations,
        'PACKAGE_RUNTIME_VALUE_MISSING',
        `${entry.name} must expose at least one real runtime value`,
        entry.relativePath,
      );
    }
    for (const name of names) {
      if (FORBIDDEN_PUBLIC_NAMES[entry.name]?.some((pattern) => pattern.test(name))) {
        addViolation(
          violations,
          'PUBLIC_EXPORT_FORBIDDEN',
          `${entry.name} may not export ${name}`,
          entry.relativePath,
        );
      }
    }
  }
}

function exportedNamesFromModule(
  importer: string,
  moduleSpecifier: ts.Expression,
): ReadonlySet<string> | undefined {
  if (!ts.isStringLiteralLike(moduleSpecifier) || !moduleSpecifier.text.startsWith('.')) {
    return undefined;
  }
  const target = resolveSourceFile(dirname(importer), moduleSpecifier.text);
  if (!target) return new Set<string>();
  const source = ts.createSourceFile(
    target,
    readFileSync(target, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  for (const statement of source.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    }
  }
  return names;
}

function validateConsumers(
  packages: PackageRecord[],
  imports: ImportEdge[],
  violations: RuntimePackageViolation[],
): void {
  for (const entry of packages) {
    const externalConsumer = imports.some((edge) => edge.targetPackage?.name === entry.name);
    const testConsumer = entry.testFiles.some((file) =>
      readFileSync(file, 'utf8').includes(`from '${entry.name}`),
    );
    if (!NON_EXPORTING_PRIVATE_APPS.has(entry.name) && !externalConsumer && !testConsumer) {
      addViolation(
        violations,
        'PACKAGE_CONSUMER_MISSING',
        `${entry.name} has no package-export consumer`,
        entry.relativePath,
      );
    }
    for (const dependency of Object.keys(entry.manifest.dependencies ?? {}).filter((name) =>
      name.startsWith('@kite-ai/'),
    )) {
      if (
        !imports.some(
          (edge) => edge.owner.name === entry.name && edge.targetPackage?.name === dependency,
        )
      ) {
        addViolation(
          violations,
          'DECLARED_INTERNAL_DEPENDENCY_UNUSED',
          `${entry.name} declares but does not import ${dependency}`,
          `${entry.relativePath}/package.json`,
        );
      }
    }
  }
}

function validateClientBoundary(
  root: string,
  packages: PackageRecord[],
  imports: ImportEdge[],
  violations: RuntimePackageViolation[],
): void {
  const app = packages.find((entry) => entry.name === '@kite-ai/kite-cli');
  if (!app) return;
  const clientPrefix = /apps\/kite-cli\/src\/(cli|tui)\//;
  const forbiddenRootRuntime = [
    '@/core/runtime/actions',
    '@/core/runtime/agent',
    '@/core/runtime/effects',
    '@kite-ai/agent-kernel',
    '@kite-ai/builtin-runtime',
    '@/core/runtime/executor',
    '@/core/runtime/file-checkpoints',
    '@/core/runtime/kernel',
    '@/core/runtime/runner',
    '@/core/runtime/scheduler',
    '@kite-ai/runtime-host',
    '@kite-ai/runtime-protocol',
    '@kite-ai/runtime-server',
    '@kite-ai/runtime-storage-sqlite',
    '@/core/runtime/store',
  ];
  for (const edge of imports.filter((candidate) => candidate.owner.name === app.name)) {
    const sourcePath = normalizedRelative(root, edge.source);
    if (!clientPrefix.test(sourcePath)) continue;
    if (
      forbiddenRootRuntime.some(
        (specifier) => edge.specifier === specifier || edge.specifier.startsWith(`${specifier}/`),
      ) ||
      edge.specifier === 'bun:sqlite'
    ) {
      addViolation(
        violations,
        'CLIENT_RUNTIME_AUTHORITY_IMPORT',
        `CLI/TUI Client may not import ${edge.specifier}`,
        sourcePath,
      );
    }
    if (edge.specifier.includes('bootstrap/legacy')) {
      addViolation(
        violations,
        'CLIENT_LEGACY_IMPLEMENTATION_IMPORT',
        `CLI/TUI Client may not import ${edge.specifier}`,
        sourcePath,
      );
    }
    if (edge.specifier === '../bootstrap' || edge.specifier.startsWith('#kite-service/bootstrap')) {
      addViolation(
        violations,
        'COMPOSITION_ROOT_BYPASS',
        'CLI production code may not request the relocated Runtime bootstrap',
        sourcePath,
      );
    }
  }

  const service = packages.find((entry) => entry.name === '@kite-ai/kite-service');
  if (service) {
    for (const edge of imports.filter((candidate) => candidate.owner.name === service.name)) {
      if (
        edge.specifier === 'react' ||
        edge.specifier.startsWith('react/') ||
        edge.specifier === 'ink' ||
        edge.specifier.startsWith('ink-') ||
        edge.specifier === '@kite-ai/kite-cli' ||
        edge.specifier.startsWith('@kite-ai/kite-cli/') ||
        edge.specifier.startsWith('#kite-cli/')
      ) {
        addViolation(
          violations,
          'SERVICE_UI_OR_CLI_IMPORT',
          `Runtime Service may not import ${edge.specifier}`,
          normalizedRelative(root, edge.source),
        );
      }
    }
  }

  for (const legacySource of [
    'src/app/cli',
    'src/app/tui',
    'src/app/git',
    'src/app/observability',
    'src/app/release',
    'src/app/workspace',
  ]) {
    if (collectFiles(join(root, legacySource), /\.[cm]?[jt]sx?$/).length > 0) {
      addViolation(
        violations,
        'LEGACY_APP_SOURCE_PRESENT',
        `RM-03 source must be absent: ${legacySource}`,
        legacySource,
      );
    }
  }

  const executionModule = join(
    root,
    'apps/kite-service/src/bootstrap/runtime/KiteRuntimeExecutionModule.ts',
  );
  if (!isRegularFile(executionModule)) {
    addViolation(
      violations,
      'RUNTIME_EXECUTION_MODULE_MISSING',
      'RM-16 requires the unique Service Runtime execution module',
      'apps/kite-service/src/bootstrap/runtime/KiteRuntimeExecutionModule.ts',
    );
  }

  const contractSource = join(root, 'packages/runtime-contract/src/index.ts');
  if (isRegularFile(contractSource)) {
    const text = readFileSync(contractSource, 'utf8');
    // The public contract stays free of concrete persistence format ownership.
    for (const forbidden of ['State 26', 'Store 5']) {
      if (text.includes(forbidden)) {
        addViolation(
          violations,
          'FORMAT_AUTHORITY_LEAK',
          `RM Contract may not introduce ${forbidden}`,
          'packages/runtime-contract/src/index.ts',
        );
      }
    }
  }
}

function validateCycles(
  edges: readonly { from: string; to: string }[],
  violations: RuntimePackageViolation[],
): void {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }
  const visited = new Set<string>();
  const active: string[] = [];
  const reported = new Set<string>();
  const visit = (name: string): void => {
    const activeIndex = active.indexOf(name);
    if (activeIndex >= 0) {
      const cycle = [...active.slice(activeIndex), name];
      const key = cycle.join(' -> ');
      if (!reported.has(key)) {
        reported.add(key);
        addViolation(violations, 'PACKAGE_CYCLE', key);
      }
      return;
    }
    if (visited.has(name)) return;
    active.push(name);
    for (const target of adjacency.get(name) ?? []) visit(target);
    active.pop();
    visited.add(name);
  };
  for (const [name] of RUNTIME_WORKSPACE_PACKAGES) visit(name);
}

function validateTransitiveForbiddenEdges(
  edges: readonly { from: string; to: string }[],
  violations: RuntimePackageViolation[],
): void {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges)
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  const illegal = edges.filter(
    (edge) => !(ALLOWED_DIRECT_DEPENDENCIES[edge.from] ?? []).includes(edge.to),
  );
  for (const [origin] of RUNTIME_WORKSPACE_PACKAGES) {
    const seen = new Set<string>();
    const visit = (name: string): void => {
      if (seen.has(name)) return;
      seen.add(name);
      for (const violation of illegal) {
        if (violation.from === name && origin !== name) {
          addViolation(
            violations,
            'FORBIDDEN_TRANSITIVE_DEPENDENCY',
            `${origin} reaches forbidden edge ${violation.from} -> ${violation.to}`,
          );
        }
      }
      for (const target of adjacency.get(name) ?? []) visit(target);
    };
    visit(origin);
  }
}

function validateCompositionRoot(
  root: string,
  packages: PackageRecord[],
  imports: ImportEdge[],
  violations: RuntimePackageViolation[],
): string[] {
  const service = packages.find((entry) => entry.name === '@kite-ai/kite-service');
  if (!service) return [];
  const concretePackages = new Set([
    '@kite-ai/runtime-host',
    '@kite-ai/runtime-storage-sqlite',
    '@kite-ai/builtin-runtime',
  ]);
  const importsByFile = new Map<string, Set<string>>();
  for (const edge of imports.filter((candidate) => candidate.owner.name === service.name)) {
    if (!edge.targetPackage) continue;
    const names = importsByFile.get(edge.source) ?? new Set<string>();
    names.add(edge.targetPackage.name);
    importsByFile.set(edge.source, names);
  }
  const roots = [...importsByFile]
    .filter(([, names]) => [...concretePackages].every((name) => names.has(name)))
    .map(([path]) => normalizedRelative(root, path))
    .sort();
  const expectedRoot = 'apps/kite-service/src/bootstrap.ts';
  if (roots.length === 0) {
    addViolation(violations, 'COMPOSITION_ROOT_MISSING', `expected ${expectedRoot}`);
  } else if (roots.length > 1) {
    addViolation(violations, 'COMPOSITION_ROOT_MULTIPLE', roots.join(', '));
  } else if (roots[0] !== expectedRoot) {
    addViolation(violations, 'COMPOSITION_ROOT_BYPASS', `composition is in ${roots[0]}`);
  }
  const bootstrapImports = importsByFile.get(join(root, expectedRoot)) ?? new Set<string>();
  const requiredCompositionDependencies = [
    '@kite-ai/builtin-runtime',
    '@kite-ai/runtime-client',
    '@kite-ai/runtime-contract',
    '@kite-ai/runtime-host',
    '@kite-ai/runtime-protocol',
    '@kite-ai/runtime-server',
    '@kite-ai/runtime-spi',
    '@kite-ai/runtime-storage-sqlite',
  ] as const;
  for (const required of requiredCompositionDependencies) {
    if (!bootstrapImports.has(required)) {
      addViolation(
        violations,
        'COMPOSITION_ROOT_INCOMPLETE',
        `${expectedRoot} must import ${required}`,
        expectedRoot,
      );
    }
  }
  for (const edge of imports.filter(
    (candidate) => candidate.owner.name === service.name && candidate.targetPackage,
  )) {
    const sourcePath = normalizedRelative(root, edge.source);
    if (sourcePath === expectedRoot || edge.targetPackage?.name === '@kite-ai/runtime-contract') {
      continue;
    }
    const authority = compositionAuthorityBinding(edge);
    if (authority) {
      addViolation(
        violations,
        'COMPOSITION_ROOT_BYPASS',
        `non-bootstrap Service source imports composition authority ${authority} from ${edge.specifier}`,
        sourcePath,
      );
    }
  }
  if (!readFileSync(join(root, expectedRoot), 'utf8').includes('createKiteRuntimeBoundary')) {
    addViolation(
      violations,
      'COMPOSITION_ROOT_EXPORT_MISSING',
      'bootstrap must export createKiteRuntimeBoundary',
      expectedRoot,
    );
  }
  return roots;
}

/**
 * App sub-compositions may consume typed SPI contracts and Builtin-owned
 * presentation/configuration mechanisms.  The unique root rule applies to
 * factories that create the Host, Store, Registry, or frozen Builtin catalog,
 * not every symbol exported by those packages.
 */
function compositionAuthorityBinding(edge: ImportEdge): string | undefined {
  const packageName = edge.targetPackage?.name;
  if (!packageName || edge.valueBindings.length === 0) return undefined;
  if (packageName === '@kite-ai/runtime-storage-sqlite') {
    return edge.valueBindings[0] ?? '*';
  }
  const exact: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
    '@kite-ai/runtime-host': new Set([
      'createRuntimeHost',
      'createRuntimeHostBoundary',
      'createRuntimeHostStateStorageBinding',
    ]),
    '@kite-ai/runtime-spi': new Set(['createRuntimeModuleRegistry', 'defineRuntimeModule']),
    '@kite-ai/builtin-runtime': new Set([
      'createBuiltinContextCompilerPort',
      'createBuiltinRuntimeModules',
      'createBuiltinToolCatalogProjection',
    ]),
  });
  const forbidden = exact[packageName];
  if (!forbidden) return undefined;
  if (edge.valueBindings.includes('*')) return '*';
  return edge.valueBindings.find((binding) => forbidden.has(binding));
}

function parseExportTargets(
  value: PackageJson['exports'],
  packagePath: string,
  violations: RuntimePackageViolation[],
): Map<string, string> {
  const targets = new Map<string, string>();
  if (typeof value === 'string') {
    targets.set('.', value);
    return targets;
  }
  for (const [subpath, targetValue] of Object.entries(value ?? {})) {
    if (subpath.includes('*')) {
      addViolation(
        violations,
        'PUBLIC_EXPORT_WILDCARD',
        `wildcard export is forbidden: ${subpath}`,
        `${packagePath}/package.json`,
      );
      continue;
    }
    const target =
      typeof targetValue === 'string'
        ? targetValue
        : (targetValue.import ?? targetValue.default ?? targetValue.types);
    if (typeof target !== 'string') {
      addViolation(
        violations,
        'EXPORT_TARGET_INVALID',
        `export ${subpath} has no string target`,
        `${packagePath}/package.json`,
      );
      continue;
    }
    targets.set(subpath, target);
  }
  return targets;
}

function collectModuleSpecifiers(source: ts.SourceFile): string[] {
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      values.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return values;
}

function containsIdentifier(source: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function internalPackageName(specifier: string): string | undefined {
  if (!specifier.startsWith('@kite-ai/')) return undefined;
  const [scope, name] = specifier.split('/');
  return scope && name ? `${scope}/${name}` : undefined;
}

function resolveSourceFile(fromDirectory: string, specifier: string): string | undefined {
  const candidate = resolve(fromDirectory, specifier);
  const extension = extname(candidate);
  const candidates = extension
    ? [
        candidate,
        ...(extension === '.js' || extension === '.jsx'
          ? [
              `${candidate.slice(0, -extension.length)}.ts`,
              `${candidate.slice(0, -extension.length)}.tsx`,
            ]
          : []),
      ]
    : [
        candidate,
        `${candidate}.ts`,
        `${candidate}.tsx`,
        join(candidate, 'index.ts'),
        join(candidate, 'index.tsx'),
      ];
  return candidates.find(isRegularFile);
}

function resolveKiteCliAliasSourceFile(root: string, specifier: string): string | undefined {
  if (!specifier.startsWith('#kite-cli/')) return undefined;
  return resolveSourceFile(join(root, 'apps/kite-cli/src'), specifier.slice('#kite-cli/'.length));
}

function resolveKiteServiceAliasSourceFile(root: string, specifier: string): string | undefined {
  if (!specifier.startsWith('#kite-service/')) return undefined;
  return resolveSourceFile(
    join(root, 'apps/kite-service/src'),
    specifier.slice('#kite-service/'.length),
  );
}

function collectFiles(directory: string, pattern: RegExp): string[] {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return [];
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && pattern.test(entry.name)) files.push(absolute);
    }
  };
  visit(directory);
  return files.sort();
}

function uniqueEdges(
  edges: readonly { from: string; to: string }[],
): Array<{ from: string; to: string }> {
  return [...new Map(edges.map((edge) => [`${edge.from}\0${edge.to}`, edge])).values()].sort(
    (left, right) => `${left.from}\0${left.to}`.localeCompare(`${right.from}\0${right.to}`),
  );
}

function sortViolations(violations: RuntimePackageViolation[]): RuntimePackageViolation[] {
  return violations.sort((left, right) =>
    `${left.code}\0${left.path ?? ''}\0${left.message}`.localeCompare(
      `${right.code}\0${right.path ?? ''}\0${right.message}`,
    ),
  );
}

function addViolation(
  violations: RuntimePackageViolation[],
  code: string,
  message: string,
  path?: string,
): void {
  const violation: RuntimePackageViolation = path ? { code, message, path } : { code, message };
  if (
    !violations.some(
      (entry) =>
        entry.code === violation.code &&
        entry.message === violation.message &&
        entry.path === violation.path,
    )
  ) {
    violations.push(violation);
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function isRegularFile(path: string): boolean {
  return existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink();
}

function isInside(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function normalizedRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

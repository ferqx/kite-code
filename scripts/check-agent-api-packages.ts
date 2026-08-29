import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

export interface AgentApiPackageViolation {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

interface PackageManifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly type?: string;
  readonly module?: string;
  readonly exports?: unknown;
  readonly scripts?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
}

function files(path: string, pattern: RegExp): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? files(child, pattern) : pattern.test(entry.name) ? [child] : [];
  });
}

function imports(source: string): string[] {
  const file = ts.createSourceFile('agent-api-boundary.ts', source, ts.ScriptTarget.Latest, true);
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      values.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      values.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return values;
}

export function analyzeAgentApiPackages(repositoryRoot: string): AgentApiPackageViolation[] {
  const root = resolve(repositoryRoot);
  const packageRoot = join(root, 'packages', 'agent-api-contract');
  const violations: AgentApiPackageViolation[] = [];
  const add = (code: string, path: string, message: string): void => {
    violations.push({ code, path, message });
  };
  const required = [
    'package.json',
    'biome.json',
    'README.md',
    'tsconfig.json',
    'src/index.ts',
    'src/generation.ts',
    'scripts/generate.ts',
    'generated/openapi.json',
    'generated/digest.json',
    'generated/wire.d.ts',
  ];
  for (const path of required) {
    if (!existsSync(join(packageRoot, path))) {
      add('REQUIRED_FILE_MISSING', `packages/agent-api-contract/${path}`, `${path} is required`);
    }
  }
  if (!existsSync(join(packageRoot, 'package.json'))) return violations;

  const manifest = JSON.parse(
    readFileSync(join(packageRoot, 'package.json'), 'utf8'),
  ) as PackageManifest;
  if (
    manifest.name !== '@kite-ai/agent-api-contract' ||
    manifest.private !== true ||
    manifest.type !== 'module' ||
    manifest.module !== './src/index.ts'
  ) {
    add(
      'MANIFEST_IDENTITY_INVALID',
      'packages/agent-api-contract/package.json',
      'contract must be one private ESM source package',
    );
  }
  if (JSON.stringify(manifest.exports) !== JSON.stringify({ '.': './src/index.ts' })) {
    add(
      'EXPORT_SURFACE_INVALID',
      'packages/agent-api-contract/package.json',
      'only the root source entry may be exported',
    );
  }
  for (const script of ['build', 'check:generated', 'generate', 'typecheck', 'test']) {
    if (!manifest.scripts?.[script]) {
      add('SCRIPT_MISSING', 'packages/agent-api-contract/package.json', `${script} is required`);
    }
  }
  const dependencies = Object.keys(manifest.dependencies ?? {}).sort();
  if (JSON.stringify(dependencies) !== JSON.stringify(['zod'])) {
    add(
      'DEPENDENCY_BOUNDARY_INVALID',
      'packages/agent-api-contract/package.json',
      'zod is the only allowed dependency and workspace dependencies are forbidden',
    );
  }

  const sourceFiles = files(join(packageRoot, 'src'), /\.ts$/u);
  const testFiles = files(join(packageRoot, 'test'), /\.(?:test|spec)\.ts$/u);
  const fixtureFiles = files(join(packageRoot, 'fixtures'), /\.json$/u);
  const generatedSchemaFiles = files(join(packageRoot, 'generated', 'schema'), /\.json$/u);
  if (sourceFiles.length === 0)
    add('SOURCE_MISSING', 'packages/agent-api-contract/src', 'source is required');
  if (testFiles.length === 0)
    add('TEST_MISSING', 'packages/agent-api-contract/test', 'owner tests are required');
  if (fixtureFiles.length === 0)
    add('FIXTURE_MISSING', 'packages/agent-api-contract/fixtures', 'fixtures are required');
  if (generatedSchemaFiles.length === 0) {
    add(
      'GENERATED_SCHEMA_MISSING',
      'packages/agent-api-contract/generated/schema',
      'generated JSON Schemas are required',
    );
  }

  for (const absolute of sourceFiles) {
    const path = relative(root, absolute).replaceAll('\\', '/');
    const source = readFileSync(absolute, 'utf8');
    for (const specifier of imports(source)) {
      if (
        specifier.startsWith('@kite-ai/') ||
        specifier.startsWith('node:') ||
        specifier.startsWith('bun:') ||
        specifier === 'react' ||
        specifier.startsWith('react/') ||
        specifier === 'ink' ||
        specifier.startsWith('../..')
      ) {
        add(
          'BROWSER_BOUNDARY_IMPORT',
          path,
          `browser-safe Public contract may not import ${specifier}`,
        );
      }
    }
    if (/\b(?:Bun|Buffer|process|require)\b/u.test(source)) {
      add(
        'AMBIENT_RUNTIME_AUTHORITY',
        path,
        'contract source may not reference Bun, Buffer, process or require',
      );
    }
  }

  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    readonly devDependencies?: Record<string, string>;
    readonly scripts?: Record<string, string>;
  };
  if (rootManifest.devDependencies?.['@kite-ai/agent-api-contract'] !== 'workspace:*') {
    add(
      'ROOT_WORKSPACE_DEPENDENCY_MISSING',
      'package.json',
      'root devDependencies must register the contract workspace',
    );
  }
  if (
    rootManifest.scripts?.['check:agent-api-packages'] !==
    'bun run scripts/check-agent-api-packages.ts'
  ) {
    add('ROOT_GATE_MISSING', 'package.json', 'root package boundary gate is required');
  }
  for (const path of ['scripts/run-default-tests.ts', 'scripts/run-runtime-workspace-script.ts']) {
    if (!readFileSync(join(root, path), 'utf8').includes("'packages/agent-api-contract'")) {
      add('WORKSPACE_RUNNER_MISSING', path, 'contract workspace must be in the root runner');
    }
  }

  return violations.sort((left, right) =>
    `${left.path}:${left.code}`.localeCompare(`${right.path}:${right.code}`),
  );
}

if (import.meta.main) {
  const violations = analyzeAgentApiPackages(process.cwd());
  if (violations.length === 0) {
    console.log('Agent API package boundary checks passed.');
  } else {
    console.error('Agent API package boundary checks failed.');
    for (const violation of violations) {
      console.error(`[${violation.code}] ${violation.path}: ${violation.message}`);
    }
    process.exitCode = 1;
  }
}

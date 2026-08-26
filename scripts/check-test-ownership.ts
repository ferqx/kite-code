import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { testSourceRequiresProcessIsolation } from './test-suite';

const testPattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const rootSuites = new Set([
  'integration',
  'isolated',
  'qualification',
  'tui-system',
  'e2e',
  'release',
  'golden',
]);
const migrationNamePattern = /(?:parity|cutover|legacy|state\d+)/iu;

export interface TestOwnershipViolation {
  code: string;
  path: string;
  message: string;
}

function collect(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? collect(child) : testPattern.test(entry.name) ? [child] : [];
  });
}

function normalized(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function moduleSpecifiers(source: string): string[] {
  const file = ts.createSourceFile('ownership.ts', source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}

function isIsolated(path: string): boolean {
  return path.includes('/isolated/');
}

export function analyzeTestOwnership(repositoryRoot: string): TestOwnershipViolation[] {
  const root = resolve(repositoryRoot);
  const violations: TestOwnershipViolation[] = [];
  const rootTests = collect(join(root, 'tests'));
  const ownerTests = [
    ...collect(join(root, 'apps', 'kite-cli', 'test')),
    ...collect(join(root, 'apps', 'kite-service', 'test')),
    ...readdirSync(join(root, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => collect(join(root, 'packages', entry.name, 'test'))),
  ];

  for (const absolute of rootTests) {
    const path = normalized(root, absolute);
    const suite = path.split('/')[1];
    if (!suite || !rootSuites.has(suite)) {
      violations.push({
        code: 'ROOT_TEST_UNCLASSIFIED',
        path,
        message:
          'root test must live in an explicit integration/isolated/qualification/system suite',
      });
      continue;
    }
    const source = readFileSync(absolute, 'utf8');
    if (suite === 'integration') {
      for (const specifier of moduleSpecifiers(source)) {
        if (
          specifier.startsWith('#kite-cli/') ||
          specifier.startsWith('#app/') ||
          specifier.startsWith('@/app/') ||
          /^#(?:agent-kernel|builtin-runtime|runtime-contract|runtime-host|runtime-spi|runtime-storage)/u.test(
            specifier,
          ) ||
          /(?:^|\/)packages\/[^/]+\/src(?:\/|$)/u.test(specifier) ||
          /(?:^|\/)apps\/kite-cli\/src(?:\/|$)/u.test(specifier) ||
          /@kite-ai\/[^/]+\/src(?:\/|$)/u.test(specifier)
        ) {
          violations.push({
            code: 'INTEGRATION_INTERNAL_IMPORT',
            path,
            message: 'integration test imports non-public production path: ' + specifier,
          });
        }
      }
      if (testSourceRequiresProcessIsolation(source)) {
        violations.push({
          code: 'PARALLEL_TEST_MUTATES_PROCESS',
          path,
          message: 'process-global or child-process test must move to isolated or qualification',
        });
      }
    }
  }

  for (const absolute of ownerTests) {
    const path = normalized(root, absolute);
    const source = readFileSync(absolute, 'utf8');
    if (!isIsolated(path) && testSourceRequiresProcessIsolation(source)) {
      violations.push({
        code: 'OWNER_TEST_REQUIRES_ISOLATION',
        path,
        message: 'owner test mutates process-global state or launches a real child process',
      });
    }
  }

  for (const absolute of [...rootTests, ...ownerTests]) {
    const path = normalized(root, absolute);
    if (migrationNamePattern.test(basename(path))) {
      violations.push({
        code: 'MIGRATION_TEST_NAME',
        path,
        message: 'use a current domain, conformance, or compatibility test name',
      });
    }
  }

  if (existsSync(join(root, 'tests', 'runtime'))) {
    const remaining = readdirSync(join(root, 'tests', 'runtime'));
    if (remaining.length > 0) {
      violations.push({
        code: 'GENERIC_RUNTIME_SUITE_PRESENT',
        path: 'tests/runtime',
        message: 'generic Runtime ownership has been retired',
      });
    }
  }
  return violations.sort((left, right) =>
    (left.path + ':' + left.code).localeCompare(right.path + ':' + right.code),
  );
}

if (import.meta.main) {
  const violations = analyzeTestOwnership(process.cwd());
  if (violations.length === 0) {
    console.log('Test ownership checks passed.');
  } else {
    console.error('Test ownership checks failed.');
    for (const violation of violations) {
      console.error('[' + violation.code + '] ' + violation.path + ': ' + violation.message);
    }
    process.exitCode = 1;
  }
}

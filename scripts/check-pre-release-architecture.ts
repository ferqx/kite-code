import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dir, '..');
const violations: string[] = [];
const packageSources = readdirSync(join(root, 'packages'))
  .map((name) => join(root, 'packages', name, 'src'))
  .filter(existsSync);
const productionRoots = [
  join(root, 'apps/kite/src'),
  ...packageSources,
  join(root, 'native'),
].filter(existsSync);
const versionedPath = /(?:^|[/_.-])(?:v\d+|state\d+|store\d+|rmv\d+|rav\d+)(?:[/_.-]|$)/iu;
const versionedEntity = /(?:V\d+|State\d+|Store\d+|RMV\d+|RAV\d+|Legacy|Compat)/iu;
const oldRuntimePath = /\.runtime-(?:v\d+|state\d+-store\d+)\.db/iu;
const sqliteFormatBranch = /\b(?:targetFormat|formatProfile|compatibilityMode|legacyStore)\b/u;

function declarationName(node: ts.Node): ts.Identifier | undefined {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node)
  ) {
    return node.name && ts.isIdentifier(node.name) ? node.name : undefined;
  }
  return undefined;
}

function isVersionedEntity(name: string): boolean {
  const withoutAlgorithmNames = name.replace(/IPv[46]|SHA(?:1|256|512)/giu, '');
  return versionedEntity.test(withoutAlgorithmNames);
}

function inspectSource(path: string): void {
  const relativePath = relative(root, path);
  const source = readFileSync(path, 'utf8');
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const visitNode = (node: ts.Node): void => {
    const name = declarationName(node);
    if (name && isVersionedEntity(name.text)) {
      const position = sourceFile.getLineAndCharacterOfPosition(name.getStart(sourceFile));
      violations.push(
        `${relativePath}:${position.line + 1}: versioned production entity ${name.text}`,
      );
    }
    if (
      relativePath.startsWith('apps/kite/src/bootstrap/runtime/') &&
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /(?:^|[/#])tui(?:[/]|$)/u.test(node.moduleSpecifier.text)
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push(`${relativePath}:${position.line + 1}: App Runtime imports TUI`);
    }
    ts.forEachChild(node, visitNode);
  };
  visitNode(sourceFile);
  if (oldRuntimePath.test(source)) violations.push(`${relativePath}: obsolete Runtime Store path`);
  if (
    relativePath.startsWith('packages/runtime-storage-sqlite/src/') &&
    sqliteFormatBranch.test(source)
  ) {
    violations.push(`${relativePath}: SQLite format-selection or compatibility branch`);
  }
}

function visit(path: string): void {
  const entry = statSync(path);
  if (entry.isDirectory()) {
    for (const child of readdirSync(path)) {
      if (child === 'node_modules' || child === 'dist' || child === 'test' || child === 'tests') {
        continue;
      }
      visit(join(path, child));
    }
    return;
  }
  const relativePath = relative(root, path);
  if (versionedPath.test(relativePath)) {
    violations.push(`${relativePath}: versioned production path`);
  }
  if (/\.(?:ts|tsx|js|jsx)$/.test(path)) inspectSource(path);
}

for (const path of productionRoots) visit(path);

const activeDocsRoot = join(root, 'docs/active');
for (const name of readdirSync(activeDocsRoot)) {
  if (!name.endsWith('.md')) continue;
  const source = readFileSync(join(activeDocsRoot, name), 'utf8');
  if (/\b(?:State|Store|RMV|RAV)\d+\b/u.test(source)) {
    violations.push(`docs/active/${name}: versioned entity in active documentation`);
  }
  if (oldRuntimePath.test(source)) {
    violations.push(`docs/active/${name}: obsolete Runtime Store path in active documentation`);
  }
}

const compositionRoots = ['apps/kite/src/bootstrap.ts'].filter((path) =>
  existsSync(join(root, path)),
);
if (compositionRoots.length !== 1) violations.push('composition root count is not exactly one');

if (violations.length > 0) {
  console.error('pre-release architecture gate failed');
  for (const violation of violations) console.error(`[ARCHITECTURE] ${violation}`);
  process.exit(1);
}
console.log('pre-release architecture gate passed');

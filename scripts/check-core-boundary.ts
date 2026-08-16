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
        imports.push({ file, line: lineOf(source, node), specifier: module.text });
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
  const gateway = resolve(sourceRoot, 'core/model/invocation-gateway');
  const transport = resolve(sourceRoot, 'core/model/transport');
  const legacyInvoke = resolve(sourceRoot, 'core/model/invoke');
  return roots.flatMap((root) =>
    importedFiles(root).flatMap(({ file, line, specifier }) => {
      const target = resolveImport(file, specifier, sourceRoot);
      if (!target) return [];
      if (target === transport && resolve(file).replace(/\.ts$/, '') !== gateway) {
        return [
          {
            check: 'model transport must stay behind ModelInvocationGateway',
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
const scriptsRoot = join(root, 'scripts');
const violations = [
  ...forbiddenImports('core must not import app', coreRoot, sourceRoot, [appRoot]),
  ...forbiddenImports('protocol must not import core or app', protocolRoot, sourceRoot, [
    coreRoot,
    appRoot,
  ]),
  ...forbiddenModelDispatchImports([sourceRoot, scriptsRoot], sourceRoot),
  ...forbiddenProviderSdkCalls([sourceRoot, scriptsRoot]),
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

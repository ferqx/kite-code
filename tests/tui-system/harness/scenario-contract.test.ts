import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const scenariosDirectory = join(import.meta.dir, '..', 'scenarios');
const OUTPUT_WAIT_HELPERS = new Set([
  'expectTextAbsentFor',
  'waitForAnyText',
  'waitForCondition',
  'waitForOutputQuiescence',
  'waitForText',
  'waitForTextGone',
]);

function scenarioSources(): Array<{ file: string; source: string }> {
  return readdirSync(scenariosDirectory)
    .filter((file) => file.endsWith('.test.ts'))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(scenariosDirectory, file), 'utf8') }));
}

function regexViolations(pattern: RegExp): string[] {
  return scenarioSources()
    .filter(({ source }) => pattern.test(source))
    .map(({ file }) => file);
}

type DeclarationMap = Map<string, ts.Node>;

function collectDeclarations(sourceFile: ts.SourceFile): DeclarationMap {
  const declarations: DeclarationMap = new Map();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.set(node.name.text, node.initializer);
    } else if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      declarations.set(node.name.text, node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

function nodeUsesOutputAccessor(
  node: ts.Node,
  accessorNames: ReadonlySet<string>,
  declarations: DeclarationMap,
  visited = new Set<string>(),
): boolean {
  if (ts.isPropertyAccessExpression(node) && accessorNames.has(node.name.text)) return true;
  if (ts.isIdentifier(node)) {
    const declaration = declarations.get(node.text);
    if (declaration && !visited.has(node.text)) {
      const nextVisited = new Set(visited).add(node.text);
      if (nodeUsesOutputAccessor(declaration, accessorNames, declarations, nextVisited))
        return true;
    }
  }

  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && nodeUsesOutputAccessor(child, accessorNames, declarations, visited)) found = true;
  });
  return found;
}

export function findOutputWaitContractViolations(source: string, file = 'fixture.ts'): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = collectDeclarations(sourceFile);
  const violations: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const helper = node.expression.text;
      const outputReader = node.arguments[0];
      if (OUTPUT_WAIT_HELPERS.has(helper) && outputReader) {
        if (nodeUsesOutputAccessor(outputReader, new Set(['output', 'transcript']), declarations)) {
          violations.push(
            `${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
          );
        }
        if (
          helper === 'waitForOutputQuiescence' &&
          !nodeUsesOutputAccessor(
            outputReader,
            new Set(['outputSince', 'outputSinceLastAction']),
            declarations,
          )
        ) {
          violations.push(
            `${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}:quiescence-without-fresh-output`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

export function findRawSemanticAssertionViolations(source: string, file = 'fixture.ts'): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = collectDeclarations(sourceFile);
  const violations: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'expect' &&
      node.arguments[0] &&
      nodeUsesOutputAccessor(
        node.arguments[0],
        new Set(['output', 'outputSince', 'outputSinceLastAction', 'transcript']),
        declarations,
      )
    ) {
      violations.push(
        `${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

interface BunTestBindings {
  beforeAll: Set<string>;
  describe: Set<string>;
  test: Set<string>;
}

function expressionRootName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expressionRootName(expression.expression);
  if (ts.isElementAccessExpression(expression)) return expressionRootName(expression.expression);
  if (ts.isCallExpression(expression)) return expressionRootName(expression.expression);
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return expressionRootName(expression.expression);
  }
  return undefined;
}

function bunTestBindings(sourceFile: ts.SourceFile): BunTestBindings {
  const bindings: BunTestBindings = {
    beforeAll: new Set(['beforeAll']),
    describe: new Set(['describe']),
    test: new Set(['it', 'test']),
  };

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.moduleSpecifier.getText(sourceFile).replaceAll(/['"]/g, '') !== 'bun:test' ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === 'beforeAll') bindings.beforeAll.add(element.name.text);
      if (imported === 'describe') bindings.describe.add(element.name.text);
      if (imported === 'test' || imported === 'it') bindings.test.add(element.name.text);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const root = expressionRootName(node.initializer);
        for (const names of [bindings.beforeAll, bindings.describe, bindings.test]) {
          if (root && names.has(root) && !names.has(node.name.text)) {
            names.add(node.name.text);
            changed = true;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return bindings;
}

function isOutermostRegistrationCall(node: ts.CallExpression, names: ReadonlySet<string>): boolean {
  const root = expressionRootName(node.expression);
  if (!root || !names.has(root)) return false;
  return !(ts.isCallExpression(node.parent) && node.parent.expression === node);
}

function hasDirectBeforeAll(
  statements: ts.NodeArray<ts.Statement>,
  names: ReadonlySet<string>,
): boolean {
  return statements.some(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      isOutermostRegistrationCall(statement.expression, names),
  );
}

function countTestRegistrations(node: ts.Node, names: ReadonlySet<string>): number {
  let count = 0;
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current) && isOutermostRegistrationCall(current, names)) count++;
    ts.forEachChild(current, visit);
  };
  visit(node);
  return count;
}

export function findSharedFixtureTestViolations(source: string, file = 'fixture.ts'): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const bindings = bunTestBindings(sourceFile);
  const violations: string[] = [];

  if (
    hasDirectBeforeAll(sourceFile.statements, bindings.beforeAll) &&
    countTestRegistrations(sourceFile, bindings.test) > 1
  ) {
    violations.push(`${file}:1`);
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isOutermostRegistrationCall(node, bindings.describe)) {
      const body = node.arguments[1];
      if (
        body &&
        (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) &&
        ts.isBlock(body.body)
      ) {
        if (
          hasDirectBeforeAll(body.body.statements, bindings.beforeAll) &&
          countTestRegistrations(body.body, bindings.test) > 1
        ) {
          violations.push(
            `${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

export function findRemoteMcpPermitFixtureViolations(
  source: string,
  file = 'fixture.ts',
): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const bindings = bunTestBindings(sourceFile);
  const violations: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isOutermostRegistrationCall(node, bindings.test)) {
      const body = node.arguments[1];
      if (body) {
        const text = body.getText(sourceFile);
        const enablesPolicy = /remoteMcpEgressPolicyV1\s*:\s*true/.test(text);
        const injectsPermit =
          /remoteMcpEgressPermitResolver\s*:\s*['"]allow-each-invocation['"]/.test(text);
        if (enablesPolicy !== injectsPermit) {
          violations.push(
            `${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

export function findDirectSlashSubmitViolations(source: string, file = 'fixture.ts'): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = collectDeclarations(sourceFile);
  const violations: string[] = [];

  const helperBindings = (
    importedName: 'clearInput' | 'submitCommand' | 'typeText',
  ): Set<string> => {
    const bindings = new Set<string>([importedName]);
    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !statement.moduleSpecifier
          .getText(sourceFile)
          .replaceAll(/['"]/g, '')
          .endsWith('input-helpers') ||
        !statement.importClause?.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        continue;
      }
      for (const element of statement.importClause.namedBindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === importedName) {
          bindings.add(element.name.text);
        }
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const [name, declaration] of declarations) {
        if (!ts.isExpression(declaration)) continue;
        const root = expressionRootName(declaration);
        if (root && bindings.has(root) && !bindings.has(name)) {
          bindings.add(name);
          changed = true;
        }
      }
    }
    return bindings;
  };

  const clearInputBindings = helperBindings('clearInput');
  const typeTextBindings = helperBindings('typeText');
  const submitCommandBindings = helperBindings('submitCommand');

  const resolveStaticString = (
    expression: ts.Expression,
    visited = new Set<string>(),
  ): string | undefined => {
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.text;
    }
    if (ts.isIdentifier(expression)) {
      if (visited.has(expression.text)) return undefined;
      const declaration = declarations.get(expression.text);
      if (!declaration || !ts.isExpression(declaration)) return undefined;
      return resolveStaticString(declaration, new Set(visited).add(expression.text));
    }
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      return resolveStaticString(expression.expression, visited);
    }
    if (ts.isTemplateExpression(expression)) {
      let value = expression.head.text;
      for (const span of expression.templateSpans) {
        const interpolation = resolveStaticString(span.expression, visited);
        if (interpolation === undefined) return undefined;
        value += interpolation + span.literal.text;
      }
      return value;
    }
    return undefined;
  };

  const callsIn = (node: ts.Node): ts.CallExpression[] => {
    const calls: ts.CallExpression[] = [];
    const collect = (current: ts.Node): void => {
      if (ts.isFunctionLike(current)) return;
      if (ts.isCallExpression(current)) calls.push(current);
      ts.forEachChild(current, collect);
    };
    collect(node);
    return calls.sort((left, right) => left.getStart() - right.getStart());
  };

  const isHelperCall = (call: ts.CallExpression, bindings: ReadonlySet<string>): boolean => {
    const root = expressionRootName(call.expression);
    return root !== undefined && bindings.has(root);
  };

  const inputRoot = (call: ts.CallExpression): string | undefined => {
    const input = call.arguments[0];
    return input ? expressionRootName(input) : undefined;
  };

  const isEnterWrite = (call: ts.CallExpression, expectedRoot: string | undefined): boolean => {
    if (
      !ts.isPropertyAccessExpression(call.expression) ||
      call.expression.name.text !== 'write' ||
      !call.arguments[0] ||
      resolveStaticString(call.arguments[0]) !== '\r'
    ) {
      return false;
    }
    const root = expressionRootName(call.expression.expression);
    return expectedRoot === undefined || root === undefined || root === expectedRoot;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      const statements = node.statements;
      for (let index = 0; index < statements.length; index++) {
        const current = statements[index];
        if (!current) continue;
        const directSlashInputs = callsIn(current).filter(
          (call) =>
            isHelperCall(call, typeTextBindings) &&
            call.arguments[1] !== undefined &&
            resolveStaticString(call.arguments[1])?.startsWith('/'),
        );

        for (const slashInput of directSlashInputs) {
          const expectedRoot = inputRoot(slashInput);
          let clearedSafely = false;
          scan: for (let nextIndex = index + 1; nextIndex < statements.length; nextIndex++) {
            const next = statements[nextIndex];
            if (!next) continue;
            for (const call of callsIn(next)) {
              if (isEnterWrite(call, expectedRoot)) {
                break scan;
              }
              if (isHelperCall(call, clearInputBindings) && inputRoot(call) === expectedRoot) {
                clearedSafely = true;
                break scan;
              }
              if (
                (isHelperCall(call, typeTextBindings) ||
                  isHelperCall(call, submitCommandBindings)) &&
                inputRoot(call) === expectedRoot
              ) {
                break scan;
              }
            }
          }
          if (!clearedSafely) {
            violations.push(
              `${file}:${sourceFile.getLineAndCharacterOfPosition(slashInput.getStart()).line + 1}`,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe('TUI system scenario contract', () => {
  test('condition waits cannot be satisfied by cumulative output from an earlier action', () => {
    const violations = scenarioSources().flatMap(({ file, source }) =>
      findOutputWaitContractViolations(source, file),
    );
    expect(violations).toEqual([]);
  });

  test('scenario semantics never assert against the raw PTY transcript', () => {
    expect(regexViolations(/\.transcript\(\)/)).toEqual([]);
  });

  test('final UI semantics never assert against raw action deltas', () => {
    const violations = scenarioSources().flatMap(({ file, source }) =>
      findRawSemanticAssertionViolations(source, file),
    );
    expect(violations).toEqual([]);
  });

  test('shared beforeAll fixtures expose one runnable journey instead of dependent tests', () => {
    const violations = scenarioSources().flatMap(({ file, source }) =>
      findSharedFixtureTestViolations(source, file),
    );
    expect(violations).toEqual([]);
  });

  test('remote MCP permit fixtures are paired with the default-off policy in the same test', () => {
    const violations = scenarioSources().flatMap(({ file, source }) =>
      findRemoteMcpPermitFixtureViolations(source, file),
    );
    expect(violations).toEqual([]);
  });

  test('slash command submission uses the semantic submitCommand receipt', () => {
    const violations = scenarioSources().flatMap(({ file, source }) =>
      findDirectSlashSubmitViolations(source, file),
    );
    expect(violations).toEqual([]);
  });

  test('AST contract catches indirect cumulative readers and allows fresh readers', () => {
    expect(
      findOutputWaitContractViolations(
        'const getOutput = () => tui.output(); waitForText(getOutput, "ready");',
      ),
    ).not.toEqual([]);
    expect(
      findOutputWaitContractViolations('waitForText(tui.output.bind(tui), "ready");'),
    ).not.toEqual([]);
    expect(
      findOutputWaitContractViolations('waitForText(() => tui.transcript(), "ready");'),
    ).not.toEqual([]);
    expect(
      findOutputWaitContractViolations(
        'waitForCondition(() => screenContains(tui.output(), "ready"), "ready");',
      ),
    ).not.toEqual([]);
    expect(
      findOutputWaitContractViolations(
        'const fresh = () => tui.outputSinceLastAction(); waitForText(fresh, "ready");',
      ),
    ).toEqual([]);
    expect(
      findOutputWaitContractViolations(
        'const fresh = () => tui.outputSince(mark); waitForOutputQuiescence(fresh);',
      ),
    ).toEqual([]);
    expect(findOutputWaitContractViolations('waitForOutputQuiescence(() => "");')).not.toEqual([]);
  });

  test('AST contract catches direct and indirect raw semantic assertions', () => {
    expect(
      findRawSemanticAssertionViolations(
        'const render = tui.outputSince(mark); expect(screenContains(render, "ready")).toBe(true);',
      ),
    ).not.toEqual([]);
    expect(
      findRawSemanticAssertionViolations('expect(tui.viewport()).toContain("ready");'),
    ).toEqual([]);
    expect(
      findRawSemanticAssertionViolations(
        'const frames = tui.screenFramesSince(mark); expect(frames.join("\\n")).not.toContain("bad");',
      ),
    ).toEqual([]);
  });

  test('AST contract distinguishes dependent shared-fixture tests from isolated cases', () => {
    expect(
      findSharedFixtureTestViolations(
        'describe("bad", () => { beforeAll(setup); test("a", first); test("b", second); });',
      ),
    ).not.toEqual([]);
    expect(
      findSharedFixtureTestViolations(
        'describe("journey", () => { beforeAll(setup); step("a", first); step("b", second); test("journey", run); });',
      ),
    ).toEqual([]);
    expect(
      findSharedFixtureTestViolations(
        'describe("isolated", () => { beforeEach(setup); test("a", first); test("b", second); });',
      ),
    ).toEqual([]);
    expect(
      findSharedFixtureTestViolations(
        'describe("modifiers", () => { beforeAll(setup); test.only("a", first); test.each([1])("b", second); });',
      ),
    ).not.toEqual([]);
    expect(
      findSharedFixtureTestViolations(
        'import { test as scenario } from "bun:test"; describe("alias", () => { beforeAll(setup); const selected = scenario.skip; selected("a", first); scenario("b", second); });',
      ),
    ).not.toEqual([]);
    expect(
      findSharedFixtureTestViolations(
        'beforeAll(setup); describe("nested", () => { it("a", first); test("b", second); });',
      ),
    ).not.toEqual([]);
  });

  test('AST contract rejects partial remote MCP egress fixture setup', () => {
    expect(
      findRemoteMcpPermitFixtureViolations(
        'test("bad", () => createTestWorkspace({ configOverrides: { features: { remoteMcpEgressPolicyV1: true } } }));',
      ),
    ).not.toEqual([]);
    expect(
      findRemoteMcpPermitFixtureViolations(
        'test("bad", () => spawnTui({ remoteMcpEgressPermitResolver: "allow-each-invocation" }));',
      ),
    ).not.toEqual([]);
    expect(
      findRemoteMcpPermitFixtureViolations(
        'test("good", () => { createTestWorkspace({ configOverrides: { features: { remoteMcpEgressPolicyV1: true } } }); spawnTui({ remoteMcpEgressPermitResolver: "allow-each-invocation" }); });',
      ),
    ).toEqual([]);
    expect(
      findRemoteMcpPermitFixtureViolations('test("default denial", () => spawnTui({}));'),
    ).toEqual([]);
  });

  test('AST contract rejects direct slash Enter and requires suggestion cleanup', () => {
    expect(
      findDirectSlashSubmitViolations("await typeText(tui, '/theme purple');\ntui.write('\\r');"),
    ).not.toEqual([]);
    expect(findDirectSlashSubmitViolations("await typeText(tui, '/mc');")).not.toEqual([]);
    expect(
      findDirectSlashSubmitViolations(
        "await typeText(tui, '/mc');\nawait clearInput(tui, 3);\ntui.write('\\r');",
      ),
    ).toEqual([]);
    expect(findDirectSlashSubmitViolations("await submitCommand(tui, '/theme purple');")).toEqual(
      [],
    );
    expect(
      findDirectSlashSubmitViolations(`
        import { typeText as enterText } from '../harness/input-helpers';
        const alias = enterText;
        const command = '/theme purple';
        const enter = '\\r';
        await alias(tui, command);
        await waitForOutputQuiescence(() => tui.outputSinceLastAction());
        tui.write(enter);
      `),
    ).not.toEqual([]);
  });

  test('input readiness belongs to each input action instead of a warmup flow', () => {
    expect(regexViolations(/warmupInputPipeline/)).toEqual([]);
    expect(regexViolations(/test\([\s\S]{0,80}['"]warmup(?::|['"])/)).toEqual([]);
    expect(regexViolations(/\bspawnTui\b/)).toEqual([]);
    expect(regexViolations(/\.setRawMode\(true\)/)).toEqual([]);
    expect(regexViolations(/waitForText\([^\n]*['"]❯['"]/)).toEqual([]);
  });

  test('raw-mode setup does not rely on an arbitrary fixed delay', () => {
    expect(
      regexViolations(
        /setRawMode\(true\);\n(?:\s*\/\/[^\n]*\n){0,2}\s*await (?:sleep\(|new Promise\()/,
      ),
    ).toEqual([]);
  });

  test('scenario teardown uses the fail-complete fixture lifecycle', () => {
    expect(regexViolations(/\.(?:stop|cleanup)\(/)).toEqual([]);
    expect(
      scenarioSources()
        .filter(({ source }) => /after(?:All|Each)\(/.test(source))
        .filter(({ source }) => !/cleanupTuiSystemFixtures\(/.test(source))
        .map(({ file }) => file),
    ).toEqual([]);
  });

  test('scenario steps do not use arbitrary fixed delays or character offsets', () => {
    expect(regexViolations(/await (?:sleep\(|new Promise\([^\n]*setTimeout)/)).toEqual([]);
    expect(regexViolations(/\.output\(\)\.(?:length|slice)/)).toEqual([]);
    expect(regexViolations(/testTiming\s*:/)).toEqual([]);
    expect(regexViolations(/test\([^\n]*journey\.run\(\)[^\n]*,\s*\d[\d_]*\s*\)/)).toEqual([]);
  });

  test('default scenarios do not contain public provider endpoints or native smoke switches', () => {
    expect(regexViolations(/api\.(?:deepseek|openai)\.com/)).toEqual([]);
    expect(regexViolations(/KITE_RUN_NATIVE|detectSandboxBackend/)).toEqual([]);
  });
});

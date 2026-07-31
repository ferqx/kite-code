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

  test('input readiness belongs to each input action instead of a warmup flow', () => {
    expect(regexViolations(/warmupInputPipeline/)).toEqual([]);
    expect(regexViolations(/test\([\s\S]{0,80}['"]warmup(?::|['"])/)).toEqual([]);
  });

  test('raw-mode setup does not rely on an arbitrary fixed delay', () => {
    expect(
      regexViolations(
        /setRawMode\(true\);\n(?:\s*\/\/[^\n]*\n){0,2}\s*await (?:sleep\(|new Promise\()/,
      ),
    ).toEqual([]);
  });

  test('scenario steps do not use arbitrary fixed delays or character offsets', () => {
    expect(regexViolations(/await (?:sleep\(|new Promise\([^\n]*setTimeout)/)).toEqual([]);
    expect(regexViolations(/\.output\(\)\.(?:length|slice)/)).toEqual([]);
  });

  test('default scenarios do not contain public provider endpoints or native smoke switches', () => {
    expect(regexViolations(/api\.(?:deepseek|openai)\.com/)).toEqual([]);
    expect(regexViolations(/KITE_RUN_NATIVE|detectSandboxBackend/)).toEqual([]);
  });
});

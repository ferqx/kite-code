import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import ts from 'typescript';
import {
  assertCurrentRuntimeEvent,
  decodeCurrentRuntimeEventJson,
} from '@/core/runtime/event-codec';

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

describe('current RuntimeEvent codec', () => {
  test('rejects unknown discriminants and incomplete current payloads', () => {
    expect(() => assertCurrentRuntimeEvent({ type: 'tool.execution_ready' })).toThrow(
      'is not part of the current format',
    );
    expect(() => decodeCurrentRuntimeEventJson('{"type":"turn.started"}')).toThrow(
      'requires turnId',
    );
  });

  test('rejects invalid sandbox cleanup lifecycle identities and attempts', () => {
    const completed = {
      type: 'capability.sandbox_disposal_completed',
      invocationId: 'invocation',
      attempt: 1,
      readyDigest: 'ready',
      lifecycleIntentDigest: 'cleanup-intent',
      cleanupAttempt: 1,
      disposed: false,
      disposedAt: '2026-08-17T00:00:00.000Z',
    } as const;
    expect(() => assertCurrentRuntimeEvent({ ...completed, lifecycleIntentDigest: '' })).toThrow(
      'requires lifecycleIntentDigest',
    );
    expect(() => assertCurrentRuntimeEvent({ ...completed, cleanupAttempt: 0 })).toThrow(
      'boolean disposed receipt',
    );
    expect(() => assertCurrentRuntimeEvent({ ...completed, cleanupAttempt: 1.5 })).toThrow(
      'boolean disposed receipt',
    );
    expect(() => assertCurrentRuntimeEvent({ ...completed, unexpected: true })).toThrow(
      'invalid shape',
    );
  });

  test('required-field manifest exactly matches the RuntimeEvent union', () => {
    const eventsPath = resolve('src/core/runtime/events.ts');
    const codecPath = resolve('src/core/runtime/event-codec.ts');
    const program = ts.createProgram([eventsPath, codecPath], {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      target: ts.ScriptTarget.ESNext,
    });
    const checker = program.getTypeChecker();
    const eventsSource = program.getSourceFile(eventsPath)!;
    const codecSource = program.getSourceFile(codecPath)!;
    const runtimeEvent = eventsSource.statements.find(
      (statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text === 'RuntimeEvent',
    )!;
    const manifestDeclaration = codecSource.statements
      .flatMap((statement) =>
        ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
      )
      .find(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS',
      )!;
    const manifest = unwrapExpression(manifestDeclaration.initializer!);
    expect(ts.isObjectLiteralExpression(manifest)).toBe(true);
    if (!ts.isObjectLiteralExpression(manifest)) throw new Error('Expected event manifest object.');

    const actual = Object.fromEntries(
      manifest.properties.map((property) => {
        if (!ts.isPropertyAssignment(property))
          throw new Error('Expected event manifest property.');
        const name = property.name.getText(codecSource).replace(/^['"]|['"]$/g, '');
        const fields = unwrapExpression(property.initializer);
        if (!ts.isArrayLiteralExpression(fields)) throw new Error('Expected required-field array.');
        return [
          name,
          fields.elements.map((field) => {
            if (!ts.isStringLiteralLike(field)) throw new Error('Expected required-field string.');
            return field.text;
          }),
        ];
      }),
    );

    const runtimeEventType = checker.getTypeAtLocation(runtimeEvent.name);
    if (!runtimeEventType.isUnion()) throw new Error('Expected RuntimeEvent union.');
    const expected = Object.fromEntries(
      runtimeEventType.types.map((member) => {
        const discriminant = member.getProperty('type')!;
        const discriminantType = checker.getTypeOfSymbolAtLocation(discriminant, runtimeEvent);
        if (!discriminantType.isStringLiteral()) {
          throw new Error('Expected literal RuntimeEvent discriminant.');
        }
        return [
          discriminantType.value,
          member
            .getProperties()
            .filter(
              (property) =>
                property.name !== 'type' && (property.flags & ts.SymbolFlags.Optional) === 0,
            )
            .map((property) => property.name),
        ];
      }),
    );

    expect(actual).toEqual(expected);
  });
});

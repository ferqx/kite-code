import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  assertAgentStateInvariants,
  assertCurrentRuntimeEvent,
  decodeCurrentRuntimeEventJson,
} from '@kite/agent-kernel';
import { createRuntimeHostState26InitialStateV1 } from '@kite/runtime-host';
import ts from 'typescript';

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

  test('strictly decodes every Subagent lifecycle fact and rejects identity drift', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const at = '2026-08-17T00:00:00.000Z';
    const taskArtifact = {
      artifactId: `pa_${'b'.repeat(64)}`,
      kind: 'subagent_task',
      integrityIdentifier: `sha256:${'c'.repeat(64)}`,
      byteLength: 128,
    } as const;
    const handleArtifact = {
      artifactId: `pa_${'d'.repeat(64)}`,
      kind: 'subagent_handle',
      integrityIdentifier: `sha256:${'e'.repeat(64)}`,
      byteLength: 256,
    } as const;
    const events = [
      {
        type: 'capability.subagent_dispatch_intent_recorded',
        invocationId: 'invocation',
        attempt: 1,
        purpose: 'start',
        childInvocationId: 'child',
        taskArtifact,
        dispatchIntentDigest: digest,
        recordedAt: at,
      },
      {
        type: 'capability.subagent_handle_recorded',
        invocationId: 'invocation',
        attempt: 1,
        dispatchIntentDigest: digest,
        handleArtifact,
        handleIntegrityIdentifier: `sha256:${'f'.repeat(64)}`,
        recordedAt: at,
      },
      {
        type: 'capability.subagent_observation_recorded',
        invocationId: 'invocation',
        attempt: 1,
        dispatchIntentDigest: digest,
        status: 'blocked',
        observedAt: at,
      },
      {
        type: 'capability.subagent_cleanup_started',
        invocationId: 'invocation',
        attempt: 1,
        dispatchIntentDigest: digest,
        cleanupAttempt: 1,
        cleanupKind: 'handle_reconcile',
        startedAt: at,
      },
      {
        type: 'capability.subagent_cleanup_completed',
        invocationId: 'invocation',
        attempt: 1,
        dispatchIntentDigest: digest,
        cleanupAttempt: 1,
        cleanupKind: 'handle_reconcile',
        cleanupConfirmed: true,
        completedAt: at,
      },
    ] as const;
    for (const event of events) {
      expect(decodeCurrentRuntimeEventJson(JSON.stringify(event))).toEqual(event);
      expect(() => assertCurrentRuntimeEvent({ ...event, unexpected: true })).toThrow(
        'invalid shape',
      );
      expect(() =>
        assertCurrentRuntimeEvent({ ...event, dispatchIntentDigest: 'a'.repeat(64) }),
      ).toThrow();
      expect(() =>
        assertCurrentRuntimeEvent({ ...event, dispatchIntentDigest: `sha256:${'A'.repeat(64)}` }),
      ).toThrow();
      expect(() => assertCurrentRuntimeEvent({ ...event, attempt: 0 })).toThrow();
    }
    expect(() =>
      assertCurrentRuntimeEvent({
        ...events[0],
        taskArtifact: { ...taskArtifact, kind: 'subagent_handle' },
      }),
    ).toThrow();
    expect(() => assertCurrentRuntimeEvent({ ...events[2], status: 'unknown' })).toThrow();
  });

  test('rejects malformed Subagent lifecycle state combinations during restore validation', () => {
    const state = createRuntimeHostState26InitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'subagent-lifecycle-invariant',
      userId: 'user',
      workspace: '/workspace',
    });
    state.capabilities.invocations.invocation = {
      invocationId: 'invocation',
      toolCallId: 'task-call',
      capabilityId: 'builtin:task',
      capabilityRevision: '1'.repeat(64),
      argumentsDigest: '2'.repeat(64),
      authorizationDigest: '3'.repeat(64),
      admissionDigest: '4'.repeat(64),
      effectiveEffectsDigest: '5'.repeat(64),
      receiptRequirement: 'control_receipt',
      status: 'running',
      attemptsStarted: 1,
      recordedAt: '2026-08-17T00:00:00.000Z',
      startedAt: '2026-08-17T00:00:00.000Z',
      subagentProviderLifecycle: {
        attempt: 1,
        purpose: 'start',
        childInvocationId: 'child',
        taskArtifact: {
          artifactId: `pa_${'6'.repeat(64)}`,
          kind: 'subagent_task',
          integrityIdentifier: `sha256:${'7'.repeat(64)}`,
          byteLength: 128,
        },
        dispatchIntentDigest: `sha256:${'8'.repeat(64)}`,
        status: 'cleanup_completed',
        recordedAt: '2026-08-17T00:00:00.000Z',
        handleArtifact: {
          artifactId: `pa_${'9'.repeat(64)}`,
          kind: 'subagent_handle',
          integrityIdentifier: `sha256:${'a'.repeat(64)}`,
          byteLength: 256,
        },
        handleIntegrityIdentifier: `sha256:${'b'.repeat(64)}`,
        handleRecordedAt: '2026-08-17T00:00:00.000Z',
        observationStatus: 'blocked',
        observedAt: '2026-08-17T00:00:00.000Z',
        cleanupAttempt: 1,
        cleanupKind: 'handle_reconcile',
        cleanupStartedAt: '2026-08-17T00:00:00.000Z',
        cleanupConfirmed: true,
        cleanupCompletedAt: '2026-08-17T00:00:00.000Z',
      },
    };
    expect(() => assertAgentStateInvariants(state)).not.toThrow();
    for (const [label, mutate] of [
      [
        'attempt',
        (value: typeof state) => {
          value.capabilities.invocations.invocation!.attemptsStarted = 2;
        },
      ],
      [
        'digest',
        (value: typeof state) => {
          value.capabilities.invocations.invocation!
            .subagentProviderLifecycle!.dispatchIntentDigest = '8'.repeat(64);
        },
      ],
      [
        'status',
        (value: typeof state) => {
          value.capabilities.invocations.invocation!.subagentProviderLifecycle!.status =
            'cleanup_pending';
        },
      ],
      [
        'receipt',
        (value: typeof state) => {
          value.capabilities.invocations.invocation!.subagentProviderLifecycle!.cleanupConfirmed =
            false;
        },
      ],
      [
        'handle-group',
        (value: typeof state) => {
          value.capabilities.invocations.invocation!.subagentProviderLifecycle!.handleRecordedAt =
            undefined;
        },
      ],
    ] as const) {
      const malformed = structuredClone(state);
      mutate(malformed);
      expect(() => assertAgentStateInvariants(malformed), label).toThrow(
        /invalid Provider lifecycle evidence/u,
      );
    }
  });

  test('required-field manifest exactly matches the RuntimeEvent union', () => {
    const eventsPath = resolve('packages/agent-kernel/src/events.ts');
    const codecPath = eventsPath;
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

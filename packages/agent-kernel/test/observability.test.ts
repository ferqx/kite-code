import { describe, expect, test } from 'bun:test';
import {
  assertObservabilityEventCoverageV1,
  OBSERVABILITY_HANDLED_RUNTIME_EVENT_TYPES_V1,
  OBSERVABILITY_IGNORED_RUNTIME_EVENT_TYPES_V1,
  OBSERVABILITY_RUNTIME_FACT_SCHEMA_V1,
  projectRuntimeEventToObservabilityFactV1,
} from '../src/observability';

const FALLBACK = '1970-01-01T00:00:00.000Z';

describe('Kernel observability fact projection', () => {
  test('covers every State26 event exactly once', () => {
    expect(() => assertObservabilityEventCoverageV1()).not.toThrow();
    expect(
      OBSERVABILITY_HANDLED_RUNTIME_EVENT_TYPES_V1.length +
        OBSERVABILITY_IGNORED_RUNTIME_EVENT_TYPES_V1.length,
    ).toBe(136);
  });

  test('uses envelope time and strips event identity and free-form fields', () => {
    const fact = projectRuntimeEventToObservabilityFactV1(
      {
        eventId: 'private-event',
        threadId: 'private-thread',
        revision: 7,
        occurredAt: '2026-08-21T00:00:01.000Z',
        payload: {
          type: 'model.responded',
          messageId: 'private-message',
          text: 'PRIVATE_MODEL_TEXT',
          durationMs: 12,
          inputTokens: 3,
          outputTokens: 4,
        },
      },
      FALLBACK,
    );

    expect(fact).toEqual({
      schema: OBSERVABILITY_RUNTIME_FACT_SCHEMA_V1,
      observedAt: '2026-08-21T00:00:01.000Z',
      type: 'model.responded',
      durationMs: 12,
      inputTokens: 3,
      outputTokens: 4,
    });
    expect(JSON.stringify(fact)).not.toContain('PRIVATE_MODEL_TEXT');
    expect(JSON.stringify(fact)).not.toContain('private-event');
    expect(JSON.stringify(fact)).not.toContain('private-thread');
  });

  test('projects only canonical bounded tool outcome facts', () => {
    const fact = projectRuntimeEventToObservabilityFactV1(
      {
        type: 'tool.finished',
        toolCallId: 'private-tool-call',
        name: 'shell_execute',
        command: 'PRIVATE_COMMAND',
        result: { ok: false },
        outcomeV1: {
          schemaVersion: 1,
          status: 'failed',
          failure: { kind: 'cancel_incomplete', detailCode: 'process_cleanup_unknown' },
          dispatchState: 'started',
          externalEffects: 'unknown',
          recovery: {
            disposition: 'never',
            maximumAdditionalCalls: 0,
            requiresNewModelResponse: false,
            safeAutomaticRetry: false,
          },
          timing: { source: 'runtime_boundary', totalActiveMs: 25 },
        },
      },
      FALLBACK,
    );

    expect(fact).toEqual({
      schema: OBSERVABILITY_RUNTIME_FACT_SCHEMA_V1,
      observedAt: FALLBACK,
      type: 'tool.finished',
      capabilityAlias: 'shell_execute',
      outcome: {
        status: 'failed',
        totalActiveMs: 25,
        failureKind: 'cancel_incomplete',
      },
    });
    expect(JSON.stringify(fact)).not.toContain('PRIVATE_COMMAND');
    expect(JSON.stringify(fact)).not.toContain('private-tool-call');
  });

  test('keeps run defaults and low-cardinality reason parity', () => {
    expect(
      projectRuntimeEventToObservabilityFactV1(
        { type: 'run.completed', turnId: 'private-turn', output: 'PRIVATE_OUTPUT' },
        FALLBACK,
      ),
    ).toMatchObject({ type: 'run.completed', outcome: 'completed', reason: 'completed' });
    expect(
      projectRuntimeEventToObservabilityFactV1(
        { type: 'run.error', message: 'PRIVATE_ERROR', recoverable: false },
        FALLBACK,
      ),
    ).toMatchObject({ type: 'run.error', outcome: 'failed', reason: 'unknown' });
    expect(
      projectRuntimeEventToObservabilityFactV1(
        {
          type: 'run.error',
          message: 'PRIVATE_ERROR',
          recoverable: false,
          outcome: { status: 'failed', reasonCode: 'checkpoint_restore_error' },
        },
        FALLBACK,
      ),
    ).toMatchObject({ type: 'run.error', outcome: 'failed', reason: 'runtime' });
  });

  test('fails closed for terminal events before Kernel canonical outcome admission', () => {
    expect(
      projectRuntimeEventToObservabilityFactV1(
        {
          type: 'tool.failed',
          toolCallId: 'private-tool',
          failure: { kind: 'tool_runtime_error', message: 'PRIVATE_ERROR' },
        },
        FALLBACK,
      ),
    ).toBeUndefined();
    expect(
      projectRuntimeEventToObservabilityFactV1(
        {
          type: 'tool.finished',
          toolCallId: 'private-tool',
          name: 'read_file',
          result: { ok: true },
        },
        FALLBACK,
      ),
    ).toBeUndefined();
  });

  test('fails closed for malformed and explicitly ignored events', () => {
    expect(
      projectRuntimeEventToObservabilityFactV1({ type: 'not-a-runtime-event' }, FALLBACK),
    ).toBeUndefined();
    expect(
      projectRuntimeEventToObservabilityFactV1(
        {
          occurredAt: '2026-08-21T00:00:00.000Z',
          payload: { type: 'model.responded' },
        },
        FALLBACK,
      ),
    ).toBeUndefined();
    for (const type of OBSERVABILITY_IGNORED_RUNTIME_EVENT_TYPES_V1) {
      expect(projectRuntimeEventToObservabilityFactV1({ type }, FALLBACK)).toBeUndefined();
    }
  });
});

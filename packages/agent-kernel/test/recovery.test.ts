import { describe, expect, test } from 'bun:test';
import type { KernelEvent } from '../src/events';
import {
  classifyToolOutcomeV1,
  isToolOutcomeV1,
  normalizeAgentToolOutcomeEvent,
  type ToolOutcomeV1,
} from '../src/normalization';
import {
  closeToolRecoveryScopeV1,
  createToolRecoveryJournalV1,
  isToolRecoveryJournalInvalidV1,
  isToolRecoveryResolutionV1,
  mergeToolRecoveryJournalsV1,
  normalizeToolRecoveryJournalV1,
  recordRecoveryFailureV1,
  recordToolOwnedProgressV1,
  toolFailureInstanceIdV1,
} from '../src/recovery';
import { createInitialAgentState } from '../src/state';

const IDENTITY_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function userActionOutcome(): ToolOutcomeV1 {
  return {
    schemaVersion: 1,
    status: 'failed',
    failure: { kind: 'tool_not_found', detailCode: 'unknown_tool' },
    dispatchState: 'not_started',
    externalEffects: 'none',
    replaySafety: 'pre_dispatch',
    recovery: {
      disposition: 'user_action',
      maximumAdditionalCalls: 0,
      requiresNewModelResponse: false,
      safeAutomaticRetry: false,
    },
    timing: { source: 'legacy_unknown' },
  };
}

describe('State25 ToolOutcome user-action recovery parity', () => {
  test('recovery journals consume normalization-owned outcomes without widening unknown or diagnostic facts', () => {
    const canonicalFailure = classifyToolOutcomeV1({
      status: 'failed',
      failure: {
        kind: 'tool_runtime_error',
        message: 'redacted recovery fixture',
        retryable: true,
        modelFixable: true,
        needsUserIntervention: false,
        terminatesTurn: false,
        journal: true,
      },
      authority: {
        dispatchState: 'not_started',
        externalEffects: 'none',
        replaySafety: 'pre_dispatch',
      },
      toolAdvice: { detailCode: 'runtime_exception', disposition: 'correct_args' },
      unknownFields: {
        hasUnknown: true,
        count: 1,
        toolClass: 'builtin_other',
        schemaRevision: 'rmv1-s6-outcome-v1',
      },
    });
    expect(isToolOutcomeV1(canonicalFailure)).toBe(true);
    const journal = recordRecoveryFailureV1(createToolRecoveryJournalV1(IDENTITY_KEY), {
      toolCallId: 'canonical-tool-call',
      toolName: 'shell_execute',
      invocationFingerprint: 'a'.repeat(64),
      modelMessageId: 'canonical-model-message',
      outcome: canonicalFailure,
    });
    const failure = Object.values(journal.failures)[0];
    expect(failure?.outcome).toMatchObject(canonicalFailure);
    expect(failure?.outcome.unknownFields).toEqual(canonicalFailure.unknownFields);

    const diagnosticOutcome = classifyToolOutcomeV1({
      status: 'failed',
      authority: {
        dispatchState: 'started',
        externalEffects: 'unknown',
      },
      classifierDiagnostic: 'classifier_missing',
    });
    expect(isToolOutcomeV1(diagnosticOutcome)).toBe(true);
    const diagnosticJournal = recordRecoveryFailureV1(createToolRecoveryJournalV1(IDENTITY_KEY), {
      toolCallId: 'diagnostic-tool-call',
      toolName: 'shell_execute',
      invocationFingerprint: 'b'.repeat(64),
      modelMessageId: 'diagnostic-model-message',
      outcome: diagnosticOutcome,
    });
    expect(Object.values(diagnosticJournal.failures)[0]?.outcome.diagnosticCodes).toEqual([
      'classifier_missing',
    ]);
    expect(Object.values(diagnosticJournal.failures)[0]?.status).toBe('exhausted');
  });

  test('keeps the four user-action recovery facts fail-closed', () => {
    const outcome = userActionOutcome();
    expect(isToolOutcomeV1(outcome)).toBe(true);
    expect(outcome.recovery).toMatchObject({
      disposition: 'user_action',
      maximumAdditionalCalls: 0,
      requiresNewModelResponse: false,
      safeAutomaticRetry: false,
    });
    expect(
      isToolOutcomeV1({
        ...outcome,
        recovery: { ...outcome.recovery, requiresNewModelResponse: true },
      }),
    ).toBe(false);
    expect(
      isToolOutcomeV1({
        ...outcome,
        recovery: { ...outcome.recovery, maximumAdditionalCalls: 1 },
      }),
    ).toBe(false);
    expect(
      isToolOutcomeV1({
        ...outcome,
        recovery: { ...outcome.recovery, safeAutomaticRetry: true },
      }),
    ).toBe(false);
  });

  test('preserves user-action recovery when an undispatched failure has no call record', () => {
    const state = createInitialAgentState({
      threadId: 'recovery-test',
      userId: 'user',
      workspace: '/workspace',
      turnId: 'turn-1',
      recoveryIdentityKey: IDENTITY_KEY,
    });
    for (const kind of [
      'model_refused',
      'provider_auth_required',
      'sandbox_error',
      'user_input_cancelled',
    ]) {
      const normalized = normalizeAgentToolOutcomeEvent(
        {
          type: 'tool.failed',
          toolCallId: 'missing-call',
          createdAt: '2026-08-20T00:00:00.000Z',
          failure: {
            kind,
            message: kind,
            retryable: false,
            modelFixable: false,
            needsUserIntervention: true,
            terminatesTurn: true,
            journal: true,
          },
        } as KernelEvent,
        state,
        '2026-08-20T00:00:00.000Z',
      ) as KernelEvent & { readonly outcomeV1: ToolOutcomeV1 };
      expect(normalized.outcomeV1.recovery).toEqual({
        disposition: 'user_action',
        maximumAdditionalCalls: 0,
        requiresNewModelResponse: false,
        safeAutomaticRetry: false,
      });
    }
  });

  test('records and resolves explicit user-action evidence only for the named failure', () => {
    const outcome = userActionOutcome();
    const journal = recordRecoveryFailureV1(createToolRecoveryJournalV1(IDENTITY_KEY), {
      toolCallId: 'missing-tool',
      toolName: 'read_file',
      invocationFingerprint: 'a'.repeat(64),
      modelMessageId: 'model-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      outcome,
    });
    const failureId = toolFailureInstanceIdV1({
      toolCallId: 'missing-tool',
      invocationFingerprint: 'a'.repeat(64),
      outcome,
    });
    expect(journal.failures[failureId]?.status).toBe('unresolved');

    const progressed = recordToolOwnedProgressV1(journal, {
      kind: 'user_action',
      referenceId: 'user-resolution-1',
      resolvesFailureIds: [failureId],
    });
    expect(progressed.failures[failureId]).toMatchObject({
      status: 'recovered',
      resolution: 'user_action',
    });
    expect(journal.failures[failureId]?.status).toBe('unresolved');

    const closed = closeToolRecoveryScopeV1(journal, {
      kind: 'failure',
      failureIds: [failureId],
      resolution: 'user_action',
    });
    expect(closed.failures[failureId]).toMatchObject({
      status: 'recovered',
      resolution: 'user_action',
    });
  });

  test('normalizes user-action journals with the host identity and rejects forged identity/fields', () => {
    const outcome = userActionOutcome();
    const journal = recordRecoveryFailureV1(createToolRecoveryJournalV1(IDENTITY_KEY), {
      toolCallId: 'missing-tool',
      toolName: 'read_file',
      invocationFingerprint: 'b'.repeat(64),
      modelMessageId: 'model-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      outcome,
    });
    expect(normalizeToolRecoveryJournalV1(journal, IDENTITY_KEY)).toEqual(journal);

    const forgedIdentity = normalizeToolRecoveryJournalV1(
      { ...journal, identityKey: 'c'.repeat(64) },
      IDENTITY_KEY,
    );
    expect(isToolRecoveryJournalInvalidV1(forgedIdentity)).toBe(true);

    const forgedField = normalizeToolRecoveryJournalV1(
      { ...journal, unexpected: true },
      IDENTITY_KEY,
    );
    expect(isToolRecoveryJournalInvalidV1(forgedField)).toBe(true);
    expect(isToolRecoveryResolutionV1('user_action')).toBe(true);
    expect(isToolRecoveryResolutionV1('provider')).toBe(false);
  });

  test('requires a trusted host identity and rejects missing or forged lineage', () => {
    const outcome = userActionOutcome();
    const journal = recordRecoveryFailureV1(createToolRecoveryJournalV1(IDENTITY_KEY), {
      toolCallId: 'missing-host-key',
      toolName: 'read_file',
      invocationFingerprint: 'd'.repeat(64),
      modelMessageId: 'model-host-key',
      taskId: 'task-host-key',
      turnId: 'turn-host-key',
      outcome,
    });
    const failureId = journal.order[0]!;
    const failure = journal.failures[failureId]!;

    expect(() => normalizeToolRecoveryJournalV1(journal, 'not-a-host-key')).toThrow(
      'canonical host-supplied key',
    );
    expect(() => normalizeToolRecoveryJournalV1(journal, undefined as unknown as string)).toThrow(
      'Host-supplied identityKey',
    );

    const candidateWithoutIdentity = { ...journal } as Record<string, unknown>;
    delete candidateWithoutIdentity.identityKey;
    expect(normalizeToolRecoveryJournalV1(candidateWithoutIdentity, IDENTITY_KEY)).toMatchObject({
      identityKey: IDENTITY_KEY,
      qualityGuard: { blocked: true, reasonCode: 'journal_invalid' },
    });

    const missingLineage = {
      ...journal,
      failures: {
        ...journal.failures,
        [failureId]: {
          ...failure,
          outcome: { ...failure.outcome, lineage: undefined },
        },
      },
    };
    expect(normalizeToolRecoveryJournalV1(missingLineage, IDENTITY_KEY)).toMatchObject({
      identityKey: IDENTITY_KEY,
      qualityGuard: { blocked: true, reasonCode: 'journal_invalid' },
    });

    const forgedLineage = {
      ...journal,
      failures: {
        ...journal.failures,
        [failureId]: {
          ...failure,
          outcome: {
            ...failure.outcome,
            lineage: { ...failure.outcome.lineage, failureInstanceId: 'f'.repeat(64) },
          },
        },
      },
    };
    expect(normalizeToolRecoveryJournalV1(forgedLineage, IDENTITY_KEY)).toMatchObject({
      identityKey: IDENTITY_KEY,
      qualityGuard: { blocked: true, reasonCode: 'journal_invalid' },
    });

    const child = createToolRecoveryJournalV1('c'.repeat(64));
    const merged = mergeToolRecoveryJournalsV1(journal, child, IDENTITY_KEY, {
      taskId: 'task-host-key',
      turnId: 'turn-host-key',
    });
    expect(merged.identityKey).toBe(IDENTITY_KEY);
    expect(merged.qualityGuard).toMatchObject({
      blocked: true,
      reasonCode: 'journal_invalid',
    });
    expect(() => mergeToolRecoveryJournalsV1(journal, child, 'not-a-host-key')).toThrow(
      'canonical host-supplied key',
    );
  });
});

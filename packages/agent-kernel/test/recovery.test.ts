import { describe, expect, test } from 'bun:test';
import type { KernelEvent } from '../src/events';
import {
  classifyToolOutcome,
  isToolOutcome,
  normalizeAgentToolOutcomeEvent,
  type ToolOutcome,
} from '../src/normalization';
import {
  closeToolRecoveryScope,
  createToolRecoveryJournal,
  isToolRecoveryJournalInvalid,
  isToolRecoveryResolution,
  mergeToolRecoveryJournals,
  normalizeToolRecoveryJournal,
  recordRecoveryFailure,
  recordToolOwnedProgress,
  toolFailureInstanceId,
} from '../src/recovery';
import { createInitialAgentState } from '../src/state';

const IDENTITY_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function userActionOutcome(): ToolOutcome {
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

describe('State ToolOutcome user-action recovery parity', () => {
  test('recovery journals consume normalization-owned outcomes without widening unknown or diagnostic facts', () => {
    const canonicalFailure = classifyToolOutcome({
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
        schemaRevision: 'recovery-outcome-current',
      },
    });
    expect(isToolOutcome(canonicalFailure)).toBe(true);
    const journal = recordRecoveryFailure(createToolRecoveryJournal(IDENTITY_KEY), {
      toolCallId: 'canonical-tool-call',
      toolName: 'shell_execute',
      invocationFingerprint: 'a'.repeat(64),
      modelMessageId: 'canonical-model-message',
      outcome: canonicalFailure,
    });
    const failure = Object.values(journal.failures)[0];
    expect(failure?.outcome).toMatchObject(canonicalFailure);
    expect(failure?.outcome.unknownFields).toEqual(canonicalFailure.unknownFields);

    const diagnosticOutcome = classifyToolOutcome({
      status: 'failed',
      authority: {
        dispatchState: 'started',
        externalEffects: 'unknown',
      },
      classifierDiagnostic: 'classifier_missing',
    });
    expect(isToolOutcome(diagnosticOutcome)).toBe(true);
    const diagnosticJournal = recordRecoveryFailure(createToolRecoveryJournal(IDENTITY_KEY), {
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
    expect(isToolOutcome(outcome)).toBe(true);
    expect(outcome.recovery).toMatchObject({
      disposition: 'user_action',
      maximumAdditionalCalls: 0,
      requiresNewModelResponse: false,
      safeAutomaticRetry: false,
    });
    expect(
      isToolOutcome({
        ...outcome,
        recovery: { ...outcome.recovery, requiresNewModelResponse: true },
      }),
    ).toBe(false);
    expect(
      isToolOutcome({
        ...outcome,
        recovery: { ...outcome.recovery, maximumAdditionalCalls: 1 },
      }),
    ).toBe(false);
    expect(
      isToolOutcome({
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
      ) as KernelEvent & { readonly outcome: ToolOutcome };
      expect(normalized.outcome.recovery).toEqual({
        disposition: 'user_action',
        maximumAdditionalCalls: 0,
        requiresNewModelResponse: false,
        safeAutomaticRetry: false,
      });
    }
  });

  test('records and resolves explicit user-action evidence only for the named failure', () => {
    const outcome = userActionOutcome();
    const journal = recordRecoveryFailure(createToolRecoveryJournal(IDENTITY_KEY), {
      toolCallId: 'missing-tool',
      toolName: 'read_file',
      invocationFingerprint: 'a'.repeat(64),
      modelMessageId: 'model-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      outcome,
    });
    const failureId = toolFailureInstanceId({
      toolCallId: 'missing-tool',
      invocationFingerprint: 'a'.repeat(64),
      outcome,
    });
    expect(journal.failures[failureId]?.status).toBe('unresolved');

    const progressed = recordToolOwnedProgress(journal, {
      kind: 'user_action',
      referenceId: 'user-resolution-1',
      resolvesFailureIds: [failureId],
    });
    expect(progressed.failures[failureId]).toMatchObject({
      status: 'recovered',
      resolution: 'user_action',
    });
    expect(journal.failures[failureId]?.status).toBe('unresolved');

    const closed = closeToolRecoveryScope(journal, {
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
    const journal = recordRecoveryFailure(createToolRecoveryJournal(IDENTITY_KEY), {
      toolCallId: 'missing-tool',
      toolName: 'read_file',
      invocationFingerprint: 'b'.repeat(64),
      modelMessageId: 'model-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      outcome,
    });
    expect(normalizeToolRecoveryJournal(journal, IDENTITY_KEY)).toEqual(journal);

    const forgedIdentity = normalizeToolRecoveryJournal(
      { ...journal, identityKey: 'c'.repeat(64) },
      IDENTITY_KEY,
    );
    expect(isToolRecoveryJournalInvalid(forgedIdentity)).toBe(true);

    const forgedField = normalizeToolRecoveryJournal(
      { ...journal, unexpected: true },
      IDENTITY_KEY,
    );
    expect(isToolRecoveryJournalInvalid(forgedField)).toBe(true);
    expect(isToolRecoveryResolution('user_action')).toBe(true);
    expect(isToolRecoveryResolution('provider')).toBe(false);
  });

  test('requires a trusted host identity and rejects missing or forged lineage', () => {
    const outcome = userActionOutcome();
    const journal = recordRecoveryFailure(createToolRecoveryJournal(IDENTITY_KEY), {
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

    expect(() => normalizeToolRecoveryJournal(journal, 'not-a-host-key')).toThrow(
      'canonical host-supplied key',
    );
    expect(() => normalizeToolRecoveryJournal(journal, undefined as unknown as string)).toThrow(
      'Host-supplied identityKey',
    );

    const candidateWithoutIdentity = { ...journal } as Record<string, unknown>;
    delete candidateWithoutIdentity.identityKey;
    expect(normalizeToolRecoveryJournal(candidateWithoutIdentity, IDENTITY_KEY)).toMatchObject({
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
    expect(normalizeToolRecoveryJournal(missingLineage, IDENTITY_KEY)).toMatchObject({
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
    expect(normalizeToolRecoveryJournal(forgedLineage, IDENTITY_KEY)).toMatchObject({
      identityKey: IDENTITY_KEY,
      qualityGuard: { blocked: true, reasonCode: 'journal_invalid' },
    });

    const child = createToolRecoveryJournal('c'.repeat(64));
    const merged = mergeToolRecoveryJournals(journal, child, IDENTITY_KEY, {
      taskId: 'task-host-key',
      turnId: 'turn-host-key',
    });
    expect(merged.identityKey).toBe(IDENTITY_KEY);
    expect(merged.qualityGuard).toMatchObject({
      blocked: true,
      reasonCode: 'journal_invalid',
    });
    expect(() => mergeToolRecoveryJournals(journal, child, 'not-a-host-key')).toThrow(
      'canonical host-supplied key',
    );
  });
});

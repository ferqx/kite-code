import { describe, expect, test } from 'bun:test';
import { createChatModel } from '@/core/model/factory';
import { createRecordModelResponseSourceV1 } from '@/core/model/response-source';
import type {
  CanonicalModelTextPartV1,
  CanonicalModelToolCallPartV1,
  ModelAttemptOutcomeV1,
} from '@/protocol/model-surface';
import { sanitizeModelReplayRecordOutcomeV1 } from '../../../scripts/evals/model-replay-record';
import {
  createPs03LocalSubagentCandidateCatalogV1,
  PS03_LOCAL_SUBAGENT_CANDIDATE_SUITE_ID_V1,
  runFreshPs03LocalSubagentReplayV1,
  runPs03LocalSubagentJourneyV1,
} from '../../../scripts/evals/model-replay-subagent-journey';

const CONFIG = {
  providerName: 'ps03-record-test',
  providerType: 'openai-compatible' as const,
  apiKey: '',
  baseURL: 'https://ps03-record-test.invalid/v1',
  modelName: 'ps03-record-test',
  sandbox: { enabled: false },
  features: { providerDataPolicyV1: false },
};

describe('PS-03 candidate Local start → blocked → resume replay contract', () => {
  test('records through Gateway ack and fresh-replays through Strict catalog exactly once', async () => {
    const model = createChatModel(CONFIG);
    const records: import('@/protocol/model-surface').ModelReplayAttemptRecordV1[] = [];
    let liveAttempts = 0;
    const live: import('@/core/model/response-source').ModelResponseSourceV1 = {
      mode: 'live',
      attempt: async () => {
        liveAttempts += 1;
        return liveAttempts === 1
          ? successOutcome({
              type: 'tool_call',
              toolCallId: 'raw-approval-call',
              toolName: 'shell_execute',
              input: { command: 'bun run typecheck' },
            })
          : successOutcome({ type: 'text', text: 'Approved local continuation completed.' });
      },
    };
    const recordSource = createRecordModelResponseSourceV1({
      live,
      recorder: {
        append: (record) => {
          records.push(record);
        },
      },
      encodeForCassette: ({ outcome, context, attemptOrdinal }) => {
        if (!context.replayBinding) throw new Error('missing candidate replay binding');
        return sanitizeModelReplayRecordOutcomeV1({
          outcome,
          purpose: context.purpose,
          actor: context.replayBinding.actor,
          logicalInvocationOrdinal: context.replayBinding.logicalInvocationOrdinal,
          attemptOrdinal,
        });
      },
    });
    const recorded = await runPs03LocalSubagentJourneyV1({
      config: CONFIG,
      model,
      source: recordSource,
      suiteRevision: 2,
    });
    expect(recorded).toMatchObject({
      mode: 'record',
      status: 'candidate_preflight_passed',
      lifecycle: { started: true, blocked: true, resumed: true },
      modelAttemptCount: 2,
      providerSourceAttempts: 2,
      providerTransportAttempts: 2,
      liveFallback: false,
      artifactReadback: { modelSurfaces: 2, modelResponses: 2, capabilityReceipt: true },
    });
    expect(liveAttempts).toBe(2);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.actor.kind)).toEqual(['subagent', 'subagent']);
    expect(records[0]?.actor).toMatchObject({
      parentToolCallId: 'ps03-parent-task',
      continuationId: null,
    });
    expect(records[1]?.actor).toMatchObject({
      parentToolCallId: 'ps03-parent-task',
    });
    expect(records[1]?.actor.kind === 'subagent' ? records[1].actor.continuationId : null).toMatch(
      /^continuation-/,
    );

    const catalog = createPs03LocalSubagentCandidateCatalogV1({ records, suiteRevision: 2 });
    expect(catalog.suite.suiteId).toBe(PS03_LOCAL_SUBAGENT_CANDIDATE_SUITE_ID_V1);
    const replayed = await runFreshPs03LocalSubagentReplayV1({
      config: { ...CONFIG, apiKey: '' },
      catalog,
    });
    expect(replayed).toMatchObject({
      mode: 'replay',
      status: 'fresh_replay_passed',
      lifecycle: { started: true, blocked: true, resumed: true },
      providerSourceAttempts: 2,
      providerTransportAttempts: 0,
      keyless: true,
      liveFallback: false,
      artifactReadback: { modelSurfaces: 2, modelResponses: 2, capabilityReceipt: true },
      allRecordsConsumed: true,
    });
  });

  test('rejects a replay invocation that presents credential material', async () => {
    await expect(
      runFreshPs03LocalSubagentReplayV1({
        config: { ...CONFIG, apiKey: 'credential-must-not-enter-replay' },
        catalog: {} as never,
      }),
    ).rejects.toThrow('PS03_LOCAL_SUBAGENT_REPLAY_CREDENTIAL_FORBIDDEN');
  });
});

function successOutcome(
  content: CanonicalModelTextPartV1 | CanonicalModelToolCallPartV1,
): ModelAttemptOutcomeV1 {
  return {
    schema: {
      name: 'kite.model-attempt-outcome',
      version: 1,
      canonicalizerVersion: 'kite.model-surface.canonical-json.v1',
    },
    kind: 'success',
    nativeReplayState: null,
    response: {
      message: { role: 'assistant', content: [content] },
      finishReason: content.type === 'tool_call' ? 'tool_calls' : 'stop',
      usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12, cacheReadTokens: 0 },
      providerMetadata: { responseId: 'raw-provider-response', rawFinishReason: null },
    },
  };
}

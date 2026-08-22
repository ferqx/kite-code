import assert from 'node:assert/strict';
import type { ContextTokenEstimate } from '@kite/builtin-runtime/model';
import {
  createChatModel,
  createModelContextSummaryGenerator,
  createNarrativeContextCompactor,
} from '@kite/builtin-runtime/model';
import { createRuntimeHostState25InitialStateV1, type RuntimeState } from '@kite/runtime-host';
import type { AgentConfig } from '#app/config';

const LIVE_TIMEOUT_MS = Number(process.env.KITE_LIVE_MODEL_TIMEOUT_MS ?? 90_000);
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} to run the real-model compaction suite.`);
  return value;
};

if (process.env.KITE_RUN_LIVE_MODEL_COMPACTION !== '1') {
  throw new Error('Set KITE_RUN_LIVE_MODEL_COMPACTION=1 to run this opt-in suite.');
}

const config: AgentConfig = {
  providerName: process.env.KITE_LIVE_MODEL_PROVIDER ?? 'live-openai-compatible',
  providerType:
    process.env.KITE_LIVE_MODEL_PROVIDER_TYPE === 'deepseek' ? 'deepseek' : 'openai-compatible',
  apiKey: required('KITE_LIVE_MODEL_API_KEY'),
  baseURL: required('KITE_LIVE_MODEL_BASE_URL'),
  modelName: required('KITE_LIVE_MODEL_NAME'),
  sandbox: { enabled: true },
};

const estimate: ContextTokenEstimate = {
  systemTokens: 100,
  toolSchemaTokens: 0,
  transcriptTokens: 12_000,
  summaryTokens: 0,
  dynamicRuntimeTokens: 100,
  framingTokens: 100,
  totalInputTokens: 12_300,
};

function historyState(): RuntimeState {
  const state = createRuntimeHostState25InitialStateV1({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'live-context-compaction',
    userId: 'live-test',
    workspace: '/live-test',
  });
  state.transcript.messages = Array.from({ length: 7 }, (_, index) => ({
    kind: 'user' as const,
    messageId: `message-${index}`,
    turnId: `turn-${index}`,
    ordinal: index,
    createdAt: `2026-07-22T00:00:0${index}.000Z`,
    content: `Historical goal ${index}: preserve decisions, failures, and next steps. ${'Implementation context. '.repeat(700)}`,
  }));
  return state;
}

function pending(state: RuntimeState, compactionId: string) {
  return {
    compactionId,
    reason: 'manual' as const,
    requestedAtRevision: state.revision,
    requestedAtTurnId: state.turn.turnId,
    force: false,
    estimate,
  };
}

const deadline = setTimeout(() => {
  console.error(`Real-model compaction suite exceeded ${LIVE_TIMEOUT_MS}ms.`);
  process.exit(1);
}, LIVE_TIMEOUT_MS);

try {
  const model = createChatModel(config);
  const generate = createModelContextSummaryGenerator({
    model,
    signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
  });
  const compact = createNarrativeContextCompactor({
    generate,
    maxSummaryTokens: 600,
    maxNarrativeTokens: 800,
  });

  const state = historyState();
  const first = await compact({
    state,
    pending: pending(state, 'live-manual'),
    sourceRevision: state.revision,
  });
  assert.ok(first.summary.length > 0);
  assert.ok(first.inputTokensAfter < first.inputTokensBefore);

  state.context.activeCheckpoint = first;
  state.transcript.messages = [
    ...state.transcript.messages,
    {
      kind: 'user',
      messageId: 'message-7',
      turnId: 'turn-7',
      ordinal: 7,
      createdAt: '2026-07-22T00:00:07.000Z',
      content: `New settled work: ${'incremental context '.repeat(700)}`,
    },
    {
      kind: 'user',
      messageId: 'message-8',
      turnId: 'turn-8',
      ordinal: 8,
      createdAt: '2026-07-22T00:00:08.000Z',
      content: 'Current live tail must remain outside the summary.',
    },
  ];
  const incremental = await compact({
    state,
    pending: pending(state, 'live-incremental'),
    sourceRevision: state.revision,
  });
  assert.equal(incremental.baseCheckpointId, first.compactionId);
  assert.notEqual(incremental.summary, first.summary);
  assert.ok(incremental.inputTokensAfter < incremental.inputTokensBefore);

  console.log(
    JSON.stringify({
      ok: true,
      provider: config.providerName,
      model: config.modelName,
      scenarios: ['manual-direct-summary', 'incremental-summary'],
    }),
  );
} finally {
  clearTimeout(deadline);
}

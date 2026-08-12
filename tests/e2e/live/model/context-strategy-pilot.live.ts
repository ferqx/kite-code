import assert from 'node:assert/strict';
import { loadAgentConfig } from '@/core/config';
import { type BaseMessage, humanMessage } from '@/core/messages';
import {
  createModelContextSummaryGenerator,
  createNarrativeContextCompactor,
} from '@/core/model/compaction-summary';
import type { ContextTokenEstimate } from '@/core/model/context-budget';
import { serializeFramesToMessages } from '@/core/model/context-serializer';
import { selectCheckpointWorkingSetV1 } from '@/core/model/context-working-set';
import { createChatModel } from '@/core/model/factory';
import { invokeBoundModel } from '@/core/model/invoke';
import { createInitialRuntimeState, type RuntimeState } from '@/core/runtime/state';

const TIMEOUT_MS = Number(process.env.KITE_LIVE_CONTEXT_STRATEGY_TIMEOUT_MS ?? 120_000);
const REQUIRED_FACTS = [
  'FACT[goal]=preserve-api-compatibility',
  'FACT[constraint]=do-not-change-canonical-transcript',
  'FACT[decision]=use-a-single-tier-selector',
  'FACT[verification]=run-the-regression-suite',
] as const;

if (process.env.KITE_RUN_LIVE_CONTEXT_STRATEGY_PILOT !== '1') {
  throw new Error(
    'Set KITE_RUN_LIVE_CONTEXT_STRATEGY_PILOT=1 to run this opt-in real-model pilot.',
  );
}

function state(): RuntimeState {
  const runtime = createInitialRuntimeState({
    threadId: 'live-context-strategy-pilot',
    userId: 'live-evaluator',
    workspace: '/live-evaluator',
  });
  runtime.revision = 1;
  runtime.lastAppliedEventId = 'e'.repeat(64);
  runtime.appliedEventIds = ['e'.repeat(64)];
  runtime.context.lastTranscriptProducingEventCutV1 = {
    revision: 1,
    eventId: 'e'.repeat(64),
  };
  runtime.transcript.messages = Array.from({ length: 18 }, (_, index) => ({
    kind: 'user' as const,
    messageId: `history-${index}`,
    turnId: `turn-${index}`,
    content: [
      ...(index < REQUIRED_FACTS.length ? [REQUIRED_FACTS[index]!] : []),
      `Historical coding-agent investigation ${index}.`,
      index < 14
        ? 'The deliberately long settled history is eligible for summary reduction. '.repeat(90)
        : 'This short live tail must remain in every projected context.',
    ].join('\n'),
  }));
  return runtime;
}

function estimate(): ContextTokenEstimate {
  return {
    systemTokens: 0,
    toolSchemaTokens: 0,
    transcriptTokens: 18_000,
    summaryTokens: 0,
    dynamicRuntimeTokens: 0,
    framingTokens: 0,
    totalInputTokens: 18_000,
  };
}

function query(): BaseMessage {
  return humanMessage(
    [
      'List every required FACT line from the historical context exactly, one per line.',
      'Do not add prose, explanations, or facts that are not present.',
    ].join('\n'),
  );
}

function contents(messages: readonly BaseMessage[]): string {
  return messages
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    )
    .join('\n');
}

async function queryModel(input: {
  model: ReturnType<typeof createChatModel>;
  messages: BaseMessage[];
  profile: 'raw' | 'rolling_summary' | 'progressive';
}) {
  const startedAt = performance.now();
  const response = await invokeBoundModel({
    model: input.model,
    tools: {},
    messages: input.messages,
    maxOutputTokens: 256,
    streaming: false,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = contents([response]);
  const usage = response.response_metadata?.usage as
    | { input_tokens?: number; prompt_tokens?: number; completion_tokens?: number }
    | undefined;
  return {
    profile: input.profile,
    factsRetained: REQUIRED_FACTS.filter((fact) => text.includes(fact)).length,
    complete: REQUIRED_FACTS.every((fact) => text.includes(fact)),
    inputTokens: usage?.input_tokens ?? usage?.prompt_tokens ?? null,
    outputTokens: usage?.completion_tokens ?? null,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

const deadline = setTimeout(() => {
  console.error(`Live context strategy pilot exceeded ${TIMEOUT_MS}ms.`);
  process.exit(1);
}, TIMEOUT_MS);

try {
  const config = loadAgentConfig();
  const model = createChatModel(config);
  const runtime = state();
  const generate = createModelContextSummaryGenerator({
    model,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const compact = createNarrativeContextCompactor({
    generate,
    maxSummaryTokens: 600,
    maxNarrativeTokens: 800,
  });
  const checkpoint = await compact({
    state: runtime,
    pending: {
      compactionId: 'live-context-strategy-pilot',
      reason: 'manual',
      requestedAtRevision: runtime.revision,
      requestedAtTurnId: runtime.turn.turnId,
      force: false,
      estimate: estimate(),
    },
    sourceRevision: runtime.revision,
  });
  assert.equal(checkpoint.version, 3, 'Pilot requires a V3 checkpoint.');
  const incrementalState = structuredClone(runtime);
  incrementalState.context.activeCheckpoint = checkpoint;
  incrementalState.transcript.messages.push(
    ...Array.from({ length: 12 }, (_, index) => ({
      kind: 'user' as const,
      messageId: `incremental-history-${index}`,
      turnId: `incremental-turn-${index}`,
      content:
        `Incremental context ${index} must remain recoverable after a verified checkpoint. `.repeat(
          80,
        ),
    })),
  );
  const incrementalCheckpoint = await compact({
    state: incrementalState,
    pending: {
      compactionId: 'live-context-strategy-pilot-incremental',
      reason: 'manual',
      requestedAtRevision: incrementalState.revision,
      requestedAtTurnId: incrementalState.turn.turnId,
      force: false,
      estimate: estimate(),
    },
    sourceRevision: incrementalState.revision,
  });
  assert.equal(incrementalCheckpoint.version, 3, 'Pilot incremental summary must produce V3.');
  assert.equal(
    incrementalCheckpoint.baseCheckpoint?.checkpointId,
    checkpoint.checkpointId,
    'Pilot incremental summary must bind its direct checkpoint.',
  );
  runtime.context.activeCheckpoint = checkpoint;
  runtime.context.projectionBaseIdentity = `checkpoint:${checkpoint.checkpointId}:${checkpoint.source.sourceRangeDigest}`;
  const workingSet = selectCheckpointWorkingSetV1({
    state: runtime,
    checkpoint,
    contextWindowTokens: 64_000,
  });
  assert.equal(workingSet.status, 'available', 'Pilot Working Set must be available.');
  if (workingSet.status !== 'available') throw new Error('Pilot Working Set is unavailable.');
  assert.equal(typeof checkpoint.summary, 'string', 'Pilot checkpoint must carry a summary.');
  const summary = checkpoint.summary;

  const raw = await queryModel({
    model,
    profile: 'raw',
    messages: [
      ...runtime.transcript.messages.map((message) => humanMessage(message.content ?? '')),
      query(),
    ],
  });
  const rolling = await queryModel({
    model,
    profile: 'rolling_summary',
    messages: [
      humanMessage(summary),
      ...runtime.transcript.messages
        .slice(-4)
        .map((message) => humanMessage(message.content ?? '')),
      query(),
    ],
  });
  const progressive = await queryModel({
    model,
    profile: 'progressive',
    messages: [humanMessage(summary), ...serializeFramesToMessages(workingSet.frames), query()],
  });
  console.log(
    JSON.stringify({
      schema: 'live-context-strategy-pilot:v1',
      status: raw.complete ? 'completed' : 'completed_with_raw_reference_failure',
      provider: config.providerName,
      model: config.modelName,
      contentLogged: false,
      checkpoint: {
        inputTokensBefore: checkpoint.inputTokensBefore,
        inputTokensAfter: checkpoint.inputTokensAfter,
        incrementalInputTokensBefore: incrementalCheckpoint.inputTokensBefore,
        incrementalInputTokensAfter: incrementalCheckpoint.inputTokensAfter,
      },
      profiles: [raw, rolling, progressive],
    }),
  );
} finally {
  clearTimeout(deadline);
}

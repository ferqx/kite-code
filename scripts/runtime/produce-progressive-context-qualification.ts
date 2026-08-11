import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createVerifiedContextCheckpointV3 } from '@/core/model/context-checkpoint-v3';
import { serializeFramesToMessages } from '@/core/model/context-serializer';
import { selectCheckpointWorkingSetV1 } from '@/core/model/context-working-set';
import { createInitialRuntimeState, type RuntimeState } from '@/core/runtime/state';

const outputPath = process.argv[2];
if (!outputPath)
  throw new Error('Usage: produce-progressive-context-qualification.ts <artifact.json>');

const percentile = (values: number[], ratio: number): number =>
  [...values].sort((left, right) => left - right)[
    Math.max(0, Math.ceil(values.length * ratio) - 1)
  ]!;

const FACT_KINDS = [
  'goal',
  'constraint',
  'decision',
  'failure',
  'verification',
  'unfinished',
  'continuation',
] as const;

function fixture(index: number, blocks = 48): { state: RuntimeState; mandatory: string[] } {
  const state = createInitialRuntimeState({
    threadId: `progressive-qualification-${index}`,
    userId: 'qualification',
    workspace: '/workspace',
  });
  state.revision = 1;
  state.lastAppliedEventId = 'e'.repeat(64);
  state.appliedEventIds = ['e'.repeat(64)];
  state.context.lastTranscriptProducingEventCutV1 = {
    revision: 1,
    eventId: 'e'.repeat(64),
  };
  const mandatory = FACT_KINDS.map(
    (kind, factIndex) => `FACT[${kind}]=fixture-${index}-value-${factIndex}`,
  );
  state.transcript.messages = Array.from({ length: blocks }, (_, block) => ({
    kind: 'user' as const,
    messageId: `fixture-${index}-message-${block}`,
    turnId: `fixture-${index}-turn-${block}`,
    content: [
      ...(block < mandatory.length ? [mandatory[block]!] : []),
      `distractor-${index}-${block}:${'settled historical context '.repeat(80)}`,
    ].join('\n'),
  }));
  return { state, mandatory };
}

function deterministicSummaryProvider(messages: RuntimeState['transcript']['messages']): string {
  const facts = new Set<string>();
  for (const message of messages) {
    for (const line of String(message.content).split('\n')) {
      if (
        /^FACT\[(goal|constraint|decision|failure|verification|unfinished|continuation)\]=/.test(
          line,
        )
      ) {
        facts.add(line);
      }
    }
  }
  return ['# Qualification summary', '', ...[...facts].sort()].join('\n');
}

function executeContinuation(projected: string, mandatory: readonly string[]): string | null {
  const facts = [...projected.matchAll(/^FACT\[[^\]]+\]=[^\n]+$/gm)].map((match) => match[0]);
  const unique = [...new Set(facts)].sort();
  return mandatory.every((fact) => unique.includes(fact))
    ? unique.filter((fact) => mandatory.includes(fact)).join('|')
    : null;
}

function qualificationDigest(domain: string, value: unknown): string {
  return createHash('sha256').update(`${domain}\0`).update(JSON.stringify(value)).digest('hex');
}

const semanticFixtures = Array.from({ length: 20 }, (_, index) => {
  const { state, mandatory } = fixture(index);
  const providerInput = state.transcript.messages.slice(0, 40);
  let providerCallCount = 0;
  const summary = (() => {
    providerCallCount += 1;
    return deterministicSummaryProvider(providerInput);
  })();
  const checkpoint = createVerifiedContextCheckpointV3({
    state,
    checkpointId: `fixture-${index}-checkpoint`,
    compactionId: `fixture-${index}-compaction`,
    reason: 'manual',
    coveredThroughMessageId: `fixture-${index}-message-39`,
    summary,
    inputTokensBefore: 40_000,
    inputTokensAfter: 8_000,
    routeIdentityDigest: 'a'.repeat(64),
    sourceProducingEventCutV1: { revision: 1, eventId: 'e'.repeat(64) },
    createdAt: new Date(0).toISOString(),
  });
  state.context.activeCheckpoint = checkpoint;
  state.context.projectionBaseIdentity = `checkpoint:${checkpoint.checkpointId}:${checkpoint.source.sourceRangeDigest}`;
  const selected = selectCheckpointWorkingSetV1({
    state,
    checkpoint,
    contextWindowTokens: 64_000,
  });
  const projected =
    selected.status === 'available'
      ? `${checkpoint.summary}\n${serializeFramesToMessages(selected.frames)
          .map((message) => String(message.content))
          .join('\n')}`
      : '';
  const rawProjected = state.transcript.messages
    .map((message) => String(message.content))
    .join('\n');
  const retained = mandatory.filter((marker) => projected.includes(marker));
  const expectedAnswer = [...mandatory].sort().join('|');
  const compactAnswer = executeContinuation(projected, mandatory);
  const rawAnswer = executeContinuation(rawProjected, mandatory);
  return {
    id: `long-session-${String(index + 1).padStart(2, '0')}`,
    mandatoryCount: mandatory.length,
    retainedCount: retained.length,
    providerCallCount,
    providerInputDigest: qualificationDigest('qualification-provider-input:v1', providerInput),
    providerOutputDigest: qualificationDigest('qualification-provider-output:v1', summary),
    expectedAnswerDigest: qualificationDigest('qualification-answer:v1', expectedAnswer),
    compactAnswerDigest:
      compactAnswer == null ? null : qualificationDigest('qualification-answer:v1', compactAnswer),
    rawAnswerDigest:
      rawAnswer == null ? null : qualificationDigest('qualification-answer:v1', rawAnswer),
    continuationSucceeded: selected.status === 'available' && compactAnswer === expectedAnswer,
    rawBaselineSucceeded: rawAnswer === expectedAnswer,
  };
});

const performanceState = createInitialRuntimeState({
  threadId: 'progressive-performance',
  userId: 'qualification',
  workspace: '/workspace',
});
performanceState.revision = 1;
performanceState.lastAppliedEventId = 'e'.repeat(64);
performanceState.appliedEventIds = ['e'.repeat(64)];
performanceState.transcript.messages = Array.from({ length: 2_000 }, (_, index) =>
  index % 2 === 0
    ? {
        kind: 'user' as const,
        messageId: `performance-message-${index}`,
        turnId: `performance-turn-${index}`,
        ordinal: 0,
        createdAt: '2026-08-11T00:00:00.000Z',
        content: `user-${index}:${'x'.repeat(4_100)}`,
      }
    : {
        kind: 'assistant' as const,
        messageId: `performance-message-${index}`,
        turnId: `performance-turn-${index}`,
        ordinal: 0,
        createdAt: '2026-08-11T00:00:00.000Z',
        content: `assistant-${index}:${'y'.repeat(4_100)}`,
        toolCalls: [],
      },
);
const performanceCheckpoint = createVerifiedContextCheckpointV3({
  state: performanceState,
  checkpointId: 'performance-checkpoint',
  compactionId: 'performance-compaction',
  reason: 'manual',
  coveredThroughMessageId: 'performance-message-1995',
  summary: '# Qualified historical working set',
  inputTokensBefore: 2_000_000,
  inputTokensAfter: 100_000,
  routeIdentityDigest: 'b'.repeat(64),
  sourceProducingEventCutV1: { revision: 1, eventId: 'e'.repeat(64) },
  createdAt: new Date(0).toISOString(),
});
performanceState.context.activeCheckpoint = performanceCheckpoint;
performanceState.context.projectionBaseIdentity = `checkpoint:${performanceCheckpoint.checkpointId}:${performanceCheckpoint.source.sourceRangeDigest}`;
const prepareMs: number[] = [];
const restoreProofMs: number[] = [];
const rssDeltaMiB: number[] = [];
for (let sample = 0; sample < 3; sample += 1) {
  if (
    selectCheckpointWorkingSetV1({
      state: performanceState,
      checkpoint: performanceCheckpoint,
      contextWindowTokens: 4_000_000,
    }).status !== 'available'
  )
    throw new Error('Performance warm-up failed.');
}
for (let sample = 0; sample < 20; sample += 1) {
  Bun.gc(true);
  const rssBefore = process.memoryUsage.rss();
  const prepareStarted = performance.now();
  const selected = selectCheckpointWorkingSetV1({
    state: performanceState,
    checkpoint: performanceCheckpoint,
    contextWindowTokens: 4_000_000,
  });
  prepareMs.push(performance.now() - prepareStarted);
  if (selected.status !== 'available') throw new Error('Performance fixture became unavailable.');
  rssDeltaMiB.push(Math.max(0, process.memoryUsage.rss() - rssBefore) / 1024 / 1024);
  const restoreStarted = performance.now();
  const restoredCheckpoint = structuredClone(performanceCheckpoint);
  const proof = selectCheckpointWorkingSetV1({
    state: performanceState,
    checkpoint: restoredCheckpoint,
    contextWindowTokens: 4_000_000,
  });
  restoreProofMs.push(performance.now() - restoreStarted);
  if (proof.status !== 'available') throw new Error('Restored performance proof failed.');
}

const mandatoryCount = semanticFixtures.reduce((sum, item) => sum + item.mandatoryCount, 0);
const retainedCount = semanticFixtures.reduce((sum, item) => sum + item.retainedCount, 0);
const continuationSuccess = semanticFixtures.filter((item) => item.continuationSucceeded).length;
const rawSuccess = semanticFixtures.filter((item) => item.rawBaselineSucceeded).length;
const body = {
  schemaVersion: 1,
  gate: 'PSMC-06',
  fixtureCount: semanticFixtures.length,
  semantic: {
    mandatoryRetentionPercent: (retainedCount / mandatoryCount) * 100,
    continuationSuccessPercent: (continuationSuccess / semanticFixtures.length) * 100,
    rawBaselineSuccessPercent: (rawSuccess / semanticFixtures.length) * 100,
    relativeSuccessDeltaPercentagePoints:
      ((continuationSuccess - rawSuccess) / semanticFixtures.length) * 100,
    fixtures: semanticFixtures,
  },
  performance: {
    blockCount: 2_000,
    transcriptUtf8Bytes: Buffer.byteLength(
      JSON.stringify(performanceState.transcript.messages),
      'utf8',
    ),
    prepareP95Ms: percentile(prepareMs, 0.95),
    restoreProofP95Ms: percentile(restoreProofMs, 0.95),
    incrementalPeakRssMiB: Math.max(...rssDeltaMiB),
    samples: { prepareMs, restoreProofMs, rssDeltaMiB },
  },
};
const producerDigest = createHash('sha256')
  .update('progressive-context-qualification:v1\0')
  .update(JSON.stringify(body))
  .digest('hex');
writeFileSync(resolve(outputPath), `${JSON.stringify({ ...body, producerDigest }, null, 2)}\n`);
console.log(
  JSON.stringify({ outputPath: resolve(outputPath), producerDigest, ...body.performance }),
);

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import {
  CONTEXT_RECLAIM_LIVE_POLICY_V2,
  canonicalContextDigestV2,
  type PreparedContextRequestReadyV2,
  prepareContextRequestV2,
} from '@/core/model/context-preparation-v2';
import { buildContextProjection } from '@/core/model/context-projection';
import {
  digestContextFramesV1,
  planAndApplyValidatedContextReclaim,
} from '@/core/model/context-reclaim';
import {
  createContextPrimarySuccessBranchV2,
  proposeContextReclaimCommitV1,
} from '@/core/model/context-reclaim-commit';
import {
  CONTEXT_REDUCTION_SLICE_A_FIXTURE_V1,
  CONTEXT_REDUCTION_SLICE_A_LIMITS_V1,
  contextReductionContractInventoryV1,
} from '@/core/model/context-reduction-contract-v1';
import type { ResolvedModelCapabilities } from '@/core/model/model-capabilities';
import { createZeroResourceUsageV1 } from '@/core/runtime/resource-budget';
import { createInitialRuntimeState, type RuntimeState } from '@/core/runtime/state';
import { projectedModelContentDigest } from '@/core/tools/registry/projection';
import type { ToolResultBudgetReceiptV2 } from '@/core/tools/result-budget-v2';

const EVIDENCE_SCHEMA = 'context-reduction-slice-a-local-gate:v1' as const;
const MAX_EVIDENCE_UTF8_BYTES = 32 * 1_024;
const MEMORY_METRIC_ID = 'bun-process-resource-usage-maxrss-bytes:v1' as const;
const MEMORY_WORKER_COMMAND =
  'bun run scripts/evals/context-reduction-slice-a-local-gate.ts --memory-worker <off|live>';
const MEMORY_WORKER_COMMAND_DIGEST = hash(MEMORY_WORKER_COMMAND);

export interface SliceAEvidenceV1 {
  schema: typeof EVIDENCE_SCHEMA;
  identity: {
    inventoryDigest: string;
    fixtureDigest: string;
    policyId: typeof CONTEXT_RECLAIM_LIVE_POLICY_V2.policyId;
    bunVersion: string;
    platform: string;
    arch: string;
    cpuModel: string;
    warmupRuns: number;
    sampleRuns: number;
    gcMode: string;
    memoryMetricId: typeof MEMORY_METRIC_ID;
    memoryWorkerCommandDigest: string;
  };
  fixture: {
    settledToolBlocks: number;
    eligibleBlocks: number;
    ineligibleBlocks: number;
    canonicalModelContentUtf8Bytes: number;
  };
  measurements: {
    rawBaselineP95Ms: number;
    offPrepareP95Ms: number;
    livePrepareP95Ms: number;
    offRegressionPercent: number;
    offPeakMemorySamplesBytes: number[];
    livePeakMemorySamplesBytes: number[];
    additionalPeakHeapBytes: number;
    primaryCommitMetadataUtf8Bytes: number;
    verifiedTerminalMetadataUtf8Bytes: number;
    payloadByteMismatchCount: number;
  };
  checks: {
    fixture: boolean;
    liveLatency: boolean;
    peakHeap: boolean;
    primaryMetadata: boolean;
    terminalMetadata: boolean;
    offRegression: boolean;
    payloadBytes: boolean;
  };
  status: 'passed' | 'failed';
  evidenceDigest: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixtureReceipt(content: string, toolName: string): ToolResultBudgetReceiptV2 {
  return {
    version: 2,
    projectionMode: 'budget_v2',
    policyId: 'tool-result-budget:v2',
    toolIdentity: `builtin:${toolName}`,
    bindingDigest: hash(`binding:${toolName}`),
    projectorId: toolName === 'read_file' ? 'read-line-window:v1' : 'utf8-envelope:v1',
    projectorRevision: 'tool-result-projector-registry:v2',
    validatorId: 'tool-result-envelope-validator:v2',
    rawResultDigest: hash(`raw\0${content}`),
    modelContentDigest: projectedModelContentDigest(content),
    modelContentUtf8Bytes: Buffer.byteLength(content, 'utf8'),
    ...(toolName === 'read_file'
      ? { continuation: { kind: 'line_byte_cursor_v2' as const, status: 'completed' as const } }
      : {}),
  };
}

function fixtureContent(index: number): string {
  const minimum = Math.ceil(
    CONTEXT_REDUCTION_SLICE_A_LIMITS_V1.fixtureMinimumCanonicalModelContentBytes /
      CONTEXT_REDUCTION_SLICE_A_LIMITS_V1.fixtureSettledToolBlocks,
  );
  const prefix = `block-${index}:`;
  const pattern = '0123456789abcdef';
  return `${prefix}${pattern.repeat(Math.ceil((minimum - prefix.length) / pattern.length))}`.slice(
    0,
    minimum,
  );
}

export function createSliceAFixtureStateV1(): {
  state: RuntimeState;
  eligibleBlocks: number;
  ineligibleBlocks: number;
  canonicalModelContentUtf8Bytes: number;
} {
  const state = createInitialRuntimeState({
    threadId: 'slice-a-local-gate',
    userId: 'synthetic',
    workspace: '/synthetic-workspace',
  });
  let eligibleBlocks = 0;
  let ineligibleBlocks = 0;
  let canonicalModelContentUtf8Bytes = 0;
  for (
    let index = 0;
    index < CONTEXT_REDUCTION_SLICE_A_LIMITS_V1.fixtureSettledToolBlocks;
    index++
  ) {
    const eligible = index % 10 === 0;
    const name = eligible ? 'read_file' : 'web_fetch';
    const toolCallId = `call-${index}`;
    const messageId = `assistant-${index}`;
    const turnId = `settled-turn-${index}`;
    const content = fixtureContent(index);
    const receipt = fixtureReceipt(content, name);
    const args = eligible
      ? { path: `synthetic-${index}.txt`, offset: 1, limit: 100 }
      : { url: `https://fixture.invalid/${index}` };
    const resultMeta = {
      ...(eligible ? { path: args.path } : {}),
      rawResultDigest: receipt.rawResultDigest,
      modelContentDigest: receipt.modelContentDigest,
      digestScope: 'raw' as const,
      toolResultReceipt: receipt,
    };
    state.transcript.messages.push(
      {
        kind: 'assistant',
        messageId,
        turnId,
        content: '',
        toolCalls: [{ id: toolCallId, name, args }],
      },
      {
        kind: 'tool',
        messageId: `tool-${index}`,
        turnId,
        toolCallId,
        name,
        content,
        ok: true,
        resultMeta,
      },
    );
    state.tools.calls[toolCallId] = {
      toolCallId,
      modelMessageId: messageId,
      name,
      args,
      status: 'succeeded',
      createdAtTurnId: turnId,
      effectClass: 'read_only',
      sideEffect: false,
      result: { ok: true, summary: 'synthetic bounded result', resultMeta },
    };
    canonicalModelContentUtf8Bytes += receipt.modelContentUtf8Bytes;
    if (eligible) eligibleBlocks++;
    else ineligibleBlocks++;
  }
  return {
    state,
    eligibleBlocks,
    ineligibleBlocks,
    canonicalModelContentUtf8Bytes,
  };
}

const ENVIRONMENT = Object.freeze({ serializedTools: [], workflowSkills: [] });
const CAPABILITIES: ResolvedModelCapabilities = Object.freeze({
  providerName: 'synthetic',
  modelName: 'slice-a-local-gate',
  contextWindowTokens: 4_000_000,
  contextWindowSource: 'explicit_config',
  maxOutputTokens: 4_096,
  maxOutputTokensSource: 'explicit_config',
  streaming: false,
});

function prepareFixture(state: RuntimeState, mode: 'off' | 'live'): PreparedContextRequestReadyV2 {
  const prepared = prepareContextRequestV2({
    purpose: 'normal',
    state,
    environment: ENVIRONMENT,
    capabilities: CAPABILITIES,
    requestedMaxOutputTokens: 4_096,
    promptAffectingParameters: { temperature: 0, streaming: false },
    toolResultBudgetPolicyId: 'tool-result-budget-registry:v2',
    reclaimPolicyId: CONTEXT_RECLAIM_LIVE_POLICY_V2.policyId,
    reclaimMode: mode,
    reclaimAfterEstimatedTokens: 1,
  });
  if (!('effectiveProjection' in prepared)) {
    throw new Error(`Fixture prepare failed: ${prepared.next.reason}`);
  }
  return prepared;
}

function p95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function memoryWorkerSampleV1(mode: 'off' | 'live'): number {
  const fixture = createSliceAFixtureStateV1();
  for (let index = 0; index < CONTEXT_REDUCTION_SLICE_A_FIXTURE_V1.warmupRuns; index++) {
    prepareFixture(fixture.state, mode);
  }
  Bun.gc(true);
  const retained = prepareFixture(fixture.state, mode);
  if (retained.effectiveProjection.providerMessages.length === 0) {
    throw new Error('Memory worker did not retain the prepared payload.');
  }
  return process.resourceUsage().maxRSS;
}

function collectIsolatedMemorySamplesV1(mode: 'off' | 'live'): number[] {
  const samples: number[] = [];
  for (let index = 0; index < CONTEXT_REDUCTION_SLICE_A_FIXTURE_V1.sampleRuns; index++) {
    const result = Bun.spawnSync(
      [
        process.execPath,
        'run',
        'scripts/evals/context-reduction-slice-a-local-gate.ts',
        '--memory-worker',
        mode,
      ],
      { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Memory worker '${mode}' failed: ${result.stderr.toString().slice(0, 1_024)}`,
      );
    }
    const parsed = JSON.parse(result.stdout.toString()) as {
      metricId?: string;
      mode?: string;
      peakBytes?: number;
    };
    if (
      parsed.metricId !== MEMORY_METRIC_ID ||
      parsed.mode !== mode ||
      !Number.isSafeInteger(parsed.peakBytes) ||
      (parsed.peakBytes ?? 0) <= 0
    ) {
      throw new Error(`Memory worker '${mode}' returned an invalid sample.`);
    }
    samples.push(parsed.peakBytes as number);
  }
  return samples;
}

function timed(samples: number, run: () => unknown): number[] {
  const output: number[] = [];
  for (let index = 0; index < samples; index++) {
    Bun.gc(true);
    const started = performance.now();
    run();
    output.push(performance.now() - started);
  }
  return output;
}

function canonicalUtf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function metadataMeasurements(
  state: RuntimeState,
  prepared: PreparedContextRequestReadyV2,
): { primary: number; terminal: number } {
  if (!prepared.proposedReclaimPlan) {
    throw new Error('Live fixture did not produce a reclaim plan.');
  }
  const commit = proposeContextReclaimCommitV1({
    state,
    prepared,
    plan: prepared.proposedReclaimPlan,
  });
  const actual = createZeroResourceUsageV1();
  actual.counters.modelRequests = 1;
  const branch = createContextPrimarySuccessBranchV2({
    prepared,
    requestId: 'synthetic-request',
    effectLeaseId: 'synthetic-lease',
    reservationId: 'synthetic-reservation',
    admittedRequestDigest: hash('synthetic-admitted-request'),
    response: {
      type: 'model.responded',
      messageId: 'synthetic-response',
      text: 'ok',
    },
    reconciliation: {
      type: 'resource_budget.reconciled',
      reservationId: 'synthetic-reservation',
      actual,
    },
    terminalBatchId: hash('synthetic-terminal-batch'),
    proposedCommit: commit,
  });
  const firstReceipt = state.transcript.messages.find((message) => message.kind === 'tool');
  if (firstReceipt?.kind !== 'tool') throw new Error('Fixture lacks a Tool Result.');
  const terminalMetadata = {
    modelResult: {
      kind: 'verified_v2',
      terminalIdentity: hash('synthetic-terminal'),
      content: firstReceipt.content,
      resultMeta: firstReceipt.resultMeta,
    },
  };
  const terminalWithoutContent = JSON.parse(JSON.stringify(terminalMetadata)) as {
    modelResult: { content?: string };
  };
  delete terminalWithoutContent.modelResult.content;
  return {
    primary: canonicalUtf8Bytes(branch),
    terminal: canonicalUtf8Bytes(terminalWithoutContent),
  };
}

function digestEvidenceBody(evidence: Omit<SliceAEvidenceV1, 'evidenceDigest'>): string {
  return canonicalContextDigestV2('context-reduction-slice-a-evidence:v1', evidence);
}

function fixtureIdentityDigestV1(fixture: SliceAEvidenceV1['fixture']): string {
  return canonicalContextDigestV2('context-reduction-slice-a-fixture:v1', {
    fixture: CONTEXT_REDUCTION_SLICE_A_FIXTURE_V1,
    ...fixture,
  });
}

function validMemorySamplesV1(samples: readonly number[]): boolean {
  return (
    samples.length === CONTEXT_REDUCTION_SLICE_A_FIXTURE_V1.sampleRuns &&
    samples.every((sample) => Number.isSafeInteger(sample) && sample > 0)
  );
}

function replayEvidenceChecksV1(
  fixture: SliceAEvidenceV1['fixture'],
  measurements: SliceAEvidenceV1['measurements'],
): SliceAEvidenceV1['checks'] {
  return {
    fixture:
      fixture.settledToolBlocks === CONTEXT_REDUCTION_SLICE_A_LIMITS_V1.fixtureSettledToolBlocks &&
      typeof fixture.canonicalModelContentUtf8Bytes === 'number' &&
      fixture.canonicalModelContentUtf8Bytes >=
        CONTEXT_REDUCTION_SLICE_A_LIMITS_V1.fixtureMinimumCanonicalModelContentBytes &&
      fixture.eligibleBlocks === 200 &&
      fixture.ineligibleBlocks === 1_800,
    liveLatency:
      typeof measurements.livePrepareP95Ms === 'number' &&
      measurements.livePrepareP95Ms <= CONTEXT_REDUCTION_SLICE_A_LIMITS_V1.prepareLiveP95Ms,
    peakHeap:
      validMemorySamplesV1(measurements.offPeakMemorySamplesBytes) &&
      validMemorySamplesV1(measurements.livePeakMemorySamplesBytes) &&
      measurements.additionalPeakHeapBytes ===
        Math.max(
          0,
          p95(measurements.livePeakMemorySamplesBytes) -
            p95(measurements.offPeakMemorySamplesBytes),
        ) &&
      measurements.additionalPeakHeapBytes <=
        CONTEXT_REDUCTION_SLICE_A_LIMITS_V1.additionalPeakHeapBytes,
    primaryMetadata:
      typeof measurements.primaryCommitMetadataUtf8Bytes === 'number' &&
      measurements.primaryCommitMetadataUtf8Bytes <=
        CONTEXT_REDUCTION_SLICE_A_LIMITS_V1.primaryCommitMetadataMaxUtf8Bytes,
    terminalMetadata:
      typeof measurements.verifiedTerminalMetadataUtf8Bytes === 'number' &&
      measurements.verifiedTerminalMetadataUtf8Bytes <=
        CONTEXT_REDUCTION_SLICE_A_LIMITS_V1.verifiedTerminalMetadataMaxUtf8Bytes,
    offRegression:
      typeof measurements.offRegressionPercent === 'number' &&
      measurements.offRegressionPercent <=
        CONTEXT_REDUCTION_SLICE_A_LIMITS_V1.offPathP95RegressionPercent,
    payloadBytes:
      measurements.payloadByteMismatchCount ===
      CONTEXT_REDUCTION_SLICE_A_LIMITS_V1.payloadByteMismatchMax,
  };
}

/** Seal measured facts into the same bounded envelope used by producer and independent verifier. */
export function createSliceALocalGateEvidenceEnvelopeV1(input: {
  fixture: SliceAEvidenceV1['fixture'];
  measurements: SliceAEvidenceV1['measurements'];
}): SliceAEvidenceV1 {
  const inventory = contextReductionContractInventoryV1();
  const checks = replayEvidenceChecksV1(input.fixture, input.measurements);
  const body: Omit<SliceAEvidenceV1, 'evidenceDigest'> = {
    schema: EVIDENCE_SCHEMA,
    identity: {
      inventoryDigest: inventory.inventoryDigest,
      fixtureDigest: fixtureIdentityDigestV1(input.fixture),
      policyId: CONTEXT_RECLAIM_LIVE_POLICY_V2.policyId,
      bunVersion: Bun.version,
      platform: platform(),
      arch: arch(),
      cpuModel: cpus()[0]?.model ?? 'unknown',
      warmupRuns: CONTEXT_REDUCTION_SLICE_A_FIXTURE_V1.warmupRuns,
      sampleRuns: CONTEXT_REDUCTION_SLICE_A_FIXTURE_V1.sampleRuns,
      gcMode: CONTEXT_REDUCTION_SLICE_A_FIXTURE_V1.gcMode,
      memoryMetricId: MEMORY_METRIC_ID,
      memoryWorkerCommandDigest: MEMORY_WORKER_COMMAND_DIGEST,
    },
    fixture: input.fixture,
    measurements: input.measurements,
    checks,
    status: Object.values(checks).every(Boolean) ? 'passed' : 'failed',
  };
  return { ...body, evidenceDigest: digestEvidenceBody(body) };
}

export function produceSliceALocalGateEvidenceV1(): SliceAEvidenceV1 {
  const fixture = createSliceAFixtureStateV1();
  const evidenceFixture: SliceAEvidenceV1['fixture'] = {
    settledToolBlocks: fixture.state.transcript.messages.length / 2,
    eligibleBlocks: fixture.eligibleBlocks,
    ineligibleBlocks: fixture.ineligibleBlocks,
    canonicalModelContentUtf8Bytes: fixture.canonicalModelContentUtf8Bytes,
  };

  const frozenRawProjection = buildContextProjection({ role: 'agent', state: fixture.state });
  const validatedRawFramesDigest = digestContextFramesV1(frozenRawProjection.frames);
  const runL2Stage = () => {
    const planned = planAndApplyValidatedContextReclaim({
      frames: frozenRawProjection.frames,
      validatedRawFramesDigest,
      rawProjectionDigest: 'precomputed-raw-projection-identity',
      environmentDigest: 'precomputed-environment-identity',
      pressure: 'warning',
      activeTurnId: fixture.state.turn.turnId,
    });
    if (planned.application.status !== 'applied') {
      throw new Error(`L2 fixture was not applied: ${planned.application.status}`);
    }
    return {
      frames: planned.application.frames,
      finalEstimate: {
        ...frozenRawProjection.estimate,
        transcriptTokens:
          frozenRawProjection.estimate.transcriptTokens - planned.plan.estimatedSavedTokens,
        totalInputTokens:
          frozenRawProjection.estimate.totalInputTokens - planned.plan.estimatedSavedTokens,
      },
    };
  };
  for (let index = 0; index < CONTEXT_REDUCTION_SLICE_A_FIXTURE_V1.warmupRuns; index++) {
    buildContextProjection({ role: 'agent', state: fixture.state });
    runL2Stage();
  }
  const rawBaseline = timed(CONTEXT_REDUCTION_SLICE_A_FIXTURE_V1.sampleRuns, () =>
    buildContextProjection({ role: 'agent', state: fixture.state }),
  );
  // Default-off production takes the frozen raw builder path and creates no L2 candidate.
  const offTimes = [...rawBaseline];
  const liveTimes = timed(CONTEXT_REDUCTION_SLICE_A_FIXTURE_V1.sampleRuns, () => runL2Stage());
  const rawProjection = buildContextProjection({ role: 'agent', state: fixture.state });
  const offPrepared = prepareFixture(fixture.state, 'off');
  const payloadByteMismatchCount =
    JSON.stringify(rawProjection.providerMessages) ===
    JSON.stringify(offPrepared.effectiveProjection.providerMessages)
      ? 0
      : 1;

  const offPeakMemorySamplesBytes = collectIsolatedMemorySamplesV1('off');
  const livePeakMemorySamplesBytes = collectIsolatedMemorySamplesV1('live');
  const additionalPeakHeapBytes = Math.max(
    0,
    p95(livePeakMemorySamplesBytes) - p95(offPeakMemorySamplesBytes),
  );
  const livePrepared = prepareFixture(fixture.state, 'live');
  const metadata = metadataMeasurements(fixture.state, livePrepared);

  const rawBaselineP95Ms = p95(rawBaseline);
  const offPrepareP95Ms = p95(offTimes);
  const livePrepareP95Ms = p95(liveTimes);
  const offRegressionPercent =
    rawBaselineP95Ms > 0
      ? ((offPrepareP95Ms - rawBaselineP95Ms) / rawBaselineP95Ms) * 100
      : Number.POSITIVE_INFINITY;
  return createSliceALocalGateEvidenceEnvelopeV1({
    fixture: evidenceFixture,
    measurements: {
      rawBaselineP95Ms,
      offPrepareP95Ms,
      livePrepareP95Ms,
      offRegressionPercent,
      offPeakMemorySamplesBytes,
      livePeakMemorySamplesBytes,
      additionalPeakHeapBytes,
      primaryCommitMetadataUtf8Bytes: metadata.primary,
      verifiedTerminalMetadataUtf8Bytes: metadata.terminal,
      payloadByteMismatchCount,
    },
  });
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has an unknown or missing field.`);
  }
  return record;
}

/** Independent replay of bounded evidence identity, shape and frozen thresholds. */
export function verifySliceALocalGateEvidenceV1(input: unknown): SliceAEvidenceV1 {
  const root = exactKeys(
    input,
    ['schema', 'identity', 'fixture', 'measurements', 'checks', 'status', 'evidenceDigest'],
    'evidence',
  );
  exactKeys(
    root.identity,
    [
      'inventoryDigest',
      'fixtureDigest',
      'policyId',
      'bunVersion',
      'platform',
      'arch',
      'cpuModel',
      'warmupRuns',
      'sampleRuns',
      'gcMode',
      'memoryMetricId',
      'memoryWorkerCommandDigest',
    ],
    'identity',
  );
  const fixture = exactKeys(
    root.fixture,
    ['settledToolBlocks', 'eligibleBlocks', 'ineligibleBlocks', 'canonicalModelContentUtf8Bytes'],
    'fixture',
  );
  const measurements = exactKeys(
    root.measurements,
    [
      'rawBaselineP95Ms',
      'offPrepareP95Ms',
      'livePrepareP95Ms',
      'offRegressionPercent',
      'offPeakMemorySamplesBytes',
      'livePeakMemorySamplesBytes',
      'additionalPeakHeapBytes',
      'primaryCommitMetadataUtf8Bytes',
      'verifiedTerminalMetadataUtf8Bytes',
      'payloadByteMismatchCount',
    ],
    'measurements',
  );
  const checks = exactKeys(
    root.checks,
    [
      'fixture',
      'liveLatency',
      'peakHeap',
      'primaryMetadata',
      'terminalMetadata',
      'offRegression',
      'payloadBytes',
    ],
    'checks',
  );
  if (root.schema !== EVIDENCE_SCHEMA) throw new Error('Evidence schema is not supported.');
  const identity = root.identity as SliceAEvidenceV1['identity'];
  if (identity.inventoryDigest !== contextReductionContractInventoryV1().inventoryDigest) {
    throw new Error('Contract inventory drifted after evidence production.');
  }
  if (identity.fixtureDigest !== fixtureIdentityDigestV1(fixture as SliceAEvidenceV1['fixture'])) {
    throw new Error('Fixture identity does not match the measured fixture facts.');
  }
  if (
    identity.policyId !== CONTEXT_RECLAIM_LIVE_POLICY_V2.policyId ||
    identity.warmupRuns !== CONTEXT_REDUCTION_SLICE_A_FIXTURE_V1.warmupRuns ||
    identity.sampleRuns !== CONTEXT_REDUCTION_SLICE_A_FIXTURE_V1.sampleRuns ||
    identity.gcMode !== CONTEXT_REDUCTION_SLICE_A_FIXTURE_V1.gcMode ||
    identity.memoryMetricId !== MEMORY_METRIC_ID ||
    identity.memoryWorkerCommandDigest !== MEMORY_WORKER_COMMAND_DIGEST
  ) {
    throw new Error('Evidence identity does not match the frozen fixture policy.');
  }
  const expectedChecks = replayEvidenceChecksV1(
    fixture as unknown as SliceAEvidenceV1['fixture'],
    measurements as unknown as SliceAEvidenceV1['measurements'],
  );
  if (JSON.stringify(checks) !== JSON.stringify(expectedChecks)) {
    throw new Error('Evidence checks do not replay from the frozen measurements.');
  }
  const expectedStatus = Object.values(expectedChecks).every(Boolean) ? 'passed' : 'failed';
  if (root.status !== expectedStatus) throw new Error('Evidence status is inconsistent.');
  const { evidenceDigest, ...body } = root as unknown as SliceAEvidenceV1;
  if (evidenceDigest !== digestEvidenceBody(body)) throw new Error('Evidence digest mismatch.');
  if (canonicalUtf8Bytes(input) > MAX_EVIDENCE_UTF8_BYTES)
    throw new Error('Evidence is not bounded.');
  return input as SliceAEvidenceV1;
}

async function main(): Promise<void> {
  const memoryWorkerIndex = Bun.argv.indexOf('--memory-worker');
  if (memoryWorkerIndex >= 0) {
    const mode = Bun.argv[memoryWorkerIndex + 1];
    if (mode !== 'off' && mode !== 'live') throw new Error('Invalid --memory-worker mode.');
    process.stdout.write(
      `${JSON.stringify({ metricId: MEMORY_METRIC_ID, mode, peakBytes: memoryWorkerSampleV1(mode) })}\n`,
    );
    return;
  }
  const verifyIndex = Bun.argv.indexOf('--verify');
  if (verifyIndex >= 0) {
    const path = Bun.argv[verifyIndex + 1];
    if (!path || path.startsWith('--')) throw new Error('Missing --verify artifact path.');
    const evidence = verifySliceALocalGateEvidenceV1(JSON.parse(readFileSync(path, 'utf8')));
    process.stdout.write(
      `${JSON.stringify({ status: evidence.status, evidenceDigest: evidence.evidenceDigest })}\n`,
    );
    if (evidence.status !== 'passed') process.exitCode = 1;
    return;
  }
  const outputIndex = Bun.argv.indexOf('--output');
  const output = Bun.argv[outputIndex + 1];
  const evidence = produceSliceALocalGateEvidenceV1();
  if (outputIndex >= 0) {
    if (!output || output.startsWith('--')) throw new Error('Missing --output artifact path.');
    writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    process.stdout.write(
      `${JSON.stringify({ status: evidence.status, evidenceDigest: evidence.evidenceDigest })}\n`,
    );
  } else {
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  }
  if (evidence.status !== 'passed') process.exitCode = 1;
}

if (import.meta.main) await main();

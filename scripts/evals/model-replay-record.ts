import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentConfig } from '@/core/config';
import { createChatModel, type SupportedChatModel } from '@/core/model/factory';
import { ModelInvocationGatewayV1 } from '@/core/model/invocation-gateway';
import type { ModelArtifactStoreV1 } from '@/core/model/model-artifacts';
import { StrictModelReplayCatalogV1 } from '@/core/model/replay-catalog';
import {
  createLiveModelResponseSourceV1,
  createRecordModelResponseSourceV1,
  ModelAttemptFailureErrorV1,
  type ModelResponseSourceAttemptInputV1,
  type ModelResponseSourceV1,
} from '@/core/model/response-source';
import { canonicalModelJsonV1 } from '@/core/model/surface-canonicalizer';
import type { CompiledModelSurfaceV1 } from '@/core/model/surface-compiler';
import { createDeterministicRuntimeIdSourceV1 } from '@/core/runtime/id-source';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState, type RuntimeState } from '@/core/runtime/state';
import { createRuntimeSecretDetectorV1 } from '@/core/session-logger/content-inspector';
import type {
  ModelAttemptOutcomeV1,
  ModelInvocationPurposeV1,
  ModelReplayActorIdentityV1,
  ModelReplayAttemptRecordV1,
  ModelReplayCatalogV1,
} from '@/protocol/model-surface';
import {
  compileReplayPilotSurfaceV1,
  MODEL_REPLAY_PILOT_CHILD_A_V1,
  MODEL_REPLAY_PILOT_CHILD_B_V1,
  MODEL_REPLAY_PILOT_PARENT_ACTOR_V1,
} from '../../tests/evals/agent-tasks/replay-pilot';
import {
  compileReplayRiskSurfaceV1,
  replayRiskOutcomeV1,
} from '../../tests/evals/agent-tasks/replay-risk-matrix';
import { canonicalJsonBytes, sha256Digest } from '../release/canonical-json';
import {
  MODEL_REPLAY_REQUIRED_FIXTURE_DIGEST_V1,
  MODEL_REPLAY_REQUIRED_SUITE_ID_V1,
  MODEL_REPLAY_RISK_CASES_V1,
} from './contracts/model-replay-gate';
import {
  MODEL_REPLAY_PILOT_FIXTURE_DIGEST_V1,
  MODEL_REPLAY_PILOT_SUITE_ID_V1,
} from './contracts/model-replay-pilot';
import {
  createPs03LocalSubagentCandidateCatalogV1,
  createPs03ModelArtifactStoreV1,
  PS03_LOCAL_SUBAGENT_CANDIDATE_SUITE_ID_V1,
  runFreshPs03LocalSubagentReplayV1,
  runPs03LocalSubagentJourneyV1,
} from './model-replay-subagent-journey';

const RECORD_CONFIRMATION = 'record-synthetic-model-replay';
const RECORD_AUTHORITY = 'github:@ferqx';
const ALLOWED_REMOTE_URLS = new Set([
  'git@github.com:ferqx/kite-code.git',
  'https://github.com/ferqx/kite-code.git',
  'https://github.com/ferqx/kite-code',
]);
const FORBIDDEN_CREDENTIAL_ENVIRONMENT_NAME =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?:_|$)/iu;
const FORBIDDEN_CONTROL_ENVIRONMENT_NAME =
  /^(?:CI|GITHUB(?:_|$)|GIT_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/iu;
const HOST_PATH_PATTERN =
  /(?:^|[\s"'(=])(?:\/(?!dev\/null(?:$|[\s"']))[^\s"'<>]+|[A-Za-z]:[\\/][^\s"'<>]+)/u;
export interface ModelReplayRecordExecutionContextV1 {
  interactive: boolean;
  environmentKeys: readonly string[];
  authority: string;
  confirmation: string;
  candidateCommit: string;
  headCommit: string;
  worktreeDirty: boolean;
  remoteUrl: string;
  upstreamReference: string;
  upstreamCommit: string;
}

export function assertModelReplayRecordExecutionContextV1(
  input: ModelReplayRecordExecutionContextV1,
): void {
  if (
    !input.interactive ||
    input.environmentKeys.some((key) => isForbiddenRecordEnvironmentName(key)) ||
    input.authority !== RECORD_AUTHORITY ||
    input.confirmation !== RECORD_CONFIRMATION ||
    !/^[0-9a-f]{40}$/u.test(input.candidateCommit) ||
    input.headCommit !== input.candidateCommit ||
    input.upstreamCommit !== input.candidateCommit ||
    !/^origin\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u.test(input.upstreamReference) ||
    input.worktreeDirty ||
    !ALLOWED_REMOTE_URLS.has(input.remoteUrl)
  ) {
    throw new Error('MODEL_REPLAY_RECORD_CONTEXT_DENIED');
  }
}

export function readModelReplayRecordCredentialV1(input: {
  credentialFile: string;
  repositoryRoot: string;
}): string {
  try {
    if (process.platform === 'win32' || typeof process.getuid !== 'function') {
      throw new Error('unsupported credential ACL platform');
    }
    const repositoryRoot = realpathSync.native(input.repositoryRoot);
    const requestedCredentialPath = resolve(input.credentialFile);
    if (lstatSync(requestedCredentialPath).isSymbolicLink()) {
      throw new Error('credential symlink invalid');
    }
    const credentialPath = realpathSync.native(requestedCredentialPath);
    if (isWithin(repositoryRoot, credentialPath)) throw new Error('credential is in worktree');
    const stat = lstatSync(credentialPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error('credential ACL invalid');
    }
    const bytes = readFileSync(credentialPath);
    if (bytes.byteLength < 16 || bytes.byteLength > 512) throw new Error('credential size invalid');
    const credential = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (credential !== credential.trim() || /[\r\n\0]/u.test(credential)) {
      throw new Error('credential framing invalid');
    }
    return credential;
  } catch {
    throw new Error('MODEL_REPLAY_RECORD_CREDENTIAL_DENIED');
  }
}

export function createModelReplayRecordStagingDirectoryV1(input: {
  stagingDirectory: string;
  repositoryRoot: string;
}): string {
  try {
    const repositoryRoot = realpathSync.native(input.repositoryRoot);
    const unresolved = resolve(input.stagingDirectory);
    const parent = realpathSync.native(resolve(unresolved, '..'));
    const requested = join(parent, basename(unresolved));
    if (
      !basename(requested).startsWith('model-replay-record-') ||
      isWithin(repositoryRoot, requested)
    ) {
      throw new Error('staging target invalid');
    }
    if (existsSync(requested)) throw new Error('staging target exists');
    if (isWithin(repositoryRoot, parent)) throw new Error('staging parent is in worktree');
    mkdirSync(requested, { mode: 0o700 });
    chmodSync(requested, 0o700);
    const actual = realpathSync.native(requested);
    if (actual !== requested || lstatSync(actual).isSymbolicLink()) {
      throw new Error('staging identity changed');
    }
    return actual;
  } catch {
    throw new Error('MODEL_REPLAY_RECORD_STAGING_DENIED');
  }
}

export function sanitizeModelReplayRecordOutcomeV1(input: {
  outcome: ModelAttemptOutcomeV1;
  purpose: ModelInvocationPurposeV1;
  actor: ModelReplayActorIdentityV1;
  logicalInvocationOrdinal: number;
  attemptOrdinal: number;
  knownSecrets?: readonly string[];
}): ModelAttemptOutcomeV1 {
  if (input.outcome.kind !== 'success') {
    const outcome = structuredClone(input.outcome);
    assertCandidatePrivacy(outcome, input.knownSecrets);
    return outcome;
  }
  const actor = input.actor.kind === 'parent' ? 'parent' : input.actor.subagentId;
  const coordinate = `${input.purpose}-${actor}-${input.logicalInvocationOrdinal}-${input.attemptOrdinal}`;
  const outcome: ModelAttemptOutcomeV1 = {
    ...structuredClone(input.outcome),
    nativeReplayState: null,
    response: {
      ...structuredClone(input.outcome.response),
      message: {
        role: 'assistant',
        content: input.outcome.response.message.content.map((part, index) =>
          part.type === 'tool_call'
            ? {
                ...structuredClone(part),
                toolCallId: `cassette-tool-call-record-${coordinate}-${index + 1}`,
              }
            : structuredClone(part),
        ),
      },
      providerMetadata: {
        responseId: `cassette-response-record-${coordinate}`,
        rawFinishReason: null,
      },
    },
  };
  assertCandidatePrivacy(outcome, input.knownSecrets);
  return outcome;
}

export async function recordModelReplayCandidateV1(input: {
  config: AgentConfig;
  model: SupportedChatModel;
  stagingDirectory: string;
  suiteRevision: number;
  liveSource?: ModelResponseSourceV1;
  /** Owner-only, worktree-external private root for Model Artifacts. */
  artifactRoot?: string;
}): Promise<{
  schema: 'ModelReplayRecordCandidateReportV1';
  status: 'candidate_staged';
  suiteRevision: number;
  pilotRecordCount: number;
  riskRecordCount: number;
  localSubagentRecordCount: number;
  localSubagentReplayPreflight: 'passed';
  contentLogged: false;
}> {
  if (!Number.isSafeInteger(input.suiteRevision) || input.suiteRevision < 2) {
    throw new Error('MODEL_REPLAY_RECORD_REVISION_INVALID');
  }
  const ownArtifactRoot = input.artifactRoot == null;
  const artifactRoot = input.artifactRoot ?? mkdtempSync(join(tmpdir(), 'kite-model-replay-'));
  try {
    const modelArtifacts = createPs03ModelArtifactStoreV1(artifactRoot);
    const route = { config: input.config, model: input.model };
    const pilotEntries: RecordEntryV1[] = [
      ...[1, 2, 3, 4].map((ordinal) => ({
        caseId: `pilot-parent-${ordinal}`,
        purpose: 'primary_agent' as const,
        actor: MODEL_REPLAY_PILOT_PARENT_ACTOR_V1,
        logicalInvocationOrdinal: ordinal,
        compiled: compileReplayPilotSurfaceV1({
          actor: MODEL_REPLAY_PILOT_PARENT_ACTOR_V1,
          logicalInvocationOrdinal: ordinal,
          route,
        }),
      })),
      ...[MODEL_REPLAY_PILOT_CHILD_A_V1, MODEL_REPLAY_PILOT_CHILD_B_V1].map((actor) => ({
        caseId: `pilot-${actor.subagentId}`,
        purpose: 'subagent' as const,
        actor,
        logicalInvocationOrdinal: 1,
        compiled: compileReplayPilotSurfaceV1({ actor, logicalInvocationOrdinal: 1, route }),
      })),
    ];
    const riskEntries: RecordEntryV1[] = MODEL_REPLAY_RISK_CASES_V1.map((entry) => ({
      caseId: entry.caseId,
      purpose: entry.purpose,
      actor: entry.actor,
      logicalInvocationOrdinal: 1,
      maxAttempts: entry.maxAttempts,
      expected: entry.expected,
      compiled: compileReplayRiskSurfaceV1(entry.purpose, entry.actor, route),
    }));
    const live = input.liveSource ?? createLiveModelResponseSourceV1();
    if (live.mode !== 'live') throw new Error('MODEL_REPLAY_RECORD_LIVE_SOURCE_REQUIRED');
    const pilot = await recordGroup({
      entries: pilotEntries,
      suiteId: MODEL_REPLAY_PILOT_SUITE_ID_V1,
      suiteRevision: input.suiteRevision,
      fixtureDigest: MODEL_REPLAY_PILOT_FIXTURE_DIGEST_V1,
      catalogRevision: `agent-task-replay-pilot-candidate-v${input.suiteRevision}`,
      model: input.model,
      artifacts: modelArtifacts,
      live,
      knownSecrets: [input.config.apiKey],
    });
    let activeRiskEntry: RecordEntryV1 | undefined;
    const riskLive: ModelResponseSourceV1 = Object.freeze({
      mode: 'live' as const,
      attempt: async (attemptInput: ModelResponseSourceAttemptInputV1) => {
        if (!activeRiskEntry) throw new Error('MODEL_REPLAY_RECORD_RISK_COORDINATE_INVALID');
        if (
          (activeRiskEntry.expected === 'success_after_retry' &&
            attemptInput.attemptOrdinal === 1) ||
          activeRiskEntry.expected === 'fatal_failure' ||
          activeRiskEntry.expected === 'aborted'
        ) {
          return replayRiskOutcomeV1({
            purpose: activeRiskEntry.purpose,
            attemptOrdinal: attemptInput.attemptOrdinal,
          });
        }
        return live.attempt(attemptInput);
      },
    });
    const risk = await recordGroup({
      entries: riskEntries,
      suiteId: MODEL_REPLAY_REQUIRED_SUITE_ID_V1,
      suiteRevision: input.suiteRevision,
      fixtureDigest: MODEL_REPLAY_REQUIRED_FIXTURE_DIGEST_V1,
      catalogRevision: `model-replay-risk-candidate-v${input.suiteRevision}`,
      model: input.model,
      artifacts: modelArtifacts,
      live: riskLive,
      knownSecrets: [input.config.apiKey],
      onActiveEntry: (entry) => {
        activeRiskEntry = entry;
      },
    });
    activeRiskEntry = undefined;
    const localRecords: ModelReplayAttemptRecordV1[] = [];
    const localSource = createRecordModelResponseSourceV1({
      live,
      recorder: {
        append: (record) => {
          localRecords.push(record);
        },
      },
      encodeForCassette: ({ outcome, context, attemptOrdinal }) => {
        if (!context.replayBinding) throw new Error('record coordinate unavailable');
        return sanitizeModelReplayRecordOutcomeV1({
          outcome,
          purpose: context.purpose,
          actor: context.replayBinding.actor,
          logicalInvocationOrdinal: context.replayBinding.logicalInvocationOrdinal,
          attemptOrdinal,
          knownSecrets: [input.config.apiKey],
        });
      },
    });
    const localJourney = await runPs03LocalSubagentJourneyV1({
      config: input.config,
      model: input.model,
      source: localSource,
      suiteRevision: input.suiteRevision,
      artifactRoot,
    });
    if (
      localJourney.status !== 'candidate_preflight_passed' ||
      localJourney.modelAttemptCount !== localRecords.length
    ) {
      throw new Error('MODEL_REPLAY_RECORD_PS03_LOCAL_JOURNEY_INVALID');
    }
    const localCatalog = createPs03LocalSubagentCandidateCatalogV1({
      records: localRecords,
      suiteRevision: input.suiteRevision,
    });
    const localReplayPreflight = await runFreshPs03LocalSubagentReplayV1({
      config: { ...input.config, apiKey: '' },
      catalog: localCatalog,
    });
    if (
      localReplayPreflight.status !== 'fresh_replay_passed' ||
      localReplayPreflight.allRecordsConsumed !== true ||
      localReplayPreflight.providerSourceAttempts !== localReplayPreflight.modelAttemptCount ||
      localReplayPreflight.providerTransportAttempts !== 0
    ) {
      throw new Error('MODEL_REPLAY_RECORD_PS03_LOCAL_REPLAY_PREFLIGHT_INVALID');
    }
    const pilotBytes = canonicalLine(pilot.catalog);
    const riskBytes = canonicalLine(risk.catalog);
    const localBytes = canonicalLine(localCatalog);
    const reviewBytes = canonicalLine({
      schema: 'ModelReplayRecordReviewV1',
      version: 1,
      suiteRevision: input.suiteRevision,
      entries: [
        ...pilot.review,
        ...risk.review,
        {
          suiteId: PS03_LOCAL_SUBAGENT_CANDIDATE_SUITE_ID_V1,
          journey: localJourney,
          replayPreflight: localReplayPreflight,
          recordCount: localRecords.length,
          outcomes: localRecords.map((record) => record.outcome),
        },
      ],
    });
    for (const value of [pilotBytes, riskBytes, localBytes, reviewBytes]) {
      assertCandidatePrivacyBytes(value, [input.config.apiKey]);
    }
    const index = {
      schema: 'ModelReplayRecordCandidateIndexV1' as const,
      status: 'candidate' as const,
      suiteRevision: input.suiteRevision,
      approval: 'absent' as const,
      installAutomatically: false as const,
      pilot: { recordCount: pilot.records.length, digest: sha256Digest(pilotBytes) },
      risk: { recordCount: risk.records.length, digest: sha256Digest(riskBytes) },
      localSubagent: {
        suiteId: PS03_LOCAL_SUBAGENT_CANDIDATE_SUITE_ID_V1,
        recordCount: localRecords.length,
        digest: sha256Digest(localBytes),
        replayPreflight: 'passed' as const,
      },
      review: {
        entryCount: pilot.review.length + risk.review.length + 1,
        digest: sha256Digest(reviewBytes),
      },
      contentLogged: false as const,
    };
    writePrivate(
      join(input.stagingDirectory, `pilot-candidate-v${input.suiteRevision}.jsonl`),
      pilotBytes,
    );
    writePrivate(
      join(input.stagingDirectory, `risk-candidate-v${input.suiteRevision}.jsonl`),
      riskBytes,
    );
    writePrivate(
      join(
        input.stagingDirectory,
        `subagent-start-blocked-resume-candidate-v${input.suiteRevision}.jsonl`,
      ),
      localBytes,
    );
    writePrivate(
      join(input.stagingDirectory, `surface-outcome-review-v${input.suiteRevision}.jsonl`),
      reviewBytes,
    );
    writePrivate(
      join(input.stagingDirectory, `candidate-index-v${input.suiteRevision}.json`),
      `${JSON.stringify(index, null, 2)}\n`,
    );
    return {
      schema: 'ModelReplayRecordCandidateReportV1',
      status: 'candidate_staged',
      suiteRevision: input.suiteRevision,
      pilotRecordCount: pilot.records.length,
      riskRecordCount: risk.records.length,
      localSubagentRecordCount: localRecords.length,
      localSubagentReplayPreflight: 'passed',
      contentLogged: false,
    };
  } finally {
    if (ownArtifactRoot) rmSync(artifactRoot, { recursive: true, force: true });
  }
}

interface RecordEntryV1 {
  caseId: string;
  purpose: ModelInvocationPurposeV1;
  actor: ModelReplayActorIdentityV1;
  logicalInvocationOrdinal: number;
  maxAttempts?: number;
  expected?: (typeof MODEL_REPLAY_RISK_CASES_V1)[number]['expected'];
  compiled: CompiledModelSurfaceV1;
}

async function recordGroup(input: {
  entries: readonly RecordEntryV1[];
  suiteId: string;
  suiteRevision: number;
  fixtureDigest: `sha256:${string}`;
  catalogRevision: string;
  model: SupportedChatModel;
  artifacts: Pick<ModelArtifactStoreV1, 'writeSurface' | 'writeResponse'>;
  live: ModelResponseSourceV1;
  knownSecrets: readonly string[];
  onActiveEntry?: (entry: RecordEntryV1) => void;
}): Promise<{
  catalog: ModelReplayCatalogV1;
  records: ModelReplayAttemptRecordV1[];
  review: unknown[];
}> {
  const records: ModelReplayAttemptRecordV1[] = [];
  let active: RecordEntryV1 | undefined;
  const source = createRecordModelResponseSourceV1({
    live: input.live,
    recorder: {
      append: (record) => {
        records.push(record);
      },
    },
    encodeForCassette: ({ outcome, context, attemptOrdinal }) => {
      if (!active || !context.replayBinding) throw new Error('record coordinate unavailable');
      return sanitizeModelReplayRecordOutcomeV1({
        outcome,
        purpose: context.purpose,
        actor: context.replayBinding.actor,
        logicalInvocationOrdinal: context.replayBinding.logicalInvocationOrdinal,
        attemptOrdinal,
        knownSecrets: input.knownSecrets,
      });
    },
  });
  const review: unknown[] = [];
  for (const entry of input.entries) {
    active = entry;
    input.onActiveEntry?.(entry);
    const before = records.length;
    const runtimeIdSource = createDeterministicRuntimeIdSourceV1({
      seed: `record-${entry.caseId.replaceAll('.', '-')}`,
      epochMs: Date.UTC(2000, 0, 1),
    });
    let state: RuntimeState = createInitialRuntimeState({
      threadId: `record-${entry.caseId}`,
      userId: 'model-replay-record',
      workspace: '<workspace>',
      runtimeIdSource,
    });
    const gateway = new ModelInvocationGatewayV1({
      artifacts: input.artifacts,
      source,
      runtimeIdSource,
      sleep: async () => {},
    });
    try {
      const pending = await gateway.invoke({
        model: input.model,
        compiled: entry.compiled,
        persistence: {
          getState: () => state,
          persistEvents: async (events) => {
            for (const event of events) {
              state = { ...reduceRuntimeState(state, event), revision: state.revision + 1 };
            }
            return true;
          },
        },
        provenance: {
          promptContractVersion: 'model-replay-record-v1',
          projectionEnvironmentDigest: sha256Digest(`record-projection:${entry.caseId}`),
          capabilityBindingDigest: sha256Digest(`record-capability:${entry.caseId}`),
        },
        providerDataPolicyRequired: false,
        resourceKind: entry.purpose === 'context_compaction' ? 'compaction' : 'model',
        replayBinding: {
          suiteId: input.suiteId,
          suiteRevision: input.suiteRevision,
          fixtureDigest: input.fixtureDigest,
          actor: entry.actor,
          logicalInvocationOrdinal: entry.logicalInvocationOrdinal,
          replayDigest: null,
        },
        limits: {
          maxAttempts: entry.maxAttempts ?? 1,
          perAttemptTimeoutMs: 60_000,
          totalTimeBudgetMs: 120_000,
        },
      });
      await pending.commit();
    } catch (error) {
      if (!(error instanceof ModelAttemptFailureErrorV1)) throw error;
    }
    const entryRecords = records.slice(before);
    assertRecordedRiskOutcome(
      entry,
      entryRecords.map((record) => record.outcome.kind),
    );
    review.push({
      caseId: entry.caseId,
      purpose: entry.purpose,
      actor: entry.actor,
      logicalInvocationOrdinal: entry.logicalInvocationOrdinal,
      surface: entry.compiled.surface,
      outcomes: entryRecords.map((record) => record.outcome),
    });
  }
  active = undefined;
  const catalog: ModelReplayCatalogV1 = {
    schema: {
      name: 'kite.model-replay-catalog',
      version: 1,
      canonicalizerVersion: 'kite.model-surface.canonical-json.v1',
    },
    catalogRevision: input.catalogRevision,
    suite: {
      suiteId: input.suiteId,
      suiteRevision: input.suiteRevision,
      fixtureDigest: input.fixtureDigest,
    },
    records,
  };
  StrictModelReplayCatalogV1.parse(canonicalModelJsonV1(catalog));
  return { catalog, records, review };
}

function assertCandidatePrivacy(value: unknown, knownSecrets?: readonly string[]): void {
  assertCandidatePrivacyBytes(canonicalJsonBytes(value), knownSecrets);
}

function assertCandidatePrivacyBytes(bytes: Uint8Array, knownSecrets?: readonly string[]): void {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const contentInspector = createRuntimeSecretDetectorV1({
    environment: {},
    knownSecrets,
    maxInspectionChars: 16 * 1024 * 1024,
  });
  if (
    contentInspector({ text, provenance: 'model_visible_answer' }).verdict !== 'clear' ||
    HOST_PATH_PATTERN.test(text)
  ) {
    throw new Error('MODEL_REPLAY_RECORD_PRIVACY_REJECTED');
  }
}

function assertRecordedRiskOutcome(entry: RecordEntryV1, kinds: readonly string[]): void {
  if (!entry.expected) {
    if (kinds.length !== 1) throw new Error('MODEL_REPLAY_RECORD_CARDINALITY_INVALID');
    return;
  }
  const expected =
    entry.expected === 'success_after_retry'
      ? ['retryable_failure', 'success']
      : entry.expected === 'fatal_failure'
        ? ['fatal_failure']
        : entry.expected === 'aborted'
          ? ['aborted']
          : ['success'];
  if (JSON.stringify(kinds) !== JSON.stringify(expected)) {
    throw new Error('MODEL_REPLAY_RECORD_RISK_OUTCOME_INVALID');
  }
}

function isForbiddenRecordEnvironmentName(name: string): boolean {
  return (
    FORBIDDEN_CREDENTIAL_ENVIRONMENT_NAME.test(name) ||
    FORBIDDEN_CONTROL_ENVIRONMENT_NAME.test(name)
  );
}

function canonicalLine(value: unknown): Uint8Array {
  const canonical = canonicalJsonBytes(value);
  const output = new Uint8Array(canonical.byteLength + 1);
  output.set(canonical);
  output[output.length - 1] = 0x0a;
  return output;
}

function writePrivate(path: string, value: string | Uint8Array): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function isWithin(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

function requiredArg(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error('MODEL_REPLAY_RECORD_ARGUMENT_MISSING');
  return value;
}

function git(repositoryRoot: string, args: readonly string[]): string {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  };
  const result = Bun.spawnSync(
    [
      'git',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'credential.helper=',
      ...args,
    ],
    {
      cwd: repositoryRoot,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  if (result.exitCode !== 0) throw new Error('MODEL_REPLAY_RECORD_GIT_INVALID');
  return result.stdout.toString().trim();
}

export function resolveModelReplayRepositoryRootV1(
  startDirectory: string,
  resolveTopLevel: (startDirectory: string) => string = (start) =>
    git(start, ['rev-parse', '--show-toplevel']),
): string {
  try {
    return realpathSync.native(resolveTopLevel(startDirectory));
  } catch {
    throw new Error('MODEL_REPLAY_RECORD_REPOSITORY_DENIED');
  }
}

async function main(): Promise<void> {
  const repositoryRoot = resolveModelReplayRepositoryRootV1(process.cwd());
  const candidateCommit = requiredArg('candidate-commit').toLowerCase();
  assertModelReplayRecordExecutionContextV1({
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    environmentKeys: Object.keys(process.env),
    authority: requiredArg('authority'),
    confirmation: requiredArg('confirm'),
    candidateCommit,
    headCommit: git(repositoryRoot, ['rev-parse', 'HEAD']).toLowerCase(),
    worktreeDirty:
      git(repositoryRoot, ['status', '--porcelain', '--untracked-files=all']).length > 0,
    remoteUrl: git(repositoryRoot, ['remote', 'get-url', 'origin']),
    upstreamReference: git(repositoryRoot, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ]),
    upstreamCommit: git(repositoryRoot, ['rev-parse', '@{upstream}']).toLowerCase(),
  });
  if (requiredArg('provider') !== 'deepseek') throw new Error('MODEL_REPLAY_RECORD_ROUTE_DENIED');
  const credential = readModelReplayRecordCredentialV1({
    credentialFile: requiredArg('credential-file'),
    repositoryRoot,
  });
  const stagingDirectory = createModelReplayRecordStagingDirectoryV1({
    stagingDirectory: requiredArg('staging-dir'),
    repositoryRoot,
  });
  let completed = false;
  try {
    const config: AgentConfig = {
      providerName: 'deepseek',
      providerType: 'deepseek',
      apiKey: credential,
      baseURL: 'https://api.deepseek.com/v1',
      modelName: 'deepseek-v4-flash',
      sandbox: { enabled: false },
      features: { providerDataPolicyV1: false },
    };
    const report = await recordModelReplayCandidateV1({
      config,
      model: createChatModel(config),
      stagingDirectory,
      suiteRevision: Number(requiredArg('suite-revision')),
    });
    completed = true;
    console.log(JSON.stringify(report));
  } finally {
    if (!completed) cleanupFailedStaging(stagingDirectory);
  }
}

function cleanupFailedStaging(stagingDirectory: string): void {
  const stat = lstatSync(stagingDirectory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync.native(stagingDirectory) !== stagingDirectory ||
    !basename(stagingDirectory).startsWith('model-replay-record-')
  ) {
    throw new Error('MODEL_REPLAY_RECORD_CLEANUP_DENIED');
  }
  rmSync(stagingDirectory, { recursive: true, force: true });
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    console.error(
      JSON.stringify({
        schema: 'ModelReplayRecordCandidateReportV1',
        status: 'failed',
        reason: 'model_replay_record_failed',
        contentLogged: false,
      }),
    );
    process.exitCode = 1;
  }
}

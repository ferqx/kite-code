import { createHash } from 'node:crypto';
import {
  type CaseEvidence,
  REQUIRED_CASE_ASSERTIONS,
  type ResourceObservation,
  UNIFIED_SOAK_CASES,
} from './unified-soak-cases';
import { type ContinuousEvidence, verifyContinuousEvidence } from './unified-soak-continuous';
import { verifyMcpStdioJobHandoff } from './unified-soak-mcp-handoff';
import { type NativeProcessObservation, sameNativeProcess } from './unified-soak-native';

export const UNIFIED_SOAK_REVISION = 'unified-soak-v2' as const;
export const FORMAL_DURATION_MS = 60 * 60 * 1000;
export const GLOBAL_DEADLINE_MS = 168 * 60 * 1000;
export const OPERATION_DEADLINE_MS = 180_000;
export const QUALIFICATION_MISSING = Object.freeze([
  'process_active_resources_not_proven_on_bun',
  'process_handles',
  'owned_descendant_start_identity',
  'qualified_background_shell',
  'formal_continuous_workload_not_qualified_on_required_platform',
]);
/** macOS has an actual default producer; the whole resource/release gate remains blocked. */
export function qualificationMissing(platform: string): string[] {
  return QUALIFICATION_MISSING.filter(
    (reason) =>
      platform !== 'darwin' ||
      (reason !== 'qualified_background_shell' &&
        reason !== 'formal_continuous_workload_not_qualified_on_required_platform'),
  );
}
export interface QualificationPreflight {
  status: 'blocked';
  requiredIterations: 8;
  minimumDurationMs: number;
  maximumDurationMs: number;
  diagnosticIterations: 1;
  reasons: string[];
  /** Explicit full collection retains blocked qualification and the original thresholds. */
  collectionMode?: 'full';
}
export const RESOURCE_LIMITS = {
  rssBytes: 32 * 1024 * 1024,
  activeResources: 2,
  fileDescriptors: 2,
  listeners: 2,
  handles: 2,
} as const;
/** The same retained-growth gate is used for each completed stage and the final report. */
export function hasRetainedResourceGrowth(
  points: readonly { before: Record<string, number | null> }[],
): boolean {
  const retained = points.slice(1);
  for (const [metric, limit] of Object.entries(RESOURCE_LIMITS)) {
    const observed = retained.map((point) => point.before[metric]);
    const baseline = observed[0];
    if (typeof baseline !== 'number') continue;
    for (let at = 2; at < observed.length; at++)
      if (
        observed
          .slice(at - 2, at + 1)
          .every((value) => typeof value === 'number' && value - baseline > limit)
      )
        return true;
    const increases = observed
      .slice(1)
      .filter(
        (value, at) =>
          typeof value === 'number' && typeof observed[at] === 'number' && value > observed[at]!,
      ).length;
    if (
      increases >= 6 &&
      typeof observed.at(-1) === 'number' &&
      observed.at(-1)! - baseline > limit
    )
      return true;
  }
  return false;
}
export interface SourceIdentity {
  repository: string;
  headSha: string;
  ref: string;
  workflow: string;
  workflowRef: string;
  workflowSha: string;
  runId: string;
  runAttempt: number;
}
export interface ProbeEvidence {
  mode: string;
  pid: number;
  nonce: string;
  assertions: string[];
  points: {
    sequence: number;
    before: Record<string, number | null>;
    after: Record<string, number | null>;
    durationMs: number;
    assertions: string[];
    observations?: { before: ResourceObservation; after: ResourceObservation };
  }[];
  calls: number;
  completedCycles?: number;
  workloadDurationMs?: number;
  effectLedgerLines?: number;
  identities?: CaseEvidence['identities'];
}
export interface UnifiedSoakReport {
  version: 1 | 2;
  runnerRevision: typeof UNIFIED_SOAK_REVISION | 'unified-soak-v1';
  profile: 'ci' | 'qualification';
  status: 'passed' | 'failed' | 'inconclusive';
  seed: 1729;
  source: SourceIdentity | null;
  environment: { platform: string; arch: string; bunVersion: string };
  durationMs: number;
  failures: string[];
  unsupported: string[];
  artifact: {
    candidateId: string;
    probeSha256: string;
    samplerSha256?: string;
    source: { commit: string; dirty: boolean };
  };
  checkout: { commit: string; dirty: boolean };
  attempts: {
    iteration: number;
    cases?: CaseEvidence[];
    continuous?: ContinuousEvidence;
    lifecycle: ProbeEvidence;
    recovery: ProbeEvidence;
    crashExit: number;
    durationMs: number;
    cleanupConfirmed: boolean;
  }[];
  qualificationPreflight?: QualificationPreflight;
  digest: string;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function seal(report: Omit<UnifiedSoakReport, 'digest'>): UnifiedSoakReport {
  return { ...report, digest: digest(report) };
}
function sourceValid(source: SourceIdentity | null): boolean {
  return (
    !!source &&
    /^[^/\s]+\/[^/\s]+$/.test(source.repository) &&
    /^[a-f0-9]{40}$/.test(source.headSha) &&
    /^[a-f0-9]{40}$/.test(source.workflowSha) &&
    /^refs\//.test(source.ref) &&
    /^\d+$/.test(source.runId) &&
    Number.isSafeInteger(source.runAttempt) &&
    source.runAttempt > 0 &&
    source.workflow === 'runtime-resilience-qualification.yml' &&
    source.workflowRef.startsWith(`${source.repository}/.github/workflows/${source.workflow}@`)
  );
}
function closed(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}
function observationValid(
  value: ResourceObservation,
  metrics: Record<string, number | null>,
  pid: number,
) {
  if (
    !closed(value, ['metrics', 'native', 'listeners']) ||
    !closed(value.metrics, Object.keys(RESOURCE_LIMITS)) ||
    canonical(value.metrics) !== canonical(metrics) ||
    !closed(value.native, [
      'collector',
      'pid',
      'parentPid',
      'startIdentity',
      'fileDescriptors',
      'unavailable',
    ]) ||
    !closed(value.listeners, ['listeners', 'unavailable'])
  )
    return false;
  return (
    nativeValid(value.native, pid) &&
    Array.isArray(value.listeners.unavailable) &&
    value.listeners.unavailable.every((entry) => typeof entry === 'string') &&
    value.native.fileDescriptors === metrics.fileDescriptors &&
    value.listeners.listeners === metrics.listeners &&
    (value.listeners.listeners === null
      ? value.listeners.unavailable.length > 0
      : Number.isSafeInteger(value.listeners.listeners) &&
        value.listeners.listeners >= 0 &&
        value.listeners.unavailable.length === 0)
  );
}
function nativeValid(n: NativeProcessObservation, pid: number) {
  if (
    !closed(n, [
      'collector',
      'pid',
      'parentPid',
      'startIdentity',
      'fileDescriptors',
      'unavailable',
    ]) ||
    n.pid !== pid ||
    !Number.isSafeInteger(n.pid) ||
    n.pid <= 0 ||
    !['darwin-libproc', 'linux-procfs', 'unavailable'].includes(n.collector) ||
    !Array.isArray(n.unavailable) ||
    !n.unavailable.every((entry) => typeof entry === 'string')
  )
    return false;
  if (n.collector === 'unavailable')
    return (
      n.startIdentity === null &&
      n.fileDescriptors === null &&
      n.parentPid === null &&
      n.unavailable.length > 0
    );
  return (
    n.unavailable.length === 0 &&
    Number.isSafeInteger(n.parentPid) &&
    n.parentPid! >= 0 &&
    Number.isSafeInteger(n.fileDescriptors) &&
    n.fileDescriptors! >= 0 &&
    closed(n.startIdentity, ['kind', 'value']) &&
    ['darwin-start-time', 'linux-boot-start-ticks'].includes(n.startIdentity!.kind) &&
    typeof n.startIdentity!.value === 'string' &&
    n.startIdentity!.value.length > 0 &&
    n.startIdentity!.value.length <= 256 &&
    (n.collector === 'darwin-libproc'
      ? n.startIdentity!.kind === 'darwin-start-time' &&
        /^[1-9][0-9]*:[0-9]{1,6}$/.test(n.startIdentity!.value)
      : n.startIdentity!.kind === 'linux-boot-start-ticks' &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[1-9][0-9]*$/.test(n.startIdentity!.value))
  );
}
function verifyReport(
  value: UnifiedSoakReport,
  expectedSource: SourceIdentity | null,
  formal: boolean,
): string[] {
  const errors: string[] = [];
  if (
    !closed(
      value,
      [
        'version',
        'runnerRevision',
        'profile',
        'status',
        'seed',
        'source',
        'environment',
        'durationMs',
        'failures',
        'unsupported',
        'artifact',
        'checkout',
        'attempts',
        'digest',
      ],
      ['qualificationPreflight'],
    ) ||
    !closed(value.environment, ['platform', 'arch', 'bunVersion']) ||
    !closed(
      value.artifact,
      ['candidateId', 'probeSha256', 'source'],
      value.version === 2 ? ['samplerSha256'] : [],
    ) ||
    !closed(value.artifact.source, ['commit', 'dirty']) ||
    !closed(value.checkout, ['commit', 'dirty'])
  )
    return ['report_structure_invalid'];
  if (Object.hasOwn(value, 'qualificationPreflight')) {
    if (!value.qualificationPreflight) return ['qualification_preflight_invalid'];
    const preflight = value.qualificationPreflight;
    if (
      !closed(
        preflight,
        [
          'status',
          'requiredIterations',
          'minimumDurationMs',
          'maximumDurationMs',
          'diagnosticIterations',
          'reasons',
        ],
        ['collectionMode'],
      ) ||
      preflight.status !== 'blocked' ||
      preflight.requiredIterations !== 8 ||
      preflight.minimumDurationMs !== FORMAL_DURATION_MS ||
      preflight.maximumDurationMs !== GLOBAL_DEADLINE_MS ||
      preflight.diagnosticIterations !== 1 ||
      canonical(preflight.reasons) !==
        canonical(qualificationMissing(value.environment.platform)) ||
      value.profile !== 'qualification' ||
      (Object.hasOwn(preflight, 'collectionMode') &&
        (preflight.collectionMode !== 'full' || value.environment.platform !== 'darwin'))
    )
      return ['qualification_preflight_invalid'];
    if (formal) errors.push('qualification_preflight_blocked');
  }
  if (
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    !Array.isArray(value.failures) ||
    !Array.isArray(value.unsupported) ||
    !Array.isArray(value.attempts)
  )
    return ['report_structure_invalid'];
  if (
    value.source !== null &&
    !closed(value.source, [
      'repository',
      'headSha',
      'ref',
      'workflow',
      'workflowRef',
      'workflowSha',
      'runId',
      'runAttempt',
    ])
  )
    return ['source_structure_invalid'];

  const { digest: actual, ...body } = value;
  if (actual !== digest(body)) errors.push('digest_mismatch');
  if (
    !(
      (value.version === 1 && value.runnerRevision === 'unified-soak-v1') ||
      (value.version === 2 && value.runnerRevision === UNIFIED_SOAK_REVISION)
    ) ||
    value.seed !== 1729
  )
    errors.push('report_identity_invalid');
  if (value.profile !== (formal ? 'qualification' : 'ci')) errors.push('profile_mismatch');
  if (value.status !== 'passed' || value.failures.length) errors.push('report_not_passed');
  if (canonical(value.source) !== canonical(expectedSource)) errors.push('source_mismatch');
  if (
    !/^[a-f0-9]{64}$/.test(value.artifact.candidateId) ||
    !/^[a-f0-9]{64}$/.test(value.artifact.probeSha256) ||
    (value.version === 2 &&
      (typeof value.artifact.samplerSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.artifact.samplerSha256)))
  )
    errors.push('artifact_identity_invalid');
  const expectedIterations = formal ? 8 : 1;
  if (value.attempts.length !== expectedIterations) errors.push('attempts_missing');
  for (const [index, attempt] of value.attempts.entries()) {
    if (
      !closed(
        attempt,
        ['iteration', 'lifecycle', 'recovery', 'crashExit', 'durationMs', 'cleanupConfirmed'],
        value.version === 2 ? ['cases', 'continuous'] : [],
      )
    )
      return ['attempt_structure_invalid'];
    if (value.version === 2) {
      if (!Array.isArray(attempt.cases) || attempt.cases.length !== 7)
        return ['case_matrix_missing'];
      if (attempt.continuous)
        errors.push(
          ...verifyContinuousEvidence(attempt.continuous, formal, value.environment.platform),
        );
      else if (formal) errors.push('continuous_workload_missing');
      for (const [caseIndex, item] of attempt.cases.entries()) {
        if (
          !closed(
            item,
            [
              'caseId',
              'status',
              'pid',
              'nonce',
              'durationMs',
              'workloadDurationMs',
              'cleanupConfirmed',
              'assertions',
              'unavailable',
            ],
            ['points', 'identities', 'mcpStdioHandoff'],
          ) ||
          item.caseId !== UNIFIED_SOAK_CASES[caseIndex] ||
          !Array.isArray(item.unavailable) ||
          item.unavailable.length > 256 ||
          !item.unavailable.every((value) => typeof value === 'string') ||
          typeof item.cleanupConfirmed !== 'boolean' ||
          (item.points !== undefined && !Array.isArray(item.points))
        )
          return ['case_structure_invalid'];
        if (item.identities) {
          if (!Array.isArray(item.identities) || item.identities.length > 256)
            return ['case_identity_invalid'];
          for (const identity of item.identities)
            if (
              !closed(identity, ['storeId', 'sessionId', 'runId', 'executionId', 'commandId']) ||
              ![identity.storeId, identity.sessionId].every(
                (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value),
              ) ||
              ![identity.runId, identity.executionId, identity.commandId].every(
                (value) =>
                  value === null ||
                  (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)),
              )
            )
              return ['case_identity_invalid'];
        }
        if (item.status !== 'passed' || !item.cleanupConfirmed || item.unavailable.length)
          errors.push('case_not_passed');
        if (
          !Number.isSafeInteger(item.pid) ||
          item.pid <= 0 ||
          typeof item.nonce !== 'string' ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(item.nonce) ||
          !Number.isFinite(item.durationMs) ||
          item.durationMs < 0 ||
          item.durationMs > OPERATION_DEADLINE_MS * (formal ? 9 : 2) ||
          !Number.isFinite(item.workloadDurationMs) ||
          item.workloadDurationMs < 0 ||
          item.workloadDurationMs > item.durationMs
        )
          errors.push('case_identity_or_deadline_invalid');
        const receipts = item.assertions;
        const validateReceipts = (receipts: CaseEvidence['assertions']) => {
          if (!Array.isArray(receipts) || receipts.length > 256) return false;
          const ids = new Set<string>();
          for (const receipt of receipts)
            if (
              !closed(receipt, ['id', 'actual', 'expected', 'passed']) ||
              typeof receipt.id !== 'string' ||
              !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.id) ||
              ids.has(receipt.id) ||
              !['string', 'number', 'boolean'].includes(typeof receipt.actual) ||
              (typeof receipt.actual === 'number' && !Number.isFinite(receipt.actual)) ||
              typeof receipt.actual !== typeof receipt.expected ||
              receipt.passed !== true ||
              receipt.actual !== receipt.expected
            )
              return false;
            else ids.add(receipt.id);
          return REQUIRED_CASE_ASSERTIONS[item.caseId].every((id) =>
            receipts.some((receipt) => receipt.id === id),
          );
        };
        if (!validateReceipts(receipts)) errors.push('case_assertion_missing');
        if (item.caseId !== 'runtime_sigkill_recovery' || item.points !== undefined) {
          if (!Array.isArray(item.points) || item.points.length !== (formal ? 9 : 2))
            errors.push('case_lifecycle_missing');
          for (const [sequence, point] of (item.points ?? []).entries()) {
            if (
              !closed(
                point,
                ['sequence', 'before', 'after', 'durationMs', 'assertions'],
                ['observations', 'descendants', 'identities', 'mcpStdioHandoff'],
              ) ||
              point.sequence !== sequence ||
              !closed(point.before, Object.keys(RESOURCE_LIMITS)) ||
              !closed(point.after, Object.keys(RESOURCE_LIMITS)) ||
              !validateReceipts(point.assertions) ||
              !Number.isFinite(point.durationMs) ||
              point.durationMs < 0 ||
              point.durationMs > OPERATION_DEADLINE_MS
            )
              return ['case_lifecycle_invalid'];
            if (
              point.identities &&
              (!Array.isArray(point.identities) ||
                point.identities.length > 256 ||
                point.identities.some(
                  (identity) =>
                    !closed(identity, [
                      'storeId',
                      'sessionId',
                      'runId',
                      'executionId',
                      'commandId',
                    ]) ||
                    ![identity.storeId, identity.sessionId].every(
                      (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value),
                    ) ||
                    ![identity.runId, identity.executionId, identity.commandId].every(
                      (value) =>
                        value === null ||
                        (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)),
                    ),
                ))
            )
              return ['case_identity_invalid'];
            if (
              formal &&
              item.caseId === 'runtime_sigkill_recovery' &&
              (!point.identities?.length ||
                point.identities.some(
                  (identity) => !identity.runId || !identity.executionId || !identity.commandId,
                ))
            )
              errors.push('case_identity_missing');
            if (
              point.observations &&
              (!closed(point.observations, ['before', 'after']) ||
                !observationValid(point.observations.before, point.before, item.pid) ||
                !observationValid(point.observations.after, point.after, item.pid) ||
                !sameNativeProcess(
                  point.observations.before.native,
                  point.observations.after.native,
                ))
            )
              return ['case_native_observation_invalid'];
            if (
              point.observations &&
              item.points?.[0]?.observations &&
              !sameNativeProcess(
                item.points[0].observations.before.native,
                point.observations.before.native,
              )
            )
              return ['case_native_observation_invalid'];
            if (formal && !point.observations) errors.push('native_observation_missing');
            if (Object.hasOwn(point, 'mcpStdioHandoff')) {
              if (item.caseId !== 'mcp_churn') return ['mcp_stdio_handoff_invalid'];
              errors.push(
                ...verifyMcpStdioJobHandoff(point.mcpStdioHandoff!, {
                  ownerPid: item.pid,
                  identities: point.identities ?? [],
                  platform: value.environment.platform,
                }),
              );
            }
            if (point.descendants) {
              if (
                item.caseId !== 'runtime_sigkill_recovery' ||
                !Array.isArray(point.descendants) ||
                point.descendants.length !== 2
              )
                return ['case_descendant_invalid'];
              for (const [index, child] of point.descendants.entries())
                if (
                  !closed(child, ['role', 'native', 'exitCode', 'reaped']) ||
                  child.role !== ['crash', 'recovery'][index] ||
                  child.reaped !== true ||
                  child.exitCode !== (index === 0 ? 137 : 0) ||
                  !nativeValid(child.native, child.native?.pid) ||
                  child.native.parentPid !== item.pid ||
                  child.native.pid === item.pid ||
                  !child.native.startIdentity
                )
                  return ['case_descendant_invalid'];
            }
            if (formal && item.caseId === 'runtime_sigkill_recovery' && !point.descendants)
              errors.push('descendant_identity_missing');
            for (const metric of Object.keys(RESOURCE_LIMITS))
              for (const boundary of [point.before, point.after]) {
                const value = boundary[metric];
                if (
                  value !== null &&
                  (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
                )
                  errors.push('metric_invalid');
                if (formal && typeof value !== 'number') errors.push('metric_unsupported');
              }
          }
        }
        if (Object.hasOwn(item, 'mcpStdioHandoff')) {
          if (
            item.caseId !== 'mcp_churn' ||
            !item.points?.length ||
            item.points.some((point) => !Object.hasOwn(point, 'mcpStdioHandoff')) ||
            JSON.stringify(item.mcpStdioHandoff) !== JSON.stringify(item.points[0]!.mcpStdioHandoff)
          )
            return ['mcp_stdio_handoff_invalid'];
          errors.push(
            ...verifyMcpStdioJobHandoff(item.mcpStdioHandoff!, {
              ownerPid: item.pid,
              identities: item.identities ?? [],
              platform: value.environment.platform,
            }),
          );
        } else if (item.points?.some((point) => Object.hasOwn(point, 'mcpStdioHandoff')))
          return ['mcp_stdio_handoff_invalid'];
        if (formal && item.caseId === 'mcp_churn' && !Object.hasOwn(item, 'mcpStdioHandoff'))
          errors.push('mcp_stdio_handoff_missing');
        if (
          formal &&
          item.caseId === 'runtime_sigkill_recovery' &&
          (item.points?.length ?? 0) !== 9
        )
          errors.push('case_lifecycle_missing');
        if (formal && item.points && hasRetainedResourceGrowth(item.points))
          errors.push('retained_resource_growth');
      }
    }
    for (const proof of [attempt.lifecycle, attempt.recovery]) {
      if (
        !closed(
          proof,
          ['mode', 'pid', 'nonce', 'assertions', 'points', 'calls'],
          ['completedCycles', 'workloadDurationMs', 'effectLedgerLines', 'identities'],
        ) ||
        !Array.isArray(proof.points) ||
        !Array.isArray(proof.assertions)
      )
        return ['probe_structure_invalid'];
      for (const [sequence, point] of proof.points.entries())
        if (
          !closed(
            point,
            ['sequence', 'before', 'after', 'durationMs', 'assertions'],
            ['observations'],
          ) ||
          point.sequence !== sequence ||
          !closed(point.before, Object.keys(RESOURCE_LIMITS)) ||
          !closed(point.after, Object.keys(RESOURCE_LIMITS))
        )
          return ['sample_structure_invalid'];
      for (const point of proof.points) {
        if (
          point.observations &&
          (!closed(point.observations, ['before', 'after']) ||
            !observationValid(point.observations.before, point.before, proof.pid) ||
            !observationValid(point.observations.after, point.after, proof.pid) ||
            !sameNativeProcess(point.observations.before.native, point.observations.after.native) ||
            (proof.points[0]?.observations &&
              !sameNativeProcess(
                proof.points[0].observations.before.native,
                point.observations.before.native,
              )))
        )
          return ['sample_native_observation_invalid'];
        if (formal && !point.observations) errors.push('native_observation_missing');
      }
    }

    if (
      !Number.isSafeInteger(attempt.lifecycle.pid) ||
      attempt.lifecycle.pid <= 0 ||
      !attempt.lifecycle.nonce ||
      !Number.isSafeInteger(attempt.recovery.pid) ||
      attempt.recovery.pid <= 0 ||
      !attempt.recovery.nonce ||
      attempt.recovery.pid === attempt.lifecycle.pid
    )
      errors.push('process_identity_invalid');
    if (attempt.iteration !== index + 1 || attempt.crashExit !== 137 || !attempt.cleanupConfirmed)
      errors.push('attempt_identity_or_cleanup_invalid');
    if (
      !attempt.lifecycle.assertions.includes('same_process_lifecycle') ||
      attempt.lifecycle.points.length !== (formal ? 9 : 2)
    )
      errors.push('lifecycle_missing');
    for (const point of attempt.lifecycle.points) {
      if (
        !point.assertions.includes('completed') ||
        !point.assertions.includes('cancel_settled') ||
        !point.assertions.includes('reconnected_original_receipt') ||
        !point.assertions.includes('sessions_deleted') ||
        !Number.isFinite(point.durationMs) ||
        point.durationMs < 0 ||
        point.durationMs >= OPERATION_DEADLINE_MS
      )
        errors.push('lifecycle_evidence_invalid');
      for (const metric of Object.keys(RESOURCE_LIMITS))
        for (const boundary of [point.before, point.after]) {
          const observed = boundary[metric];
          if (
            observed !== null &&
            (typeof observed !== 'number' || !Number.isFinite(observed) || observed < 0)
          )
            errors.push('metric_invalid');
          if (formal && (typeof observed !== 'number' || !Number.isFinite(observed)))
            errors.push('metric_unsupported');
        }
    }
    if (
      formal &&
      value.version === 1 &&
      (attempt.lifecycle.workloadDurationMs ?? 0) < FORMAL_DURATION_MS / 8
    )
      errors.push('continuous_workload_missing');
    if (attempt.lifecycle.mode !== 'lifecycle' || attempt.recovery.mode !== 'recover')
      errors.push('probe_mode_invalid');
    if (formal && hasRetainedResourceGrowth(attempt.lifecycle.points))
      errors.push('retained_resource_growth');
    if (
      attempt.recovery.calls !== 0 ||
      attempt.recovery.effectLedgerLines !== 1 ||
      !attempt.recovery.assertions.includes('zero_model_replay') ||
      !attempt.recovery.assertions.includes('original_execution_ids')
    )
      errors.push('recovery_evidence_invalid');
  }
  if (formal) {
    if (
      value.artifact.source.dirty !== false ||
      value.checkout.dirty !== false ||
      value.artifact.source.commit !== value.source?.headSha ||
      value.checkout.commit !== value.source?.headSha ||
      !/^[a-f0-9]{40}$/.test(value.artifact.source.commit)
    )
      errors.push('formal_candidate_checkout_source_invalid');
    if (value.profile !== 'qualification' || !sourceValid(value.source))
      errors.push('formal_source_invalid');
    if (
      value.environment.platform !== 'linux' ||
      value.environment.arch !== 'x64' ||
      value.environment.bunVersion !== '1.4.2'
    )
      errors.push('formal_environment_invalid');
    if (value.durationMs < FORMAL_DURATION_MS || value.durationMs > GLOBAL_DEADLINE_MS)
      errors.push('formal_duration_invalid');
    if (value.unsupported.length) errors.push('formal_evidence_unsupported');
    // This narrow packet never claims the migrated seven-case/resource qualification.
    if (value.version === 1) errors.push('legacy_report_not_formal');
    errors.push('descendant_identity_qualification_not_implemented');
  }
  return [...new Set(errors)];
}

export function verifyUnifiedSoakReport(
  value: UnifiedSoakReport,
  expectedSource: SourceIdentity | null,
  formal: boolean,
): string[] {
  try {
    return verifyReport(value, expectedSource, formal);
  } catch {
    return ['report_structure_invalid'];
  }
}

/** Validates the collected workload only. The unchanged formal verifier still rejects this report. */
export function verifyBlockedWorkloadCollection(value: UnifiedSoakReport): string[] {
  try {
    if (
      value.version !== 2 ||
      value.profile !== 'qualification' ||
      value.status !== 'inconclusive' ||
      value.failures.length !== 0 ||
      value.qualificationPreflight?.collectionMode !== 'full' ||
      value.environment.platform !== 'darwin' ||
      !['arm64', 'x64'].includes(value.environment.arch) ||
      value.environment.bunVersion !== '1.4.2' ||
      !/^[a-f0-9]{40}$/.test(value.checkout.commit) ||
      value.artifact.source.commit !== value.checkout.commit ||
      (value.source !== null &&
        (!sourceValid(value.source) || value.source.headSha !== value.checkout.commit)) ||
      canonical(value.unsupported) !== canonical(qualificationMissing('darwin'))
    )
      return ['blocked_collection_configuration_invalid'];
    if (
      value.attempts.some(
        (attempt) => attempt.continuous?.shell?.candidateDigest !== value.artifact.candidateId,
      )
    )
      return ['blocked_collection_candidate_mismatch'];
    // Only the explicitly unavailable Bun counters remain null. Native FD,
    // listener and identity evidence is mandatory even for this collection.
    const points = value.attempts.flatMap((attempt) => [
      ...attempt.lifecycle.points,
      ...(attempt.cases ?? []).flatMap((item) => item.points ?? []),
    ]);
    for (const point of points)
      for (const boundary of ['before', 'after'] as const) {
        const metrics = point[boundary],
          observation = point.observations?.[boundary];
        if (
          metrics.activeResources !== null ||
          metrics.handles !== null ||
          !['rssBytes', 'fileDescriptors', 'listeners'].every(
            (key) =>
              typeof metrics[key] === 'number' &&
              Number.isFinite(metrics[key]) &&
              metrics[key]! >= 0,
          ) ||
          observation?.native.collector !== 'darwin-libproc'
        )
          return ['blocked_collection_observation_invalid'];
      }
    // Keep all behavior, duration, per-point identity and numeric growth checks.
    // These known eligibility errors are retained by verifyUnifiedSoakReport;
    // excluding them here cannot turn collection into release qualification.
    const eligibility = new Set([
      'qualification_preflight_blocked',
      'report_not_passed',
      'metric_unsupported',
      'formal_candidate_checkout_source_invalid',
      'formal_source_invalid',
      'formal_environment_invalid',
      'formal_evidence_unsupported',
      'descendant_identity_qualification_not_implemented',
    ]);
    return verifyUnifiedSoakReport(value, value.source, true).filter(
      (error) => !eligibility.has(error),
    );
  } catch {
    return ['blocked_collection_structure_invalid'];
  }
}

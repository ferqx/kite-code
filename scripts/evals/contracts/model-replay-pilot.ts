import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { RUNTIME_ID_SOURCE_REVISION_V1 } from '../../../src/core/runtime/id-source';
import { canonicalJsonBytes, sha256Digest } from '../../release/canonical-json';

export const MODEL_REPLAY_PILOT_SUITE_ID_V1 = 'agent-task-replay-deterministic-pilot-v1' as const;
export const MODEL_REPLAY_PILOT_SUITE_REVISION_V1 = 1 as const;
export const MODEL_REPLAY_PILOT_CASE_ID_V1 = 'approved.03-typescript-bug-fix.v1' as const;
export const MODEL_REPLAY_PILOT_FIXTURE_ID_V1 = 'approved-local-dev-v1' as const;
export const MODEL_REPLAY_PILOT_FIXTURE_DIGEST_V1 =
  'sha256:12fd4637aeac1a441096cdb61468e6085fcffb85d2583e3121b6e0b4cfd07dfd' as const;
export const MODEL_REPLAY_PILOT_CATALOG_REVISION_V1 =
  'agent-task-replay-deterministic-pilot-catalog-v1' as const;
export const MODEL_REPLAY_PILOT_CASSETTE_DIGEST_V1 =
  'sha256:abb0541f426ac12a12d9b7be0c3e6306c392281ebc5691e3edbef0c41acd171c' as const;
export const MODEL_REPLAY_WORKSPACE_NORMALIZER_REVISION_V1 =
  'kite.eval-workspace-normalizer.v1' as const;
export const MODEL_REPLAY_PILOT_CLOCK_REVISION_V1 = 'kite.eval-clock.v1' as const;
export const MODEL_REPLAY_PILOT_CLOCK_EPOCH_MS_V1 = Date.UTC(2000, 0, 1) as number;

/** Fields omitted from the canonical pilot projection, never wildcard content. */
export const MODEL_REPLAY_PILOT_IGNORED_EVENT_FIELDS_V1 = Object.freeze([
  'RuntimeEvent.createdAt',
  'RuntimeEvent.finishedAt',
  'RuntimeEvent.requestedAt',
  'ToolOutcomeV1.timing.startedAt',
  'ToolOutcomeV1.timing.finishedAt',
  'ToolOutcomeV1.timing.executionMs',
  'ToolOutcomeV1.timing.totalActiveMs',
  'WorkspaceFilesystemObservationRecordV1.canonicalTargetDigest',
  'WorkspaceFilesystemObservationRecordV1.targetIdentityDigest',
  'FilesystemCapabilityReceiptV1.resultDigest',
  'FilesystemCapabilityReceiptV1.evidenceDigest',
  'FilesystemCapabilityReceiptV1.artifact.integrityIdentifier',
] as const);

export const MODEL_REPLAY_PILOT_AUTHORITY_V1 = Object.freeze({
  version: 1 as const,
  decision: 'ADR-0112' as const,
  status: 'deterministic_pilot' as const,
  evidenceEligible: false as const,
  replayGate: 'disabled' as const,
  recordAuthorization: 'denied' as const,
  suiteId: MODEL_REPLAY_PILOT_SUITE_ID_V1,
  suiteRevision: MODEL_REPLAY_PILOT_SUITE_REVISION_V1,
  caseId: MODEL_REPLAY_PILOT_CASE_ID_V1,
  fixtureId: MODEL_REPLAY_PILOT_FIXTURE_ID_V1,
  fixtureDigest: MODEL_REPLAY_PILOT_FIXTURE_DIGEST_V1,
  catalogRevision: MODEL_REPLAY_PILOT_CATALOG_REVISION_V1,
  cassetteDigest: MODEL_REPLAY_PILOT_CASSETTE_DIGEST_V1,
  oracleVersion: 'agent-task-oracle-v1' as const,
  expectedOracleDigest:
    'sha256:eb456b2958ff8ccdde0a6730d995470f69edd496e2537394907e632d4744faef' as const,
  catalogRecordCount: 6 as const,
  requiredRiskCoverage: Object.freeze([
    'parent_cursor',
    'concurrent_sibling_cursor',
    'workspace_mutation',
    'tool_failure_recovery',
    'verification',
    'canonical_terminal_receipt_equality',
    'privacy_no_egress_cleanup',
  ] as const),
  workspaceNormalizerRevision: MODEL_REPLAY_WORKSPACE_NORMALIZER_REVISION_V1,
  runtimeIdSourceRevision: RUNTIME_ID_SOURCE_REVISION_V1,
  clockRevision: MODEL_REPLAY_PILOT_CLOCK_REVISION_V1,
  ignoredEventFields: MODEL_REPLAY_PILOT_IGNORED_EVENT_FIELDS_V1,
});

export const MODEL_REPLAY_PILOT_AUTHORITY_DIGEST_V1 = sha256Digest(
  canonicalJsonBytes(MODEL_REPLAY_PILOT_AUTHORITY_V1),
);
export const MODEL_REPLAY_PILOT_EXPECTED_REPORT_DIGEST_V1 =
  'sha256:f9f67aacee606a6846404e4953b79574ddfa5d7ac14114407ecfde9ec356c7c4' as const;

export interface ReplayWorkspaceNormalizerV1 {
  readonly revision: typeof MODEL_REPLAY_WORKSPACE_NORMALIZER_REVISION_V1;
  normalize<T>(value: T): T;
  digest(value: unknown): `sha256:${string}`;
}

/**
 * Suite-scoped diagnostic normalizer. RP-03 manifest verification is still
 * required before its output may become a non-null catalog replayDigest.
 */
export function createReplayWorkspaceNormalizerV1(input: {
  workspace: string;
  processCwd: string;
}): ReplayWorkspaceNormalizerV1 {
  const roots = uniqueRoots([
    { path: input.workspace, token: '<workspace>' },
    { path: input.processCwd, token: '<process-cwd>' },
  ]);
  const normalize = <T>(value: T): T => {
    const normalized = normalizeValue(value, roots, '$');
    canonicalJsonBytes(normalized);
    return normalized as T;
  };
  return Object.freeze({
    revision: MODEL_REPLAY_WORKSPACE_NORMALIZER_REVISION_V1,
    normalize,
    digest: (value: unknown) => sha256Digest(canonicalJsonBytes(normalize(value))),
  });
}

function uniqueRoots(input: Array<{ path: string; token: string }>): Array<{
  path: string;
  token: string;
}> {
  const values = new Map<string, string>();
  for (const entry of input) {
    for (const candidate of [resolve(entry.path), realpathSync.native(resolve(entry.path))]) {
      values.set(candidate, entry.token);
      values.set(candidate.replaceAll('\\', '/'), entry.token);
    }
  }
  return [...values]
    .map(([path, token]) => ({ path, token }))
    .sort(
      (left, right) =>
        right.path.length - left.path.length || left.token.localeCompare(right.token),
    );
}

function normalizeValue(
  value: unknown,
  roots: readonly { path: string; token: string }[],
  path: string,
): unknown {
  if (typeof value === 'string') return normalizeString(value, roots, path);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) {
      throw new Error('Replay workspace normalizer rejects sparse or extended arrays.');
    }
    return value.map((entry, index) => normalizeValue(entry, roots, `${path}[${index}]`));
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('Replay workspace normalizer accepts plain JSON values only.');
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new Error('Replay workspace normalizer rejects symbol fields.');
  }
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new Error('Replay workspace normalizer rejects accessors and hidden fields.');
    }
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = normalizeString(key, roots, `${path}.<key>`);
    if (normalizedKey in normalized) {
      throw new Error('Replay workspace normalization produced a duplicate key.');
    }
    normalized[normalizedKey] = normalizeValue(child, roots, `${path}.${normalizedKey}`);
  }
  return normalized;
}

function normalizeString(
  input: string,
  roots: readonly { path: string; token: string }[],
  path: string,
): string {
  let output = input;
  for (const root of roots) output = output.replaceAll(root.path, root.token);
  if (
    /(?:^|[\s"'(=])(?:\/(?!dev\/null(?:$|[\s"']))[^\s"'<>]+|[A-Za-z]:[\\/][^\s"'<>]+)/u.test(output)
  ) {
    throw new Error(`Replay evidence contains an unbound absolute path at ${path}.`);
  }
  return output;
}

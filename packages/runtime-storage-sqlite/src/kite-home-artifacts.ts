import type { Database } from 'bun:sqlite';

const ARTIFACT_ID = /^pa_[a-f0-9]{64}$/u;
const INTEGRITY_IDENTIFIER = /^sha256:[a-f0-9]{64}$/u;
const SAFE_KIND = /^[a-z][a-z0-9_]{0,63}$/u;

type Binding = string | number | null;
type ArtifactTable =
  | 'model_artifacts'
  | 'plan_artifacts'
  | 'capability_artifacts'
  | 'filesystem_preimage_artifacts'
  | 'sandbox_preparation_artifacts'
  | 'subagent_task_artifacts'
  | 'subagent_lifecycle_artifacts'
  | 'subagent_continuation_artifacts';

export type KiteHomeArtifactErrorCode =
  | 'invalid_reference'
  | 'artifact_missing'
  | 'artifact_conflict'
  | 'artifact_corrupt'
  | 'reachability_incomplete';

export class KiteHomeArtifactError extends Error {
  readonly code: KiteHomeArtifactErrorCode;

  constructor(code: KiteHomeArtifactErrorCode, message: string) {
    super(message);
    this.name = 'KiteHomeArtifactError';
    this.code = code;
  }
}

export interface KiteHomePrivateArtifactReference<Kind extends string> {
  readonly artifactId: string;
  readonly kind: Kind;
  readonly integrityIdentifier: string;
  readonly byteLength: number;
}

export type KiteHomeModelArtifactKind = 'model_surface' | 'model_response' | 'provider_options';
export type KiteHomeSubagentTaskArtifactKind = 'subagent_task_request' | 'subagent_task';

export interface KiteHomePlanArtifactReference {
  readonly artifactId: string;
  readonly taskId: string;
  readonly planId: string;
  readonly version: number;
  readonly structuralDigest: string;
  readonly byteLength: number;
}

export interface KiteHomeArtifactGarbageCollectionInput {
  readonly complete: boolean;
  readonly reachableArtifactIds: readonly string[];
  readonly createdBeforeOrAt: number;
}

export interface KiteHomeArtifactGarbageCollectionResult {
  readonly retainedArtifacts: number;
  readonly deletedArtifacts: number;
}

export interface KiteHomeArtifactStore {
  writeModel(input: {
    readonly ref: KiteHomePrivateArtifactReference<KiteHomeModelArtifactKind>;
    readonly artifactFormatVersion: number;
    readonly canonicalJson: string;
    readonly createdAt: number;
  }): void;
  readModel(
    ref: KiteHomePrivateArtifactReference<KiteHomeModelArtifactKind>,
  ): Readonly<{ artifactFormatVersion: number; canonicalJson: string }>;
  collectModelGarbage(
    input: KiteHomeArtifactGarbageCollectionInput,
  ): KiteHomeArtifactGarbageCollectionResult;

  writePlan(input: {
    readonly ref: KiteHomePlanArtifactReference;
    readonly artifactFormatVersion: number;
    readonly planJson: string;
    readonly markdown: string;
    readonly createdAt: number;
  }): void;
  readPlan(ref: KiteHomePlanArtifactReference): Readonly<{
    artifactFormatVersion: number;
    planJson: string;
    markdown: string;
  }>;
  collectPlanGarbage(
    input: KiteHomeArtifactGarbageCollectionInput,
  ): KiteHomeArtifactGarbageCollectionResult;

  writeCapability(input: {
    readonly ref: KiteHomePrivateArtifactReference<'capability_result'>;
    readonly invocationId: string;
    readonly evidenceDigest: string;
    readonly artifactFormatVersion: number;
    readonly canonicalJson: string;
    readonly createdAt: number;
  }): void;
  readCapability(ref: KiteHomePrivateArtifactReference<'capability_result'>): Readonly<{
    invocationId: string;
    evidenceDigest: string;
    artifactFormatVersion: number;
    canonicalJson: string;
  }>;
  collectCapabilityGarbage(
    input: KiteHomeArtifactGarbageCollectionInput,
  ): KiteHomeArtifactGarbageCollectionResult;

  writeFilesystemPreimage(input: {
    readonly ref: KiteHomePrivateArtifactReference<'filesystem_preimage'>;
    readonly invocationId: string;
    readonly operationDigest: string;
    readonly targetIdentityDigest: string;
    readonly artifactFormatVersion: number;
    readonly canonicalJson: string;
    readonly createdAt: number;
  }): void;
  readFilesystemPreimage(ref: KiteHomePrivateArtifactReference<'filesystem_preimage'>): Readonly<{
    invocationId: string;
    operationDigest: string;
    targetIdentityDigest: string;
    artifactFormatVersion: number;
    canonicalJson: string;
  }>;
  collectFilesystemPreimageGarbage(
    input: KiteHomeArtifactGarbageCollectionInput,
  ): KiteHomeArtifactGarbageCollectionResult;

  writeSandboxPreparation(input: {
    readonly ref: KiteHomePrivateArtifactReference<'sandbox_preparation'>;
    readonly preparationDigest: string;
    readonly artifactFormatVersion: number;
    readonly canonicalJson: string;
    readonly expiresAtMs: number;
    readonly createdAt: number;
  }): void;
  readSandboxPreparation(ref: KiteHomePrivateArtifactReference<'sandbox_preparation'>): Readonly<{
    preparationDigest: string;
    artifactFormatVersion: number;
    canonicalJson: string;
    expiresAtMs: number;
  }>;
  collectSandboxPreparationGarbage(
    input: KiteHomeArtifactGarbageCollectionInput,
  ): KiteHomeArtifactGarbageCollectionResult;

  writeSubagentTask(input: {
    readonly ref: KiteHomePrivateArtifactReference<KiteHomeSubagentTaskArtifactKind>;
    readonly artifactFormatVersion: number;
    readonly canonicalJson: string;
    readonly createdAt: number;
  }): void;
  readSubagentTask(
    ref: KiteHomePrivateArtifactReference<KiteHomeSubagentTaskArtifactKind>,
  ): Readonly<{ artifactFormatVersion: number; canonicalJson: string }>;
  collectSubagentTaskGarbage(
    input: KiteHomeArtifactGarbageCollectionInput,
  ): KiteHomeArtifactGarbageCollectionResult;

  writeSubagentLifecycle(input: {
    readonly ref: KiteHomePrivateArtifactReference<'subagent_handle'>;
    readonly artifactFormatVersion: number;
    readonly canonicalJson: string;
    readonly createdAt: number;
  }): void;
  readSubagentLifecycle(
    ref: KiteHomePrivateArtifactReference<'subagent_handle'>,
  ): Readonly<{ artifactFormatVersion: number; canonicalJson: string }>;
  collectSubagentLifecycleGarbage(
    input: KiteHomeArtifactGarbageCollectionInput,
  ): KiteHomeArtifactGarbageCollectionResult;

  writeSubagentContinuation(input: {
    readonly ref: KiteHomePrivateArtifactReference<'subagent_continuation'>;
    readonly artifactFormatVersion: number;
    readonly canonicalJson: string;
    readonly createdAt: number;
  }): void;
  readSubagentContinuation(
    ref: KiteHomePrivateArtifactReference<'subagent_continuation'>,
  ): Readonly<{ artifactFormatVersion: number; canonicalJson: string }>;
  collectSubagentContinuationGarbage(
    input: KiteHomeArtifactGarbageCollectionInput,
  ): KiteHomeArtifactGarbageCollectionResult;
}

export function createKiteHomeArtifactStore(database: Database): KiteHomeArtifactStore {
  const store: KiteHomeArtifactStore = {
    writeModel: (input) => {
      assertPrivateReference(input.ref, ['model_surface', 'model_response', 'provider_options']);
      assertPayload(input.canonicalJson, input.ref.byteLength, 16 * 1024 * 1024);
      insertExact(database, 'model_artifacts', {
        artifact_id: input.ref.artifactId,
        kind: input.ref.kind,
        integrity_identifier: input.ref.integrityIdentifier,
        artifact_format_version: positiveInteger(input.artifactFormatVersion),
        canonical_json: input.canonicalJson,
        byte_length: input.ref.byteLength,
        created_at: nonNegativeInteger(input.createdAt),
      });
    },
    readModel: (ref) => {
      assertPrivateReference(ref, ['model_surface', 'model_response', 'provider_options']);
      const row = readExact(database, 'model_artifacts', ref.artifactId);
      assertStoredReference(row, ref);
      return Object.freeze({
        artifactFormatVersion: storedInteger(row, 'artifact_format_version'),
        canonicalJson: storedString(row, 'canonical_json'),
      });
    },
    collectModelGarbage: (input) => collect(database, 'model_artifacts', input),

    writePlan: (input) => {
      assertPlanReference(input.ref);
      assertJson(input.planJson);
      if (Buffer.byteLength(input.markdown, 'utf8') !== input.ref.byteLength) {
        invalidReference('Plan Artifact byte length is invalid.');
      }
      insertExact(database, 'plan_artifacts', {
        artifact_id: input.ref.artifactId,
        task_id: input.ref.taskId,
        plan_id: input.ref.planId,
        version: input.ref.version,
        artifact_format_version: positiveInteger(input.artifactFormatVersion),
        structural_digest: input.ref.structuralDigest,
        plan_json: input.planJson,
        markdown: input.markdown,
        byte_length: input.ref.byteLength,
        created_at: nonNegativeInteger(input.createdAt),
      });
    },
    readPlan: (ref) => {
      assertPlanReference(ref);
      const row = readExact(database, 'plan_artifacts', ref.artifactId);
      if (
        storedString(row, 'task_id') !== ref.taskId ||
        storedString(row, 'plan_id') !== ref.planId ||
        storedInteger(row, 'version') !== ref.version ||
        storedString(row, 'structural_digest') !== ref.structuralDigest ||
        storedInteger(row, 'byte_length') !== ref.byteLength
      ) {
        corrupt('Plan Artifact reference does not match its stored row.');
      }
      return Object.freeze({
        artifactFormatVersion: storedInteger(row, 'artifact_format_version'),
        planJson: storedString(row, 'plan_json'),
        markdown: storedString(row, 'markdown'),
      });
    },
    collectPlanGarbage: (input) => collect(database, 'plan_artifacts', input),

    writeCapability: (input) => {
      assertPrivateReference(input.ref, ['capability_result']);
      assertIdentifier(input.invocationId, 'Capability invocation ID');
      assertIdentifier(input.evidenceDigest, 'Capability evidence digest');
      assertPayload(input.canonicalJson, input.ref.byteLength, 16 * 1024 * 1024);
      insertExact(database, 'capability_artifacts', {
        artifact_id: input.ref.artifactId,
        integrity_identifier: input.ref.integrityIdentifier,
        invocation_id: input.invocationId,
        evidence_digest: input.evidenceDigest,
        artifact_format_version: positiveInteger(input.artifactFormatVersion),
        canonical_json: input.canonicalJson,
        byte_length: input.ref.byteLength,
        created_at: nonNegativeInteger(input.createdAt),
      });
    },
    readCapability: (ref) => {
      assertPrivateReference(ref, ['capability_result']);
      const row = readExact(database, 'capability_artifacts', ref.artifactId);
      assertStoredReference(row, ref, 'capability_result');
      return Object.freeze({
        invocationId: storedString(row, 'invocation_id'),
        evidenceDigest: storedString(row, 'evidence_digest'),
        artifactFormatVersion: storedInteger(row, 'artifact_format_version'),
        canonicalJson: storedString(row, 'canonical_json'),
      });
    },
    collectCapabilityGarbage: (input) => collect(database, 'capability_artifacts', input),

    writeFilesystemPreimage: (input) => {
      assertPrivateReference(input.ref, ['filesystem_preimage']);
      assertIdentifier(input.invocationId, 'Filesystem preimage invocation ID');
      assertIntegrityIdentifier(input.operationDigest, 'Filesystem preimage operation digest');
      assertIntegrityIdentifier(
        input.targetIdentityDigest,
        'Filesystem preimage target identity digest',
      );
      assertPayload(input.canonicalJson, input.ref.byteLength, 16 * 1024 * 1024);
      insertExact(database, 'filesystem_preimage_artifacts', {
        artifact_id: input.ref.artifactId,
        integrity_identifier: input.ref.integrityIdentifier,
        invocation_id: input.invocationId,
        operation_digest: input.operationDigest,
        target_identity_digest: input.targetIdentityDigest,
        artifact_format_version: positiveInteger(input.artifactFormatVersion),
        canonical_json: input.canonicalJson,
        byte_length: input.ref.byteLength,
        created_at: nonNegativeInteger(input.createdAt),
      });
    },
    readFilesystemPreimage: (ref) => {
      assertPrivateReference(ref, ['filesystem_preimage']);
      const row = readExact(database, 'filesystem_preimage_artifacts', ref.artifactId);
      assertStoredReference(row, ref, 'filesystem_preimage');
      return Object.freeze({
        invocationId: storedString(row, 'invocation_id'),
        operationDigest: storedString(row, 'operation_digest'),
        targetIdentityDigest: storedString(row, 'target_identity_digest'),
        artifactFormatVersion: storedInteger(row, 'artifact_format_version'),
        canonicalJson: storedString(row, 'canonical_json'),
      });
    },
    collectFilesystemPreimageGarbage: (input) =>
      collect(database, 'filesystem_preimage_artifacts', input),

    writeSandboxPreparation: (input) => {
      assertPrivateReference(input.ref, ['sandbox_preparation']);
      assertIdentifier(input.preparationDigest, 'Sandbox preparation digest');
      assertPayload(input.canonicalJson, input.ref.byteLength, 2 * 1024 * 1024);
      insertExact(database, 'sandbox_preparation_artifacts', {
        artifact_id: input.ref.artifactId,
        integrity_identifier: input.ref.integrityIdentifier,
        preparation_digest: input.preparationDigest,
        artifact_format_version: positiveInteger(input.artifactFormatVersion),
        canonical_json: input.canonicalJson,
        byte_length: input.ref.byteLength,
        expires_at_ms: nonNegativeInteger(input.expiresAtMs),
        created_at: nonNegativeInteger(input.createdAt),
      });
    },
    readSandboxPreparation: (ref) => {
      assertPrivateReference(ref, ['sandbox_preparation']);
      const row = readExact(database, 'sandbox_preparation_artifacts', ref.artifactId);
      assertStoredReference(row, ref, 'sandbox_preparation');
      return Object.freeze({
        preparationDigest: storedString(row, 'preparation_digest'),
        artifactFormatVersion: storedInteger(row, 'artifact_format_version'),
        canonicalJson: storedString(row, 'canonical_json'),
        expiresAtMs: storedInteger(row, 'expires_at_ms'),
      });
    },
    collectSandboxPreparationGarbage: (input) =>
      collect(database, 'sandbox_preparation_artifacts', input),

    writeSubagentTask: (input) => {
      assertPrivateReference(input.ref, ['subagent_task_request', 'subagent_task']);
      assertPayload(input.canonicalJson, input.ref.byteLength, 1024 * 1024);
      insertExact(database, 'subagent_task_artifacts', {
        artifact_id: input.ref.artifactId,
        kind: input.ref.kind,
        integrity_identifier: input.ref.integrityIdentifier,
        artifact_format_version: positiveInteger(input.artifactFormatVersion),
        canonical_json: input.canonicalJson,
        byte_length: input.ref.byteLength,
        created_at: nonNegativeInteger(input.createdAt),
      });
    },
    readSubagentTask: (ref) => {
      assertPrivateReference(ref, ['subagent_task_request', 'subagent_task']);
      const row = readExact(database, 'subagent_task_artifacts', ref.artifactId);
      assertStoredReference(row, ref);
      return Object.freeze({
        artifactFormatVersion: storedInteger(row, 'artifact_format_version'),
        canonicalJson: storedString(row, 'canonical_json'),
      });
    },
    collectSubagentTaskGarbage: (input) => collect(database, 'subagent_task_artifacts', input),

    writeSubagentLifecycle: (input) => {
      assertPrivateReference(input.ref, ['subagent_handle']);
      assertPayload(input.canonicalJson, input.ref.byteLength, 64 * 1024);
      insertExact(database, 'subagent_lifecycle_artifacts', {
        artifact_id: input.ref.artifactId,
        integrity_identifier: input.ref.integrityIdentifier,
        artifact_format_version: positiveInteger(input.artifactFormatVersion),
        canonical_json: input.canonicalJson,
        byte_length: input.ref.byteLength,
        created_at: nonNegativeInteger(input.createdAt),
      });
    },
    readSubagentLifecycle: (ref) => {
      assertPrivateReference(ref, ['subagent_handle']);
      const row = readExact(database, 'subagent_lifecycle_artifacts', ref.artifactId);
      assertStoredReference(row, ref, 'subagent_handle');
      return Object.freeze({
        artifactFormatVersion: storedInteger(row, 'artifact_format_version'),
        canonicalJson: storedString(row, 'canonical_json'),
      });
    },
    collectSubagentLifecycleGarbage: (input) =>
      collect(database, 'subagent_lifecycle_artifacts', input),

    writeSubagentContinuation: (input) => {
      assertPrivateReference(input.ref, ['subagent_continuation']);
      assertPayload(input.canonicalJson, input.ref.byteLength, 4 * 1024 * 1024);
      insertExact(database, 'subagent_continuation_artifacts', {
        artifact_id: input.ref.artifactId,
        integrity_identifier: input.ref.integrityIdentifier,
        artifact_format_version: positiveInteger(input.artifactFormatVersion),
        canonical_json: input.canonicalJson,
        byte_length: input.ref.byteLength,
        created_at: nonNegativeInteger(input.createdAt),
      });
    },
    readSubagentContinuation: (ref) => {
      assertPrivateReference(ref, ['subagent_continuation']);
      const row = readExact(database, 'subagent_continuation_artifacts', ref.artifactId);
      assertStoredReference(row, ref, 'subagent_continuation');
      return Object.freeze({
        artifactFormatVersion: storedInteger(row, 'artifact_format_version'),
        canonicalJson: storedString(row, 'canonical_json'),
      });
    },
    collectSubagentContinuationGarbage: (input) =>
      collect(database, 'subagent_continuation_artifacts', input),
  };
  return Object.freeze(store);
}

function assertPrivateReference<Kind extends string>(
  ref: KiteHomePrivateArtifactReference<Kind>,
  kinds: readonly Kind[],
): void {
  if (
    !ref ||
    typeof ref !== 'object' ||
    !ARTIFACT_ID.test(ref.artifactId) ||
    !SAFE_KIND.test(ref.kind) ||
    !kinds.includes(ref.kind) ||
    !INTEGRITY_IDENTIFIER.test(ref.integrityIdentifier) ||
    !Number.isSafeInteger(ref.byteLength) ||
    ref.byteLength < 1
  ) {
    invalidReference('Private Artifact reference is invalid.');
  }
}

function assertPlanReference(ref: KiteHomePlanArtifactReference): void {
  if (
    !ref ||
    typeof ref !== 'object' ||
    !identifier(ref.taskId) ||
    !identifier(ref.planId) ||
    !Number.isSafeInteger(ref.version) ||
    ref.version < 1 ||
    ref.artifactId !== `${ref.planId}:v${ref.version}` ||
    !identifier(ref.structuralDigest) ||
    !Number.isSafeInteger(ref.byteLength) ||
    ref.byteLength < 1 ||
    ref.byteLength > 16 * 1024 * 1024
  ) {
    invalidReference('Plan Artifact reference is invalid.');
  }
}

function assertPayload(canonicalJson: string, byteLength: number, maxBytes: number): void {
  assertJson(canonicalJson);
  const actual = Buffer.byteLength(canonicalJson, 'utf8');
  if (actual !== byteLength || actual < 1 || actual > maxBytes) {
    invalidReference('Private Artifact byte length is invalid.');
  }
}

function assertIntegrityIdentifier(value: string, label: string): void {
  if (!INTEGRITY_IDENTIFIER.test(value)) invalidReference(`${label} is invalid.`);
}

function assertJson(value: string): void {
  if (typeof value !== 'string') invalidReference('Artifact payload is invalid.');
  try {
    JSON.parse(value);
  } catch {
    invalidReference('Artifact payload is not valid JSON.');
  }
}

function insertExact(
  database: Database,
  table: ArtifactTable,
  record: Readonly<Record<string, Binding>>,
): void {
  const columns = Object.keys(record);
  const values = columns.map((column) => record[column] ?? null);
  database
    .query(
      `INSERT OR IGNORE INTO ${table}(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(...values);
  const stored = database
    .query<Record<string, Binding>, [string]>(`SELECT * FROM ${table} WHERE artifact_id = ?`)
    .get(storedString(record, 'artifact_id'));
  if (!stored) {
    throw new KiteHomeArtifactError(
      'artifact_conflict',
      'Artifact metadata conflicts with another unique identity.',
    );
  }
  for (const column of columns) {
    if (stored[column] !== record[column]) {
      throw new KiteHomeArtifactError(
        'artifact_conflict',
        'Artifact identity already exists with different bytes or metadata.',
      );
    }
  }
}

function readExact(
  database: Database,
  table: ArtifactTable,
  artifactId: string,
): Record<string, Binding> {
  const row = database
    .query<Record<string, Binding>, [string]>(`SELECT * FROM ${table} WHERE artifact_id = ?`)
    .get(artifactId);
  if (!row) {
    throw new KiteHomeArtifactError('artifact_missing', 'Artifact does not exist.');
  }
  return row;
}

function assertStoredReference<Kind extends string>(
  row: Readonly<Record<string, Binding>>,
  ref: KiteHomePrivateArtifactReference<Kind>,
  fixedKind?: Kind,
): void {
  if (
    storedString(row, 'artifact_id') !== ref.artifactId ||
    storedString(row, 'integrity_identifier') !== ref.integrityIdentifier ||
    storedInteger(row, 'byte_length') !== ref.byteLength ||
    (fixedKind ? ref.kind !== fixedKind : storedString(row, 'kind') !== ref.kind)
  ) {
    corrupt('Private Artifact reference does not match its stored row.');
  }
}

function collect(
  database: Database,
  table: ArtifactTable,
  input: KiteHomeArtifactGarbageCollectionInput,
): KiteHomeArtifactGarbageCollectionResult {
  if (!input.complete) {
    throw new KiteHomeArtifactError(
      'reachability_incomplete',
      'Artifact garbage collection requires a complete reachability snapshot.',
    );
  }
  const cutoff = nonNegativeInteger(input.createdBeforeOrAt);
  const reachable = [...new Set(input.reachableArtifactIds)];
  for (const artifactId of reachable) {
    if (table === 'plan_artifacts') {
      if (!identifier(artifactId)) invalidReference('Plan Artifact reachability is invalid.');
    } else if (!ARTIFACT_ID.test(artifactId)) {
      invalidReference('Private Artifact reachability is invalid.');
    }
  }
  const before = count(database, table);
  if (reachable.length === 0) {
    database.query(`DELETE FROM ${table} WHERE created_at <= ?`).run(cutoff);
  } else {
    database
      .query(
        `DELETE FROM ${table} WHERE created_at <= ? AND artifact_id NOT IN (${reachable.map(() => '?').join(', ')})`,
      )
      .run(cutoff, ...reachable);
  }
  const retainedArtifacts = count(database, table);
  return Object.freeze({
    retainedArtifacts,
    deletedArtifacts: before - retainedArtifacts,
  });
}

function count(database: Database, table: ArtifactTable): number {
  return (
    database.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count ??
    0
  );
}

function storedString(record: Readonly<Record<string, Binding>>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') corrupt(`Stored Artifact field '${key}' is invalid.`);
  return value;
}

function storedInteger(record: Readonly<Record<string, Binding>>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value)) corrupt(`Stored Artifact field '${key}' is invalid.`);
  return value as number;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) invalidReference('Artifact version is invalid.');
  return value;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) invalidReference('Artifact timestamp is invalid.');
  return value;
}

function assertIdentifier(value: string, label: string): void {
  if (!identifier(value)) invalidReference(`${label} is invalid.`);
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0')
  );
}

function invalidReference(message: string): never {
  throw new KiteHomeArtifactError('invalid_reference', message);
}

function corrupt(message: string): never {
  throw new KiteHomeArtifactError('artifact_corrupt', message);
}

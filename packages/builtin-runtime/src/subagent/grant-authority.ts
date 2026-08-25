import { createHash, randomUUID } from 'node:crypto';
import type {
  SubagentDelegationGrant,
  SubagentGrantBinding,
  SubagentHandle,
  SubagentProviderFailureCode,
  SubagentResumeGrant,
} from '@kite/runtime-spi';
import { SUBAGENT_PROVIDER_SCHEMA_ } from '@kite/runtime-spi';

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_CONSUMED_GRANT_TOMBSTONES = 4_096;
const DOMAIN = 'kite.subagent-provider-grant.v1\0';
const HANDLE_DOMAIN = 'kite.subagent-provider-handle.v1\0';
const CHILD_ID_DOMAIN = 'kite.subagent-provider-child-id.v1\0';

export class SubagentGrantError extends Error {
  readonly code: Extract<
    SubagentProviderFailureCode,
    'invalid_grant' | 'expired_grant' | 'consumed_grant'
  >;
  constructor(
    code: Extract<
      SubagentProviderFailureCode,
      'invalid_grant' | 'expired_grant' | 'consumed_grant'
    >,
    message: string,
  ) {
    super(message);
    this.name = 'SubagentGrantError';
    this.code = code;
  }
}

export interface SubagentGrantVerifier {
  verifyAndConsumeStart(grant: SubagentDelegationGrant): Readonly<SubagentDelegationGrant>;
  verifyAndConsumeResume(grant: SubagentResumeGrant): Readonly<SubagentResumeGrant>;
  issueHandle(
    grant: Readonly<SubagentDelegationGrant | SubagentResumeGrant>,
    local: {
      readonly handleId: string;
      readonly ownerProcessId: number;
      readonly ownerProcessStartIdentity: string;
      readonly providerInstanceId: string;
    },
  ): Readonly<SubagentHandle>;
  verifyHandle(handle: SubagentHandle): Readonly<SubagentHandle>;
}

export class SubagentGrantAuthority {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #idSource: () => string;
  /** Wall clocks can move backwards; expiry decisions must not. */
  #clockHighWaterMs = -1;
  /**
   * A consumed grant only needs to remain a tombstone until the grant expires.
   * Keep the expiry with the identity so a long-lived Runtime cannot retain
   * every grant it has ever seen.  Tombstones are never evicted while valid:
   * if the bounded ledger is exhausted, verification fails closed instead.
   */
  readonly #consumed = new Map<string, number>();
  readonly #maxConsumedGrantTombstones: number;

  constructor(
    options: {
      now?: () => number;
      ttlMs?: number;
      idSource?: () => string;
      maxConsumedGrantTombstones?: number;
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#idSource = options.idSource ?? randomUUID;
    this.#maxConsumedGrantTombstones =
      options.maxConsumedGrantTombstones ?? MAX_CONSUMED_GRANT_TOMBSTONES;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0 || this.#ttlMs > DEFAULT_TTL_MS) {
      throw new Error('Subagent grant TTL is invalid.');
    }
    if (
      !Number.isSafeInteger(this.#maxConsumedGrantTombstones) ||
      this.#maxConsumedGrantTombstones < 1 ||
      this.#maxConsumedGrantTombstones > MAX_CONSUMED_GRANT_TOMBSTONES
    ) {
      throw new Error('Subagent consumed-grant tombstone capacity is invalid.');
    }
  }

  issueStart(binding: SubagentGrantBinding): Readonly<SubagentDelegationGrant> {
    exactKeys(binding, BINDING_KEYS);
    const timing = this.#timing();
    const unsigned = {
      schema: SUBAGENT_PROVIDER_SCHEMA_,
      purpose: 'start' as const,
      grantId: required(this.#idSource(), 'grantId'),
      ...validateBinding(binding),
      ...timing,
    };
    return freeze({ ...unsigned, seal: this.#seal(unsigned) });
  }

  issueChildInvocationId(input: {
    readonly parentModelInvocationId: string;
    readonly parentToolCallId: string;
    readonly parentAttempt: number;
    readonly role: SubagentGrantBinding['role'];
  }): string {
    exactKeys(input, ['parentModelInvocationId', 'parentToolCallId', 'parentAttempt', 'role']);
    required(input.parentModelInvocationId, 'parentModelInvocationId');
    required(input.parentToolCallId, 'parentToolCallId');
    positive(input.parentAttempt, 'parentAttempt');
    if (!['explore', 'plan', 'code', 'review'].includes(input.role)) invalid();
    return `subagent-${createHash('sha256')
      .update(CHILD_ID_DOMAIN)
      .update(canonical(input))
      .digest('hex')}`;
  }

  issueResume(
    input: SubagentGrantBinding & {
      continuationId: string;
      continuationDigest: string;
      blockedToolCallId: string;
      blockedRuntimeToolCallId: string;
      resumeAttempt: number;
    },
  ): Readonly<SubagentResumeGrant> {
    exactKeys(input, [...BINDING_KEYS, ...RESUME_KEYS]);
    const timing = this.#timing();
    const unsigned = {
      schema: SUBAGENT_PROVIDER_SCHEMA_,
      purpose: 'resume' as const,
      grantId: required(this.#idSource(), 'grantId'),
      ...validateBinding(input),
      continuationId: required(input.continuationId, 'continuationId'),
      continuationDigest: canonicalDigest(input.continuationDigest, 'continuationDigest'),
      blockedToolCallId: required(input.blockedToolCallId, 'blockedToolCallId'),
      blockedRuntimeToolCallId: required(
        input.blockedRuntimeToolCallId,
        'blockedRuntimeToolCallId',
      ),
      resumeAttempt: positive(input.resumeAttempt, 'resumeAttempt'),
      ...timing,
    };
    return freeze({ ...unsigned, seal: this.#seal(unsigned) });
  }

  verifier(): SubagentGrantVerifier {
    return Object.freeze({
      verifyAndConsumeStart: (grant: SubagentDelegationGrant) => this.#verify(grant, 'start'),
      verifyAndConsumeResume: (grant: SubagentResumeGrant) => this.#verify(grant, 'resume'),
      issueHandle: (
        grant: Readonly<SubagentDelegationGrant | SubagentResumeGrant>,
        local: {
          readonly handleId: string;
          readonly ownerProcessId: number;
          readonly ownerProcessStartIdentity: string;
          readonly providerInstanceId: string;
        },
      ) => this.#issueHandle(grant, local),
      verifyHandle: (handle: SubagentHandle) => this.#verifyHandle(handle),
    });
  }

  #issueHandle(
    grant: Readonly<SubagentDelegationGrant | SubagentResumeGrant>,
    local: {
      readonly handleId: string;
      readonly ownerProcessId: number;
      readonly ownerProcessStartIdentity: string;
      readonly providerInstanceId: string;
    },
  ): Readonly<SubagentHandle> {
    required(local.handleId, 'handleId');
    positive(local.ownerProcessId, 'ownerProcessId');
    required(local.ownerProcessStartIdentity, 'ownerProcessStartIdentity');
    required(local.providerInstanceId, 'providerInstanceId');
    const unsigned = {
      schema: SUBAGENT_PROVIDER_SCHEMA_,
      handleId: local.handleId,
      grantId: grant.grantId,
      purpose: grant.purpose,
      childInvocationId: grant.childInvocationId,
      parentInvocationId: grant.parentInvocationId,
      parentToolCallId: grant.parentToolCallId,
      parentAttempt: grant.parentAttempt,
      role: grant.role,
      taskArtifact: grant.taskArtifact,
      taskDigest: grant.taskDigest,
      continuationId: grant.purpose === 'resume' ? grant.continuationId : null,
      continuationDigest: grant.purpose === 'resume' ? grant.continuationDigest : null,
      blockedToolCallId: grant.purpose === 'resume' ? grant.blockedToolCallId : null,
      blockedRuntimeToolCallId: grant.purpose === 'resume' ? grant.blockedRuntimeToolCallId : null,
      resumeAttempt: grant.purpose === 'resume' ? grant.resumeAttempt : null,
      ownerProcessId: local.ownerProcessId,
      ownerProcessStartIdentity: local.ownerProcessStartIdentity,
      providerInstanceId: local.providerInstanceId,
      lifecycle: 'running' as const,
    };
    return freeze({ ...unsigned, integrityIdentifier: this.#handleSeal(unsigned) });
  }

  #verifyHandle(handle: SubagentHandle): Readonly<SubagentHandle> {
    try {
      const copy = structuredClone(handle);
      exactKeys(copy, HANDLE_KEYS);
      const { integrityIdentifier, ...unsigned } = copy;
      if (!safeEqual(integrityIdentifier, this.#handleSeal(unsigned))) invalid();
      required(copy.handleId, 'handleId');
      required(copy.grantId, 'grantId');
      required(copy.childInvocationId, 'childInvocationId');
      required(copy.parentInvocationId, 'parentInvocationId');
      required(copy.parentToolCallId, 'parentToolCallId');
      positive(copy.parentAttempt, 'parentAttempt');
      if (!['start', 'resume'].includes(copy.purpose)) invalid();
      if (!['explore', 'plan', 'code', 'review'].includes(copy.role)) invalid();
      validateTaskArtifact(copy.taskArtifact);
      taskDigest(copy.taskDigest, 'taskDigest');
      positive(copy.ownerProcessId, 'ownerProcessId');
      required(copy.ownerProcessStartIdentity, 'ownerProcessStartIdentity');
      required(copy.providerInstanceId, 'providerInstanceId');
      if (copy.lifecycle !== 'running') invalid();
      const resumeValues = [
        copy.continuationId,
        copy.continuationDigest,
        copy.blockedToolCallId,
        copy.blockedRuntimeToolCallId,
        copy.resumeAttempt,
      ];
      if (copy.purpose === 'start') {
        if (resumeValues.some((value) => value !== null)) invalid();
      } else {
        required(copy.continuationId ?? '', 'continuationId');
        canonicalDigest(copy.continuationDigest ?? '', 'continuationDigest');
        required(copy.blockedToolCallId ?? '', 'blockedToolCallId');
        required(copy.blockedRuntimeToolCallId ?? '', 'blockedRuntimeToolCallId');
        positive(copy.resumeAttempt ?? 0, 'resumeAttempt');
      }
      return freeze(copy);
    } catch {
      throw new SubagentGrantError('invalid_grant', 'Subagent handle identity is invalid.');
    }
  }

  #handleSeal(value: object): string {
    return `sha256:${createHash('sha256').update(HANDLE_DOMAIN).update(canonical(value)).digest('hex')}`;
  }

  #timing() {
    const issuedAtMs = this.#effectiveNow();
    const expiresAtMs = issuedAtMs + this.#ttlMs;
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= issuedAtMs) {
      throw new Error('Subagent grant expiry is invalid.');
    }
    return { issuedAtMs, expiresAtMs };
  }

  #seal(value: object): string {
    return `sha256:${createHash('sha256').update(DOMAIN).update(canonical(value)).digest('hex')}`;
  }

  #verify<T extends SubagentDelegationGrant | SubagentResumeGrant>(
    grant: T,
    purpose: T['purpose'],
  ): Readonly<T> {
    try {
      const now = this.#effectiveNow();
      this.#pruneConsumed(now);
      const copy = structuredClone(grant);
      exactKeys(copy, purpose === 'start' ? START_GRANT_KEYS : RESUME_GRANT_KEYS);
      if (copy.schema !== SUBAGENT_PROVIDER_SCHEMA_ || copy.purpose !== purpose) invalid();
      validateBinding(copy);
      const { seal, ...unsigned } = copy;
      if (!safeEqual(seal, this.#seal(unsigned))) invalid();
      if (
        !Number.isSafeInteger(copy.issuedAtMs) ||
        copy.issuedAtMs < 0 ||
        !Number.isSafeInteger(copy.expiresAtMs) ||
        copy.expiresAtMs <= copy.issuedAtMs
      ) {
        invalid();
      }
      if (copy.issuedAtMs > now || copy.expiresAtMs <= now) {
        throw new SubagentGrantError(
          'expired_grant',
          'Subagent grant expired before lifecycle start.',
        );
      }
      if (copy.expiresAtMs - copy.issuedAtMs > this.#ttlMs) invalid();
      if (this.#consumed.has(copy.grantId)) {
        throw new SubagentGrantError('consumed_grant', 'Subagent grant was already consumed.');
      }
      if (purpose === 'resume') {
        const resume = copy as SubagentResumeGrant;
        required(resume.continuationId, 'continuationId');
        canonicalDigest(resume.continuationDigest, 'continuationDigest');
        required(resume.blockedToolCallId, 'blockedToolCallId');
        required(resume.blockedRuntimeToolCallId, 'blockedRuntimeToolCallId');
        positive(resume.resumeAttempt, 'resumeAttempt');
      }
      if (this.#consumed.size >= this.#maxConsumedGrantTombstones) {
        // Dropping a still-valid tombstone would make a replayable grant look
        // fresh.  Refuse the new lifecycle instead of weakening single-use.
        throw new SubagentGrantError(
          'invalid_grant',
          'Subagent consumed-grant tombstone capacity is exhausted.',
        );
      }
      this.#consumed.set(copy.grantId, copy.expiresAtMs);
      return freeze(copy);
    } catch (error) {
      if (error instanceof SubagentGrantError) throw error;
      throw new SubagentGrantError('invalid_grant', 'Subagent grant identity is invalid.');
    }
  }

  #pruneConsumed(now: number): void {
    for (const [grantId, expiresAtMs] of this.#consumed) {
      if (expiresAtMs <= now) this.#consumed.delete(grantId);
    }
  }

  #effectiveNow(): number {
    const current = this.#now();
    if (!Number.isSafeInteger(current) || current < 0) throw new Error('Invalid clock.');
    if (current > this.#clockHighWaterMs) this.#clockHighWaterMs = current;
    return this.#clockHighWaterMs;
  }
}

function validateBinding<T extends SubagentGrantBinding>(value: T): T {
  required(value.parentInvocationId, 'parentInvocationId');
  required(value.parentToolCallId, 'parentToolCallId');
  positive(value.parentAttempt, 'parentAttempt');
  canonicalDigest(value.capabilityRevision, 'capabilityRevision');
  canonicalDigest(value.admissionDigest, 'admissionDigest');
  canonicalDigest(value.effectiveEffectsDigest, 'effectiveEffectsDigest');
  required(value.childInvocationId, 'childInvocationId');
  if (!['explore', 'plan', 'code', 'review'].includes(value.role)) invalid();
  validateTaskArtifact(value.taskArtifact);
  taskDigest(value.taskDigest, 'taskDigest');
  exactKeys(value.capabilityCeiling, [
    'allowedTools',
    'bindingIds',
    'bindingRevision',
    'ceilingDigest',
  ]);
  canonicalDigest(value.capabilityCeiling.bindingRevision, 'capabilityCeiling.bindingRevision');
  canonicalDigest(value.capabilityCeiling.ceilingDigest, 'capabilityCeiling.ceilingDigest');
  uniqueStrings(value.capabilityCeiling.allowedTools, 'allowedTools');
  uniqueStrings(value.capabilityCeiling.bindingIds, 'bindingIds');
  exactKeys(value.authorization, [
    'authorizationDigest',
    'interactionMode',
    'phase',
    'workspaceAccess',
  ]);
  canonicalDigest(value.authorization.authorizationDigest, 'authorizationDigest');
  if (!['accept_edits', 'auto', 'full'].includes(value.authorization.interactionMode)) invalid();
  if (!['planning', 'building'].includes(value.authorization.phase)) invalid();
  if (!['read', 'write'].includes(value.authorization.workspaceAccess)) invalid();
  exactKeys(value.executionBoundary, ['canonicalWorkspace', 'executionBoundaryDigest']);
  required(value.executionBoundary.canonicalWorkspace, 'canonicalWorkspace');
  namespacedSha256Digest(
    value.executionBoundary.executionBoundaryDigest,
    'executionBoundaryDigest',
  );
  exactKeys(value.resource, ['parentReservationId', 'budgetDigest']);
  if (
    !(
      value.resource.parentReservationId === null ||
      typeof value.resource.parentReservationId === 'string'
    )
  )
    invalid();
  if (typeof value.resource.parentReservationId === 'string')
    required(value.resource.parentReservationId, 'parentReservationId');
  canonicalDigest(value.resource.budgetDigest, 'budgetDigest');
  required(value.cancellationCorrelation, 'cancellationCorrelation');
  exactKeys(value.model, ['parentModelInvocationId', 'parentToolCallId']);
  required(value.model.parentModelInvocationId, 'parentModelInvocationId');
  if (value.model.parentToolCallId !== value.parentToolCallId) invalid();
  return structuredClone(value);
}

function uniqueStrings(value: readonly string[], name: string): void {
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== 'string'))
    invalid();
  if (new Set(value).size !== value.length) throw new Error(`${name} contains duplicates.`);
}

function required(value: string, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function canonicalDigest(value: string, name: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${name} is invalid.`);
  return value;
}

function taskDigest(value: string, name: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${name} is invalid.`);
  return value;
}

function namespacedSha256Digest(value: string, name: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${name} is invalid.`);
  return value;
}

const BINDING_KEYS = [
  'parentInvocationId',
  'parentToolCallId',
  'parentAttempt',
  'capabilityRevision',
  'admissionDigest',
  'effectiveEffectsDigest',
  'childInvocationId',
  'role',
  'taskArtifact',
  'taskDigest',
  'capabilityCeiling',
  'authorization',
  'executionBoundary',
  'resource',
  'cancellationCorrelation',
  'model',
] as const;
const RESUME_KEYS = [
  'continuationId',
  'continuationDigest',
  'blockedToolCallId',
  'blockedRuntimeToolCallId',
  'resumeAttempt',
] as const;
const START_GRANT_KEYS = [
  'schema',
  'purpose',
  'grantId',
  ...BINDING_KEYS,
  'issuedAtMs',
  'expiresAtMs',
  'seal',
] as const;
const RESUME_GRANT_KEYS = [
  ...START_GRANT_KEYS.filter((key) => key !== 'purpose' && key !== 'seal'),
  'purpose',
  ...RESUME_KEYS,
  'seal',
] as const;
const HANDLE_KEYS = [
  'schema',
  'handleId',
  'grantId',
  'purpose',
  'childInvocationId',
  'parentInvocationId',
  'parentToolCallId',
  'parentAttempt',
  'role',
  'taskArtifact',
  'taskDigest',
  'continuationId',
  'continuationDigest',
  'blockedToolCallId',
  'blockedRuntimeToolCallId',
  'resumeAttempt',
  'ownerProcessId',
  'ownerProcessStartIdentity',
  'providerInstanceId',
  'lifecycle',
  'integrityIdentifier',
] as const;

function validateTaskArtifact(value: SubagentGrantBinding['taskArtifact']): void {
  exactKeys(value, ['artifactId', 'kind', 'integrityIdentifier', 'byteLength']);
  if (!/^pa_[0-9a-f]{64}$/u.test(value.artifactId)) invalid();
  if (value.kind !== 'subagent_task') invalid();
  if (!/^sha256:[0-9a-f]{64}$/u.test(value.integrityIdentifier)) invalid();
  positive(value.byteLength, 'taskArtifact.byteLength');
}

function exactKeys(value: unknown, expected: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    invalid();
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} is invalid.`);
  return value;
}

function invalid(): never {
  throw new Error('invalid subagent grant');
}

function safeEqual(a: string, b: string): boolean {
  return a === b;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`;
}

function freeze<T>(value: T): Readonly<T> {
  const copy = structuredClone(value);
  const visit = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) return;
    for (const child of Object.values(entry as Record<string, unknown>)) visit(child);
    Object.freeze(entry);
  };
  visit(copy);
  return copy;
}

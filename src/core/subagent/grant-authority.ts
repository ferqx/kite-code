import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  SubagentDelegationGrantV1,
  SubagentGrantBindingV1,
  SubagentHandleV1,
  SubagentProviderFailureCodeV1,
  SubagentResumeGrantV1,
} from '@/protocol/subagent-provider';
import { SUBAGENT_PROVIDER_SCHEMA_V1 } from '@/protocol/subagent-provider';

const DEFAULT_TTL_MS = 5 * 60_000;
const DOMAIN = 'kite.subagent-provider-grant.v1\0';
const HANDLE_DOMAIN = 'kite.subagent-provider-handle.v1\0';
const CHILD_ID_DOMAIN = 'kite.subagent-provider-child-id.v1\0';

export class SubagentGrantErrorV1 extends Error {
  readonly code: Extract<
    SubagentProviderFailureCodeV1,
    'invalid_grant' | 'expired_grant' | 'consumed_grant'
  >;
  constructor(
    code: Extract<
      SubagentProviderFailureCodeV1,
      'invalid_grant' | 'expired_grant' | 'consumed_grant'
    >,
    message: string,
  ) {
    super(message);
    this.name = 'SubagentGrantErrorV1';
    this.code = code;
  }
}

export interface SubagentGrantVerifierV1 {
  verifyAndConsumeStart(grant: SubagentDelegationGrantV1): Readonly<SubagentDelegationGrantV1>;
  verifyAndConsumeResume(grant: SubagentResumeGrantV1): Readonly<SubagentResumeGrantV1>;
  issueHandle(
    grant: Readonly<SubagentDelegationGrantV1 | SubagentResumeGrantV1>,
    local: {
      readonly handleId: string;
      readonly ownerProcessId: number;
      readonly ownerProcessStartIdentity: string;
      readonly providerInstanceId: string;
    },
  ): Readonly<SubagentHandleV1>;
  verifyHandle(handle: SubagentHandleV1): Readonly<SubagentHandleV1>;
}

export class SubagentGrantAuthorityV1 {
  readonly #key: Uint8Array;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #idSource: () => string;
  readonly #consumed = new Set<string>();

  constructor(
    options: {
      key?: Uint8Array;
      now?: () => number;
      ttlMs?: number;
      idSource?: () => string;
    } = {},
  ) {
    this.#key = new Uint8Array(options.key ?? randomBytes(32));
    if (this.#key.byteLength < 32) throw new Error('Subagent grant key is unavailable.');
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#idSource = options.idSource ?? randomUUID;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0 || this.#ttlMs > DEFAULT_TTL_MS) {
      throw new Error('Subagent grant TTL is invalid.');
    }
  }

  issueStart(binding: SubagentGrantBindingV1): Readonly<SubagentDelegationGrantV1> {
    exactKeys(binding, BINDING_KEYS);
    const timing = this.#timing();
    const unsigned = {
      schema: SUBAGENT_PROVIDER_SCHEMA_V1,
      purpose: 'start' as const,
      grantId: required(this.#idSource(), 'grantId'),
      ...validateBinding(binding),
      ...timing,
    };
    return freeze({ ...unsigned, seal: this.#seal(unsigned) });
  }

  issueChildInvocationId(input: {
    readonly parentInvocationId: string;
    readonly parentToolCallId: string;
    readonly parentAttempt: number;
    readonly role: SubagentGrantBindingV1['role'];
  }): string {
    exactKeys(input, ['parentInvocationId', 'parentToolCallId', 'parentAttempt', 'role']);
    required(input.parentInvocationId, 'parentInvocationId');
    required(input.parentToolCallId, 'parentToolCallId');
    positive(input.parentAttempt, 'parentAttempt');
    if (!['explore', 'plan', 'code', 'review'].includes(input.role)) invalid();
    return `subagent-${createHash('sha256')
      .update(CHILD_ID_DOMAIN)
      .update(canonical(input))
      .digest('hex')}`;
  }

  issueResume(
    input: SubagentGrantBindingV1 & {
      continuationId: string;
      continuationDigest: string;
      blockedToolCallId: string;
      blockedRuntimeToolCallId: string;
      resumeAttempt: number;
    },
  ): Readonly<SubagentResumeGrantV1> {
    exactKeys(input, [...BINDING_KEYS, ...RESUME_KEYS]);
    const timing = this.#timing();
    const unsigned = {
      schema: SUBAGENT_PROVIDER_SCHEMA_V1,
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

  verifier(): SubagentGrantVerifierV1 {
    return Object.freeze({
      verifyAndConsumeStart: (grant: SubagentDelegationGrantV1) => this.#verify(grant, 'start'),
      verifyAndConsumeResume: (grant: SubagentResumeGrantV1) => this.#verify(grant, 'resume'),
      issueHandle: (
        grant: Readonly<SubagentDelegationGrantV1 | SubagentResumeGrantV1>,
        local: {
          readonly handleId: string;
          readonly ownerProcessId: number;
          readonly ownerProcessStartIdentity: string;
          readonly providerInstanceId: string;
        },
      ) => this.#issueHandle(grant, local),
      verifyHandle: (handle: SubagentHandleV1) => this.#verifyHandle(handle),
    });
  }

  #issueHandle(
    grant: Readonly<SubagentDelegationGrantV1 | SubagentResumeGrantV1>,
    local: {
      readonly handleId: string;
      readonly ownerProcessId: number;
      readonly ownerProcessStartIdentity: string;
      readonly providerInstanceId: string;
    },
  ): Readonly<SubagentHandleV1> {
    required(local.handleId, 'handleId');
    positive(local.ownerProcessId, 'ownerProcessId');
    required(local.ownerProcessStartIdentity, 'ownerProcessStartIdentity');
    required(local.providerInstanceId, 'providerInstanceId');
    const unsigned = {
      schema: SUBAGENT_PROVIDER_SCHEMA_V1,
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

  #verifyHandle(handle: SubagentHandleV1): Readonly<SubagentHandleV1> {
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
      throw new SubagentGrantErrorV1('invalid_grant', 'Subagent handle identity is invalid.');
    }
  }

  #handleSeal(value: object): string {
    return `hmac-sha256:${createHmac('sha256', this.#key).update(HANDLE_DOMAIN).update(canonical(value)).digest('hex')}`;
  }

  #timing() {
    const issuedAtMs = this.#now();
    if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0) throw new Error('Invalid clock.');
    return { issuedAtMs, expiresAtMs: issuedAtMs + this.#ttlMs };
  }

  #seal(value: object): string {
    return `hmac-sha256:${createHmac('sha256', this.#key).update(DOMAIN).update(canonical(value)).digest('hex')}`;
  }

  #verify<T extends SubagentDelegationGrantV1 | SubagentResumeGrantV1>(
    grant: T,
    purpose: T['purpose'],
  ): Readonly<T> {
    try {
      const copy = structuredClone(grant);
      exactKeys(copy, purpose === 'start' ? START_GRANT_KEYS : RESUME_GRANT_KEYS);
      if (copy.schema !== SUBAGENT_PROVIDER_SCHEMA_V1 || copy.purpose !== purpose) invalid();
      validateBinding(copy);
      const { seal, ...unsigned } = copy;
      if (!safeEqual(seal, this.#seal(unsigned))) invalid();
      if (copy.issuedAtMs > this.#now() || copy.expiresAtMs <= this.#now()) {
        throw new SubagentGrantErrorV1(
          'expired_grant',
          'Subagent grant expired before lifecycle start.',
        );
      }
      if (copy.expiresAtMs - copy.issuedAtMs > this.#ttlMs) invalid();
      if (this.#consumed.has(copy.grantId)) {
        throw new SubagentGrantErrorV1('consumed_grant', 'Subagent grant was already consumed.');
      }
      if (purpose === 'resume') {
        const resume = copy as SubagentResumeGrantV1;
        required(resume.continuationId, 'continuationId');
        canonicalDigest(resume.continuationDigest, 'continuationDigest');
        required(resume.blockedToolCallId, 'blockedToolCallId');
        required(resume.blockedRuntimeToolCallId, 'blockedRuntimeToolCallId');
        positive(resume.resumeAttempt, 'resumeAttempt');
      }
      this.#consumed.add(copy.grantId);
      return freeze(copy);
    } catch (error) {
      if (error instanceof SubagentGrantErrorV1) throw error;
      throw new SubagentGrantErrorV1('invalid_grant', 'Subagent grant identity is invalid.');
    }
  }
}

function validateBinding<T extends SubagentGrantBindingV1>(value: T): T {
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
  if (!['default', 'accept_edits', 'full'].includes(value.authorization.interactionMode)) invalid();
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
  exactKeys(value.model, [
    'parentModelInvocationId',
    'parentToolCallId',
    'responseSourceMode',
    'replayContextDigest',
  ]);
  required(value.model.parentModelInvocationId, 'parentModelInvocationId');
  if (value.model.parentToolCallId !== value.parentToolCallId) invalid();
  if (!['live', 'record', 'replay'].includes(value.model.responseSourceMode)) invalid();
  canonicalDigest(value.model.replayContextDigest, 'replayContextDigest');
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

function validateTaskArtifact(value: SubagentGrantBindingV1['taskArtifact']): void {
  exactKeys(value, ['artifactId', 'kind', 'integrityIdentifier', 'byteLength']);
  if (!/^pa_[0-9a-f]{64}$/u.test(value.artifactId)) invalid();
  if (value.kind !== 'subagent_task') invalid();
  if (!/^hmac-sha256:[0-9a-f]{64}$/u.test(value.integrityIdentifier)) invalid();
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
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
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

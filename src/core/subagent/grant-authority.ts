import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  SubagentDelegationGrantV1,
  SubagentGrantBindingV1,
  SubagentProviderFailureCodeV1,
  SubagentResumeGrantV1,
} from '@/protocol/subagent-provider';
import { SUBAGENT_PROVIDER_SCHEMA_V1 } from '@/protocol/subagent-provider';

const DEFAULT_TTL_MS = 5 * 60_000;
const DOMAIN = 'kite.subagent-provider-grant.v1\0';

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

  issueResume(
    input: SubagentGrantBindingV1 & {
      continuationId: string;
      continuationDigest: string;
      blockedToolCallId: string;
      blockedRuntimeToolCallId: string;
      resumeAttempt: number;
    },
  ): Readonly<SubagentResumeGrantV1> {
    const timing = this.#timing();
    const unsigned = {
      schema: SUBAGENT_PROVIDER_SCHEMA_V1,
      purpose: 'resume' as const,
      grantId: required(this.#idSource(), 'grantId'),
      ...validateBinding(input),
      continuationId: required(input.continuationId, 'continuationId'),
      continuationDigest: digest(input.continuationDigest, 'continuationDigest'),
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
    });
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
        digest(resume.continuationDigest, 'continuationDigest');
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
  digest(value.capabilityRevision, 'capabilityRevision');
  digest(value.admissionDigest, 'admissionDigest');
  digest(value.effectiveEffectsDigest, 'effectiveEffectsDigest');
  required(value.childInvocationId, 'childInvocationId');
  if (!['explore', 'plan', 'code', 'review'].includes(value.role)) invalid();
  required(value.taskArtifact.artifactId, 'taskArtifact.artifactId');
  if (value.taskArtifact.kind !== 'subagent_task') invalid();
  digest(value.taskArtifact.digest, 'taskArtifact.digest');
  positive(value.taskArtifact.byteLength, 'taskArtifact.byteLength');
  if (value.taskDigest !== value.taskArtifact.digest) invalid();
  digest(value.capabilityCeiling.bindingRevision, 'capabilityCeiling.bindingRevision');
  digest(value.capabilityCeiling.ceilingDigest, 'capabilityCeiling.ceilingDigest');
  uniqueStrings(value.capabilityCeiling.allowedTools, 'allowedTools');
  uniqueStrings(value.capabilityCeiling.bindingIds, 'bindingIds');
  digest(value.authorization.authorizationDigest, 'authorizationDigest');
  required(value.executionBoundary.canonicalWorkspace, 'canonicalWorkspace');
  digest(value.executionBoundary.executionBoundaryDigest, 'executionBoundaryDigest');
  digest(value.resource.budgetDigest, 'budgetDigest');
  required(value.cancellationCorrelation, 'cancellationCorrelation');
  required(value.model.parentModelInvocationId, 'parentModelInvocationId');
  if (value.model.parentToolCallId !== value.parentToolCallId) invalid();
  if (!['live', 'record', 'replay'].includes(value.model.responseSourceMode)) invalid();
  digest(value.model.replayContextDigest, 'replayContextDigest');
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

function digest(value: string, name: string): string {
  if (!/^(?:sha256:)?[0-9a-f]{64}$/u.test(value)) throw new Error(`${name} is invalid.`);
  return value;
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

import type {
  ProviderDataAdmissionDecisionV1,
  ProviderDataAdmissionGateV1,
} from '@/core/config/provider-data-admission';
import {
  ProviderDataAdmissionError,
  providerPayloadFromModelPromptV1,
} from '@/core/config/provider-data-admission';
import type { BaseMessage } from '@/core/messages';
import {
  canonicalContextDigestV2,
  type PreparedContextRequestReadyV2,
  type ProjectionSourceIdentityV2,
  type RequestAdmissionIdentityV2,
} from './context-preparation-v2';

export type PreparedPrimaryContextRequestV2 = PreparedContextRequestReadyV2 & {
  readonly next: Readonly<{ kind: 'primary_ready' }>;
};

export interface ContextDispatchIdentityV2 {
  readonly sourceIdentity: Readonly<ProjectionSourceIdentityV2>;
  readonly requestIdentity: Readonly<RequestAdmissionIdentityV2>;
}

export interface StartedContextAdmissionV2 {
  readonly effectLeaseId: string;
  readonly reservationIds: readonly string[];
}

export interface AdmittedContextRequestV2 {
  readonly version: 2;
  readonly requestId: string;
  readonly prepared: PreparedPrimaryContextRequestV2;
  readonly providerMessages: readonly BaseMessage[];
  readonly effectLeaseId: string;
  readonly reservationIds: readonly string[];
  readonly providerAdmission: Readonly<ProviderDataAdmissionDecisionV1>;
  readonly admittedRequestDigest: string;
}

export class PreparedContextStaleErrorV2 extends Error {
  constructor(message = 'Prepared context request became stale before dispatch.') {
    super(message);
    this.name = 'PreparedContextStaleErrorV2';
  }
}

export class PreparedContextPurposeErrorV2 extends Error {
  constructor() {
    super('Only a primary_ready context request can be admitted in Slice A.');
    this.name = 'PreparedContextPurposeErrorV2';
  }
}

function sameIdentity(left: unknown, right: unknown): boolean {
  return (
    canonicalContextDigestV2('context-admission-identity:v2', left) ===
    canonicalContextDigestV2('context-admission-identity:v2', right)
  );
}

function assertPreparedIdentity(
  prepared: PreparedPrimaryContextRequestV2,
  current: ContextDispatchIdentityV2,
): void {
  if (
    !sameIdentity(prepared.sourceIdentity, current.sourceIdentity) ||
    !sameIdentity(prepared.requestIdentity, current.requestIdentity)
  ) {
    throw new PreparedContextStaleErrorV2();
  }
  const payloadDigest = canonicalContextDigestV2(
    'context-final-provider-payload:v2',
    prepared.effectiveProjection.providerMessages,
  );
  if (payloadDigest !== prepared.requestIdentity.finalProviderPayloadDigest) {
    throw new PreparedContextStaleErrorV2(
      'Prepared provider payload does not match its request identity.',
    );
  }
}

function frozenAdmission(
  decision: ProviderDataAdmissionDecisionV1,
): Readonly<ProviderDataAdmissionDecisionV1> {
  return Object.freeze(structuredClone(decision));
}

/**
 * Effect-only final admission boundary. The caller owns Kernel lease and
 * reservation persistence; this function never rebuilds provider bytes.
 */
export async function admitAndDispatchPreparedContextRequestV2<T>(input: {
  prepared: PreparedPrimaryContextRequestV2;
  requestId: string;
  providerDataPolicyRequired: boolean;
  providerDataAdmission?: ProviderDataAdmissionGateV1;
  resolveCurrentIdentity: () => ContextDispatchIdentityV2;
  startEffect: (
    prepared: PreparedPrimaryContextRequestV2,
  ) => Promise<StartedContextAdmissionV2> | StartedContextAdmissionV2;
  markLocalProviderAdmissionDenied: (started: StartedContextAdmissionV2) => Promise<void> | void;
  markUnknownExternalOutcome: (started: StartedContextAdmissionV2) => Promise<void> | void;
  dispatch: (admitted: AdmittedContextRequestV2) => Promise<T>;
}): Promise<T> {
  if (input.prepared.purpose !== 'normal' || input.prepared.next.kind !== 'primary_ready') {
    throw new PreparedContextPurposeErrorV2();
  }

  // Precheck before durable ownership. A waiter wake-up must call prepare
  // again and therefore cannot reuse this function with an old artifact.
  assertPreparedIdentity(input.prepared, input.resolveCurrentIdentity());
  const started = await input.startEffect(input.prepared);

  try {
    // The start transition may advance Runtime revision only through its own
    // lease/reservation events. The resolver must return the projection
    // dependency identity, not the incidental global revision.
    assertPreparedIdentity(input.prepared, input.resolveCurrentIdentity());
  } catch (error) {
    await input.markUnknownExternalOutcome(started);
    throw error;
  }

  const providerAdmission = input.providerDataPolicyRequired
    ? (input.providerDataAdmission?.(
        providerPayloadFromModelPromptV1(input.prepared.effectiveProjection.providerMessages),
        'primary_model',
      ) ?? {
        admitted: false,
        reason: 'mandatory_policy_unavailable' as const,
        routeAlias: 'unresolved',
      })
    : {
        admitted: true,
        reason: 'feature_disabled' as const,
        routeAlias: 'feature_disabled',
      };
  if (!providerAdmission.admitted) {
    await input.markLocalProviderAdmissionDenied(started);
    throw new ProviderDataAdmissionError(providerAdmission);
  }

  const admittedRequestDigest = canonicalContextDigestV2('admitted-context-request:v2', {
    preparedDigest: input.prepared.preparedDigest,
    sourceIdentity: input.prepared.sourceIdentity,
    requestIdentity: input.prepared.requestIdentity,
    requestId: input.requestId,
    effectLeaseId: started.effectLeaseId,
    reservationIds: started.reservationIds,
    providerAdmission,
  });
  const admitted = Object.freeze({
    version: 2 as const,
    requestId: input.requestId,
    prepared: input.prepared,
    providerMessages: input.prepared.effectiveProjection.providerMessages,
    effectLeaseId: started.effectLeaseId,
    reservationIds: Object.freeze([...started.reservationIds]),
    providerAdmission: frozenAdmission(providerAdmission),
    admittedRequestDigest,
  });

  try {
    return await input.dispatch(admitted);
  } catch (error) {
    await input.markUnknownExternalOutcome(started);
    throw error;
  }
}

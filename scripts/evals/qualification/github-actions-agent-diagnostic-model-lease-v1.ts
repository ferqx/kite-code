import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { SupportedChatModel } from '../../../src/core/model/factory';

/**
 * The public-safe GitHub Actions diagnostic suite owns one credential
 * acquisition per job. A case receives only a fixed model binding: never a
 * raw credential, endpoint, or generic fetch capability. This lease is
 * deliberately separate from ADR-0071's formal credential/ledger transport.
 */
export const GITHUB_ACTIONS_DIAGNOSTIC_MODEL_LEASE_SCHEMA_V1 =
  'GitHubActionsDiagnosticModelLeaseV1' as const;

/** The workflow Environment secret; it is never copied into a report. */
export const GITHUB_ACTIONS_DIAGNOSTIC_SECRET_V1 = 'KITE_AGENT_LIVE_EVAL_QWEN_API_KEY' as const;

/** Source-only route metadata shared by the fixed diagnostic bindings. */
export const GITHUB_ACTIONS_DIAGNOSTIC_ROUTE_ALIAS_V1 = 'gha-diagnostic-qwen' as const;
export const GITHUB_ACTIONS_DIAGNOSTIC_QWEN_BASE_URL_V1 =
  'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' as const;
export const GITHUB_ACTIONS_DIAGNOSTIC_QWEN_MODEL_V1 = 'qwen3.6-flash' as const;

const FIXED_PROVIDER_ORIGIN_V1 = 'https://token-plan.cn-beijing.maas.aliyuncs.com';
const FIXED_PROVIDER_PATH_V1 = '/compatible-mode/v1/chat/completions';
export const GITHUB_ACTIONS_DIAGNOSTIC_TOTAL_PROVIDER_ATTEMPT_CAP_V1 = 5;
const bindingBrand = Symbol('github-actions-diagnostic-model-binding-v1');

export const GITHUB_ACTIONS_DIAGNOSTIC_CASE_IDS_V1 = [
  'agent_read',
  'auto_compaction_success',
  'auto_compaction_cancel',
] as const;
export type GitHubActionsDiagnosticCaseIdV1 =
  (typeof GITHUB_ACTIONS_DIAGNOSTIC_CASE_IDS_V1)[number];

export interface GitHubActionsDiagnosticCasePolicyV1 {
  readonly maxProviderAttempts: number;
  readonly maxOutputTokens: number;
  readonly supportsToolCalls: boolean;
}

/**
 * Fixed per-case caps. Their sum equals the workflow-wide cap above, so an
 * aggregate cannot silently expand a diagnostic case's Provider exposure.
 */
export const GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1: Readonly<
  Record<GitHubActionsDiagnosticCaseIdV1, GitHubActionsDiagnosticCasePolicyV1>
> = Object.freeze({
  agent_read: Object.freeze({
    maxProviderAttempts: 2,
    maxOutputTokens: 256,
    supportsToolCalls: true,
  }),
  auto_compaction_success: Object.freeze({
    maxProviderAttempts: 2,
    maxOutputTokens: 600,
    supportsToolCalls: false,
  }),
  auto_compaction_cancel: Object.freeze({
    maxProviderAttempts: 1,
    maxOutputTokens: 600,
    supportsToolCalls: false,
  }),
});

type TransportProofKindV1 = 'provider_fetch' | 'contract_only';
type DiagnosticProviderFetchV1 = typeof globalThis.fetch;
type DiagnosticPlatformFetchV1 = (
  input: Parameters<DiagnosticProviderFetchV1>[0],
  init?: Parameters<DiagnosticProviderFetchV1>[1],
) => ReturnType<DiagnosticProviderFetchV1>;

export interface GitHubActionsDiagnosticModelBindingV1 {
  readonly caseId: GitHubActionsDiagnosticCaseIdV1;
  readonly model: SupportedChatModel;
  /** Safe provenance only; neither endpoint nor credential is serializable. */
  readonly transportProofKind: TransportProofKindV1;
  readonly transportEntries: () => number;
  /**
   * Resolves for an entry ordinal strictly later than `afterEntries`. For a
   * Provider binding that means the captured platform fetch was invoked and
   * returned a Promise; it does not mean the request completed successfully.
   */
  readonly waitForNextTransportEntry: (afterEntries: number, signal?: AbortSignal) => Promise<void>;
  readonly [bindingBrand]: true;
}

export interface GitHubActionsDiagnosticModelLeaseV1 {
  readonly schema: typeof GITHUB_ACTIONS_DIAGNOSTIC_MODEL_LEASE_SCHEMA_V1;
  /** Each fixed case can be issued exactly once from a lease. */
  readonly bind: (caseId: GitHubActionsDiagnosticCaseIdV1) => GitHubActionsDiagnosticModelBindingV1;
}

interface TransportWaiterV1 {
  readonly afterEntries: number;
  readonly resolve: () => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

interface TransportReceiptStateV1 {
  entries: number;
  readonly waiters: Set<TransportWaiterV1>;
}

interface SharedProviderAttemptQuotaV1 {
  /** Reserves before a fetch begins and returns a rollback for sync failures. */
  readonly reserveBeforeTransportInvocation: () => () => void;
}

/**
 * Consume the one GitHub Environment secret. The direct bindings are built
 * before the lease escapes, with `globalThis.fetch` captured at acquisition.
 * The credential is then removed from both the environment and this function's
 * local variable; only the SDK's fixed provider closures retain it.
 */
export function acquireGitHubActionsDiagnosticModelLeaseV1(
  environment: NodeJS.ProcessEnv = process.env,
): GitHubActionsDiagnosticModelLeaseV1 | undefined {
  let credential = environment[GITHUB_ACTIONS_DIAGNOSTIC_SECRET_V1]?.trim() ?? '';
  delete environment[GITHUB_ACTIONS_DIAGNOSTIC_SECRET_V1];
  if (!credential || typeof globalThis.fetch !== 'function') return undefined;

  const platformFetch: DiagnosticPlatformFetchV1 = globalThis.fetch.bind(globalThis);
  const sharedQuota = createSharedProviderAttemptQuotaV1();
  const preparedBindings = new Map<
    GitHubActionsDiagnosticCaseIdV1,
    GitHubActionsDiagnosticModelBindingV1
  >();
  for (const caseId of GITHUB_ACTIONS_DIAGNOSTIC_CASE_IDS_V1) {
    preparedBindings.set(
      caseId,
      createProviderFetchBindingV1({
        caseId,
        credential,
        platformFetch,
        sharedQuota,
      }),
    );
  }
  // JavaScript cannot securely zero immutable strings retained by an SDK, but
  // clearing this local removes any direct credential reference from the lease
  // constructor and makes accidental future use fail closed.
  credential = '';

  return Object.freeze({
    schema: GITHUB_ACTIONS_DIAGNOSTIC_MODEL_LEASE_SCHEMA_V1,
    bind(caseId: GitHubActionsDiagnosticCaseIdV1) {
      if (!isDiagnosticCaseIdV1(caseId)) throw new Error('diagnostic_case_binding_unavailable');
      const binding = preparedBindings.get(caseId);
      if (!binding) throw new Error('diagnostic_case_binding_unavailable');
      preparedBindings.delete(caseId);
      return binding;
    },
  });
}

/**
 * Test-only bindings deliberately have no Provider fetch. Their ordinal
 * receipt allows deterministic exercise of a cancellation state machine, but
 * their `contract_only` provenance cannot satisfy a live-report invariant.
 */
export function createGitHubActionsDiagnosticContractBindingForTestV1(input: {
  readonly caseId: GitHubActionsDiagnosticCaseIdV1;
  readonly model: SupportedChatModel;
}): GitHubActionsDiagnosticModelBindingV1 {
  if (!isDiagnosticCaseIdV1(input.caseId)) throw new Error('diagnostic_case_binding_unavailable');
  const state = createTransportReceiptStateV1();
  return Object.freeze({
    caseId: input.caseId,
    model: input.model,
    transportProofKind: 'contract_only' as const,
    transportEntries: () => state.entries,
    waitForNextTransportEntry: (afterEntries: number, signal?: AbortSignal) => {
      // This deliberately models a dispatch only after the caller has invoked
      // its test double. It is not a fetch acknowledgement and therefore can
      // never turn a contract binding into a passed live observation.
      if (!isTransportOrdinalV1(afterEntries)) {
        return Promise.reject(new Error('diagnostic_transport_ordinal_invalid'));
      }
      if (afterEntries > state.entries) {
        return Promise.reject(new Error('diagnostic_transport_ordinal_invalid'));
      }
      if (signal?.aborted) return Promise.reject(createTransportWaitAbortedErrorV1());
      if (state.entries <= afterEntries) {
        state.entries = afterEntries + 1;
        resolveTransportWaitersV1(state);
      }
      return Promise.resolve();
    },
    [bindingBrand]: true as const,
  });
}

/**
 * Test-only counterpart to the production lease. Aggregate tests can inject a
 * lease instead of threading arbitrary models through individual diagnostic
 * runners; its bindings remain permanently `contract_only`.
 */
export function createGitHubActionsDiagnosticContractLeaseForTestV1(
  models: Readonly<Record<GitHubActionsDiagnosticCaseIdV1, SupportedChatModel>>,
): GitHubActionsDiagnosticModelLeaseV1 {
  const preparedBindings = new Map<
    GitHubActionsDiagnosticCaseIdV1,
    GitHubActionsDiagnosticModelBindingV1
  >();
  for (const caseId of GITHUB_ACTIONS_DIAGNOSTIC_CASE_IDS_V1) {
    preparedBindings.set(
      caseId,
      createGitHubActionsDiagnosticContractBindingForTestV1({ caseId, model: models[caseId] }),
    );
  }
  return Object.freeze({
    schema: GITHUB_ACTIONS_DIAGNOSTIC_MODEL_LEASE_SCHEMA_V1,
    bind(caseId: GitHubActionsDiagnosticCaseIdV1) {
      if (!isDiagnosticCaseIdV1(caseId)) throw new Error('diagnostic_case_binding_unavailable');
      const binding = preparedBindings.get(caseId);
      if (!binding) throw new Error('diagnostic_case_binding_unavailable');
      preparedBindings.delete(caseId);
      return binding;
    },
  });
}

export function isGitHubActionsDiagnosticModelBindingV1(
  value: unknown,
): value is GitHubActionsDiagnosticModelBindingV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<GitHubActionsDiagnosticModelBindingV1>)[bindingBrand] === true &&
    isDiagnosticCaseIdV1((value as Partial<GitHubActionsDiagnosticModelBindingV1>).caseId) &&
    typeof (value as Partial<GitHubActionsDiagnosticModelBindingV1>).transportEntries ===
      'function' &&
    typeof (value as Partial<GitHubActionsDiagnosticModelBindingV1>).waitForNextTransportEntry ===
      'function'
  );
}

function createProviderFetchBindingV1(input: {
  readonly caseId: GitHubActionsDiagnosticCaseIdV1;
  readonly credential: string;
  readonly platformFetch: DiagnosticPlatformFetchV1;
  readonly sharedQuota: SharedProviderAttemptQuotaV1;
}): GitHubActionsDiagnosticModelBindingV1 {
  const { caseId, platformFetch, sharedQuota } = input;
  let providerCredential = input.credential;
  const policy = GITHUB_ACTIONS_DIAGNOSTIC_CASE_POLICIES_V1[caseId];
  const state = createTransportReceiptStateV1();
  const providerFetch = Object.assign(
    async (
      request: Parameters<DiagnosticPlatformFetchV1>[0],
      init?: Parameters<DiagnosticPlatformFetchV1>[1],
    ): Promise<Response> => {
      assertFixedProviderRequestV1(request, init, policy);
      const requestSignal =
        typeof Request !== 'undefined' && request instanceof Request ? request.signal : undefined;
      // An adapter that ignores its own abort may still reach this exact
      // boundary later. Never turn that late work into a platform fetch.
      if (requestSignal?.aborted || init?.signal?.aborted) {
        throw new Error('diagnostic_provider_request_aborted');
      }
      if (state.entries >= policy.maxProviderAttempts) {
        throw new Error('diagnostic_case_provider_attempt_quota_exceeded');
      }

      // This must happen before recording the entry: the acknowledgement below
      // represents invocation of the acquisition-time platform fetch, not just
      // AI SDK model dispatch or custom-fetch entry.
      const releaseQuota = sharedQuota.reserveBeforeTransportInvocation();
      let operation: Promise<Response>;
      try {
        operation = platformFetch(request, {
          ...init,
          redirect: 'error',
        });
      } catch (error) {
        releaseQuota();
        throw error;
      }
      if (!(operation instanceof Promise)) {
        releaseQuota();
        throw new Error('diagnostic_provider_transport_unavailable');
      }
      state.entries += 1;
      resolveTransportWaitersV1(state);
      return await operation;
    },
    {
      // The lease never needs preconnect. Rejecting it prevents the provider
      // surface from being repurposed to establish arbitrary network paths.
      preconnect: (): never => {
        throw new Error('diagnostic_provider_preconnect_denied');
      },
    },
  ) as DiagnosticProviderFetchV1;
  const provider = createOpenAICompatible({
    name: `${GITHUB_ACTIONS_DIAGNOSTIC_ROUTE_ALIAS_V1}-${caseId}`,
    apiKey: providerCredential,
    baseURL: GITHUB_ACTIONS_DIAGNOSTIC_QWEN_BASE_URL_V1,
    fetch: providerFetch,
  });
  // The fixed SDK provider owns its private API-key closure from here. Do not
  // retain an additional direct credential binding alongside the fetch policy.
  providerCredential = '';
  const model = Object.freeze({
    model: provider(GITHUB_ACTIONS_DIAGNOSTIC_QWEN_MODEL_V1),
    supportsToolCalls: policy.supportsToolCalls,
    capabilityMetadata: {
      maxOutputTokens: policy.maxOutputTokens,
      streaming: false,
      supportsUsageMetadata: true,
    },
    setRetryListener: () => {},
  }) as SupportedChatModel;
  return Object.freeze({
    caseId,
    model,
    transportProofKind: 'provider_fetch' as const,
    transportEntries: () => state.entries,
    waitForNextTransportEntry: (afterEntries: number, signal?: AbortSignal) =>
      waitForNextTransportEntryV1(state, afterEntries, signal),
    [bindingBrand]: true as const,
  });
}

function createSharedProviderAttemptQuotaV1(): SharedProviderAttemptQuotaV1 {
  let used = 0;
  return Object.freeze({
    reserveBeforeTransportInvocation() {
      if (used >= GITHUB_ACTIONS_DIAGNOSTIC_TOTAL_PROVIDER_ATTEMPT_CAP_V1) {
        throw new Error('diagnostic_total_provider_attempt_quota_exceeded');
      }
      used += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        used -= 1;
      };
    },
  });
}

function createTransportReceiptStateV1(): TransportReceiptStateV1 {
  return { entries: 0, waiters: new Set<TransportWaiterV1>() };
}

function waitForNextTransportEntryV1(
  state: TransportReceiptStateV1,
  afterEntries: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!isTransportOrdinalV1(afterEntries)) {
    return Promise.reject(new Error('diagnostic_transport_ordinal_invalid'));
  }
  if (state.entries > afterEntries) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(createTransportWaitAbortedErrorV1());
  return new Promise<void>((resolve, reject) => {
    let waiter: TransportWaiterV1 | undefined;
    const onAbort = () => {
      if (!waiter || !state.waiters.delete(waiter)) return;
      reject(createTransportWaitAbortedErrorV1());
    };
    waiter = {
      afterEntries,
      resolve,
      signal,
      onAbort: signal ? onAbort : undefined,
    };
    state.waiters.add(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
    // An abort may race listener registration in a user-supplied signal.
    if (signal?.aborted) onAbort();
  });
}

function resolveTransportWaitersV1(state: TransportReceiptStateV1): void {
  for (const waiter of state.waiters) {
    if (state.entries <= waiter.afterEntries) continue;
    state.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.resolve();
  }
}

function assertFixedProviderRequestV1(
  input: Parameters<DiagnosticPlatformFetchV1>[0],
  init: Parameters<DiagnosticPlatformFetchV1>[1] | undefined,
  policy: GitHubActionsDiagnosticCasePolicyV1,
): void {
  const request = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;
  const url = request
    ? new URL(request.url)
    : input instanceof URL
      ? new URL(input.href)
      : typeof input === 'string'
        ? new URL(input)
        : denyProviderRequestV1();
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  if (
    url.protocol !== 'https:' ||
    url.origin !== FIXED_PROVIDER_ORIGIN_V1 ||
    url.username ||
    url.password ||
    url.pathname !== FIXED_PROVIDER_PATH_V1 ||
    url.search ||
    url.hash ||
    method !== 'POST' ||
    (init?.redirect !== undefined && init.redirect !== 'error')
  ) {
    throw new Error('diagnostic_provider_request_denied');
  }
  assertFixedProviderRequestBodyV1(init?.body, policy);
}

function assertFixedProviderRequestBodyV1(
  body: BodyInit | null | undefined,
  policy: GitHubActionsDiagnosticCasePolicyV1,
): void {
  if (typeof body !== 'string') throw new Error('diagnostic_provider_request_denied');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('diagnostic_provider_request_denied');
  }
  if (!isRecordV1(parsed) || parsed.model !== GITHUB_ACTIONS_DIAGNOSTIC_QWEN_MODEL_V1) {
    throw new Error('diagnostic_provider_request_denied');
  }
  const maxTokens = parsed.max_tokens;
  if (
    typeof maxTokens !== 'number' ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > policy.maxOutputTokens ||
    (parsed.stream !== undefined && parsed.stream !== false)
  ) {
    throw new Error('diagnostic_provider_request_denied');
  }
  if (!policy.supportsToolCalls && parsed.tools !== undefined && parsed.tools !== null) {
    throw new Error('diagnostic_provider_request_denied');
  }
}

function isDiagnosticCaseIdV1(value: unknown): value is GitHubActionsDiagnosticCaseIdV1 {
  return (
    typeof value === 'string' &&
    (GITHUB_ACTIONS_DIAGNOSTIC_CASE_IDS_V1 as readonly string[]).includes(value)
  );
}

function isTransportOrdinalV1(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function createTransportWaitAbortedErrorV1(): Error {
  return new Error('diagnostic_transport_wait_aborted');
}

function isRecordV1(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function denyProviderRequestV1(): never {
  throw new Error('diagnostic_provider_request_denied');
}

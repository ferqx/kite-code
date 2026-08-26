import { assertProtocolJsonValue } from '@kite-ai/runtime-protocol';
import { z } from 'zod';
import {
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA,
  type LocalRuntimeServiceDescriptor,
} from '../service/codecs';

export const LOCAL_RUNTIME_LIFECYCLE_REQUEST_SCHEMA_ =
  'kite.local-runtime-lifecycle-request.v1' as const;
export const LOCAL_RUNTIME_LIFECYCLE_RESULT_SCHEMA_ =
  'kite.local-runtime-lifecycle-result.v1' as const;
export const LOCAL_RUNTIME_CREDENTIAL_REQUEST_SCHEMA_ =
  'kite.local-runtime-credential-request.v1' as const;
export const LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_ =
  'kite.local-runtime-credential-result.v1' as const;

const boundedIdentity = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/\p{Cc}/u.test(value), 'identity contains a control character');

const secretMaterial = z
  .string()
  .min(1)
  .max(16_384)
  .refine(
    (value) => ![...value].some((character) => /\p{Cc}/u.test(character)),
    'secret contains a control character',
  );

// The custom OpenAI-compatible first-run journey permits an empty key. Keep
// the field explicit (rather than optional) so the provider operation has one
// stable shape while still rejecting control characters and oversized input.
const providerApiKey = z
  .string()
  .max(16_384)
  .refine(
    (value) => ![...value].some((character) => /\p{Cc}/u.test(character)),
    'api key contains a control character',
  );

const lifecycleOperation = z.enum(['ensure', 'status', 'stop', 'restart']);
const lifecycleState = z.enum(['absent', 'starting', 'ready', 'quiescing', 'draining']);
const lifecycleOutcome = z.enum([
  'applied',
  'service_busy',
  'unavailable',
  'incompatible',
  'outcome_unknown',
]);

const localRuntimeLifecycleRequestSchema = z
  .object({
    schema: z.literal(LOCAL_RUNTIME_LIFECYCLE_REQUEST_SCHEMA_),
    requestId: boundedIdentity,
    operation: lifecycleOperation,
    clientContractRevision: z.literal(LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_),
  })
  .strict();

export type LocalRuntimeLifecycleOperation = z.infer<typeof lifecycleOperation>;
export type LocalRuntimeLifecycleRequest = z.infer<typeof localRuntimeLifecycleRequestSchema>;
export const LOCAL_RUNTIME_LIFECYCLE_REQUEST_SCHEMA = localRuntimeLifecycleRequestSchema;

const localRuntimeLifecycleResultSchema = z
  .object({
    schema: z.literal(LOCAL_RUNTIME_LIFECYCLE_RESULT_SCHEMA_),
    requestId: boundedIdentity,
    operation: lifecycleOperation,
    outcome: lifecycleOutcome,
    state: lifecycleState,
    descriptor: z
      .custom<LocalRuntimeServiceDescriptor>((value) => {
        try {
          LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA.parse(value);
          return true;
        } catch {
          return false;
        }
      }, 'invalid local runtime service descriptor')
      .optional(),
    diagnostic: z
      .enum([
        'not_running',
        'identity_uncertain',
        'protocol_incompatible',
        'client_contract_incompatible',
        'build_mismatch',
        'service_busy',
      ])
      .optional(),
  })
  .strict();

export type LocalRuntimeLifecycleResult = z.infer<typeof localRuntimeLifecycleResultSchema>;
export const LOCAL_RUNTIME_LIFECYCLE_RESULT_SCHEMA = localRuntimeLifecycleResultSchema;

const credentialOperation = z.enum([
  'write_provider_api_key',
  'delete_provider_credential',
  'write_mcp_oauth',
  'delete_mcp_credential',
]);
const expectedRevision = boundedIdentity.optional();
const credentialBase = {
  schema: z.literal(LOCAL_RUNTIME_CREDENTIAL_REQUEST_SCHEMA_),
  mutationId: boundedIdentity,
  expectedRevision,
};

const localRuntimeCredentialRequestSchema = z.discriminatedUnion('operation', [
  z
    .object({
      ...credentialBase,
      operation: z.literal('write_provider_api_key'),
      providerId: boundedIdentity,
      apiKey: providerApiKey,
      /** Optional endpoint override used by the current custom-provider first-run flow. */
      baseURL: boundedIdentity.optional(),
      /** Optional manually entered model used when discovery is unavailable. */
      modelName: boundedIdentity.optional(),
    })
    .strict(),
  z
    .object({
      ...credentialBase,
      operation: z.literal('delete_provider_credential'),
      providerId: boundedIdentity,
    })
    .strict(),
  z
    .object({
      ...credentialBase,
      operation: z.literal('write_mcp_oauth'),
      serverName: boundedIdentity,
      accessToken: secretMaterial,
      refreshToken: secretMaterial.optional(),
      expiresAt: z.iso.datetime({ offset: true }).optional(),
    })
    .strict(),
  z
    .object({
      ...credentialBase,
      operation: z.literal('delete_mcp_credential'),
      serverName: boundedIdentity,
    })
    .strict(),
]);

export type LocalRuntimeCredentialOperation = z.infer<typeof credentialOperation>;
export type LocalRuntimeCredentialRequest = z.infer<typeof localRuntimeCredentialRequestSchema>;
export type NativeProviderCredentialRequest = Extract<
  LocalRuntimeCredentialRequest,
  { readonly operation: 'write_provider_api_key' }
>;
export type NativeCredentialRequest = LocalRuntimeCredentialRequest;
export const LOCAL_RUNTIME_CREDENTIAL_REQUEST_SCHEMA = localRuntimeCredentialRequestSchema;

const credentialOutcome = z.enum(['applied', 'deleted', 'rejected', 'outcome_unknown']);
const credentialErrorCode = z.enum([
  'invalid_request',
  'not_found',
  'revision_conflict',
  'credential_unavailable',
  'temporarily_unavailable',
  'provider_incompatible',
  'model_required',
]);
const localRuntimeCredentialResultSchema = z
  .object({
    schema: z.literal(LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_),
    mutationId: boundedIdentity,
    operation: credentialOperation,
    outcome: credentialOutcome,
    credentialPresent: z.boolean().optional(),
    revision: boundedIdentity.optional(),
    errorCode: credentialErrorCode.optional(),
  })
  .strict();

export type LocalRuntimeCredentialResult = z.infer<typeof localRuntimeCredentialResultSchema>;
export type LocalRuntimeCredentialErrorCode = z.infer<typeof credentialErrorCode>;
export type NativeProviderCredentialResult = Omit<LocalRuntimeCredentialResult, 'operation'> & {
  readonly operation: 'write_provider_api_key';
};
export type NativeCredentialResult = LocalRuntimeCredentialResult;
export const LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA = localRuntimeCredentialResultSchema;

function parseStrict<T>(schema: z.ZodType<T>, value: unknown): T {
  assertProtocolJsonValue(value);
  return schema.parse(value);
}

export function decodeLocalRuntimeLifecycleRequest(value: unknown): LocalRuntimeLifecycleRequest {
  return parseStrict(localRuntimeLifecycleRequestSchema, value);
}

export function encodeLocalRuntimeLifecycleRequest(
  value: LocalRuntimeLifecycleRequest,
): LocalRuntimeLifecycleRequest {
  return decodeLocalRuntimeLifecycleRequest(value);
}

export function safeDecodeLocalRuntimeLifecycleRequest(
  value: unknown,
):
  | { readonly success: true; readonly data: LocalRuntimeLifecycleRequest }
  | { readonly success: false; readonly error: unknown } {
  try {
    return { success: true, data: decodeLocalRuntimeLifecycleRequest(value) };
  } catch (error) {
    return { success: false, error };
  }
}

export function decodeLocalRuntimeLifecycleResult(value: unknown): LocalRuntimeLifecycleResult {
  return parseStrict(localRuntimeLifecycleResultSchema, value);
}

export function encodeLocalRuntimeLifecycleResult(
  value: LocalRuntimeLifecycleResult,
): LocalRuntimeLifecycleResult {
  return decodeLocalRuntimeLifecycleResult(value);
}

export function safeDecodeLocalRuntimeLifecycleResult(
  value: unknown,
):
  | { readonly success: true; readonly data: LocalRuntimeLifecycleResult }
  | { readonly success: false; readonly error: unknown } {
  try {
    return { success: true, data: decodeLocalRuntimeLifecycleResult(value) };
  } catch (error) {
    return { success: false, error };
  }
}

export function decodeLocalRuntimeCredentialRequest(value: unknown): LocalRuntimeCredentialRequest {
  return parseStrict(localRuntimeCredentialRequestSchema, value);
}

export function encodeLocalRuntimeCredentialRequest(
  value: LocalRuntimeCredentialRequest,
): LocalRuntimeCredentialRequest {
  return decodeLocalRuntimeCredentialRequest(value);
}

export function safeDecodeLocalRuntimeCredentialRequest(
  value: unknown,
):
  | { readonly success: true; readonly data: LocalRuntimeCredentialRequest }
  | { readonly success: false; readonly error: unknown } {
  try {
    return { success: true, data: decodeLocalRuntimeCredentialRequest(value) };
  } catch (error) {
    return { success: false, error };
  }
}

export function decodeLocalRuntimeCredentialResult(value: unknown): LocalRuntimeCredentialResult {
  return parseStrict(localRuntimeCredentialResultSchema, value);
}

export function encodeLocalRuntimeCredentialResult(
  value: LocalRuntimeCredentialResult,
): LocalRuntimeCredentialResult {
  return decodeLocalRuntimeCredentialResult(value);
}

export function safeDecodeLocalRuntimeCredentialResult(
  value: unknown,
):
  | { readonly success: true; readonly data: LocalRuntimeCredentialResult }
  | { readonly success: false; readonly error: unknown } {
  try {
    return { success: true, data: decodeLocalRuntimeCredentialResult(value) };
  } catch (error) {
    return { success: false, error };
  }
}

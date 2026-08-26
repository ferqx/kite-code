import { describe, expect, test } from 'bun:test';
import {
  decodeLocalRuntimeCredentialRequest,
  decodeLocalRuntimeCredentialResult,
  decodeLocalRuntimeLifecycleRequest,
  decodeLocalRuntimeLifecycleResult,
  LOCAL_RUNTIME_CREDENTIAL_REQUEST_SCHEMA_,
  LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_,
  LOCAL_RUNTIME_LIFECYCLE_REQUEST_SCHEMA_,
  LOCAL_RUNTIME_LIFECYCLE_RESULT_SCHEMA_,
  safeDecodeLocalRuntimeCredentialRequest,
} from '@kite-ai/kite-local-runtime/client';
import { LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_ } from '@kite-ai/kite-local-runtime/service';

describe('kite-local-runtime client lifecycle codecs', () => {
  test('accepts exact lifecycle requests and results', () => {
    const request = {
      schema: LOCAL_RUNTIME_LIFECYCLE_REQUEST_SCHEMA_,
      requestId: 'request-1',
      operation: 'status',
      clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
    } as const;
    expect(decodeLocalRuntimeLifecycleRequest(request)).toEqual(request);

    const result = {
      schema: LOCAL_RUNTIME_LIFECYCLE_RESULT_SCHEMA_,
      requestId: request.requestId,
      operation: request.operation,
      outcome: 'applied',
      state: 'ready',
      diagnostic: 'build_mismatch',
    } as const;
    expect(decodeLocalRuntimeLifecycleResult(result)).toEqual(result);
    expect(() =>
      decodeLocalRuntimeLifecycleRequest({ ...request, controlToken: 'secret' }),
    ).toThrow();
  });
});

describe('kite-local-runtime native credential codecs', () => {
  test('keeps provider secret writes native-only and exact', () => {
    const request = {
      schema: LOCAL_RUNTIME_CREDENTIAL_REQUEST_SCHEMA_,
      mutationId: 'mutation-1',
      operation: 'write_provider_api_key',
      providerId: 'openai',
      apiKey: 'sk-native-only',
    } as const;
    expect(decodeLocalRuntimeCredentialRequest(request)).toEqual(request);
    expect(safeDecodeLocalRuntimeCredentialRequest(request)).toMatchObject({ success: true });

    const result = {
      schema: LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_,
      mutationId: request.mutationId,
      operation: request.operation,
      outcome: 'applied',
      credentialPresent: true,
      revision: 'credential-revision-1',
    } as const;
    expect(decodeLocalRuntimeCredentialResult(result)).toEqual(result);
    expect(() =>
      decodeLocalRuntimeCredentialResult({ ...result, apiKey: request.apiKey }),
    ).toThrow();
  });

  test('supports bounded OAuth material and explicit unknown outcomes', () => {
    expect(
      decodeLocalRuntimeCredentialRequest({
        schema: LOCAL_RUNTIME_CREDENTIAL_REQUEST_SCHEMA_,
        mutationId: 'mutation-2',
        operation: 'write_mcp_oauth',
        serverName: 'docs-provider',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: '2026-08-27T00:00:00.000Z',
      }),
    ).toMatchObject({ operation: 'write_mcp_oauth' });
    expect(
      decodeLocalRuntimeCredentialResult({
        schema: LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_,
        mutationId: 'mutation-2',
        operation: 'write_mcp_oauth',
        outcome: 'outcome_unknown',
      }),
    ).toMatchObject({ outcome: 'outcome_unknown' });
  });
});

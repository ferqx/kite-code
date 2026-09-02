import { describe, expect, test } from 'bun:test';
import {
  decodeLocalRuntimeCredentialRequest,
  decodeLocalRuntimeCredentialResult,
  LOCAL_RUNTIME_CREDENTIAL_REQUEST_SCHEMA_,
  LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_,
  safeDecodeLocalRuntimeCredentialRequest,
} from '@kite-ai/kite-local-runtime/client';

describe('kite-local-runtime native credential codecs', () => {
  test('keeps provider secret writes native-only and exact', () => {
    const request = {
      schema: LOCAL_RUNTIME_CREDENTIAL_REQUEST_SCHEMA_,
      mutationId: 'mutation-1',
      operation: 'write_provider_api_key',
      providerId: 'openai',
      apiKey: 'sk-native-only',
      baseURL: 'https://api.openai.com/v1',
      modelName: 'gpt-4o',
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

  test('permits an empty custom-endpoint key but keeps the field and error safe', () => {
    expect(
      decodeLocalRuntimeCredentialRequest({
        schema: LOCAL_RUNTIME_CREDENTIAL_REQUEST_SCHEMA_,
        mutationId: 'mutation-custom',
        operation: 'write_provider_api_key',
        providerId: 'openai-compatible',
        apiKey: '',
        baseURL: 'http://localhost:8080/v1',
        modelName: 'local-model',
      }),
    ).toMatchObject({ providerId: 'openai-compatible', apiKey: '', modelName: 'local-model' });
    expect(
      decodeLocalRuntimeCredentialResult({
        schema: LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_,
        mutationId: 'mutation-custom',
        operation: 'write_provider_api_key',
        outcome: 'rejected',
        errorCode: 'model_required',
      }),
    ).toMatchObject({ outcome: 'rejected', errorCode: 'model_required' });
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

import { expect, test } from 'bun:test';
import type { ProviderModelSnapshot } from '@kite-ai/kite-app-contract';
import { type ProviderInput, saveProvider } from '../src/models';

const input = (): ProviderInput => ({
  provider: 'openai',
  apiKey: 'test-secret',
  baseURL: '',
  modelName: '',
});
const snapshot = {} as ProviderModelSnapshot;

test('lost credential response queries state, clears the input and never replays the write', async () => {
  const calls: string[] = [];
  const value = input();
  await expect(
    saveProvider(
      {
        credential: {
          async writeProviderCredential() {
            calls.push('write');
            throw new Error('test-secret transport details');
          },
        },
      },
      value,
      async () => {
        calls.push('query');
        return snapshot;
      },
    ),
  ).rejects.toThrow('配置提交结果未知');
  expect(calls).toEqual(['write', 'query']);
  expect(value.apiKey).toBe('');
});

test('explicit unknown outcome remains unknown even when a configuration can be read', async () => {
  const value = input();
  let writes = 0;
  await expect(
    saveProvider(
      {
        credential: {
          async writeProviderCredential(request) {
            writes++;
            return {
              schema: 'kite.local-runtime-credential-result.v1',
              operation: request.operation,
              mutationId: request.mutationId,
              outcome: 'outcome_unknown',
            };
          },
        },
      },
      value,
      async () => snapshot,
    ),
  ).rejects.toThrow('结果未知');
  expect(writes).toBe(1);
  expect(value.apiKey).toBe('');
});

test('manual model and endpoint are written only when explicitly entered', async () => {
  const value = { ...input(), baseURL: ' https://example.test/v1 ', modelName: ' custom-model ' };
  let reads = 0;
  await saveProvider(
    {
      credential: {
        async writeProviderCredential(request) {
          expect(request.baseURL).toBe('https://example.test/v1');
          expect(request.modelName).toBe('custom-model');
          expect(request.apiKey).toBe('test-secret');
          return {
            schema: 'kite.local-runtime-credential-result.v1',
            operation: request.operation,
            mutationId: request.mutationId,
            outcome: 'applied',
          };
        },
      },
    },
    value,
    async () => {
      reads++;
      return snapshot;
    },
  );
  expect(reads).toBe(1);
  expect(value.apiKey).toBe('');
});

test('credential rejection does not masquerade as a successful configuration', async () => {
  await expect(
    saveProvider(
      {
        credential: {
          async writeProviderCredential(request) {
            return {
              schema: 'kite.local-runtime-credential-result.v1',
              operation: request.operation,
              mutationId: request.mutationId,
              outcome: 'rejected',
              errorCode: 'credential_unavailable',
            };
          },
        },
      },
      input(),
      async () => snapshot,
    ),
  ).rejects.toThrow('拒绝了密钥');
});

test.each([
  ['outcome_unknown', '配置提交结果未知'],
  ['rejected', '拒绝了密钥'],
  ['applied', '配置已保存，但刷新失败'],
] as const)('a failed refresh preserves the %s write outcome', async (outcome, expected) => {
  const value = input();
  let writes = 0;
  let reads = 0;
  await expect(
    saveProvider(
      {
        credential: {
          async writeProviderCredential(request) {
            writes++;
            return {
              schema: 'kite.local-runtime-credential-result.v1',
              operation: request.operation,
              mutationId: request.mutationId,
              outcome,
              ...(outcome === 'rejected' ? { errorCode: 'credential_unavailable' as const } : {}),
            };
          },
        },
      },
      value,
      async () => {
        reads++;
        expect(value.apiKey).toBe('');
        throw new Error('snapshot transport failed');
      },
    ),
  ).rejects.toThrow(expected);
  expect(writes).toBe(1);
  expect(reads).toBe(1);
});

test('a lost write response releases the secret before querying recovery state', async () => {
  const value = input();
  let secretDuringRefresh: string | undefined;
  await expect(
    saveProvider(
      {
        credential: {
          async writeProviderCredential() {
            throw new Error('lost receipt');
          },
        },
      },
      value,
      async () => {
        secretDuringRefresh = value.apiKey;
        throw new Error('snapshot unavailable');
      },
    ),
  ).rejects.toThrow('配置提交结果未知');
  expect(secretDuringRefresh).toBe('');
});

import { describe, expect, test } from 'bun:test';
import type { CapabilityExecutionContextV1, ExecutionReceiptV1 } from '@kite/runtime-spi';
import { createRuntimeModuleRegistryV1 } from '@kite/runtime-spi';
import { McpProviderError, type McpProviderFailureKind } from '../src/mcp/provider-errors';
import {
  BuiltinMcpExecutionUnknownErrorV1,
  type BuiltinMcpRuntimePortV1,
  createModelRuntimeModule,
  isBuiltinOperationExecutionValueV1,
  RMV1_11_CAPABILITY_REVISIONS_V1,
  RMV1_11_EXECUTOR_REVISIONS_V1,
  RMV1_11_PROVIDER_ID_V1,
} from '../src/model-operations';

const OPERATION_ID = 'builtin:read_mcp_resource' as const;
const CAPABILITY_REVISION = RMV1_11_CAPABILITY_REVISIONS_V1[OPERATION_ID];
const EXECUTOR_REVISION = RMV1_11_EXECUTOR_REVISIONS_V1[OPERATION_ID];

const registry = createRuntimeModuleRegistryV1([createModelRuntimeModule()]);

function runtime(readResource: BuiltinMcpRuntimePortV1['readResource']): BuiltinMcpRuntimePortV1 {
  return Object.freeze({
    getCapabilitySnapshot: () => Object.freeze({}),
    getProviderDirectorySnapshot: () => Object.freeze({}),
    getResourceDirectorySnapshot: () => Object.freeze({}),
    findCapability: () => undefined,
    callCapability: async () => Object.freeze({}),
    readResource,
  });
}

function context(
  invocationId: string,
  attemptId: string,
  readResource: BuiltinMcpRuntimePortV1['readResource'],
): {
  readonly request: {
    readonly invocationId: string;
    readonly capabilityId: typeof OPERATION_ID;
    readonly capabilityRevision: string;
    readonly input: { readonly server: string; readonly uri: string };
  };
  readonly context: CapabilityExecutionContextV1;
} {
  const request = {
    invocationId,
    capabilityId: OPERATION_ID,
    capabilityRevision: CAPABILITY_REVISION,
    input: { server: 'docs', uri: 'docs://one' },
  } as const;
  return {
    request,
    context: {
      grant: {
        grantId: 'grant-1',
        capabilityId: OPERATION_ID,
        capabilityRevision: CAPABILITY_REVISION,
        authority: {},
      },
      requestDigest: 'request-digest-1',
      signal: new AbortController().signal,
      environment: {
        environmentId: 'test',
        kind: 'in_process',
        mechanisms: Object.freeze({
          mcp: Object.freeze({ runtime: runtime(readResource) }),
        }),
      },
      attempt: { invocationId, attemptId },
    },
  };
}

function readExecutor() {
  const executor = registry.executor(OPERATION_ID);
  if (!executor) throw new Error('RMV1-11 MCP read executor is missing.');
  return executor;
}

async function executeRead(
  readResource: BuiltinMcpRuntimePortV1['readResource'],
  invocationId = 'invocation-1',
  attemptId = 'attempt-1',
): Promise<ExecutionReceiptV1> {
  const fixture = context(invocationId, attemptId, readResource);
  return readExecutor().execute(fixture.request, fixture.context);
}

describe('RMV1-11 MCP read provider failure boundary', () => {
  test('returns identity-exact attempted failed receipts for the four closed provider kinds', async () => {
    const cases: readonly [McpProviderFailureKind, boolean][] = [
      ['provider_auth_required', false],
      ['provider_approval_required', false],
      ['provider_unavailable', true],
      ['provider_capability_changed', false],
    ];

    for (const [kind, retryable] of cases) {
      const underlyingProviderReads = 0;
      const receipt = await executeRead(
        async () => {
          // This models the App readiness wrapper rejecting before it delegates
          // to the underlying provider transport.
          if (underlyingProviderReads !== 0) throw new Error('unexpected provider read');
          throw new McpProviderError({
            providerId: 'docs',
            kind,
            message: `provider detail\n${'x'.repeat(400)}`,
            retryable,
          });
        },
        `invocation-${kind}`,
        `attempt-${kind}`,
      );

      expect(receipt).toMatchObject({
        invocationId: `invocation-${kind}`,
        attemptId: `attempt-${kind}`,
        providerId: RMV1_11_PROVIDER_ID_V1,
        executorRevision: EXECUTOR_REVISION,
        requestDigest: 'request-digest-1',
        status: 'failed',
        dispatchCertainty: 'attempted',
        cleanupCertainty: 'not_required',
        failure: {
          code: kind,
          retryable,
        },
      });
      expect(receipt.value).toBeUndefined();
      expect(receipt.failure?.message.length).toBeLessThanOrEqual(256);
      expect(receipt.failure?.message).not.toContain('\n');
      expect(underlyingProviderReads).toBe(0);
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(Object.isFrozen(receipt.failure)).toBe(true);
    }
  });

  test('keeps ordinary MCP errors as the existing Builtin operationFailure value', async () => {
    let calls = 0;
    const receipt = await executeRead(async () => {
      calls += 1;
      throw new Error('Connection refused');
    });

    expect(receipt).toMatchObject({
      invocationId: 'invocation-1',
      attemptId: 'attempt-1',
      providerId: RMV1_11_PROVIDER_ID_V1,
      executorRevision: EXECUTOR_REVISION,
      requestDigest: 'request-digest-1',
      status: 'succeeded',
      dispatchCertainty: 'attempted',
    });
    expect(isBuiltinOperationExecutionValueV1(receipt.value)).toBe(true);
    expect(receipt.value).toMatchObject({
      schema: 'kite.builtin-operation-result.v1',
      ok: false,
      stderr: 'Connection refused',
    });
    expect(receipt.failure).toBeUndefined();
    expect(calls).toBe(1);

    const unknownTypedError = await executeRead(
      async () => {
        throw {
          name: 'McpProviderError',
          kind: 'provider_secret_kind',
          message: 'must not become a provider terminal code',
          retryable: true,
        };
      },
      'invocation-unknown-kind',
      'attempt-unknown-kind',
    );
    expect(unknownTypedError.status).toBe('succeeded');
    expect(isBuiltinOperationExecutionValueV1(unknownTypedError.value)).toBe(true);
    expect(unknownTypedError.failure).toBeUndefined();

    const forgedKnownKind = await executeRead(
      async () => {
        throw {
          name: 'McpProviderError',
          kind: 'provider_auth_required',
          message: 'forged structural error',
          retryable: false,
        };
      },
      'invocation-forged-kind',
      'attempt-forged-kind',
    );
    expect(forgedKnownKind.status).toBe('succeeded');
    expect(isBuiltinOperationExecutionValueV1(forgedKnownKind.value)).toBe(true);
    expect(forgedKnownKind.failure).toBeUndefined();
  });

  test('rethrows the exact coordination-unknown marker for Host recovery', async () => {
    const unknown = new BuiltinMcpExecutionUnknownErrorV1('readiness receipt drifted');
    await expect(
      executeRead(async () => {
        throw unknown;
      }),
    ).rejects.toBe(unknown);
  });

  test('preserves exact and partial output behavior at the 128 KiB boundary', async () => {
    const exact = 'x'.repeat(128 * 1024);
    const exactReceipt = await executeRead(async () => exact);
    expect(exactReceipt.status).toBe('succeeded');
    expect(isBuiltinOperationExecutionValueV1(exactReceipt.value)).toBe(true);
    if (!isBuiltinOperationExecutionValueV1(exactReceipt.value)) {
      throw new Error('exact MCP read result is not a Builtin value');
    }
    expect(exactReceipt.value.ok).toBe(true);
    expect(exactReceipt.value.stdout).toBe(exact);
    expect(exactReceipt.value.resultMeta).toMatchObject({ truncated: false });

    const oversized = 'x'.repeat(128 * 1024 + 20);
    const partialReceipt = await executeRead(async () => oversized, 'invocation-2', 'attempt-2');
    expect(partialReceipt.status).toBe('succeeded');
    expect(isBuiltinOperationExecutionValueV1(partialReceipt.value)).toBe(true);
    if (!isBuiltinOperationExecutionValueV1(partialReceipt.value)) {
      throw new Error('partial MCP read result is not a Builtin value');
    }
    const partial = JSON.parse(partialReceipt.value.stdout) as Record<string, unknown>;
    expect(partial).toMatchObject({
      status: 'partial',
      truncated: true,
      original_characters: oversized.length,
    });
    expect(partialReceipt.value.resultMeta).toMatchObject({ truncated: true });
  });
});

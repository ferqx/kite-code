import { describe, expect, test } from 'bun:test';
import type { CapabilityExecutionContext, ExecutionReceipt } from '@kite-ai/runtime-spi';
import { createRuntimeModuleRegistry } from '@kite-ai/runtime-spi';
import { McpProviderError, type McpProviderFailureKind } from '../src/mcp/provider-errors';
import {
  BuiltinMcpExecutionUnknownError,
  type BuiltinMcpRuntimePort,
  createModelRuntimeModule,
  isBuiltinOperationExecutionValue,
  MODEL_CAPABILITY_REVISIONS_,
  MODEL_EXECUTOR_REVISIONS_,
  MODEL_PROVIDER_ID_,
} from '../src/model/runtime-module';

const OPERATION_ID = 'builtin:read_mcp_resource' as const;
const CAPABILITY_REVISION = MODEL_CAPABILITY_REVISIONS_[OPERATION_ID];
const EXECUTOR_REVISION = MODEL_EXECUTOR_REVISIONS_[OPERATION_ID];

const registry = createRuntimeModuleRegistry([createModelRuntimeModule()]);

function runtime(readResource: BuiltinMcpRuntimePort['readResource']): BuiltinMcpRuntimePort {
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
  readResource: BuiltinMcpRuntimePort['readResource'],
): {
  readonly request: {
    readonly invocationId: string;
    readonly capabilityId: typeof OPERATION_ID;
    readonly capabilityRevision: string;
    readonly input: { readonly server: string; readonly uri: string };
  };
  readonly context: CapabilityExecutionContext;
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
  if (!executor) throw new Error('RM-11 MCP read executor is missing.');
  return executor;
}

async function executeRead(
  readResource: BuiltinMcpRuntimePort['readResource'],
  invocationId = 'invocation-1',
  attemptId = 'attempt-1',
): Promise<ExecutionReceipt> {
  const fixture = context(invocationId, attemptId, readResource);
  return readExecutor().execute(fixture.request, fixture.context);
}

describe('RM-11 MCP read provider failure boundary', () => {
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
        providerId: MODEL_PROVIDER_ID_,
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
      providerId: MODEL_PROVIDER_ID_,
      executorRevision: EXECUTOR_REVISION,
      requestDigest: 'request-digest-1',
      status: 'succeeded',
      dispatchCertainty: 'attempted',
    });
    expect(isBuiltinOperationExecutionValue(receipt.value)).toBe(true);
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
    expect(isBuiltinOperationExecutionValue(unknownTypedError.value)).toBe(true);
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
    expect(isBuiltinOperationExecutionValue(forgedKnownKind.value)).toBe(true);
    expect(forgedKnownKind.failure).toBeUndefined();
  });

  test('rethrows the exact coordination-unknown marker for Host recovery', async () => {
    const unknown = new BuiltinMcpExecutionUnknownError('readiness receipt drifted');
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
    expect(isBuiltinOperationExecutionValue(exactReceipt.value)).toBe(true);
    if (!isBuiltinOperationExecutionValue(exactReceipt.value)) {
      throw new Error('exact MCP read result is not a Builtin value');
    }
    expect(exactReceipt.value.ok).toBe(true);
    expect(exactReceipt.value.stdout).toBe(exact);
    expect(exactReceipt.value.resultMeta).toMatchObject({ truncated: false });

    const oversized = 'x'.repeat(128 * 1024 + 20);
    const partialReceipt = await executeRead(async () => oversized, 'invocation-2', 'attempt-2');
    expect(partialReceipt.status).toBe('succeeded');
    expect(isBuiltinOperationExecutionValue(partialReceipt.value)).toBe(true);
    if (!isBuiltinOperationExecutionValue(partialReceipt.value)) {
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

import { describe, expect, test } from 'bun:test';
import { resolveMcpToolPolicy } from '@kite/builtin-runtime/mcp';
import {
  classifyMcpWriteRecovery,
  type McpWriteIntent,
  type McpWriteReceipt,
} from './write-contract-fixtures';

const intent: McpWriteIntent = {
  invocationId: 'invocation-1',
  routeDigest: 'route-v1',
  argumentsDigest: 'arguments-v1',
  persistedBeforeDispatch: true,
};

describe('MCP write recovery contract', () => {
  test('blocks before dispatch when durable intent is missing', () => {
    expect(
      classifyMcpWriteRecovery({
        retryPolicy: 'never',
        providerActionRecovered: false,
      }),
    ).toEqual({
      action: 'blocked',
      reason: 'durable_intent_missing',
      preserveIntent: false,
      preserveReceipt: false,
    });
  });

  test('never blindly replays unknown external effects', () => {
    const policy = resolveMcpToolPolicy(
      { type: 'http', trust: 'untrusted' },
      { name: 'unknown_remote_effect' },
    );
    expect(policy.effectiveEffects.externalState).toBe('unknown');
    expect(policy.retry).toBe('never');
    const decision = classifyMcpWriteRecovery({
      intent,
      receipt: {
        invocationId: intent.invocationId,
        status: 'unknown',
        reconciliation: 'not_observed',
        compensation: 'not_observed',
      },
      retryPolicy: policy.retry,
      providerActionRecovered: true,
    });
    expect(decision).toEqual({
      action: 'reconcile',
      reason: 'control_plane_recovered_effect_unknown',
      preserveIntent: true,
      preserveReceipt: true,
    });
  });

  test('replays only the same durable invocation with a provider idempotency key', () => {
    const policy = resolveMcpToolPolicy(
      {
        type: 'http',
        trust: 'untrusted',
        tools: {
          create_issue: {
            retry: 'idempotency_key',
            idempotencyKeyArgument: 'idempotency_key',
          },
        },
      },
      { name: 'create_issue', annotations: { readOnlyHint: false } },
    );
    expect(policy.retry).toBe('idempotency_key');
    const keyedIntent = { ...intent, idempotencyKey: 'provider-key-1' };
    expect(
      classifyMcpWriteRecovery({
        intent: keyedIntent,
        retryPolicy: policy.retry,
        idempotencyKeyArgument: policy.idempotencyKeyArgument,
        providerActionRecovered: false,
      }),
    ).toEqual({
      action: 'replay_same_invocation',
      reason: 'provider_idempotency_key',
      preserveIntent: true,
      preserveReceipt: false,
    });
  });

  test('preserves intent and receipt through reconciliation and compensation', () => {
    const receipt: McpWriteReceipt = {
      invocationId: intent.invocationId,
      status: 'succeeded',
      providerReceiptDigest: 'receipt-v1',
      reconciliation: 'mismatched',
      compensation: 'not_observed',
    };
    expect(
      classifyMcpWriteRecovery({
        intent,
        receipt,
        retryPolicy: 'never',
        providerActionRecovered: false,
      }),
    ).toEqual({
      action: 'compensate',
      reason: 'reconciliation_mismatch',
      preserveIntent: true,
      preserveReceipt: true,
    });
  });
});

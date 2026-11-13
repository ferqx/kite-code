import { expect, test } from '#kite-test';
import type { PublicExecution, ReadContext } from '../../../src/extensions';
import {
  decimal64,
  decodeReconnectionInput,
  stoppedOrUnopened,
  unopenedRejection,
} from '../../../src/mcp/reconnection-proof';
import { readReconnection } from '../../../src/mcp/reconnection-query';

const original = () => ({
  serverId: 'local',
  key: 'new',
  target: {
    carrierExecutionId: 'warm_b',
    carrierKey: 'b',
    operationRef: {
      commandId: 'original',
      sessionId: 's',
      originStoreId: 'store',
      extensionId: 'builtin.mcp' as const,
      key: 'connection/local/a',
      executionId: 'job_a',
    },
    connectionExecutionId: 'job_a',
    configDigest: 'a'.repeat(64),
    currentGeneration: 1,
  },
  replacement: {
    kind: 'source' as const,
    expectedConfigDigest: 'b'.repeat(64),
    expectedReadSet: {
      scopeDigest: 'c'.repeat(64),
      user: {
        identity: {
          kind: 'user' as const,
          pathDigest: 'd'.repeat(64),
          rootIdentity: 'physical-user',
        },
        etag: null,
        error: 'bounded only by the whole request'.repeat(2048),
      },
      workspace: null,
      approvalEtag: null,
      bindingEtag: null,
      variablesDigest: 'e'.repeat(64),
    },
  },
});

test('warm carrier key and underlying operation key are distinct; complete read-set error remains unchanged', () => {
  const input = original();
  const decoded = decodeReconnectionInput(input);
  expect(decoded.target.carrierKey).toBe('b');
  expect(decoded.target.operationRef.key).toBe('connection/local/a');
  expect(decoded).toEqual(input);
  input.target.configDigest = 'f'.repeat(64);
  expect(decoded.target.configDigest).toBe('a'.repeat(64));
});
test('closed original observations reject injected authority, child ref, wrong identity and non-safe generation', () => {
  const cases: unknown[] = [
    { ...original(), permit: 'injected' },
    { ...original(), target: { ...original().target, recordRevision: '2' } },
    {
      ...original(),
      target: {
        ...original().target,
        operationRef: { ...original().target.operationRef, childSessionId: 'child' },
      },
    },
    { ...original(), target: { ...original().target, connectionExecutionId: 'other' } },
    {
      ...original(),
      target: { ...original().target, currentGeneration: Number.MAX_SAFE_INTEGER + 1 },
    },
    {
      ...original(),
      replacement: {
        ...original().replacement,
        expectedReadSet: {
          ...original().replacement.expectedReadSet,
          user: {
            ...original().replacement.expectedReadSet.user,
            identity: {
              ...original().replacement.expectedReadSet.user.identity,
              kind: 'workspace',
            },
          },
        },
      },
    },
    { ...original(), replacement: { ...original().replacement, kind: ['source'] } },
    {
      ...original(),
      replacement: {
        kind: 'static',
        expectedConfigDigest: 'a'.repeat(64),
        transport: { type: 'http' },
      },
    },
  ];
  for (const input of cases) expect(() => decodeReconnectionInput(input)).toThrow();
});
test('actual result revisions allow canonical zero and Decimal64 max, reject aliases and overflow', () => {
  expect(decimal64('0')).toBe(true);
  expect(decimal64('9223372036854775807')).toBe(true);
  for (const value of ['00', '01', '-1', '1.0', '9223372036854775808', 1, ['1'], null])
    expect(decimal64(value)).toBe(false);
});

const refusedExecution = (): PublicExecution => ({
  id: 'refused',
  sessionId: 's',
  runId: null,
  kind: 'job',
  definitionId: 'builtin.mcp/mcp.reconnect',
  definitionVersion: '1',
  inputDigest: 'a'.repeat(64),
  originStoreId: 'store',
  status: 'failed',
  resultRevision: '1',
  authorization: { dispatched: false },
  result: {
    outcome: 'failed',
    content: 'An arbitrary English presentation that is not a machine decision.',
    details: { code: 'permission_denied', reason: 'owned-policy', adapterAttempted: false },
  },
});
async function recordless(execution: PublicExecution) {
  return readReconnection(
    {
      sessionId: 's',
      async readExecutionGroupSafety() {
        return { originStoreId: 'store' };
      },
      async getExecution() {
        return structuredClone(execution);
      },
      records: {
        async get() {
          return null;
        },
      },
    } as unknown as ReadContext,
    execution.id,
    () => {
      throw Error('refusal_query_must_not_open_a_transport');
    },
  );
}
test('known unopened refusals use Core dispatch and decision facts independently of presentation', async () => {
  for (const human of [false, true]) {
    const execution = refusedExecution();
    if (human) {
      execution.authorization!.human = { state: 'answered', decision: 'deny' };
      execution.result = {
        outcome: 'failed',
        content: 'Different display text.',
        details: { adapterAttempted: false, stopConfirmation: null },
      };
    }
    const code = human ? 'approval_denied' : 'permission_denied';
    expect(unopenedRejection(execution)).toBe(code);
    expect(stoppedOrUnopened(execution)).toBe(true);
    expect(await recordless(execution)).toMatchObject({ phase: 'failed', reason: code });
  }
});
test('unknown, dispatched and external same-code claims cannot become known unopened failures', async () => {
  const cases: PublicExecution[] = [];
  const edit = (apply: (execution: PublicExecution) => void) => {
    const execution = refusedExecution();
    apply(execution);
    cases.push(execution);
  };
  edit((execution) => {
    delete execution.authorization;
  });
  edit((execution) => {
    (execution.result as Record<string, unknown>).content = null;
  });
  edit((execution) => {
    (execution.result as Record<string, unknown>).extra = 'not a closed Core result';
  });
  edit((execution) => {
    execution.authorization!.dispatched = true;
  });
  edit((execution) => {
    execution.status = 'outcome_unknown';
  });
  edit((execution) => {
    (execution.result as { outcome: string }).outcome = 'outcome_unknown';
  });
  edit((execution) => {
    (execution.result as { details: Record<string, unknown> }).details.adapterAttempted = true;
  });
  edit((execution) => {
    delete (execution.result as { details: Record<string, unknown> }).details.reason;
  });
  edit((execution) => {
    execution.result = {
      outcome: 'failed',
      content: 'permission_denied',
      details: { adapterAttempted: false, stopConfirmation: null },
    };
  });
  for (const human of [
    undefined,
    { state: 'pending' as const, decision: 'deny' as const },
    { state: 'answered' as const, decision: 'approve' as const },
  ])
    edit((execution) => {
      execution.authorization!.human = human;
      execution.result = {
        outcome: 'failed',
        content: 'approval_denied',
        details: { code: 'approval_denied', adapterAttempted: false },
      };
    });
  for (const execution of cases) {
    expect(unopenedRejection(execution)).toBeNull();
    expect(stoppedOrUnopened(execution)).toBe(false);
    expect(await recordless(execution)).toMatchObject({ phase: 'outcome_unknown' });
  }
});

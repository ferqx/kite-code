import { describe, expect, test } from 'bun:test';
import {
  createRuntimeHostCapabilityExecutionPort,
  RuntimeHostCapabilityExecutionError,
} from '@kite/runtime-host';
import {
  type CapabilityExecutionInvocation,
  type CapabilityExecutor,
  createRuntimeModuleRegistry,
  defineRuntimeModule,
} from '@kite/runtime-spi';

const CAPABILITY_ID = 'builtin:fixture';
const CAPABILITY_REVISION = 'capability-1';
const PROVIDER_ID = 'fixture-provider';
const EXECUTOR_REVISION = 'executor-1';
const SCHEMA_DIGEST = 'schema-1';

function createFixture(execute: CapabilityExecutor['execute']) {
  const registry = createRuntimeModuleRegistry([
    defineRuntimeModule({
      moduleId: 'fixture-module',
      providerId: PROVIDER_ID,
      revision: 'module-1',
      operationIds: [CAPABILITY_ID],
      register: (writer) => {
        writer.registerCapability({
          capabilityId: CAPABILITY_ID,
          revision: CAPABILITY_REVISION,
          providerId: PROVIDER_ID,
          title: 'Fixture capability',
          inputSchema: { type: 'object', properties: {} },
          inputSchemaDigest: SCHEMA_DIGEST,
        });
        writer.registerExecutor({
          providerId: PROVIDER_ID,
          capabilityId: CAPABILITY_ID,
          capabilityRevision: CAPABILITY_REVISION,
          executorRevision: EXECUTOR_REVISION,
          execute,
        });
      },
    }),
  ]);
  return createRuntimeHostCapabilityExecutionPort(registry);
}

function invocation(
  overrides: Partial<CapabilityExecutionInvocation> = {},
): CapabilityExecutionInvocation {
  return {
    binding: {
      bindingId: 'binding-1',
      capabilityId: CAPABILITY_ID,
      capabilityRevision: CAPABILITY_REVISION,
      exposedToolName: 'fixture',
      schemaDigest: SCHEMA_DIGEST,
      issuedForTurnId: 'turn-1',
    },
    request: {
      invocationId: 'invocation-1',
      capabilityId: CAPABILITY_ID,
      capabilityRevision: CAPABILITY_REVISION,
      input: {},
    },
    grant: {
      grantId: 'grant-1',
      capabilityId: CAPABILITY_ID,
      capabilityRevision: CAPABILITY_REVISION,
      authority: {},
    },
    requestDigest: 'request-digest-1',
    environment: { environmentId: 'test', kind: 'in_process' },
    attempt: { invocationId: 'invocation-1', attemptId: 'attempt-1' },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function exactReceipt(
  request: Parameters<CapabilityExecutor['execute']>[0],
  context: Parameters<CapabilityExecutor['execute']>[1],
) {
  return {
    invocationId: request.invocationId,
    attemptId: context.attempt.attemptId,
    providerId: PROVIDER_ID,
    executorRevision: EXECUTOR_REVISION,
    requestDigest: context.requestDigest,
    status: 'succeeded' as const,
    dispatchCertainty: 'attempted' as const,
    cleanupCertainty: 'not_required' as const,
    value: null,
  };
}

describe('Runtime Host capability execution', () => {
  test('fails binding, request, grant, and attempt identity before any executor call', async () => {
    let calls = 0;
    const port = createFixture(async (request, context) => {
      calls += 1;
      return exactReceipt(request, context);
    });
    const cases: Array<[CapabilityExecutionInvocation, string]> = [
      [
        invocation({ binding: { ...invocation().binding, schemaDigest: 'forged-schema' } }),
        'schema_digest_mismatch',
      ],
      [
        invocation({ request: { ...invocation().request, capabilityRevision: 'forged' } }),
        'request_identity_mismatch',
      ],
      [
        invocation({ grant: { ...invocation().grant, capabilityId: 'builtin:forged' } }),
        'grant_identity_mismatch',
      ],
      [
        invocation({ attempt: { invocationId: 'forged', attemptId: 'attempt-4' } }),
        'attempt_identity_mismatch',
      ],
    ];
    for (const [candidate, code] of cases) {
      await expect(port.invoke(candidate)).rejects.toMatchObject({ code });
    }
    expect(calls).toBe(0);
  });

  test('claims one exact attempt once and never invokes a second executor', async () => {
    let calls = 0;
    const port = createFixture(async (request, context) => {
      calls += 1;
      return exactReceipt(request, context);
    });
    const candidate = invocation();
    await expect(port.invoke(candidate)).resolves.toMatchObject({ status: 'succeeded' });
    await expect(port.invoke(candidate)).rejects.toMatchObject({ code: 'attempt_already_claimed' });
    expect(calls).toBe(1);
  });

  test('rejects a forged receipt that is not identical to the claimed attempt', async () => {
    const port = createFixture(async (request, context) => ({
      ...exactReceipt(request, context),
      attemptId: 'forged-attempt',
    }));
    await expect(port.invoke(invocation())).rejects.toBeInstanceOf(
      RuntimeHostCapabilityExecutionError,
    );
    await expect(
      createFixture(async (request, context) => ({
        ...exactReceipt(request, context),
        requestDigest: 'forged-digest',
      })).invoke(invocation()),
    ).rejects.toMatchObject({ code: 'receipt_identity_mismatch' });
  });

  test('accepts an exact late receipt after cancellation without redispatch', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const port = createFixture(async (request, context) => {
      calls += 1;
      entered?.();
      await gate;
      return exactReceipt(request, context);
    });
    const controller = new AbortController();
    const pending = port.invoke(invocation({ signal: controller.signal }));
    await enteredPromise;
    controller.abort();
    release?.();
    await expect(pending).resolves.toMatchObject({
      status: 'succeeded',
      invocationId: 'invocation-1',
      attemptId: 'attempt-1',
    });
    expect(calls).toBe(1);
  });

  test('forwards the exact RFC Provider context without side-channel fields', async () => {
    const facts = Object.freeze({ catalogRevision: 'catalog-1' });
    const mechanisms = Object.freeze({ fetch: () => undefined });
    let observedRequest: Parameters<CapabilityExecutor['execute']>[0] | undefined;
    let observedContext: Parameters<CapabilityExecutor['execute']>[1] | undefined;
    const port = createFixture(async (request, context) => {
      observedRequest = request;
      observedContext = context;
      return exactReceipt(request, context);
    });
    await port.invoke(
      invocation({
        request: { ...invocation().request, facts },
        environment: {
          environmentId: 'test',
          kind: 'in_process',
          mechanisms,
        },
      }),
    );
    expect(observedRequest?.facts).toBe(facts);
    expect(Object.keys(observedContext ?? {}).sort()).toEqual([
      'attempt',
      'environment',
      'grant',
      'requestDigest',
      'signal',
    ]);
    expect(observedContext?.environment.mechanisms).toBe(mechanisms);
  });
});

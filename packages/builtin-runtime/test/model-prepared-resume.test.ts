import { expect, test } from 'bun:test';
import {
  canonicalModelJson,
  compileModelSurface,
  createChatModel,
  derivePrivateImmutableArtifactReference,
  humanMessage,
  type ModelArtifactWriter,
  ModelInvocationGateway,
  type ModelPreparedResumeStateView,
  type ModelResponseSource,
  resumeBuiltinPreparedPrimaryModelEffect,
} from '@kite-ai/builtin-runtime/model';
import { MODEL_ATTEMPT_OUTCOME_SCHEMA_, type PrivateArtifactRef } from '@kite-ai/runtime-spi';

const config = {
  apiKey: 'resume-fixture-key',
  baseURL: 'https://resume.invalid/v1',
  modelName: 'resume-fixture',
  providerName: 'resume-fixture',
  providerType: 'openai-compatible' as const,
  sandbox: { enabled: false },
};
const model = createChatModel(config);

function fixture(withOutputLimit = true) {
  const compiled = compileModelSurface({
    purpose: 'primary_agent',
    config,
    model,
    messages: [humanMessage('Durably admitted followup mail')],
    tools: {},
    ...(withOutputLimit ? { maxOutputTokens: 16 } : {}),
    estimatedInputTokens: 20,
  });
  const canonical = canonicalModelJson(compiled.surface);
  const surfaceArtifact: PrivateArtifactRef & { kind: 'model_surface' } =
    derivePrivateImmutableArtifactReference(
      'model-artifacts',
      'model_surface',
      Buffer.from(canonical, 'utf8'),
    );
  let storedSurface = compiled.surface;
  let state: ModelPreparedResumeStateView = {
    revision: 4,
    session: { threadId: 'child' },
    turn: { turnId: 'run', status: 'active' },
    modelInvocations: {
      invocation: {
        invocationId: 'invocation',
        purpose: 'primary_agent',
        status: 'prepared',
        attempts: 0,
        surfaceArtifact,
        surfaceIntegrityIdentifier: surfaceArtifact.integrityIdentifier,
        routeFingerprint: compiled.surface.route.routeFingerprint,
        estimatedInputTokens: 20,
        preparedStateRevision: 2,
        budget: { kind: 'reservation', reservationId: 'reservation', parentReservationId: null },
        limits: { maxAttempts: 1, perAttemptTimeoutMs: 1_000, totalTimeBudgetMs: 1_000 },
        parentInvocationId: null,
        parentToolCallId: null,
      },
    },
    resourceBudget: {
      status: 'active',
      runId: 'run',
      reservations: {
        reservation: {
          reservationId: 'reservation',
          runId: 'run',
          invocationId: 'model-invocation:invocation',
          resourceKind: 'model',
          state: 'reserved',
          executableUpperBound: {
            counters: { modelRequests: 1, inputTokens: 64, outputTokens: 16 },
          },
        },
      },
    },
  };
  const order: string[] = [];
  const artifacts: ModelArtifactWriter = {
    writeSurface: () => {
      order.push('unexpected-surface-write');
      throw new Error('Resume must not write a new Surface.');
    },
    readSurface: (ref) => {
      expect(ref).toEqual(surfaceArtifact);
      order.push('surface-read');
      return storedSurface;
    },
    writeResponse: () => ({ ...surfaceArtifact, kind: 'model_response' }),
  };
  const source: ModelResponseSource = {
    attempt: async () => {
      order.push('provider');
      return {
        schema: MODEL_ATTEMPT_OUTCOME_SCHEMA_,
        kind: 'success',
        response: {
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: null },
          providerMetadata: { responseId: 'response', rawFinishReason: 'stop' },
        },
        nativeReplayState: null,
      };
    },
  };
  const gateway = new ModelInvocationGateway({
    artifacts,
    source,
    operationExecution: { execute: (attempt) => attempt.attempt() },
    runtimeIdSource: {
      next: () => {
        order.push('unexpected-new-id');
        throw new Error('Resume must not allocate a new invocation.');
      },
      now: () => 1,
    },
  });
  const persistence = {
    getState: () => state,
    persistEvents: async (events: Array<{ type: string }>) => {
      order.push(`events:${events.map((event) => event.type).join(',')}`);
      if (events.some((event) => event.type === 'model.invocation_attempt_started')) {
        if (state.modelInvocations.invocation?.status !== 'prepared') return false;
        state = {
          ...state,
          revision: state.revision + events.length,
          modelInvocations: {
            invocation: {
              ...state.modelInvocations.invocation!,
              status: 'dispatching',
              attempts: 1,
            },
          },
          resourceBudget: {
            ...state.resourceBudget,
            reservations: {
              reservation: {
                ...state.resourceBudget.reservations!.reservation!,
                state: 'dispatch_started',
              },
            },
          },
        };
      }
      return true;
    },
  };
  const input = {
    model,
    persistence,
    invocationId: 'invocation',
    expectedStateRevision: 4,
    expectedTurnId: 'run',
    expectedRouteFingerprint: compiled.surface.route.routeFingerprint,
    surfaceArtifact,
    surfaceIntegrityIdentifier: surfaceArtifact.integrityIdentifier,
    hardAttemptTimeoutMs: 1_000,
    beforeDispatch: async () => {
      order.push('gate');
      return true;
    },
  };
  return {
    gateway,
    input,
    order,
    get state() {
      return state;
    },
    setState(value: ModelPreparedResumeStateView) {
      state = value;
    },
    corruptSurface() {
      storedSurface = {
        ...compiled.surface,
        request: { ...compiled.surface.request, system: 'Tampered after admission' },
      };
    },
  };
}

test('resumes one durable prepared primary invocation after the source gate without new identity or Surface', async () => {
  const f = fixture();
  const pending = await resumeBuiltinPreparedPrimaryModelEffect(f.gateway, f.input);
  expect(pending.invocationId).toBe('invocation');
  expect(f.order).toEqual([
    'surface-read',
    'gate',
    'events:resource_budget.dispatch_started,model.invocation_attempt_started,model.requested',
    'provider',
  ]);
  await expect(resumeBuiltinPreparedPrimaryModelEffect(f.gateway, f.input)).rejects.toThrow(
    'stale or attempted durable authority',
  );
  expect(f.order.filter((item) => item === 'provider')).toHaveLength(1);
  await pending.commit();
});

test('resumes an exact duration-only child preparation without a separate attempt limit', async () => {
  const f = fixture(false);
  const state = f.state;
  const prepared = state.modelInvocations.invocation!;
  const reservation = state.resourceBudget.reservations!.reservation!;
  const durationState: ModelPreparedResumeStateView = {
    ...state,
    modelInvocations: {
      invocation: {
        ...prepared,
        limits: {
          maxAttempts: Number.MAX_SAFE_INTEGER,
          perAttemptTimeoutMs: 0,
          totalTimeBudgetMs: Number.MAX_SAFE_INTEGER,
        },
      },
    },
    resourceBudget: {
      ...state.resourceBudget,
      budget: { durationOnlyChildRun: true },
      reservations: {
        reservation: {
          ...reservation,
          executableUpperBound: {
            unboundedModelTokens: true,
            counters: { modelRequests: 1, inputTokens: 0, outputTokens: 0 },
          },
        },
      },
    },
  };
  f.setState(durationState);
  const { hardAttemptTimeoutMs: _legacyTimeout, ...unboundedInput } = f.input;
  const pending = await f.gateway.resumePrepared(unboundedInput);
  await pending.commit();
  expect(f.order).toContain('provider');

  const forged = fixture();
  forged.setState({
    ...durationState,
    resourceBudget: { ...durationState.resourceBudget, budget: undefined },
  });
  const { hardAttemptTimeoutMs: _forgedTimeout, ...forgedInput } = forged.input;
  await expect(forged.gateway.resumePrepared(forgedInput)).rejects.toThrow(
    'stale or attempted durable authority',
  );
});

test('resumes an unbounded primary preparation with the same durable authority checks', async () => {
  const f = fixture(false);
  const state = f.state;
  const prepared = state.modelInvocations.invocation!;
  const reservation = state.resourceBudget.reservations!.reservation!;
  f.setState({
    ...state,
    modelInvocations: {
      invocation: {
        ...prepared,
        limits: {
          maxAttempts: Number.MAX_SAFE_INTEGER,
          perAttemptTimeoutMs: 0,
          totalTimeBudgetMs: Number.MAX_SAFE_INTEGER,
        },
      },
    },
    resourceBudget: {
      ...state.resourceBudget,
      budget: { unboundedCumulativeUsage: true },
      reservations: {
        reservation: {
          ...reservation,
          executableUpperBound: {
            unboundedModelTokens: true,
            counters: { modelRequests: 1, inputTokens: 0, outputTokens: 0 },
          },
        },
      },
    },
  });
  const { hardAttemptTimeoutMs: _legacyTimeout, ...unboundedInput } = f.input;
  const pending = await f.gateway.resumePrepared(unboundedInput);
  await pending.commit();
  expect(f.order).toContain('provider');
});

test('resumes a legacy single-attempt preparation inside a duration-only child budget', async () => {
  const f = fixture();
  const state = f.state;
  const reservation = state.resourceBudget.reservations!.reservation!;
  f.setState({
    ...state,
    resourceBudget: {
      ...state.resourceBudget,
      budget: { durationOnlyChildRun: true },
      reservations: {
        reservation: {
          ...reservation,
          executableUpperBound: {
            unboundedModelTokens: true,
            counters: { modelRequests: 1, inputTokens: 0, outputTokens: 0 },
          },
        },
      },
    },
  });
  const pending = await f.gateway.resumePrepared(f.input);
  await pending.commit();
  expect(f.order).toContain('provider');
});

test('refuses a missing ACK without changing the prepared invocation, then resumes the same identity', async () => {
  const f = fixture();
  await expect(
    f.gateway.resumePrepared({ ...f.input, beforeDispatch: async () => false }),
  ).rejects.toThrow('no durable source acknowledgement');
  expect(f.state.modelInvocations.invocation?.status).toBe('prepared');
  expect(f.order).toEqual(['surface-read']);
  const pending = await f.gateway.resumePrepared(f.input);
  expect(pending.invocationId).toBe('invocation');
  expect(f.order).not.toContain('unexpected-new-id');
});

test('two recovery callers cannot dispatch the same prepared attempt twice', async () => {
  const f = fixture();
  let releaseGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const input = {
    ...f.input,
    beforeDispatch: async () => {
      await gate;
      return true;
    },
  };
  const first = f.gateway.resumePrepared(input);
  const second = f.gateway.resumePrepared(input);
  await Promise.resolve();
  releaseGate?.();
  const settled = await Promise.allSettled([first, second]);
  expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(1);
  expect(f.order.filter((item) => item === 'provider')).toHaveLength(1);
});

test('rejects stale route, unknown reservation, changed Surface and attempted evidence before Provider', async () => {
  const f = fixture();
  await expect(
    f.gateway.resumePrepared({ ...f.input, expectedRouteFingerprint: 'different' }),
  ).rejects.toThrow('stale or attempted durable authority');
  f.setState({
    ...f.state,
    modelInvocations: {
      invocation: { ...f.state.modelInvocations.invocation!, estimatedInputTokens: undefined },
    },
  });
  await expect(f.gateway.resumePrepared(f.input)).rejects.toThrow(
    'stale or attempted durable authority',
  );
  f.setState({
    ...f.state,
    modelInvocations: {
      invocation: { ...f.state.modelInvocations.invocation!, estimatedInputTokens: 20 },
    },
  });
  f.corruptSurface();
  await expect(f.gateway.resumePrepared(f.input)).rejects.toThrow(
    'differs from its durable artifact',
  );
  const fresh = fixture();
  fresh.setState({
    ...fresh.state,
    resourceBudget: {
      ...fresh.state.resourceBudget,
      reservations: {
        reservation: { ...fresh.state.resourceBudget.reservations!.reservation!, state: 'unknown' },
      },
    },
  });
  await expect(fresh.gateway.resumePrepared(fresh.input)).rejects.toThrow(
    'stale or attempted durable authority',
  );
  fresh.setState({
    ...fresh.state,
    modelInvocations: {
      invocation: {
        ...fresh.state.modelInvocations.invocation!,
        status: 'dispatching',
        attempts: 1,
      },
    },
  });
  await expect(fresh.gateway.resumePrepared(fresh.input)).rejects.toThrow(
    'stale or attempted durable authority',
  );
  expect(f.order).toEqual(['surface-read']);
  expect(fresh.order).toEqual([]);
});

test('does not recover a widened attempt limit or a different target Turn', async () => {
  const f = fixture();
  await expect(
    f.gateway.resumePrepared({ ...f.input, expectedTurnId: 'other-run' }),
  ).rejects.toThrow('stale or attempted durable authority');
  f.setState({
    ...f.state,
    modelInvocations: {
      invocation: {
        ...f.state.modelInvocations.invocation!,
        limits: { maxAttempts: 2, perAttemptTimeoutMs: 1_000, totalTimeBudgetMs: 1_000 },
      },
    },
  });
  await expect(f.gateway.resumePrepared(f.input)).rejects.toThrow(
    'stale or attempted durable authority',
  );
  expect(f.order).toEqual([]);
});

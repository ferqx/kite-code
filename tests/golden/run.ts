import { deepStrictEqual, ok } from 'node:assert';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import {
  createRuntimeHostStateInitialState,
  type RuntimeState,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { RuntimeUserAction } from '#app/bootstrap/runtime/state-actions';
import { runStateRuntimeLoop } from '#app/bootstrap/runtime/state-runner';
import { StateHostSessionHarness as AgentKernel } from '../../scripts/support/runtime-host-state';
import { openStateStoreForTest } from '../../scripts/support/runtime-storage';

export interface GoldenFixture {
  name: string;
  description: string;
  initialState?: Partial<RuntimeState>;
  initialEvents: RuntimeEvent[];
  effects: Array<{ events: RuntimeEvent[] }>;
  userActions?: Array<
    | { type: 'input'; text: string }
    | { type: 'approve'; grant: 'approve_once' | 'same_command' }
    | { type: 'approve_plan'; executionMode: 'accept_edits' | 'auto' }
    | { type: 'waive_verification'; reason: string }
    | { type: 'complete_provider_action'; providerDirectoryRevision?: string }
    | { type: 'waive_provider_admission' }
  >;
  expectedEvents: RuntimeEvent['type'][];
  expectedEffects?: string[];
  expectedFinalState: Record<string, unknown>;
}

function getByPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

/**
 * Deterministically replays durable RuntimeEvents through the production
 * reducer. Fixtures contain no timers, models, files, or UI state, keeping
 * their output stable and their failures useful as kernel regressions.
 */
export async function runGoldenTest(fixture: GoldenFixture): Promise<RuntimeState> {
  const base = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: `golden-${fixture.name}`,
    userId: 'golden-user',
    workspace: '/tmp/golden',
  });
  const store = openStateStoreForTest(':memory:');
  const kernel = new AgentKernel({
    store,
    initialState: { ...base, ...fixture.initialState },
    interactionMode: 'accept_edits',
    sandboxAvailable: true,
  });
  const observed = [...fixture.initialEvents];
  kernel.processEvents(fixture.initialEvents);
  const effects = [...fixture.effects];
  const actions = [...(fixture.userActions ?? [])];
  const observedEffects: string[] = [];
  try {
    for await (const event of runStateRuntimeLoop(
      kernel,
      async (effect) => {
        observedEffects.push(effect.type);
        return effects.shift()?.events ?? [];
      },
      {
        requestAction: async (effect, state): Promise<RuntimeUserAction> => {
          observedEffects.push(effect.type);
          const action = actions.shift();
          if (!action) throw new Error(`${fixture.name}: missing action for ${effect.type}`);
          if (action.type === 'input')
            return { type: 'input', interactionId: effect.interactionId, text: action.text };
          if (action.type === 'approve')
            return {
              type: 'approve',
              interactionId: effect.interactionId,
              generation:
                state.pendingApprovals.get(effect.interactionId)?.generation ??
                (() => {
                  throw new Error(`${fixture.name}: approval has no durable queue generation`);
                })(),
              grant: action.grant,
            };
          if (action.type === 'waive_verification') {
            if (effect.type !== 'request_verification_decision') {
              throw new Error(`${fixture.name}: verification waiver without a decision effect`);
            }
            return {
              type: 'waive_verification',
              verificationId: effect.verificationId,
              reason: action.reason,
            };
          }
          if (action.type === 'complete_provider_action') {
            if (effect.type !== 'request_provider_action') {
              throw new Error(`${fixture.name}: provider completion without a provider effect`);
            }
            return {
              type: 'provider_action_result',
              interactionId: effect.interactionId,
              outcome: 'completed',
              ...(action.providerDirectoryRevision
                ? { providerDirectoryRevision: action.providerDirectoryRevision }
                : {}),
            };
          }
          if (action.type === 'waive_provider_admission') {
            if (effect.type !== 'request_provider_admission') {
              throw new Error(`${fixture.name}: provider waiver without an admission effect`);
            }
            return {
              type: 'provider_admission_decision',
              interactionId: effect.interactionId,
              decision: { kind: 'waive' },
            };
          }
          if (state.interactions.kind !== 'awaiting_review') {
            throw new Error(`${fixture.name}: plan action without a plan review`);
          }
          return {
            type: 'plan_review_decision',
            interactionId: effect.interactionId,
            planId: state.interactions.planId,
            version: state.interactions.version,
            structuralDigest: state.interactions.structuralDigest,
            decision: {
              kind: 'approve',
              nextMode: action.executionMode,
            },
          };
        },
      },
    )) {
      observed.push(event);
    }
  } finally {
    store.close();
  }
  const state = kernel.getState() as RuntimeState;
  const actualTypes = observed.map((event) => event.type);
  for (const expected of fixture.expectedEvents) {
    ok(actualTypes.includes(expected), `${fixture.name}: expected event ${expected} not found`);
  }
  for (const [path, expected] of Object.entries(fixture.expectedFinalState)) {
    deepStrictEqual(getByPath(state, path), expected, `${fixture.name}: state mismatch at ${path}`);
  }
  for (const expected of fixture.expectedEffects ?? []) {
    ok(
      observedEffects.includes(expected),
      `${fixture.name}: expected effect ${expected} not requested`,
    );
  }
  return state;
}

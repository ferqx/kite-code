import { describe, expect, test } from 'bun:test';
import { createInitialAgentState } from '@kite-ai/agent-kernel';
import type { RuntimeState } from '../src/bootstrap/runtime/state-runtime';
import {
  mapRuntimeInteractionResponseToUserAction,
  projectRuntimeClientInteraction,
  type RuntimeInteractionEffect,
} from '../src/runtime-client/interaction-projector';

const recoveryIdentityKey = '0'.repeat(64);

describe('Runtime client interaction projector', () => {
  test('projects every interaction kind with only client-safe identity', () => {
    const approval = state({
      revision: 9,
      interactions: {
        kind: 'awaiting_tool_approval',
        interactionId: 'approval-1',
        toolCallId: 'tool-1',
        approval: {
          tool: 'shell',
          summary: 'authorization: Bearer secret',
          grantOptions: ['approve_once'],
        },
      },
      approvalGeneration: 4,
      pendingApprovals: new Map([['approval-1', pendingApproval(4)]]),
    });
    expect(
      projectRuntimeClientInteraction(approval, {
        type: 'request_tool_approval',
        interactionId: 'approval-1',
        toolCallId: 'tool-1',
      }),
    ).toMatchObject({
      kind: 'approval',
      interactionId: 'approval-1',
      sessionRevision: 9,
      generation: 4,
      grants: ['approve_once'],
      command: 'git status --short',
      summary: '[redacted]',
    });

    const input = state({
      interactions: {
        kind: 'awaiting_user_input',
        interactionId: 'input-1',
        toolCallId: 'tool-1',
        request: { question: 'password: hidden', allow_free_text: true, options: [] },
      },
    });
    expect(
      projectRuntimeClientInteraction(input, {
        type: 'request_user_input',
        interactionId: 'input-1',
        toolCallId: 'tool-1',
      }),
    ).toMatchObject({ kind: 'input', question: '[redacted]' });

    const plan = state({
      interactions: {
        kind: 'awaiting_review',
        interactionId: 'plan-1',
        toolCallId: 'tool-1',
        planId: 'plan-1',
        version: 2,
        structuralDigest: 'digest-2',
        plan: { name: 'Safe plan', description: '', status: 'pending', steps: [] },
        planSummary: 'summary',
      },
    });
    expect(
      projectRuntimeClientInteraction(plan, {
        type: 'request_plan_review',
        interactionId: 'plan-1',
        toolCallId: 'tool-1',
      }),
    ).toMatchObject({
      kind: 'plan_review',
      plan: { planId: 'plan-1', version: 2, structuralDigest: 'digest-2' },
    });

    const provider = providerState('awaiting_provider_action');
    expect(
      projectRuntimeClientInteraction(provider, providerEffect('request_provider_action')),
    ).toMatchObject({
      kind: 'provider_action',
      provider: { providerId: 'github', directoryRevision: 'directory-1' },
      action: 'login',
    });
    const admission = providerState('awaiting_provider_admission');
    expect(
      projectRuntimeClientInteraction(admission, providerEffect('request_provider_admission')),
    ).toMatchObject({ kind: 'provider_action', action: 'retry' });

    const verification = state({
      verification: { records: { verify: verificationRecord() } },
    });
    expect(
      projectRuntimeClientInteraction(verification, {
        type: 'request_verification_decision',
        interactionId: 'verify',
        verificationId: 'verify',
      }),
    ).toMatchObject({
      kind: 'verification',
      verification: { verificationId: 'verify', revision: '2026-08-26T00:00:00.000Z' },
    });
  });

  test('maps validated responses exhaustively and rejects stale identity or response kinds', () => {
    const approval = state({
      revision: 5,
      approvalGeneration: 3,
      interactions: {
        kind: 'awaiting_tool_approval',
        interactionId: 'approval-1',
        toolCallId: 'tool-1',
        approval: { tool: 'shell', summary: 'safe', grantOptions: ['approve_once'] },
      },
      pendingApprovals: new Map([['approval-1', pendingApproval(3)]]),
    });
    const effect = {
      type: 'request_tool_approval',
      interactionId: 'approval-1',
      toolCallId: 'tool-1',
    } as const;
    const interaction = projectRuntimeClientInteraction(approval, effect)!;
    expect(
      mapRuntimeInteractionResponseToUserAction({
        state: approval,
        effect,
        interaction,
        response: { kind: 'approval', decision: 'approve_once' },
      }),
    ).toEqual({
      type: 'approve',
      interactionId: 'approval-1',
      generation: 3,
      grant: 'approve_once',
    });
    expect(
      mapRuntimeInteractionResponseToUserAction({
        state: approval,
        effect,
        interaction: { ...interaction, generation: 2 },
        response: { kind: 'approval', decision: 'approve_once' },
      }),
    ).toBeNull();

    const input = state({
      interactions: {
        kind: 'awaiting_user_input',
        interactionId: 'input-1',
        toolCallId: 'tool-1',
        request: { question: 'Question', allow_free_text: true, options: [] },
      },
    });
    const inputEffect = {
      type: 'request_user_input',
      interactionId: 'input-1',
      toolCallId: 'tool-1',
    } as const;
    const inputInteraction = projectRuntimeClientInteraction(input, inputEffect)!;
    expect(
      mapRuntimeInteractionResponseToUserAction({
        state: input,
        effect: inputEffect,
        interaction: inputInteraction,
        response: { kind: 'text', value: 'answer' },
      }),
    ).toEqual({ type: 'input', interactionId: 'input-1', text: 'answer' });
    expect(
      mapRuntimeInteractionResponseToUserAction({
        state: approval,
        effect,
        interaction,
        response: { kind: 'text', value: 'wrong' },
      }),
    ).toBeNull();

    const plan = state({
      interactions: {
        kind: 'awaiting_review',
        interactionId: 'plan-1',
        toolCallId: 'tool-1',
        planId: 'plan-1',
        version: 2,
        structuralDigest: 'digest-2',
        plan: { name: 'Plan', description: '', status: 'pending', steps: [] },
        planSummary: 'safe',
      },
    });
    const planEffect = {
      type: 'request_plan_review',
      interactionId: 'plan-1',
      toolCallId: 'tool-1',
    } as const;
    const planInteraction = projectRuntimeClientInteraction(plan, planEffect)!;
    expect(
      mapRuntimeInteractionResponseToUserAction({
        state: plan,
        effect: planEffect,
        interaction: {
          ...planInteraction,
          plan: { ...planInteraction.plan, structuralDigest: 'stale' },
        },
        response: { kind: 'plan_review', decision: 'auto' },
      }),
    ).toBeNull();

    const verification = state({ verification: { records: { verify: verificationRecord() } } });
    const verificationEffect = {
      type: 'request_verification_decision',
      interactionId: 'verify',
      verificationId: 'verify',
    } as const;
    const verificationInteraction = projectRuntimeClientInteraction(
      verification,
      verificationEffect,
    )!;
    expect(
      mapRuntimeInteractionResponseToUserAction({
        state: verification,
        effect: verificationEffect,
        interaction: verificationInteraction,
        response: { kind: 'verification', decision: 'waive', detail: 'user accepted' },
      }),
    ).toEqual({ type: 'waive_verification', verificationId: 'verify', reason: 'user accepted' });
    expect(
      mapRuntimeInteractionResponseToUserAction({
        state: verification,
        effect: verificationEffect,
        interaction: verificationInteraction,
        response: { kind: 'verification', decision: 'compensate', detail: 'repair' },
      }),
    ).toEqual({ type: 'request_verification_compensation', verificationId: 'verify' });

    const providerAction = providerState('awaiting_provider_action');
    const providerActionEffect = providerEffect('request_provider_action');
    const providerActionInteraction = projectRuntimeClientInteraction(
      providerAction,
      providerActionEffect,
    )!;
    expect(
      mapRuntimeInteractionResponseToUserAction({
        state: providerAction,
        effect: providerActionEffect,
        interaction: providerActionInteraction,
        response: { kind: 'provider_action', outcome: 'completed' },
      }),
    ).toEqual({
      type: 'provider_action_result',
      interactionId: 'provider-1',
      outcome: 'completed',
      providerDirectoryRevision: 'directory-1',
    });

    const admission = providerState('awaiting_provider_admission');
    const admissionEffect = providerEffect('request_provider_admission');
    const admissionInteraction = projectRuntimeClientInteraction(admission, admissionEffect)!;
    expect(
      mapRuntimeInteractionResponseToUserAction({
        state: admission,
        effect: admissionEffect,
        interaction: admissionInteraction,
        response: { kind: 'provider_action', outcome: 'completed' },
      }),
    ).toEqual({
      type: 'provider_admission_decision',
      interactionId: 'provider-1',
      decision: { kind: 'retry', outcome: 'ready', providerDirectoryRevision: 'directory-1' },
    });
    expect(
      mapRuntimeInteractionResponseToUserAction({
        state: admission,
        effect: admissionEffect,
        interaction: admissionInteraction,
        response: { kind: 'provider_action', outcome: 'deferred' },
      }),
    ).toEqual({
      type: 'provider_admission_decision',
      interactionId: 'provider-1',
      decision: { kind: 'waive' },
    });
  });

  test('fails closed for stale session identity and never projects private provider state', () => {
    const provider = providerState('awaiting_provider_action');
    const effect = providerEffect('request_provider_action');
    const interaction = projectRuntimeClientInteraction(provider, effect)!;
    expect(
      mapRuntimeInteractionResponseToUserAction({
        state: { ...provider, revision: provider.revision + 1 },
        effect,
        interaction,
        response: { kind: 'provider_action', outcome: 'completed' },
      }),
    ).toBeNull();
    const withoutDirectoryRevision = projectRuntimeClientInteraction(
      { ...provider, providerReadiness: {} },
      effect,
    );
    expect(withoutDirectoryRevision).toMatchObject({
      kind: 'provider_action',
      provider: { providerId: 'github' },
      action: 'login',
    });
    expect(JSON.stringify(withoutDirectoryRevision)).not.toContain('providerReadiness');
    expect(JSON.stringify(withoutDirectoryRevision)).not.toContain('directoryRevision');
    expect(JSON.stringify(interaction)).not.toContain('/private');
    expect(JSON.stringify(interaction)).not.toContain('secret');
    expect(JSON.stringify(interaction)).not.toContain('args');
  });
});

function state(overrides: Record<string, unknown>): RuntimeState {
  return {
    ...createInitialAgentState({
      threadId: 'session-1',
      userId: 'user-1',
      workspace: '/private/workspace',
      turnId: 'turn-1',
      recoveryIdentityKey,
    }),
    ...overrides,
  } as RuntimeState;
}

function pendingApproval(generation: number) {
  return {
    interactionId: 'approval-1',
    toolCallId: 'tool-1',
    route: 'user',
    fullModeBypassEligible: false,
    fullModePolicyBypassAllowed: false,
    bindingDigest: 'binding',
    approval: {
      tool: 'shell',
      command: 'git status --short',
      summary: 'authorization: Bearer secret',
      grantOptions: ['approve_once'],
    },
    invocation: { args: { path: '/private/secret' } },
    sequence: 1,
    generation,
    createdAt: '2026-08-26T00:00:00.000Z',
    status: 'awaiting_user',
    state: 'awaiting_user',
  };
}

function providerState(
  kind: 'awaiting_provider_action' | 'awaiting_provider_admission',
): RuntimeState {
  const base = state({
    providerReadiness: {
      github: { providerId: 'github', providerDirectoryRevision: 'directory-1' },
    },
  });
  if (kind === 'awaiting_provider_action') {
    return {
      ...base,
      interactions: {
        kind,
        interactionId: 'provider-1',
        providerId: 'github',
        action: 'login',
        originatingToolCallId: 'tool-1',
        status: 'required',
      },
    } as RuntimeState;
  }
  const pending = {
    interactionId: 'provider-1',
    providerId: 'github',
    source: 'project' as const,
    providerStatus: 'login_required' as const,
    retryable: true,
  };
  return {
    ...base,
    interactions: { kind, ...pending },
    providerAdmission: { pending: [pending], waivers: {} },
  } as RuntimeState;
}

function providerEffect(
  type: 'request_provider_action' | 'request_provider_admission',
): Extract<
  RuntimeInteractionEffect,
  { type: 'request_provider_action' | 'request_provider_admission' }
> {
  return type === 'request_provider_action'
    ? {
        type,
        interactionId: 'provider-1',
        providerId: 'github',
        action: 'login',
        originatingToolCallId: 'tool-1',
      }
    : {
        type,
        interactionId: 'provider-1',
        providerId: 'github',
        providerStatus: 'login_required',
        retryable: true,
      };
}

function verificationRecord() {
  return {
    verificationId: 'verify',
    mode: 'required' as const,
    status: 'failed' as const,
    spec: {
      schemaVersion: 1 as const,
      verificationId: 'verify',
      subject: '/private/secret',
      checks: [],
      repair: { maxAttempts: 1 },
    },
    requestedAt: '2026-08-26T00:00:00.000Z',
    attempts: 1,
    repairAttempts: 0,
    checkResults: {},
  };
}

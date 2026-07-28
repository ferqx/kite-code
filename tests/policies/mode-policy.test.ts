import { describe, expect, it } from 'bun:test';
import {
  createAcceptEditsModePolicy,
  createAutoModePolicy,
  createFullModePolicy,
  createModePolicy,
} from '@/core/policies/mode-policy';
import type { PolicyInput } from '@/core/policies/runtime-policy';

// ── Test input builders ──

function baseInput(overrides?: Partial<PolicyInput>): PolicyInput {
  return {
    interactionMode: 'accept_edits',
    phase: 'building',
    planKind: 'building_without_plan',
    ...overrides,
  };
}

// ── Auto Mode ──

describe('createAutoModePolicy', () => {
  const policy = createAutoModePolicy();

  it('should allow ask_user', () => {
    expect(policy.shouldAskUser(baseInput({ interactionMode: 'auto' })).kind).toBe('allow');
  });

  it('should deny destructive tools', () => {
    const result = policy.shouldApproveTool(
      baseInput({ interactionMode: 'auto', toolRisk: 'destructive' }),
    );
    expect(result.kind).toBe('deny');
  });

  it('should allow proven-local workspace writes like accept_edits', () => {
    const result = policy.shouldApproveTool(
      baseInput({ interactionMode: 'auto', toolRisk: 'write_file' }),
    );
    expect(result.kind).toBe('allow');
  });

  it('should require auto-review for operations accept_edits would require approval for', () => {
    const result = policy.shouldApproveTool(
      baseInput({ interactionMode: 'auto', toolRisk: 'execute_code' }),
    );
    expect(result.kind).toBe('need_auto_review');
  });

  it('should require auto-review for a read tool with external effects', () => {
    const result = policy.shouldApproveTool(
      baseInput({
        interactionMode: 'auto',
        toolRisk: 'read',
        effects: { uncertainEffects: true },
      }),
    );
    expect(result.kind).toBe('need_auto_review');
  });

  it('should allow read tools without auto-review', () => {
    expect(
      policy.shouldApproveTool(baseInput({ interactionMode: 'auto', toolRisk: 'read' })).kind,
    ).toBe('allow');
  });

  it('should not bypass auto-review with an unscoped approval cache flag', () => {
    const result = policy.shouldApproveTool({
      ...baseInput({ interactionMode: 'auto', toolRisk: 'execute_code' }),
      approvalCached: true,
    } as PolicyInput);
    expect(result.kind).toBe('need_auto_review');
  });

  it('should fall back to manual approval when circuit breaker tripped', () => {
    const result = policy.shouldApproveTool(
      baseInput({ interactionMode: 'auto', toolRisk: 'execute_code', circuitBreakerTripped: true }),
    );
    expect(result.kind).toBe('need_tool_approval');
  });

  it('should enable auto-review only for operations that need approval under accept_edits', () => {
    const result = policy.shouldAutoReview(
      baseInput({ interactionMode: 'auto', toolRisk: 'execute_code' }),
    );
    expect(result.kind).toBe('need_auto_review');
  });

  it('should not auto-review read tools', () => {
    expect(
      policy.shouldAutoReview(baseInput({ interactionMode: 'auto', toolRisk: 'read' })).kind,
    ).toBe('allow');
  });

  it('should not auto-review proven-local workspace writes', () => {
    expect(
      policy.shouldAutoReview(baseInput({ interactionMode: 'auto', toolRisk: 'write_file' })).kind,
    ).toBe('allow');
  });

  it('should not auto-review destructive tools', () => {
    const result = policy.shouldAutoReview(
      baseInput({ interactionMode: 'auto', toolRisk: 'destructive' }),
    );
    expect(result.kind).toBe('allow');
  });

  it('should not continue loop', () => {
    expect(policy.shouldContinueLoop(baseInput()).kind).toBe('stop');
  });
});

// ── Full Mode ──

describe('createFullModePolicy', () => {
  describe('with sandbox available', () => {
    const policy = createFullModePolicy(true);

    it('should deny ask_user', () => {
      const result = policy.shouldAskUser(baseInput({ interactionMode: 'full' }));
      expect(result.kind).toBe('deny');
    });

    it('should deny destructive even with sandbox', () => {
      const result = policy.shouldApproveTool(
        baseInput({ interactionMode: 'full', toolRisk: 'destructive' }),
      );
      expect(result.kind).toBe('deny');
    });

    it('should allow write tools (sandbox protection)', () => {
      expect(
        policy.shouldApproveTool(baseInput({ interactionMode: 'full', toolRisk: 'write_file' }))
          .kind,
      ).toBe('allow');
    });

    it('should allow execute_code (sandbox protection)', () => {
      expect(
        policy.shouldApproveTool(baseInput({ interactionMode: 'full', toolRisk: 'execute_code' }))
          .kind,
      ).toBe('allow');
    });

    it('should allow read tools', () => {
      expect(
        policy.shouldApproveTool(baseInput({ interactionMode: 'full', toolRisk: 'read' })).kind,
      ).toBe('allow');
    });

    it('should allow external effects under explicit full mode', () => {
      expect(
        policy.shouldApproveTool(
          baseInput({
            interactionMode: 'full',
            toolRisk: 'read',
            effects: { network: true },
          }),
        ).kind,
      ).toBe('allow');
    });
  });

  describe('without sandbox', () => {
    const policy = createFullModePolicy(false);

    it('should deny ask_user with sandbox-unavailable reason', () => {
      const result = policy.shouldAskUser(baseInput({ interactionMode: 'full' }));
      expect(result.kind).toBe('deny');
    });

    it('should require tool approval when no sandbox', () => {
      const result = policy.shouldApproveTool(
        baseInput({ interactionMode: 'full', toolRisk: 'write_file' }),
      );
      expect(result.kind).toBe('need_tool_approval');
    });

    it('should still deny destructive', () => {
      const result = policy.shouldApproveTool(
        baseInput({ interactionMode: 'full', toolRisk: 'destructive' }),
      );
      expect(result.kind).toBe('deny');
    });
  });
});

// ── Accept Edits Mode ──

describe('createAcceptEditsModePolicy', () => {
  const policy = createAcceptEditsModePolicy();

  it('should allow ask_user', () => {
    expect(policy.shouldAskUser(baseInput()).kind).toBe('allow');
  });

  it('should require plan review when plan is drafted', () => {
    const result = policy.shouldReviewPlan(baseInput({ planKind: 'planning_draft' }));
    expect(result.kind).toBe('need_plan_review');
  });

  it('should allow when no plan exists', () => {
    expect(policy.shouldReviewPlan(baseInput({ planKind: 'building_without_plan' })).kind).toBe(
      'allow',
    );
  });

  it('should auto-allow write_file without approval', () => {
    const result = policy.shouldApproveTool(baseInput({ toolRisk: 'write_file' }));
    expect(result.kind).toBe('allow');
  });

  it('should require approval for Git mutations because hooks and filters are not statically safe', () => {
    const result = policy.shouldApproveTool(baseInput({ toolRisk: 'vcs_mutation', effects: {} }));
    expect(result.kind).toBe('need_tool_approval');
  });

  it('should require approval when a workspace write also accesses the network', () => {
    const result = policy.shouldApproveTool(
      baseInput({ toolRisk: 'write_file', effects: { network: true } }),
    );
    expect(result.kind).toBe('need_tool_approval');
  });

  it('should require approval when a write targets an external path', () => {
    const result = policy.shouldApproveTool(
      baseInput({ toolRisk: 'write_file', effects: { externalWrite: true } }),
    );
    expect(result.kind).toBe('need_tool_approval');
  });

  it('should require approval when a command has uncertain side effects', () => {
    const result = policy.shouldApproveTool(
      baseInput({ toolRisk: 'execute_code', effects: { uncertainEffects: true } }),
    );
    expect(result.kind).toBe('need_tool_approval');
  });

  it('should allow read tools', () => {
    expect(policy.shouldApproveTool(baseInput({ toolRisk: 'read' })).kind).toBe('allow');
  });

  it('should allow plan tools', () => {
    expect(policy.shouldApproveTool(baseInput({ toolRisk: 'plan' })).kind).toBe('allow');
  });

  it('should require approval for execute_code', () => {
    const result = policy.shouldApproveTool(baseInput({ toolRisk: 'execute_code' }));
    expect(result.kind).toBe('need_tool_approval');
  });

  it('should require approval for network tools', () => {
    const result = policy.shouldApproveTool(baseInput({ toolRisk: 'network' }));
    expect(result.kind).toBe('need_tool_approval');
  });

  it('should require approval for networked version-control mutations', () => {
    const result = policy.shouldApproveTool(
      baseInput({ toolRisk: 'vcs_mutation', effects: { network: true } }),
    );
    expect(result.kind).toBe('need_tool_approval');
  });

  it('should deny destructive tools', () => {
    const result = policy.shouldApproveTool(baseInput({ toolRisk: 'destructive' }));
    expect(result.kind).toBe('deny');
  });

  it('should not use auto-review', () => {
    expect(policy.shouldAutoReview(baseInput()).kind).toBe('allow');
  });

  it('should not continue loop', () => {
    expect(policy.shouldContinueLoop(baseInput()).kind).toBe('stop');
  });
});

// ── Factory ──

describe('createModePolicy', () => {
  it('should return auto mode policy', () => {
    const policy = createModePolicy('auto');
    expect(policy.name).toBe('auto-mode');
  });

  it('limits auto mode to the conservative allowlist without a sandbox', () => {
    const policy = createModePolicy('auto', false);
    expect(
      policy.shouldApproveTool(baseInput({ interactionMode: 'auto', toolRisk: 'execute_code' }))
        .kind,
    ).toBe('need_tool_approval');
    expect(
      policy.shouldApproveTool(baseInput({ interactionMode: 'auto', toolRisk: 'read' })).kind,
    ).toBe('allow');
    expect(
      policy.shouldApproveTool(baseInput({ interactionMode: 'auto', toolRisk: 'write_file' })).kind,
    ).toBe('allow');
  });

  it('should return full mode policy', () => {
    const policy = createModePolicy('full', true);
    expect(policy.name).toBe('full-mode');
  });

  it('should return fallback for full mode without sandbox', () => {
    const policy = createModePolicy('full', false);
    expect(policy.name).toContain('no-sandbox');
  });

  it('should return accept-edits mode policy', () => {
    const policy = createModePolicy('accept_edits');
    expect(policy.name).toBe('accept-edits');
  });
});

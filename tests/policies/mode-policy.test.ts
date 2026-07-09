import { describe, expect, it } from 'bun:test';
import {
  createAskModePolicy,
  createAutoModePolicy,
  createFullModePolicy,
  createModePolicy,
} from '@/core/policies/mode-policy';
import type { PolicyInput } from '@/core/policies/runtime-policy';

// ── Test input builders ──

function baseInput(overrides?: Partial<PolicyInput>): PolicyInput {
  return {
    interactionMode: 'ask',
    phase: 'building',
    planKind: 'none',
    ...overrides,
  };
}

// ── Ask Mode ──

describe('createAskModePolicy', () => {
  const policy = createAskModePolicy();

  it('should ask user (allow ask_user)', () => {
    expect(policy.shouldAskUser(baseInput()).kind).toBe('allow');
  });

  it('should require plan review when plan is drafted', () => {
    const result = policy.shouldReviewPlan(baseInput({ planKind: 'drafted' }));
    expect(result.kind).toBe('need_plan_review');
  });

  it('should allow when no plan exists', () => {
    expect(policy.shouldReviewPlan(baseInput({ planKind: 'none' })).kind).toBe('allow');
  });

  it('should allow read tools', () => {
    expect(policy.shouldApproveTool(baseInput({ toolRisk: 'read' })).kind).toBe('allow');
  });

  it('should allow plan tools', () => {
    expect(policy.shouldApproveTool(baseInput({ toolRisk: 'plan' })).kind).toBe('allow');
  });

  it('should require approval for write tools', () => {
    const result = policy.shouldApproveTool(baseInput({ toolRisk: 'write_file' }));
    expect(result.kind).toBe('need_tool_approval');
  });

  it('should require approval for execute_code', () => {
    const result = policy.shouldApproveTool(baseInput({ toolRisk: 'execute_code' }));
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

  it('should always allow plan requirement (optional)', () => {
    expect(policy.shouldRequirePlan(baseInput()).kind).toBe('allow');
  });
});

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

  it('should require auto-review for write tools', () => {
    const result = policy.shouldApproveTool(
      baseInput({ interactionMode: 'auto', toolRisk: 'write_file' }),
    );
    expect(result.kind).toBe('need_auto_review');
  });

  it('should allow read tools without auto-review', () => {
    expect(
      policy.shouldApproveTool(baseInput({ interactionMode: 'auto', toolRisk: 'read' })).kind,
    ).toBe('allow');
  });

  it('should allow cached approvals directly', () => {
    const result = policy.shouldApproveTool(
      baseInput({ interactionMode: 'auto', toolRisk: 'write_file', approvalCached: true }),
    );
    expect(result.kind).toBe('allow');
  });

  it('should fall back to manual approval when circuit breaker tripped', () => {
    const result = policy.shouldApproveTool(
      baseInput({ interactionMode: 'auto', toolRisk: 'write_file', circuitBreakerTripped: true }),
    );
    expect(result.kind).toBe('need_tool_approval');
  });

  it('should enable auto-review for non-destructive tools that need approval', () => {
    const result = policy.shouldAutoReview(
      baseInput({ interactionMode: 'auto', toolRisk: 'write_file' }),
    );
    expect(result.kind).toBe('need_auto_review');
  });

  it('should not auto-review read tools', () => {
    expect(
      policy.shouldAutoReview(baseInput({ interactionMode: 'auto', toolRisk: 'read' })).kind,
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

// ── Factory ──

describe('createModePolicy', () => {
  it('should return ask mode policy', () => {
    const policy = createModePolicy('ask');
    expect(policy.name).toBe('ask-mode');
  });

  it('should return auto mode policy', () => {
    const policy = createModePolicy('auto');
    expect(policy.name).toBe('auto-mode');
  });

  it('should return full mode policy', () => {
    const policy = createModePolicy('full', true);
    expect(policy.name).toBe('full-mode');
  });

  it('should return fallback for full mode without sandbox', () => {
    const policy = createModePolicy('full', false);
    expect(policy.name).toContain('no-sandbox');
  });
});

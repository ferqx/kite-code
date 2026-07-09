import { describe, expect, it } from 'bun:test';
import {
  createAutoReviewPolicy,
  createDefaultAutoReviewPolicy,
} from '@/core/policies/auto-review-policy';
import type { PolicyInput } from '@/core/policies/runtime-policy';

// ── Test helpers / 测试辅助 ──

function baseInput(overrides?: Partial<PolicyInput>): PolicyInput {
  return {
    interactionMode: 'auto',
    phase: 'building',
    planKind: 'approved',
    ...overrides,
  };
}

// ── createAutoReviewPolicy / Auto-Review 策略创建 ──

describe('createAutoReviewPolicy', () => {
  const policy = createAutoReviewPolicy();

  describe('shouldApproveTool', () => {
    // ── Read / plan tools ──
    it('allows read tools directly', () => {
      expect(policy.shouldApproveTool(baseInput({ toolRisk: 'read' })).kind).toBe('allow');
    });

    it('allows plan tools directly', () => {
      expect(policy.shouldApproveTool(baseInput({ toolRisk: 'plan' })).kind).toBe('allow');
    });

    // ── Destructive / 破坏性工具 ──
    it('denies destructive tools', () => {
      const result = policy.shouldApproveTool(baseInput({ toolRisk: 'destructive' }));
      expect(result.kind).toBe('deny');
    });

    // ── Cached approval / 已缓存审批 ──
    it('allows tools with cached approval', () => {
      const result = policy.shouldApproveTool(
        baseInput({ toolRisk: 'write_file', approvalCached: true }),
      );
      expect(result.kind).toBe('allow');
    });

    // ── Circuit breaker / 断路器 ──
    it('requires manual approval when circuit breaker is tripped', () => {
      const result = policy.shouldApproveTool(
        baseInput({ toolRisk: 'write_file', circuitBreakerTripped: true }),
      );
      expect(result.kind).toBe('need_tool_approval');
    });

    // ── Doom-loop / doom-loop 检测 ──
    it('requires manual approval when doom-loop threshold exceeded', () => {
      const result = policy.shouldApproveTool(
        baseInput({ toolRisk: 'write_file', doomLoopCount: 5 }),
      );
      expect(result.kind).toBe('need_tool_approval');
    });

    it('allows auto-review when doom-loop is below threshold', () => {
      const result = policy.shouldApproveTool(
        baseInput({ toolRisk: 'write_file', doomLoopCount: 1 }),
      );
      expect(result.kind).toBe('need_auto_review');
    });

    // ── Auto-review for write/execute tools / 写/执行工具走 auto-review ──
    it('routes write_file tools to auto-review', () => {
      const result = policy.shouldApproveTool(baseInput({ toolRisk: 'write_file' }));
      expect(result.kind).toBe('need_auto_review');
    });

    it('routes execute_code tools to auto-review', () => {
      const result = policy.shouldApproveTool(baseInput({ toolRisk: 'execute_code' }));
      expect(result.kind).toBe('need_auto_review');
    });

    it('routes network tools to auto-review', () => {
      const result = policy.shouldApproveTool(baseInput({ toolRisk: 'network' }));
      expect(result.kind).toBe('need_auto_review');
    });

    it('routes vcs_mutation tools to auto-review', () => {
      const result = policy.shouldApproveTool(baseInput({ toolRisk: 'vcs_mutation' }));
      expect(result.kind).toBe('need_auto_review');
    });

    it('routes mcp tools to auto-review', () => {
      const result = policy.shouldApproveTool(baseInput({ toolRisk: 'mcp' }));
      expect(result.kind).toBe('need_auto_review');
    });

    it('routes unknown risk tools to auto-review (conservative)', () => {
      const result = policy.shouldApproveTool(baseInput({ toolRisk: 'unknown' }));
      expect(result.kind).toBe('need_auto_review');
    });
  });

  describe('shouldAutoReview', () => {
    // ── Read / plan tools ──
    it('allows read tools (no auto-review needed)', () => {
      expect(policy.shouldAutoReview(baseInput({ toolRisk: 'read' })).kind).toBe('allow');
    });

    it('allows plan tools (no auto-review needed)', () => {
      expect(policy.shouldAutoReview(baseInput({ toolRisk: 'plan' })).kind).toBe('allow');
    });

    // ── Destructive / 破坏性 ──
    it('allows destructive tools (no auto-review, denied by shouldApproveTool)', () => {
      expect(policy.shouldAutoReview(baseInput({ toolRisk: 'destructive' })).kind).toBe('allow');
    });

    // ── Circuit breaker / 断路器 ──
    it('skips auto-review when circuit breaker is tripped', () => {
      const result = policy.shouldAutoReview(
        baseInput({ toolRisk: 'write_file', circuitBreakerTripped: true }),
      );
      expect(result.kind).toBe('allow');
    });

    // ── Doom-loop / doom-loop ──
    it('skips auto-review when doom-loop threshold exceeded', () => {
      const result = policy.shouldAutoReview(
        baseInput({ toolRisk: 'write_file', doomLoopCount: 5 }),
      );
      expect(result.kind).toBe('allow');
    });

    // ── Auto-review needed / 需要 auto-review ──
    it('requests auto-review for write_file tools', () => {
      const result = policy.shouldAutoReview(baseInput({ toolRisk: 'write_file' }));
      expect(result.kind).toBe('need_auto_review');
    });

    it('requests auto-review for execute_code tools', () => {
      const result = policy.shouldAutoReview(baseInput({ toolRisk: 'execute_code' }));
      expect(result.kind).toBe('need_auto_review');
    });
  });

  describe('shouldContinueLoop', () => {
    it('returns stop (loop mode not supported)', () => {
      expect(policy.shouldContinueLoop(baseInput()).kind).toBe('stop');
    });
  });

  describe('pass-through methods', () => {
    it('shouldRequirePlan delegates with allow', () => {
      expect(policy.shouldRequirePlan(baseInput()).kind).toBe('allow');
    });

    it('shouldReviewPlan delegates with allow', () => {
      expect(policy.shouldReviewPlan(baseInput()).kind).toBe('allow');
    });

    it('shouldAskUser delegates with allow', () => {
      expect(policy.shouldAskUser(baseInput()).kind).toBe('allow');
    });
  });
});

// ── Configurable thresholds / 可配置阈值 ──

describe('auto-review policy with custom config', () => {
  it('respects custom doom-loop threshold', () => {
    const policy = createAutoReviewPolicy({ doomLoopThreshold: 2 });
    // At count 2, should trigger manual approval
    const result = policy.shouldApproveTool(
      baseInput({ toolRisk: 'write_file', doomLoopCount: 2 }),
    );
    expect(result.kind).toBe('need_tool_approval');
  });

  it('allows auto-review below custom doom-loop threshold', () => {
    const policy = createAutoReviewPolicy({ doomLoopThreshold: 10 });
    const result = policy.shouldApproveTool(
      baseInput({ toolRisk: 'write_file', doomLoopCount: 5 }),
    );
    expect(result.kind).toBe('need_auto_review');
  });

  it('includes failOpen in auto-review reason', () => {
    const policy = createAutoReviewPolicy({ failOpen: true });
    const result = policy.shouldAutoReview(baseInput({ toolRisk: 'write_file' }));
    expect(result.kind).toBe('need_auto_review');
    if (result.kind === 'need_auto_review') {
      expect(result.reason).toContain('failOpen: true');
    }
  });
});

// ── Default factory / 默认工厂 ──

describe('createDefaultAutoReviewPolicy', () => {
  it('creates a valid policy with defaults', () => {
    const policy = createDefaultAutoReviewPolicy();
    expect(policy.name).toBe('auto-review');
    expect(policy.shouldApproveTool(baseInput({ toolRisk: 'read' })).kind).toBe('allow');
    expect(policy.shouldApproveTool(baseInput({ toolRisk: 'destructive' })).kind).toBe('deny');
  });
});

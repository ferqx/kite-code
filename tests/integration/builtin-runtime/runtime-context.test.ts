import { describe, expect, test } from 'bun:test';
import {
  buildCacheableRuntimeContext,
  buildRuntimeContext,
  buildRuntimeModeSnapshot,
  humanMessage,
} from '@kite-ai/builtin-runtime/model';
import { currentPlanDocument } from '../../helpers/current-plan';

// 测试运行时上下文构建函数 / Test runtime context building function
describe('buildRuntimeContext', () => {
  // 验证 read-only 访问下运行时上下文只包含稳定访问策略信息 / Verify read-only access runtime context only includes stable access policy
  test('includes concise workspace access policy under read-only access without identity noise', () => {
    const context = buildRuntimeContext({
      workspace: 'D:\\workspace',
      messages: [humanMessage('/plan please inspect the repo')],
      workspaceAccess: 'write',
      now: new Date('2026-04-23T12:34:56.000Z'),
      timezone: 'Asia/Shanghai',
    });

    expect(context).toContain('Time: 2026-04-23T12:34:56.000Z');
    expect(context).toContain('Timezone: Asia/Shanghai');
    expect(context).toContain('OS:');
    expect(context).toContain('Shell:');
    expect(context).toContain('Workspace: D:\\workspace');
    expect(context.length).toBeLessThan(1200);
  });

  // 验证 write 访问下运行时上下文包含合并后的访问策略信息 / Verify write access runtime context includes combined access policy
  test('includes concise workspace access policy under write access', () => {
    const context = buildRuntimeContext({
      workspace: 'D:\\workspace',
      messages: [humanMessage('please continue')],
      workspaceAccess: 'write',
      now: new Date('2026-04-23T12:34:56.000Z'),
      timezone: 'Asia/Shanghai',
    });

    expect(context).toContain('Workspace: D:\\workspace');
  });

  // 验证可缓存运行时上下文仅接受 workspace 参数，防止注入动态状态破坏 provider 前缀缓存 / Verify cacheable runtime context only accepts workspace, preventing injection of dynamic state
  test('keeps cacheable runtime context stable across calls with same workspace', () => {
    const ctx1 = buildCacheableRuntimeContext({ workspace: 'D:\\workspace' });
    const ctx2 = buildCacheableRuntimeContext({ workspace: 'D:\\workspace' });

    expect(ctx1).toBe(ctx2);
    expect(ctx1).toContain('Cacheable runtime context:');
    expect(ctx1).toContain('OS:');
    expect(ctx1).toContain('Shell:');
    expect(ctx1).toContain('Workspace: D:\\workspace');
    expect(ctx1).not.toContain('Time:');
    expect(ctx1).not.toContain('Timezone:');
  });

  test('formats dynamic mode snapshot with planningState', () => {
    const snapshot = buildRuntimeModeSnapshot({
      phase: 'planning',
      interactionMode: 'auto',
      sandboxBackend: 'seatbelt',
      planningState: {
        kind: 'planning_draft',
        document: currentPlanDocument({
          planId: 'p1',
          version: 2,
          title: 'Test Plan',
          bodyMarkdown: 'A test plan.',
          steps: [{ id: 's1', title: 'Step 1', status: 'pending' }],
          structuralDigest: 'abc123def456',
          createdAtTurnId: 't0',
          updatedAtTurnId: 't0',
        }),
      },
    });

    expect(snapshot).toContain('<runtime-state source="runtime.kernel">');
    expect(snapshot).toContain('phase: planning');
    expect(snapshot).toContain('interaction_mode: auto');
    expect(snapshot).toContain('sandbox_backend: seatbelt');
    expect(snapshot).toContain('plan_id: p1');
    expect(snapshot).toContain('version: 2');
    expect(snapshot).toContain('write_plan_allowed: true');
    expect(snapshot).toContain('write_plan_submit_allowed: true');

    const cacheable = buildCacheableRuntimeContext({ workspace: 'D:\\workspace' });
    expect(cacheable).not.toContain('Phase:');
    expect(cacheable).not.toContain('Authorization:');
    expect(cacheable).not.toContain('Sandbox backend:');
  });
});

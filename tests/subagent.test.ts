// tests/subagent.test.ts
import { describe, expect, it } from 'bun:test';
import { BUILTIN_ROLES, getRoleConfig } from '@/core/subagent/roles';

describe('内置角色定义', () => {
  it('应包含 4 个角色', () => {
    expect(BUILTIN_ROLES).toHaveLength(4);
    expect(BUILTIN_ROLES).toContain('explore');
    expect(BUILTIN_ROLES).toContain('plan');
    expect(BUILTIN_ROLES).toContain('code');
    expect(BUILTIN_ROLES).toContain('review');
  });

  it('explore 角色应有只读工具集', () => {
    const config = getRoleConfig('explore');
    expect(config.allowedTools).toBeDefined();
    expect(config.allowedTools?.has('read_file')).toBe(true);
    expect(config.allowedTools?.has('edit_file')).toBe(false);
    expect(config.allowedTools?.has('write_file')).toBe(false);
  });

  it('code 角色应有全部工具', () => {
    const config = getRoleConfig('code');
    expect(config.allowedTools).toBeUndefined();
  });

  it('plan 角色应有只读工具集和 10 分钟超时', () => {
    const config = getRoleConfig('plan');
    expect(config.allowedTools).toBeDefined();
    expect(config.allowedTools?.has('read_file')).toBe(true);
    expect(config.allowedTools?.has('edit_file')).toBe(false);
    expect(config.allowedTools?.has('write_file')).toBe(false);
    expect(config.allowedTools?.has('task')).toBe(false);
    expect(config.timeoutMs).toBe(10 * 60 * 1000);
  });

  it('review 角色应有只读工具集', () => {
    const config = getRoleConfig('review');
    expect(config.allowedTools).toBeDefined();
    expect(config.allowedTools?.has('read_file')).toBe(true);
    expect(config.allowedTools?.has('edit_file')).toBe(false);
  });

  it('所有角色的 system prompt 应非空', () => {
    for (const role of BUILTIN_ROLES) {
      const config = getRoleConfig(role);
      expect(config.systemPrompt.length).toBeGreaterThan(100);
    }
  });

  it('getRoleConfig 应返回独立的副本（非共享引用）', () => {
    const cfg1 = getRoleConfig('explore');
    const cfg2 = getRoleConfig('explore');
    expect(cfg1.allowedTools).not.toBe(cfg2.allowedTools);
  });
});

describe('SubAgentRole 类型', () => {
  it('应与 protocol 层类型一致', () => {
    const roles: string[] = [...BUILTIN_ROLES];
    expect(roles).toEqual(['explore', 'plan', 'code', 'review']);
  });
});

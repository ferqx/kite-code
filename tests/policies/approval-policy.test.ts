import { describe, expect, it } from 'bun:test';
import {
  commandGrantKey,
  hasSameCommandGrant,
  normalizeAuthorizationState,
  stableStringify,
} from '@/core/harness/tool-policy';
import {
  classifyShellRisk,
  type EvaluateToolApprovalParams,
  evaluateToolApproval,
  isDestructiveShellCommand,
} from '@/core/policies/approval-policy';

// ── Test helpers / 测试辅助 ──

function baseParams(overrides?: Partial<EvaluateToolApprovalParams>): EvaluateToolApprovalParams {
  return {
    toolName: 'shell_execute',
    toolArgs: { command: 'echo hello' },
    phase: 'building',
    workspace: '/tmp/test',
    threadId: 'thread-1',
    ...overrides,
  };
}

// ── classifyShellRisk / 命令风险分类 ──

describe('classifyShellRisk', () => {
  // Note: classifyShellRisk does NOT check for read-only — that's done
  // inside evaluateToolApproval via isReadOnlyShellCommand.
  // classifyShellRisk 只做风险分类，不判断只读（由 evaluateToolApproval 内部处理）。
  it('classifies unknown shell commands as execute_code', () => {
    expect(classifyShellRisk('ls -la')).toBe('execute_code');
  });

  it('classifies destructive commands as destructive', () => {
    expect(classifyShellRisk('rm -rf /tmp/foo')).toBe('destructive');
  });

  it('classifies git mutations as vcs_mutation', () => {
    expect(classifyShellRisk('git push origin main')).toBe('vcs_mutation');
  });

  it('classifies file writes as write_file', () => {
    expect(classifyShellRisk('cp file1 file2')).toBe('write_file');
  });

  it('classifies network commands as network', () => {
    expect(classifyShellRisk('curl https://example.com')).toBe('network');
  });

  it('classifies unknown commands as execute_code', () => {
    expect(classifyShellRisk('node script.js')).toBe('execute_code');
  });
});

// ── isDestructiveShellCommand / 破坏性命令检测 ──

describe('isDestructiveShellCommand', () => {
  it('detects rm -rf', () => {
    expect(isDestructiveShellCommand('rm -rf /')).toBe(true);
  });

  it('detects sudo commands', () => {
    expect(isDestructiveShellCommand('sudo rm file')).toBe(true);
  });

  it('detects chmod recursive', () => {
    expect(isDestructiveShellCommand('chmod -R 777 /')).toBe(true);
  });

  it('allows normal ls', () => {
    expect(isDestructiveShellCommand('ls -la')).toBe(false);
  });

  it('allows echo', () => {
    expect(isDestructiveShellCommand('echo hello')).toBe(false);
  });

  it('detects dd to /dev/', () => {
    expect(isDestructiveShellCommand('dd if=/dev/zero of=/dev/sda')).toBe(true);
  });

  it('detects mkfs', () => {
    expect(isDestructiveShellCommand('mkfs.ext4 /dev/sda1')).toBe(true);
  });

  it('detects shutdown', () => {
    expect(isDestructiveShellCommand('shutdown now')).toBe(true);
  });

  it('detects fork bomb pattern', () => {
    expect(isDestructiveShellCommand(':(){ :|:& };:')).toBe(true);
  });
});

// ── stableStringify / 确定性序列化 ──

describe('stableStringify', () => {
  it('stable-serializes objects with sorted keys', () => {
    const a = stableStringify({ b: 2, a: 1 });
    const b2 = stableStringify({ a: 1, b: 2 });
    expect(a).toBe(b2);
  });

  it('stable-serializes nested objects', () => {
    expect(stableStringify({ z: { b: 1, a: 2 }, x: 3 })).toBe(
      stableStringify({ x: 3, z: { a: 2, b: 1 } }),
    );
  });
});

// ── commandGrantKey / same_command 授权 key ──

describe('commandGrantKey', () => {
  it('generates same key for same input', () => {
    const k1 = commandGrantKey({ workspace: '/ws', threadId: 't1', command: 'ls' });
    const k2 = commandGrantKey({ workspace: '/ws', threadId: 't1', command: 'ls' });
    expect(k1).toBe(k2);
  });

  it('generates different keys for different commands', () => {
    const k1 = commandGrantKey({ workspace: '/ws', threadId: 't1', command: 'ls' });
    const k2 = commandGrantKey({ workspace: '/ws', threadId: 't1', command: 'rm' });
    expect(k1).not.toBe(k2);
  });
});

// ── normalizeAuthorizationState / 授权状态规范化 ──

describe('normalizeAuthorizationState', () => {
  it('defaults null to default mode', () => {
    expect(normalizeAuthorizationState(null).mode).toBe('default');
  });

  it('preserves full_access mode', () => {
    expect(normalizeAuthorizationState({ mode: 'full_access', commandGrants: {} }).mode).toBe(
      'full_access',
    );
  });

  it('adds empty commandGrants if missing', () => {
    const result = normalizeAuthorizationState({ mode: 'default', commandGrants: {} });
    expect(result).toEqual({ mode: 'default', commandGrants: {} });
  });
});

// ── hasSameCommandGrant / same_command 授权检查 ──

describe('hasSameCommandGrant', () => {
  it('returns true for matching grant', () => {
    const key = commandGrantKey({ workspace: '/ws', threadId: 't1', command: 'npm test' });
    const auth = {
      mode: 'default' as const,
      commandGrants: {
        [key]: { workspace: '/ws', threadId: 't1', command: 'npm test' },
      },
    };
    expect(
      hasSameCommandGrant(auth, { workspace: '/ws', threadId: 't1', command: 'npm test' }),
    ).toBe(true);
  });

  it('returns false for mismatched command', () => {
    const key = commandGrantKey({ workspace: '/ws', threadId: 't1', command: 'npm test' });
    const auth = {
      mode: 'default' as const,
      commandGrants: {
        [key]: { workspace: '/ws', threadId: 't1', command: 'npm test' },
      },
    };
    expect(hasSameCommandGrant(auth, { workspace: '/ws', threadId: 't1', command: 'other' })).toBe(
      false,
    );
  });
});

// ── evaluateToolApproval / 工具审批评估 ──

describe('evaluateToolApproval', () => {
  // ── Read tools / 只读工具 ──
  describe('read tools', () => {
    it('allows read_file', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'read_file', toolArgs: { path: '/f' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.decision).toBe('allow');
      expect(result.risk).toBe('read');
    });

    it('allows search_content', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'search_content', toolArgs: { pattern: 'foo' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it('allows search_files', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'search_files', toolArgs: { pattern: '*.ts' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });
  });

  // ── Plan tools / 计划工具 ──
  describe('plan tools', () => {
    it('allows update_plan', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'update_plan', toolArgs: { plan: {} } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.risk).toBe('plan');
    });

    it('allows ask_user', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'ask_user', toolArgs: { question: 'what?' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.risk).toBe('plan');
    });
  });

  // ── Shell commands / Shell 命令 ──
  describe('shell_execute', () => {
    it('allows read-only shell commands directly', () => {
      const result = evaluateToolApproval(baseParams({ toolArgs: { command: 'ls -la' } }));
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.risk).toBe('read');
    });

    it('requires approval for write-like shell commands', () => {
      const result = evaluateToolApproval(baseParams({ toolArgs: { command: 'cp a b' } }));
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
    });

    it('denies destructive shell commands', () => {
      const result = evaluateToolApproval(baseParams({ toolArgs: { command: 'rm -rf /tmp' } }));
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('deny');
      expect(result.risk).toBe('destructive');
    });

    it('denies empty shell commands', () => {
      const result = evaluateToolApproval(baseParams({ toolArgs: { command: '' } }));
      expect(result.allowed).toBe(false);
    });

    it('allows network-aware shell with approval', () => {
      const result = evaluateToolApproval(
        baseParams({ toolArgs: { command: 'curl example.com' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.risk).toBe('network');
    });
  });

  // ── Write tools / 写工具 ──
  describe('write_file / edit_file', () => {
    it('requires approval for write_file in building phase', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'write_file', toolArgs: { path: '/tmp/f' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.risk).toBe('write_file');
    });

    it('requires approval for edit_file', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'edit_file', toolArgs: { path: '/tmp/f' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
    });

    it('denies write_file during planning phase', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'write_file', toolArgs: { path: '/tmp/f' }, phase: 'planning' }),
      );
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('deny');
    });
  });

  // ── web_fetch / 网络请求 ──
  describe('web_fetch', () => {
    it('allows valid web_fetch URLs', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'web_fetch', toolArgs: { url: 'https://example.com' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it('denies URLs with embedded credentials', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'web_fetch',
          toolArgs: { url: 'https://user:pass@example.com' },
        }),
      );
      expect(result.allowed).toBe(false);
    });

    it('denies URLs with token in query string', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'web_fetch',
          toolArgs: { url: 'https://example.com?token=abcdef123456789012345' },
        }),
      );
      expect(result.allowed).toBe(false);
    });

    it('denies invalid URLs', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'web_fetch', toolArgs: { url: 'not-a-url' } }),
      );
      expect(result.allowed).toBe(false);
    });
  });

  // ── Authorization / 授权 ──
  describe('authorization', () => {
    it('allows write_file under full_access without approval', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'write_file',
          toolArgs: { path: '/tmp/f' },
          authorization: { mode: 'full_access', commandGrants: {} },
        }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.grantUsed).toBe('full_access');
    });

    it('allows shell under same_command grant', () => {
      const key = commandGrantKey({
        workspace: '/tmp/test',
        threadId: 'thread-1',
        command: 'npm test',
      });
      const result = evaluateToolApproval(
        baseParams({
          toolArgs: { command: 'npm test' },
          authorization: {
            mode: 'default',
            commandGrants: {
              [key]: { workspace: '/tmp/test', threadId: 'thread-1', command: 'npm test' },
            },
          },
        }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.grantUsed).toBe('same_command');
    });

    it('still denies destructive commands under full_access', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolArgs: { command: 'rm -rf /' },
          authorization: { mode: 'full_access', commandGrants: {} },
        }),
      );
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('deny');
    });

    it('denies non-read shell during planning phase regardless of auth', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolArgs: { command: 'npm test' },
          phase: 'planning',
          authorization: { mode: 'full_access', commandGrants: {} },
        }),
      );
      expect(result.allowed).toBe(false);
    });
  });

  // ── Sub-agent / 子 agent ──
  describe('task (sub-agent)', () => {
    it('allows explore sub-agent in planning phase', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'task',
          toolArgs: { subagent_type: 'explore', description: 'search' },
          phase: 'planning',
        }),
      );
      expect(result.allowed).toBe(true);
    });

    it('denies non-read sub-agent in planning phase', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'task',
          toolArgs: { subagent_type: 'general-purpose', description: 'fix' },
          phase: 'planning',
        }),
      );
      expect(result.allowed).toBe(false);
    });
  });

  // ── MCP tools / MCP 工具 ──
  describe('MCP tools', () => {
    it('requires approval for MCP tools by default', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'mcp__server__tool', toolArgs: {} }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.risk).toBe('mcp');
    });

    it('allows MCP tools under full_access without approval', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'mcp__server__tool',
          toolArgs: {},
          authorization: { mode: 'full_access', commandGrants: {} },
        }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it('allows MCP tools with config risk override to read', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'mcp__server__tool',
          toolArgs: {},
          mcpRiskOverride: { server: 'read' },
        }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.risk).toBe('read');
    });
  });

  // ── read_mcp_resource / MCP 资源读取 ──
  describe('read_mcp_resource', () => {
    it('allows read_mcp_resource directly', () => {
      const result = evaluateToolApproval(
        baseParams({
          toolName: 'read_mcp_resource',
          toolArgs: { server: 'srv', uri: 'resource://x' },
        }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.risk).toBe('read');
    });
  });

  // ── Skill / 技能 ──
  describe('Skill', () => {
    it('allows Skill invocation directly', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'Skill', toolArgs: { skill: 'test' } }),
      );
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.risk).toBe('read');
    });
  });

  // ── Unknown tools / 未知工具 ──
  describe('unknown tools', () => {
    it('denies unknown tool names', () => {
      const result = evaluateToolApproval(
        baseParams({ toolName: 'nonexistent_tool', toolArgs: {} }),
      );
      expect(result.allowed).toBe(false);
      expect(result.decision).toBe('deny');
    });
  });
});

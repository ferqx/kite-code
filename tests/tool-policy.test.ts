import { describe, expect, test } from 'bun:test';
import {
  applyApprovalGrant,
  buildToolApproval,
  defaultAuthorizationState,
  evaluateToolPolicy,
  grantSameCommand,
  hashToolApprovalRequest,
  hasSameCommandGrant,
  replaceApprovalCommand,
  validateApprovalHash,
} from '../src/core/harness/tool-policy';
import type { PendingToolRequest } from '../src/core/harness/tool-requests';

const shellExecuteRequest: PendingToolRequest = {
  id: 'call-shell',
  name: 'shell_execute',
  args: { command: 'bun test' },
  reason: 'Model requested shell_execute tool call',
  protectedCommand: 'bun test',
};

// 统一工具安全策略单元测试 / Unified tool policy unit tests
describe('tool policy', () => {
  // 验证只读工具由统一策略放行且无需审批 / Read tools are allowed without approval by the unified policy
  test('allows read tools without approval', () => {
    const requests: PendingToolRequest[] = [
      {
        id: 'call-read',
        name: 'read_file',
        args: { path: 'package.json' },
        reason: 'Model requested read_file',
        protectedCommand: 'read_file package.json',
      },
      {
        id: 'call-search-content',
        name: 'search_content',
        args: { pattern: 'describe(' },
        reason: 'Model requested search_content',
        protectedCommand: 'search_content describe(',
      },
      {
        id: 'call-search-files',
        name: 'search_files',
        args: { pattern: '*.md' },
        reason: 'Model requested search_files',
        protectedCommand: 'search_files *.md',
      },
    ];

    for (const request of requests) {
      const decision = evaluateToolPolicy({
        request,
        workspaceAccess: 'write',
        phase: 'planning',
      });

      expect(decision.allowed).toBe(true);
      expect(decision.requiresApproval).toBe(false);
      expect(decision.risk).toBe('read');
    }
  });

  // 验证普通 shell_execute 执行项目代码时需要审批 / shell_execute commands that run project code require approval
  test('requires approval for normal shell execution under building phase', () => {
    const decision = evaluateToolPolicy({
      request: shellExecuteRequest,
      workspaceAccess: 'write',
      phase: 'building',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.risk).toBe('execute_code');
    expect(decision.userVisibleSummary).toContain('bun test');
    expect(decision.expectedEffects).toContain('Executes local project code');
  });

  // 验证只读 shell_execute 命令按命令风险直通，不再只按工具名审批 / Read-only shell_execute commands are classified by command risk
  test('allows read-only shell_execute commands without approval', () => {
    const decision = evaluateToolPolicy({
      request: {
        ...shellExecuteRequest,
        args: { command: 'git status --short' },
        protectedCommand: 'git status --short',
      },
      workspaceAccess: 'write',
      phase: 'building',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.risk).toBe('read');
  });

  // 验证规划阶段拒绝执行类工具，即使工作区访问权限错误地为 write / Planning phase rejects execution tools even if workspace access is write
  test('rejects shell execution during planning phase', () => {
    const decision = evaluateToolPolicy({
      request: shellExecuteRequest,
      workspaceAccess: 'write',
      phase: 'planning',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.risk).toBe('execute_code');
    expect(decision.reason).toContain('planning phase');
  });

  // 验证高危命令默认拒绝，不进入普通审批 / High-risk shell commands are denied instead of routed to normal approval
  test('denies destructive shell execution by default', () => {
    const decision = evaluateToolPolicy({
      request: {
        ...shellExecuteRequest,
        args: { command: 'sudo rm -rf /' },
        protectedCommand: 'sudo rm -rf /',
      },
      workspaceAccess: 'write',
      phase: 'building',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.risk).toBe('destructive');
  });

  // 验证 same_command 授权命中后，同一 thread/workspace 的同一命令不再审批 / same_command grants bypass approval for the exact command in the same thread and workspace
  test('allows same-command shell execution without approval after a command grant', () => {
    const authorization = grantSameCommand(defaultAuthorizationState(), {
      workspace: '/tmp/project',
      threadId: 'thread-a',
      command: 'bun test',
    });
    const decision = evaluateToolPolicy({
      request: shellExecuteRequest,
      workspaceAccess: 'write',
      phase: 'building',
      workspace: '/tmp/project',
      threadId: 'thread-a',
      authorization,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.grantUsed).toBe('same_command');
  });

  // 验证 same_command 只看 command.trim()，不受模型解释字段变化影响 / same_command matching ignores objective and justification changes
  test('same-command grant ignores shell action metadata changes', () => {
    const authorization = grantSameCommand(defaultAuthorizationState(), {
      workspace: '/tmp/project',
      threadId: 'thread-a',
      command: 'bun test',
    });
    const decision = evaluateToolPolicy({
      request: {
        ...shellExecuteRequest,
        args: {
          command: '  bun test  ',
          objective: '重新验证修改后的行为',
          justification: '同一个命令，但解释文本不同。',
          prefix_rule: ['bun', 'test'],
        },
      },
      workspaceAccess: 'write',
      phase: 'building',
      workspace: '/tmp/project',
      threadId: 'thread-a',
      authorization,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.grantUsed).toBe('same_command');
  });

  // 验证不同命令不会命中 same_command 授权 / Different commands do not match a same_command grant
  test('does not apply same-command grant to a different command', () => {
    const authorization = grantSameCommand(defaultAuthorizationState(), {
      workspace: '/tmp/project',
      threadId: 'thread-a',
      command: 'bun test',
    });
    const decision = evaluateToolPolicy({
      request: {
        ...shellExecuteRequest,
        args: { command: 'bun run typecheck' },
        protectedCommand: 'bun run typecheck',
      },
      workspaceAccess: 'write',
      phase: 'building',
      workspace: '/tmp/project',
      threadId: 'thread-a',
      authorization,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.grantUsed).toBe('none');
  });

  // 验证 full_access 当前 thread 内允许非 destructive 的 shell_execute / full_access allows non-destructive shell commands
  test('allows shell execution risk classes under full access', () => {
    const authorization = applyApprovalGrant({
      authorization: defaultAuthorizationState(),
      grant: 'full_access',
      workspace: '/tmp/project',
      threadId: 'thread-a',
      request: shellExecuteRequest,
    });

    for (const command of ['bun test', 'echo hi > hello.txt', 'git add -A']) {
      const decision = evaluateToolPolicy({
        request: {
          ...shellExecuteRequest,
          args: { command },
          protectedCommand: command,
        },
        workspaceAccess: 'write',
        phase: 'building',
        workspace: '/tmp/project',
        threadId: 'thread-a',
        authorization,
      });

      expect(decision.allowed).toBe(true);
      expect(decision.requiresApproval).toBe(false);
      expect(decision.grantUsed).toBe('full_access');
    }
  });

  // 验证 destructive 命令在 full_access 下仍然被拒绝 / destructive commands are denied even under full_access
  test('denies destructive commands even under full access', () => {
    const authorization = applyApprovalGrant({
      authorization: defaultAuthorizationState(),
      grant: 'full_access',
      workspace: '/tmp/project',
      threadId: 'thread-a',
      request: shellExecuteRequest,
    });

    const decision = evaluateToolPolicy({
      request: {
        ...shellExecuteRequest,
        args: { command: 'sudo rm -rf /' },
        protectedCommand: 'sudo rm -rf /',
      },
      workspaceAccess: 'write',
      phase: 'building',
      workspace: '/tmp/project',
      threadId: 'thread-a',
      authorization,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.risk).toBe('destructive');
    expect(decision.grantUsed).toBe('none');
  });

  // 验证 destructive 命令在 same_command grant 下仍然被拒绝 / destructive commands are denied even with same_command grant
  test('denies destructive commands even with same_command grant', () => {
    const authorization = grantSameCommand(defaultAuthorizationState(), {
      workspace: '/tmp/project',
      threadId: 'thread-a',
      command: 'sudo rm -rf /',
    });

    const decision = evaluateToolPolicy({
      request: {
        ...shellExecuteRequest,
        args: { command: 'sudo rm -rf /' },
        protectedCommand: 'sudo rm -rf /',
      },
      workspaceAccess: 'write',
      phase: 'building',
      workspace: '/tmp/project',
      threadId: 'thread-a',
      authorization,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.risk).toBe('destructive');
    expect(decision.grantUsed).toBe('none');
  });

  // 验证 approve_once 不写入 command grant，same_command 和 full_access 才更新 thread 授权状态 / Grant updates are explicit and thread-scoped
  test('applies approval grants to thread authorization state', () => {
    const initial = defaultAuthorizationState();
    const approveOnce = applyApprovalGrant({
      authorization: initial,
      grant: 'approve_once',
      workspace: '/tmp/project',
      threadId: 'thread-a',
      request: shellExecuteRequest,
    });
    const sameCommand = applyApprovalGrant({
      authorization: initial,
      grant: 'same_command',
      workspace: '/tmp/project',
      threadId: 'thread-a',
      request: shellExecuteRequest,
    });
    const fullAccess = applyApprovalGrant({
      authorization: initial,
      grant: 'full_access',
      workspace: '/tmp/project',
      threadId: 'thread-a',
      request: shellExecuteRequest,
    });

    expect(
      hasSameCommandGrant(approveOnce, {
        workspace: '/tmp/project',
        threadId: 'thread-a',
        command: 'bun test',
      }),
    ).toBe(false);
    expect(
      hasSameCommandGrant(sameCommand, {
        workspace: '/tmp/project',
        threadId: 'thread-a',
        command: 'bun test',
      }),
    ).toBe(true);
    expect(fullAccess.mode).toBe('full_access');
  });

  // 验证审批 payload 由 runtime 基于工具请求和策略生成 / Approval payload is generated by the runtime from request and policy
  test('builds structured approval payload from policy decision', () => {
    const decision = evaluateToolPolicy({
      request: shellExecuteRequest,
      workspaceAccess: 'write',
      phase: 'building',
    });

    const approval = buildToolApproval({
      workspace: '/tmp/project',
      threadId: 'thread-a',
      request: shellExecuteRequest,
      decision,
    });

    expect(approval).toEqual({
      scope: 'once',
      cwd: '/tmp/project',
      threadId: 'thread-a',
      tool: 'shell_execute',
      command: 'bun test',
      risk: 'execute_code',
      approvalHash: hashToolApprovalRequest({
        workspace: '/tmp/project',
        threadId: 'thread-a',
        request: shellExecuteRequest,
      }),
      summary: decision.userVisibleSummary,
      reason: decision.reason,
      expectedEffects: decision.expectedEffects,
      suggestedPrefixRule: undefined,
      grantOptions: ['approve_once', 'same_command', 'full_access'],
      recommendedGrant: 'approve_once',
    });
  });

  // 验证审批 hash 绑定到具体工具参数，避免恢复时错位执行 / Approval hash is bound to exact tool arguments
  test('hashes the exact approval request', () => {
    const first = hashToolApprovalRequest({
      workspace: '/tmp/project',
      threadId: 'thread-a',
      request: shellExecuteRequest,
    });
    const changedCommand = hashToolApprovalRequest({
      workspace: '/tmp/project',
      threadId: 'thread-a',
      request: {
        ...shellExecuteRequest,
        args: { command: 'bun test tests/graph.test.ts' },
      },
    });

    expect(validateApprovalHash({ approvalHash: first }, first)).toBe(true);
    expect(validateApprovalHash({ approvalHash: 'wrong' }, first)).toBe(false);
    expect(changedCommand).not.toBe(first);
  });

  // read_mcp_resource tool policy tests
  test('allows read_mcp_resource without approval', () => {
    const decision = evaluateToolPolicy({
      request: {
        id: 'call-mcp-resource',
        name: 'read_mcp_resource',
        args: { server: 'docs', uri: 'file:///api.md' },
        reason: 'Model requested MCP resource',
        protectedCommand: 'read_mcp_resource',
      },
      workspaceAccess: 'write',
      phase: 'building',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.risk).toBe('read');
  });

  test('allows read_mcp_resource in read-only workspace', () => {
    const decision = evaluateToolPolicy({
      request: {
        id: 'call-mcp-resource',
        name: 'read_mcp_resource',
        args: { server: 'docs', uri: 'file:///api.md' },
        reason: 'Model requested MCP resource',
        protectedCommand: 'read_mcp_resource',
      },
      workspaceAccess: 'write',
      phase: 'planning',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.risk).toBe('read');
  });

  test('allows Skill without approval', () => {
    const decision = evaluateToolPolicy({
      request: {
        name: 'Skill',
        args: { skill: 'tdd' },
        reason: 'Model requested Skill tool',
        protectedCommand: 'Skill',
      },
      workspaceAccess: 'write',
      phase: 'building',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.risk).toBe('read');
  });

  // MCP 工具策略测试 / MCP tool policy tests
  describe('MCP tools', () => {
    test('requires approval for mcp__* tools by default', () => {
      const decision = evaluateToolPolicy({
        request: {
          name: 'mcp__playwright__navigate',
          args: { url: 'https://example.com' },
          reason: 'Model requested MCP tool',
          protectedCommand: 'mcp__playwright__navigate',
        } as unknown as PendingToolRequest,
        workspaceAccess: 'write',
        phase: 'building',
      });
      expect(decision.requiresApproval).toBe(true);
      expect(decision.risk).toBe('mcp');
    });

    test('allows MCP tool with server-level risk=read override', () => {
      const decision = evaluateToolPolicy({
        request: {
          name: 'mcp__safe_reader__list',
          args: {},
          reason: 'Model requested MCP tool',
          protectedCommand: 'mcp__safe_reader__list',
        } as unknown as PendingToolRequest,
        workspaceAccess: 'write',
        phase: 'building',
        mcpRiskOverride: { safe_reader: 'read' },
      });
      expect(decision.allowed).toBe(true);
      expect(decision.requiresApproval).toBe(false);
      expect(decision.risk).toBe('read');
    });

    test('denies MCP tools in read-only workspace', () => {
      const decision = evaluateToolPolicy({
        request: {
          name: 'mcp__playwright__navigate',
          args: {},
          reason: 'Model requested MCP tool',
          protectedCommand: 'mcp__playwright__navigate',
        } as unknown as PendingToolRequest,
        workspaceAccess: 'write',
        phase: 'planning',
      });
      expect(decision.allowed).toBe(false);
    });
  });

  // 验证用户替换命令时只改当前可替换工具请求，不改变工具调用 ID / Replacement approval updates only the current command-bearing request
  test('replaces the approved command for shell-like requests', () => {
    const replaced = replaceApprovalCommand(
      shellExecuteRequest,
      'bun test tests/tool-policy.test.ts',
    );

    expect(replaced.id).toBe(shellExecuteRequest.id);
    expect(replaced.name).toBe('shell_execute');
    if (replaced.name !== 'shell_execute') {
      throw new Error('expected shell_execute');
    }
    expect(replaced.args.command).toBe('bun test tests/tool-policy.test.ts');
    expect(replaced.protectedCommand).toBe('bun test tests/tool-policy.test.ts');
  });
});

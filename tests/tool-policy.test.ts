import { describe, expect, test } from 'bun:test';
import type { AgentSessionCommandGrant } from '@kite/agent-kernel';
import { createToolApprovalBindingDigest } from '@kite/agent-kernel';
import type { PendingToolRequest } from '@kite/builtin-runtime';
import {
  type BuiltinModelToolCatalogEntry,
  type BuiltinToolCapabilityProjection,
  compileBuiltinDynamicMcpPolicy,
} from '@kite/builtin-runtime';
import type { CapabilityPolicyCompilation, RuntimeJsonValue } from '@kite/runtime-spi';
import {
  buildToolApproval,
  replaceApprovalCommand,
  validateApprovalHash,
} from '#app/bootstrap/runtime/tool-policy';
import { testBuiltinToolCatalog } from './helpers/runtime-model';

type EvaluateToolApprovalParams = {
  readonly toolName: string;
  readonly toolArgs: Record<string, unknown>;
  readonly phase: 'planning' | 'building';
  readonly workspace?: string;
  readonly threadId?: string;
  readonly interactionMode?: 'auto' | 'accept_edits' | 'full';
  readonly sessionId?: string;
  readonly canonicalWorkspaceIdentity?: string;
  readonly cwd?: string;
  readonly executor?: string;
  readonly environment?: string;
  readonly scope?: string;
  readonly effectsDigest?: string;
  readonly parserRevision?: string;
  readonly executorRevision?: string;
  readonly sessionCommandGrant?: Readonly<AgentSessionCommandGrant> | null;
  readonly mcpPolicy?: {
    readonly effects: {
      readonly filesystem: 'none' | 'read' | 'write' | 'destructive';
      readonly network: 'none' | 'read' | 'write' | 'destructive';
      readonly externalState: 'none' | 'read' | 'write' | 'destructive';
    };
    readonly minimumApproval: 'none' | 'auto_review' | 'user';
  };
  readonly capability?: BuiltinToolCapabilityProjection;
};

function commandDigest(command: string): string {
  return command.trim();
}

function grantSameCommand(input: {
  workspace: string;
  threadId: string;
  command: string;
  sessionId?: string;
  canonicalWorkspaceIdentity?: string;
  cwd?: string;
  executor?: string;
  environment?: string;
  scope?: string;
  effectsDigest?: string;
  parserRevision?: string;
  executorRevision?: string;
}): AgentSessionCommandGrant {
  return {
    grant: 'same_command',
    grantKey: 'fixture-grant',
    sessionId: input.sessionId ?? 'session-a',
    threadId: input.threadId,
    workspace: input.workspace,
    canonicalWorkspaceIdentity: input.canonicalWorkspaceIdentity ?? input.workspace,
    cwd: input.cwd ?? input.workspace,
    executor: input.executor ?? 'shell',
    environment: input.environment ?? 'env-v1',
    scope: input.scope ?? 'workspace_only',
    effects: input.effectsDigest ?? 'effects-v1',
    parserRevision: input.parserRevision ?? 'parser-v1',
    executorRevision: input.executorRevision ?? 'executor-v1',
    commandDigest: commandDigest(input.command),
    createdAt: '2026-01-01T00:00:00.000Z',
    generation: 1,
  };
}

type TestApprovalDecision = Pick<
  CapabilityPolicyCompilation,
  | 'decision'
  | 'allowed'
  | 'requiresApproval'
  | 'risk'
  | 'effects'
  | 'reason'
  | 'userVisibleSummary'
  | 'expectedEffects'
  | 'phaseConstraint'
> & {
  readonly grantUsed: 'none' | 'same_command';
};

function policyCompilationFor(params: EvaluateToolApprovalParams): CapabilityPolicyCompilation {
  const entry = testBuiltinToolCatalog().entries.find(
    (candidate): candidate is BuiltinModelToolCatalogEntry =>
      candidate.visibility === 'model' && candidate.name === params.toolName,
  );
  if (entry) {
    return entry.compilePolicy(params.toolArgs as RuntimeJsonValue, {
      workspace: params.workspace ?? '',
      threadId: params.threadId,
      phase: params.phase,
    });
  }
  const effects = params.mcpPolicy?.effects ?? {
    filesystem: 'none' as const,
    network: 'write' as const,
    externalState: 'write' as const,
  };
  return compileBuiltinDynamicMcpPolicy({
    operationId: 'mcp:dynamic_tool',
    capabilityRevision: 'test-mcp-capability-v1',
    parserRevision: 'test-mcp-parser-v1',
    exposedToolName: params.toolName as `mcp__${string}`,
    effectiveEffects: effects,
    minimumApproval: params.mcpPolicy?.minimumApproval ?? 'user',
    phase: params.phase,
    workspace: params.workspace ?? '',
  });
}

function evaluateToolApproval(params: EvaluateToolApprovalParams): TestApprovalDecision {
  const compilation = policyCompilationFor(params);
  let grantUsed: TestApprovalDecision['grantUsed'] = 'none';
  const command =
    params.toolName === 'shell_execute' && typeof params.toolArgs.command === 'string'
      ? params.toolArgs.command
      : undefined;
  const sameCommand =
    command !== undefined &&
    params.workspace !== undefined &&
    params.threadId !== undefined &&
    params.sessionCommandGrant !== undefined &&
    params.sessionCommandGrant !== null &&
    params.sessionCommandGrant.sessionId === (params.sessionId ?? '') &&
    params.sessionCommandGrant.threadId === params.threadId &&
    params.sessionCommandGrant.workspace === params.workspace &&
    params.sessionCommandGrant.canonicalWorkspaceIdentity ===
      (params.canonicalWorkspaceIdentity ?? '') &&
    params.sessionCommandGrant.cwd === (params.cwd ?? '') &&
    params.sessionCommandGrant.executor === (params.executor ?? '') &&
    params.sessionCommandGrant.environment === (params.environment ?? '') &&
    params.sessionCommandGrant.scope === (params.scope ?? '') &&
    params.sessionCommandGrant.effects === (params.effectsDigest ?? '') &&
    params.sessionCommandGrant.parserRevision === (params.parserRevision ?? '') &&
    params.sessionCommandGrant.executorRevision === (params.executorRevision ?? '') &&
    params.sessionCommandGrant.commandDigest === commandDigest(command);
  if (compilation.allowed && compilation.requiresApproval) {
    if (params.interactionMode === 'full' && compilation.fullAccessMayBypassApproval) {
      // Full is an interaction mode, never an approval grant.
      grantUsed = 'none';
    } else if (sameCommand && compilation.sameCommandMayBypassApproval) grantUsed = 'same_command';
  }
  const fullModeBypass =
    params.interactionMode === 'full' && compilation.fullAccessMayBypassApproval;
  return {
    decision: grantUsed === 'none' ? compilation.decision : 'allow',
    allowed: compilation.allowed,
    requiresApproval: compilation.requiresApproval && grantUsed === 'none' && !fullModeBypass,
    risk: compilation.risk,
    ...(compilation.effects ? { effects: compilation.effects } : {}),
    reason: compilation.reason,
    userVisibleSummary: compilation.userVisibleSummary,
    expectedEffects: compilation.expectedEffects,
    ...(compilation.phaseConstraint ? { phaseConstraint: compilation.phaseConstraint } : {}),
    grantUsed,
  };
}

const shellExecuteRequest: PendingToolRequest = {
  source: 'builtin',
  id: 'call-shell',
  name: 'shell_execute',
  args: { command: 'bun test' },
  reason: 'Model requested shell_execute tool call',
  protectedCommand: 'bun test',
};

const sameCommandIdentity = {
  sessionId: 'session-a',
  canonicalWorkspaceIdentity: '/tmp/project',
  cwd: '/tmp/project',
  executor: 'shell',
  environment: 'env-v1',
  scope: 'workspace_only',
  effectsDigest: 'effects-v1',
  parserRevision: 'parser-v1',
  executorRevision: 'executor-v1',
} as const;

const presentationApprovalBindingDigest = createToolApprovalBindingDigest(
  {
    workspace: '/tmp/project',
    threadId: 'thread-a',
    turnId: 'turn-a',
    modelMessageId: 'model-a',
    toolCallId: 'call-shell',
    exposedToolName: 'shell_execute',
    operationId: 'builtin:shell_execute',
    capabilityId: 'builtin:shell_execute',
    capabilityRevision: '1'.repeat(64),
    executorRevision: null,
    descriptorRevision: '2'.repeat(64),
    parserRevision: '3'.repeat(64),
    schemaDigest: '4'.repeat(64),
    argumentsDigest: '5'.repeat(64),
    effectiveEffectsDigest: '6'.repeat(64),
    bindingId: null,
    builtinCatalogRevision: '7'.repeat(64),
    dynamicCatalogRevision: null,
    nestedCapabilityId: null,
    nestedCapabilityRevision: null,
    nestedCatalogRevision: null,
    commandDigest: '8'.repeat(64),
  },
  {
    operationId: 'builtin:shell_execute',
    capabilityRevision: '1'.repeat(64),
    parserRevision: '3'.repeat(64),
    effectiveEffectsDigest: '6'.repeat(64),
    minimumApproval: 'user',
    fullAccessMayBypassApproval: false,
    sameCommandMayBypassApproval: false,
    decision: 'ask',
    allowed: true,
    requiresApproval: true,
    risk: 'execute_code',
    effects: { uncertainEffects: true },
    reason: 'The command requires approval.',
    expectedEffects: ['execute code'],
  },
);

// 统一工具安全策略单元测试 / Unified tool policy unit tests
describe('tool policy', () => {
  // 验证只读工具由统一策略放行且无需审批 / Read tools are allowed without approval by the unified policy
  test('allows read tools without approval', () => {
    const requests: PendingToolRequest[] = [
      {
        source: 'builtin',
        id: 'call-read',
        name: 'read_file',
        args: { path: 'package.json' },
        reason: 'Model requested read_file',
        protectedCommand: 'read_file package.json',
      },
      {
        source: 'builtin',
        id: 'call-search-content',
        name: 'search_content',
        args: { pattern: 'describe(' },
        reason: 'Model requested search_content',
        protectedCommand: 'search_content describe(',
      },
      {
        source: 'builtin',
        id: 'call-search-files',
        name: 'search_files',
        args: { pattern: '*.md' },
        reason: 'Model requested search_files',
        protectedCommand: 'search_files *.md',
      },
    ];

    for (const request of requests) {
      const decision = evaluateToolApproval({
        toolName: request.name,
        toolArgs: request.args as Record<string, unknown>,
        phase: 'planning',
        workspace: '/tmp/project',
      });

      expect(decision.allowed).toBe(true);
      expect(decision.requiresApproval).toBe(false);
      expect(decision.risk).toBe('read');
    }
  });

  test('allows the Building workspace baseline directly without a grant', () => {
    const decision = evaluateToolApproval({
      toolName: shellExecuteRequest.name,
      toolArgs: shellExecuteRequest.args as unknown as Record<string, unknown>,
      phase: 'building',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.risk).toBe('unknown');
    expect(decision.userVisibleSummary).toContain('bun test');
    expect(decision.expectedEffects).toContain('Runs inside the workspace sandbox baseline');
  });

  test('keeps baseline shell commands direct without a command allowlist', () => {
    const decision = evaluateToolApproval({
      toolName: 'shell_execute',
      toolArgs: { command: 'pwd' },
      phase: 'building',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.risk).toBe('unknown');
  });

  test('allows the Planning workspace read-only baseline directly', () => {
    for (const command of ['ls -la', 'pwd', 'rg TODO src']) {
      const decision = evaluateToolApproval({
        toolName: 'shell_execute',
        toolArgs: { command },
        phase: 'planning',
        workspace: '/tmp/project',
        threadId: 'thread-a',
      });
      expect(decision.allowed, command).toBe(true);
      expect(decision.requiresApproval, command).toBe(false);
      expect(decision.risk, command).toBe('unknown');
    }
  });

  test('keeps Planning baseline shell execution direct', () => {
    const decision = evaluateToolApproval({
      toolName: shellExecuteRequest.name,
      toolArgs: shellExecuteRequest.args as unknown as Record<string, unknown>,
      phase: 'planning',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.risk).toBe('unknown');
  });

  // 验证高危命令默认拒绝，不进入普通审批 / High-risk shell commands are denied instead of routed to normal approval
  test('denies destructive shell execution by default', () => {
    const decision = evaluateToolApproval({
      toolName: 'shell_execute',
      toolArgs: { command: 'sudo rm -rf /' },
      phase: 'building',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.risk).toBe('destructive');
  });

  // same_command is a Session grant over the complete execution identity.
  test('allows same-command shell execution without approval after a command grant', () => {
    const sessionCommandGrant = grantSameCommand({
      workspace: '/tmp/project',
      threadId: 'thread-a',
      command: 'curl https://example.com',
      ...sameCommandIdentity,
    });
    const decision = evaluateToolApproval({
      toolName: 'shell_execute',
      toolArgs: { command: 'curl https://example.com' },
      phase: 'building',
      workspace: '/tmp/project',
      threadId: 'thread-a',
      ...sameCommandIdentity,
      sessionCommandGrant,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.grantUsed).toBe('same_command');
  });

  test('same-command grant canonicalizes command whitespace but preserves other identity fields', () => {
    const sessionCommandGrant = grantSameCommand({
      workspace: '/tmp/project',
      threadId: 'thread-a',
      command: 'curl https://example.com',
      ...sameCommandIdentity,
    });
    const decision = evaluateToolApproval({
      toolName: 'shell_execute',
      toolArgs: {
        command: '  curl https://example.com  ',
      },
      phase: 'building',
      workspace: '/tmp/project',
      threadId: 'thread-a',
      ...sameCommandIdentity,
      sessionCommandGrant,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.grantUsed).toBe('same_command');
  });

  // Different commands do not match a same_command grant.
  test('does not apply same-command grant to a different command', () => {
    const sessionCommandGrant = grantSameCommand({
      workspace: '/tmp/project',
      threadId: 'thread-a',
      command: 'curl https://example.com',
      ...sameCommandIdentity,
    });
    const decision = evaluateToolApproval({
      toolName: 'shell_execute',
      toolArgs: { command: 'curl https://other.example.com' },
      phase: 'building',
      workspace: '/tmp/project',
      threadId: 'thread-a',
      ...sameCommandIdentity,
      sessionCommandGrant,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.grantUsed).toBe('none');
  });

  // Full is a mode, not a persisted approval grant.
  test('allows shell execution risk classes under Full interaction mode without a grant', () => {
    for (const command of ['echo hi > hello.txt', 'git add -A', 'bun test']) {
      const decision = evaluateToolApproval({
        toolName: 'shell_execute',
        toolArgs: { command },
        phase: 'building',
        workspace: '/tmp/project',
        threadId: 'thread-a',
        interactionMode: 'full',
      });

      expect(decision.allowed).toBe(true);
      expect(decision.requiresApproval).toBe(false);
      expect(decision.grantUsed).toBe('none');
    }
  });

  test('denies destructive commands even under Full interaction mode', () => {
    const decision = evaluateToolApproval({
      toolName: 'shell_execute',
      toolArgs: { command: 'sudo rm -rf /' },
      phase: 'building',
      workspace: '/tmp/project',
      threadId: 'thread-a',
      interactionMode: 'full',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.risk).toBe('destructive');
    expect(decision.grantUsed).toBe('none');
  });

  // Destructive commands remain hard denied even with a same_command grant.
  test('denies destructive commands even with same_command grant', () => {
    const sessionCommandGrant = grantSameCommand({
      workspace: '/tmp/project',
      threadId: 'thread-a',
      command: 'sudo rm -rf /',
      ...sameCommandIdentity,
    });

    const decision = evaluateToolApproval({
      toolName: 'shell_execute',
      toolArgs: { command: 'sudo rm -rf /' },
      phase: 'building',
      workspace: '/tmp/project',
      threadId: 'thread-a',
      ...sameCommandIdentity,
      sessionCommandGrant,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.risk).toBe('destructive');
    expect(decision.grantUsed).toBe('none');
  });

  test('approve_once is per-call and cannot create a Full or Session grant', () => {
    const decision = evaluateToolApproval({
      toolName: shellExecuteRequest.name,
      toolArgs: { command: 'curl https://example.com' },
      phase: 'building',
      workspace: '/tmp/project',
      threadId: 'thread-a',
      interactionMode: 'accept_edits',
    });
    expect(decision.requiresApproval).toBe(true);
    expect(decision.grantUsed).toBe('none');
  });

  // 验证审批 payload 由 runtime 基于工具请求和策略生成 / Approval payload is generated by the runtime from request and policy
  test('builds structured approval payload from policy decision', () => {
    const decision = evaluateToolApproval({
      toolName: shellExecuteRequest.name,
      toolArgs: shellExecuteRequest.args as unknown as Record<string, unknown>,
      phase: 'building',
    });

    const approval = buildToolApproval({
      workspace: '/tmp/project',
      threadId: 'thread-a',
      request: shellExecuteRequest,
      decision,
      approvalBindingDigest: presentationApprovalBindingDigest,
    });

    expect(approval).toEqual({
      scope: 'once',
      callId: 'call-shell',
      cwd: '/tmp/project',
      threadId: 'thread-a',
      tool: 'shell_execute',
      command: 'bun test',
      risk: 'unknown',
      approvalHash: presentationApprovalBindingDigest,
      summary: 'Approve a shell command',
      reason: decision.reason,
      expectedEffects: decision.expectedEffects,
      grantOptions: ['approve_once', 'same_command'],
      recommendedGrant: 'approve_once',
    });
  });

  test('keeps shell approval summaries bounded and separate from exact commands', () => {
    const command = `bun test ${'packages/runtime/'.repeat(40)}`;
    const request: PendingToolRequest = {
      ...shellExecuteRequest,
      args: { command },
      protectedCommand: command,
    };
    const decision = evaluateToolApproval({
      toolName: request.name,
      toolArgs: request.args as unknown as Record<string, unknown>,
      phase: 'building',
    });
    const approval = buildToolApproval({
      workspace: '/tmp/project',
      threadId: 'thread-a',
      request,
      decision,
      approvalBindingDigest: presentationApprovalBindingDigest,
    });

    expect(approval.command).toBe(command);
    expect(approval.summary).toBe('Approve a shell command');
    expect(approval.summary).not.toContain(command);
    expect(approval.summary.length).toBeLessThanOrEqual(256);
  });

  test('validates the exact Kernel-supplied approval binding', () => {
    const binding = 'a'.repeat(64);
    expect(validateApprovalHash({ approvalHash: binding }, binding)).toBe(true);
    expect(validateApprovalHash({ approvalHash: 'wrong' }, binding)).toBe(false);
  });

  // read_mcp_resource tool policy tests
  test('marks externally managed MCP resources without a base approval requirement', () => {
    const decision = evaluateToolApproval({
      toolName: 'read_mcp_resource',
      toolArgs: { server: 'docs', uri: 'file:///api.md' },
      phase: 'building',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.risk).toBe('read');
    expect(decision.effects).toBeUndefined();
  });

  test('keeps MCP resource reads available in planning', () => {
    const decision = evaluateToolApproval({
      toolName: 'read_mcp_resource',
      toolArgs: { server: 'docs', uri: 'file:///api.md' },
      phase: 'planning',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.risk).toBe('read');
  });

  // MCP 工具策略测试 / MCP tool policy tests
  describe('MCP tools', () => {
    test('requires approval for mcp__* tools by default', () => {
      const decision = evaluateToolApproval({
        toolName: 'mcp__playwright__navigate',
        toolArgs: { url: 'https://example.com' },
        phase: 'building',
      });
      expect(decision.requiresApproval).toBe(true);
      expect(decision.risk).toBe('mcp');
    });

    test('allows MCP tool with a local per-tool read policy', () => {
      const decision = evaluateToolApproval({
        toolName: 'mcp__safe_reader__list',
        toolArgs: {},
        phase: 'building',
        mcpPolicy: {
          effects: { filesystem: 'read', network: 'read', externalState: 'read' },
          minimumApproval: 'none',
        },
      });
      expect(decision.allowed).toBe(true);
      expect(decision.requiresApproval).toBe(false);
      expect(decision.risk).toBe('read');
    });

    test('denies MCP tools in read-only workspace', () => {
      const decision = evaluateToolApproval({
        toolName: 'mcp__playwright__navigate',
        toolArgs: {},
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

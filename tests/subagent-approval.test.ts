import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PendingToolRequest, toolRequestFromCall } from '@/core/harness/tool-requests';
import { runApprovedTool } from '@/core/harness/tool-runner';
import type { AIMessage } from '@/core/messages';
import { aiMessage } from '@/core/messages';
import { evaluateToolApproval } from '@/core/policies/approval-policy';
import { createModePolicy } from '@/core/policies/mode-policy';
import {
  deserializeSubagentContinuation,
  serializeSubagentContinuation,
} from '@/core/subagent/continuation-codec';
import { getRoleConfig } from '@/core/subagent/roles';
import type { SubAgentContinuation } from '@/core/subagent/types';

function parseRequest(
  call: { id: string; name: string; args: Record<string, unknown> },
  workspace: string,
): PendingToolRequest {
  const result = toolRequestFromCall(call, workspace);
  if (!result?.ok) throw new Error('Failed to build request');
  return result.request;
}

describe('sub-agent external write approval chain', () => {
  // ── Policy layer: verify externalWrite effect ──

  test('evaluateToolApproval sets externalWrite effect for absolute path', () => {
    const result = evaluateToolApproval({
      toolName: 'write_file',
      toolArgs: { path: '/tmp/external.txt', content: 'hello' },
      phase: 'building',
      authorization: { mode: 'default', commandGrants: {} },
    });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.effects).toEqual({ externalWrite: true });
  });

  test('evaluateToolApproval sets externalWrite effect for ~ path', () => {
    const result = evaluateToolApproval({
      toolName: 'write_file',
      toolArgs: { path: '~/external.txt', content: 'hello' },
      phase: 'building',
    });
    expect(result.effects).toEqual({ externalWrite: true });
  });

  test('evaluateToolApproval does NOT set externalWrite for relative path', () => {
    const result = evaluateToolApproval({
      toolName: 'write_file',
      toolArgs: { path: 'src/foo.ts', content: 'hello' },
      phase: 'building',
    });
    expect(result.effects).toBeUndefined();
  });

  // ── Mode policy layer: verify accept_edits blocks external writes ──

  test('accept_edits mode requires approval for externalWrite', () => {
    const policy = createModePolicy('accept_edits');
    const decision = policy.shouldApproveTool({
      interactionMode: 'accept_edits',
      phase: 'building',
      planKind: 'building_without_plan',
      toolName: 'write_file',
      toolRisk: 'write_file',
      effects: { externalWrite: true },
    });
    expect(decision.kind).toBe('need_tool_approval');
  });

  test('accept_edits mode allows write_file without externalWrite', () => {
    const policy = createModePolicy('accept_edits');
    const decision = policy.shouldApproveTool({
      interactionMode: 'accept_edits',
      phase: 'building',
      planKind: 'building_without_plan',
      toolName: 'write_file',
      toolRisk: 'write_file',
      effects: undefined,
    });
    expect(decision.kind).toBe('allow');
  });

  // ── Full chain: policy + mode policy ──

  test('external write triggers need_tool_approval through the full policy chain', () => {
    // Step 1: evaluateToolApproval
    const approval = evaluateToolApproval({
      toolName: 'write_file',
      toolArgs: { path: '/tmp/f.txt', content: 'hello' },
      phase: 'building',
    });
    expect(approval.allowed).toBe(true);
    expect(approval.requiresApproval).toBe(true);
    expect(approval.effects).toEqual({ externalWrite: true });

    // Step 2: mode policy (this is what runApprovedTool calls)
    const policy = createModePolicy('accept_edits');
    const modeDecision = policy.shouldApproveTool({
      interactionMode: 'accept_edits',
      phase: 'building',
      planKind: 'building_without_plan',
      toolName: 'write_file',
      toolRisk: approval.risk,
      effects: approval.effects,
    });
    expect(modeDecision.kind).toBe('need_tool_approval');
  });

  // ── edit_file also gets externalWrite ──

  test('edit_file with absolute path also triggers externalWrite', () => {
    const result = evaluateToolApproval({
      toolName: 'edit_file',
      toolArgs: { path: '/etc/hosts', old_string: 'a', new_string: 'b' },
      phase: 'building',
    });
    expect(result.effects).toEqual({ externalWrite: true });
  });

  // ── Auto mode: externalWrite requires auto-review ──

  test('auto mode requires auto-review for externalWrite', () => {
    const policy = createModePolicy('auto');
    const decision = policy.shouldApproveTool({
      interactionMode: 'auto',
      phase: 'building',
      planKind: 'building_without_plan',
      toolName: 'write_file',
      toolRisk: 'write_file',
      effects: { externalWrite: true },
    });
    expect(decision.kind).toBe('need_auto_review');
  });

  // ── Full mode: full_access allows everything ──

  test('external write under full_access bypasses approval', () => {
    const result = evaluateToolApproval({
      toolName: 'write_file',
      toolArgs: { path: '/tmp/f.txt', content: 'hello' },
      phase: 'building',
      authorization: { mode: 'full_access', commandGrants: {} },
    });
    expect(result.requiresApproval).toBe(false);
    expect(result.grantUsed).toBe('full_access');
    // Still marks externalWrite for awareness
    expect(result.effects).toEqual({ externalWrite: true });
  });

  // ── runtime: runApprovedTool with sub-agent-equivalent parameters ──

  test('runApprovedTool rejects external write without approval grant', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-runApprovedTool-'));
    try {
      const request = parseRequest(
        {
          id: 'call-ext-write',
          name: 'write_file',
          args: { path: '/tmp/ext.txt', content: 'hello' },
        },
        workspace,
      );

      // Same parameters the sub-agent loop passes to runApprovedTool
      const result = await runApprovedTool({
        workspace,
        request,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: null,
        // NOT passing interactionMode — uses default ('accept_edits')
      });

      // Must return rejection because externalWrite triggers need_tool_approval
      // and no grant was provided
      expect(result.ok).toBe(false);
      expect(result.status).toBe('rejected');
      expect(result.stderr).toContain('requires approval but was not approved');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('runApprovedTool allows internal relative write without approval', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-runApprovedTool-internal-'));
    try {
      const request = parseRequest(
        {
          id: 'call-int-write',
          name: 'write_file',
          args: { path: 'internal.txt', content: 'hello' },
        },
        workspace,
      );

      const result = await runApprovedTool({
        workspace,
        request,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: null,
      });

      // Internal relative write should succeed directly in accept_edits mode
      expect(result.ok).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('read_file after write_file works correctly (no approval interference)', async () => {
    // 回归：write_file 的审批流程结束后，后续 read_file 不能受影响
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-read-after-write-'));
    try {
      // Step 1: write_file (internal, no approval needed)
      const parsedWrite = toolRequestFromCall(
        { id: 'call-w', name: 'write_file', args: { path: 'test.txt', content: 'hello' } },
        workspace,
      );
      if (!parsedWrite?.ok) throw new Error('Failed to build write request');
      const writeReq = parsedWrite.request;
      const writeResult = await runApprovedTool({
        workspace,
        request: writeReq!,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: null,
      });
      expect(writeResult.ok).toBe(true);

      // Step 2: read_file — must succeed (read is always allowed)
      const readReq = parseRequest(
        { id: 'call-r', name: 'read_file', args: { path: 'test.txt' } },
        workspace,
      );
      const readResult = await runApprovedTool({
        workspace,
        request: readReq,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: null,
      });
      expect(readResult.ok).toBe(true);
      expect(readResult.stdout).toContain('hello');
      expect(readResult.totalLines).toBeGreaterThan(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('runApprovedTool external write with approved grant succeeds', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-runApprovedTool-granted-'));
    try {
      const request = parseRequest(
        {
          id: 'call-granted-write',
          name: 'write_file',
          args: { path: '/tmp/granted-ext.txt', content: 'approved!' },
        },
        workspace,
      );

      const result = await runApprovedTool({
        workspace,
        request,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: null,
        approvedGrant: 'approve_once', // User approved!
      });

      // With approval grant, external write should succeed
      expect(result.ok).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  // ── Auto mode: external write → auto-review (not manual approval) ──

  test('auto mode routes external write to auto-review, not manual approval', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-auto-extwrite-'));
    try {
      const request = parseRequest(
        {
          id: 'call-auto-ext',
          name: 'write_file',
          args: { path: '/tmp/auto-ext.txt', content: 'auto' },
        },
        workspace,
      );

      // In auto mode without circuit breaker, the mode policy replaces need_tool_approval
      // with need_auto_review. runApprovedTool's defense-in-depth check sees need_auto_review
      // and rejects the tool unless an approved grant is present.
      const result = await runApprovedTool({
        workspace,
        request,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: null,
        interactionMode: 'auto' as const,
      });

      // Without a grant, auto mode should reject the tool (it would need auto-review)
      // The rejection means the tool won't execute; auto-review happens at a higher level
      expect(result.status).toBe('rejected');
      expect(result.stderr).toContain('requires approval but was not approved');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('auto mode internal write bypasses all reviews', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-auto-intwrite-'));
    try {
      const request = parseRequest(
        {
          id: 'call-auto-int',
          name: 'write_file',
          args: { path: 'internal.txt', content: 'auto-internal' },
        },
        workspace,
      );

      const result = await runApprovedTool({
        workspace,
        request,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: null,
        interactionMode: 'auto' as const,
      });

      // Internal write in auto mode should succeed directly
      expect(result.ok).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  // ── Full mode: external write → auto-allowed ──

  test('full_access mode auto-allows external write', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-full-extwrite-'));
    try {
      const request = parseRequest(
        {
          id: 'call-full-ext',
          name: 'write_file',
          args: { path: '/tmp/full-ext.txt', content: 'full' },
        },
        workspace,
      );

      const result = await runApprovedTool({
        workspace,
        request,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: { mode: 'full_access', commandGrants: {} },
        interactionMode: 'full' as const,
      });

      // full_access grant bypasses approval even for external writes
      expect(result.ok).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('full mode without full_access still triggers need_tool_approval for external write', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-full-noauth-extwrite-'));
    try {
      const request = parseRequest(
        {
          id: 'call-full-noauth',
          name: 'write_file',
          args: { path: '/tmp/full-reject.txt', content: 'nope' },
        },
        workspace,
      );

      const result = await runApprovedTool({
        workspace,
        request,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: null,
        interactionMode: 'full' as const,
      });

      // Full mode without sandbox requires approval (falls back to need_tool_approval)
      // Without a grant, the tool is rejected
      expect(result.status).toBe('rejected');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  // ── Workspace-internal absolute paths in all modes ──

  test('absolute path inside workspace is NOT treated as external in accept_edits mode', () => {
    const workspace = '/Users/test/project';
    const result = evaluateToolApproval({
      toolName: 'write_file',
      toolArgs: { path: '/Users/test/project/src/foo.ts', content: 'x' },
      phase: 'building',
      workspace,
    });
    // Path is absolute but inside workspace → no externalWrite effect
    expect(result.effects).toBeUndefined();
    expect(result.requiresApproval).toBe(true); // write_file always needs approval without full_access
  });

  test('absolute path inside workspace is NOT treated as external in auto mode', () => {
    const policy = createModePolicy('auto');
    const decision = policy.shouldApproveTool({
      interactionMode: 'auto',
      phase: 'building',
      planKind: 'building_without_plan',
      toolName: 'write_file',
      toolRisk: 'write_file',
      effects: undefined, // No externalWrite because path is inside workspace
    });
    // Without externalWrite, auto mode inherits accept_edits baseline → allow
    expect(decision.kind).toBe('allow');
  });

  test('shell_execute blocking preserves original tool_call_id through resume', () => {
    // 回归：shell_execute 被 blocked 后，resume 时 ToolMessage 的 tool_call_id
    // 必须匹配原始 AI message 中的 tool_call.id，否则模型返回 400 错误。
    const originalCallId = 'call-shell-real-123';
    const continuation: SubAgentContinuation = {
      id: 'sub-shell-test',
      role: getRoleConfig('code'),
      task: 'shell test',
      messages: [
        aiMessage({
          content: 'I will run a command.',
          tool_calls: [
            {
              id: originalCallId,
              name: 'shell_execute',
              args: { command: 'echo hi' },
              type: 'tool_call' as const,
            },
          ],
        }),
      ],
      toolCallCount: 1,
      steps: [
        {
          toolName: 'shell_execute',
          toolArgs: { command: 'echo hi' },
          status: 'awaiting_approval',
        },
      ],
    };

    const snapshot = serializeSubagentContinuation(continuation, {
      toolCallId: originalCallId,
      toolName: 'shell_execute',
      args: { command: 'echo hi' },
      command: 'echo hi',
    });

    const restored = deserializeSubagentContinuation(JSON.parse(JSON.stringify(snapshot)));

    // blockedTool.toolCallId must match the AI message's tool_call.id
    expect(restored.blockedTool.toolCallId).toBe(originalCallId);

    const aiMsg = restored.messages.find((m) => m.type === 'ai') as AIMessage;
    const matchingCall = aiMsg.tool_calls?.find((tc) => tc.id === restored.blockedTool.toolCallId);
    expect(matchingCall).toBeDefined();
    expect(matchingCall!.name).toBe('shell_execute');
  });

  test('absolute path inside workspace works correctly at runtime level', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-absinside-'));
    try {
      // Create a file inside the workspace first
      writeFileSync(join(workspace, 'existing.txt'), 'hello inside');

      // Read with absolute path inside workspace
      const parsedRead = toolRequestFromCall(
        {
          id: 'call-absins-read',
          name: 'read_file',
          args: { path: join(workspace, 'existing.txt') },
        },
        workspace,
      );
      if (!parsedRead?.ok) throw new Error('Failed to build read request');
      const readReq = parsedRead.request;
      const readResult = await runApprovedTool({
        workspace,
        request: readReq,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: null,
      });
      expect(readResult.ok).toBe(true);
      expect(readResult.totalLines).toBe(1);

      // Write with absolute path inside workspace
      const parsedWrite = toolRequestFromCall(
        {
          id: 'call-absins-write',
          name: 'write_file',
          args: { path: join(workspace, 'abs-new.txt'), content: 'inside' },
        },
        workspace,
      );
      if (!parsedWrite?.ok) throw new Error('Failed to build write request');
      const writeReq = parsedWrite.request;
      const writeResult = await runApprovedTool({
        workspace,
        request: writeReq!,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: null,
      });
      expect(writeResult.ok).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  // ── read_file external path consistency ──

  test('read_file rejects external path without approval grant', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-read-ext-reject-'));
    try {
      const request = parseRequest(
        {
          id: 'call-read-ext',
          name: 'read_file',
          args: { path: '/tmp/nonexistent-read-test.txt' },
        },
        workspace,
      );

      const result = await runApprovedTool({
        workspace,
        request,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: null,
        // No approvedGrant → hasExecutionGrant = false → allowExternal = false
      });

      // External read without grant should be rejected at policy level
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('requires approval but was not approved');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('read_file allows external path with approval grant (consistent with write_file)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-read-ext-granted-'));
    const extPath = join(tmpdir(), 'openpx-read-ext-test.txt');
    try {
      // First create the external file
      writeFileSync(extPath, 'external content for read test');

      const request = parseRequest(
        { id: 'call-read-ext-granted', name: 'read_file', args: { path: extPath } },
        workspace,
      );

      const result = await runApprovedTool({
        workspace,
        request,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: null,
        approvedGrant: 'approve_once', // User approved!
      });

      // With approval grant, external read should succeed for consistency with write_file
      // hasExecutionGrant = true → allowExternal = true → resolvePath skips boundary check
      expect(result.ok).toBe(true);
      expect(result.totalLines).toBe(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      try {
        rmSync(extPath, { force: true });
      } catch {
        /* cleanup */
      }
    }
  });

  test('read_file and write_file have consistent external path behavior', async () => {
    // 回归：确保 read_file 和 write_file 对同一外部路径的行为一致
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-consistency-'));
    const extPath = join(tmpdir(), 'openpx-consistency-test.txt');
    try {
      // Step 1: write_file with approval → should succeed
      const writeReq = parseRequest(
        {
          id: 'call-cons-write',
          name: 'write_file',
          args: { path: extPath, content: 'consistent test' },
        },
        workspace,
      );

      const writeResult = await runApprovedTool({
        workspace,
        request: writeReq,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: null,
        approvedGrant: 'approve_once',
      });
      expect(writeResult.ok).toBe(true);

      // Step 2: read_file with same approval → should also succeed
      const readReq = parseRequest(
        { id: 'call-cons-read', name: 'read_file', args: { path: extPath } },
        workspace,
      );

      const readResult = await runApprovedTool({
        workspace,
        request: readReq,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: null,
        approvedGrant: 'approve_once',
      });
      expect(readResult.ok).toBe(true);
      expect(readResult.totalLines).toBe(1);
      expect(readResult.stdout).toContain('consistent test');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      try {
        rmSync(extPath, { force: true });
      } catch {
        /* cleanup */
      }
    }
  });

  // ── search_files / search_content external path consistency ──

  test('search_files rejects external path without approval grant', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-search-ext-reject-'));
    try {
      const request = parseRequest(
        { id: 'call-search-ext', name: 'search_files', args: { path: '/tmp', pattern: '*.txt' } },
        workspace,
      );

      const result = await runApprovedTool({
        workspace,
        request,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: null,
        // No approvedGrant → hasExecutionGrant = false → allowExternal = false
      });

      // External search without grant should be rejected at policy level
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('requires approval but was not approved');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('search_files allows external path with approval grant (consistent with file tools)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-search-ext-granted-'));
    const extDir = mkdtempSync(join(tmpdir(), 'openpx-search-extdir-'));
    try {
      writeFileSync(join(extDir, 'test.txt'), 'hello search');

      const request = parseRequest(
        {
          id: 'call-search-ext-granted',
          name: 'search_files',
          args: { path: extDir, pattern: '*.txt' },
        },
        workspace,
      );

      const result = await runApprovedTool({
        workspace,
        request,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: null,
        approvedGrant: 'approve_once',
      });

      // With approval grant, external search should succeed for consistency
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain('test.txt');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      try {
        rmSync(extDir, { recursive: true, force: true });
      } catch {
        /* cleanup */
      }
    }
  });

  test('search_content rejects external path without approval grant', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-searchcontent-reject-'));
    try {
      const request = parseRequest(
        { id: 'call-sc-ext', name: 'search_content', args: { path: '/tmp', pattern: 'test' } },
        workspace,
      );

      const result = await runApprovedTool({
        workspace,
        request,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: null,
      });

      // External search without grant should be rejected at policy level
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('requires approval but was not approved');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('search_content allows external path with approval grant', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-searchcontent-granted-'));
    const extDir = mkdtempSync(join(tmpdir(), 'openpx-searchcontent-extdir-'));
    try {
      writeFileSync(join(extDir, 'match.txt'), 'hello world test line');

      const request = parseRequest(
        {
          id: 'call-sc-ext-granted',
          name: 'search_content',
          args: { path: extDir, pattern: 'test' },
        },
        workspace,
      );

      const result = await runApprovedTool({
        workspace,
        request,
        workspaceAccess: 'write',
        phase: 'building',
        authorization: null,
        approvedGrant: 'approve_once',
      });

      // With approval grant, external search should succeed
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain('test');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      try {
        rmSync(extDir, { recursive: true, force: true });
      } catch {
        /* cleanup */
      }
    }
  });
});

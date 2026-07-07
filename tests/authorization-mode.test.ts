import { describe, expect, test } from 'bun:test';
import { AIMessage } from '@langchain/core/messages';
import { routeAfterAgent } from '../src/core/harness/routes';
import type { CodeAgentState } from '../src/core/harness/state';
import { evaluateToolPolicy } from '../src/core/harness/tool-policy';

describe('authorization mode switch', () => {
  // ---- evaluateToolPolicy with override ----

  test('override full_access bypasses shell_execute approval', () => {
    const decision = evaluateToolPolicy({
      request: {
        id: 'call-1',
        name: 'shell_execute',
        args: { command: 'bun test' },
        reason: 'test',
        protectedCommand: 'bun test',
      },
      workspaceAccess: 'write',
      phase: 'building',
      authorization: { mode: 'default', commandGrants: {} },
      override: { current: 'full_access' },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.grantUsed).toBe('full_access');
  });

  test('override full_access allows write_file without approval', () => {
    const decision = evaluateToolPolicy({
      request: {
        id: 'call-4',
        name: 'write_file',
        args: { path: 'hello.txt', content: 'hi' },
        reason: 'create file',
        protectedCommand: 'write_file hello.txt',
      },
      workspaceAccess: 'write',
      phase: 'building',
      authorization: { mode: 'default', commandGrants: {} },
      override: { current: 'full_access' },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.grantUsed).toBe('full_access');
  });

  test('override does NOT affect read-only shell commands (still allowed, no approval)', () => {
    const decision = evaluateToolPolicy({
      request: {
        id: 'call-2',
        name: 'shell_execute',
        args: { command: 'git status' },
        reason: 'inspect',
        protectedCommand: 'git status',
      },
      workspaceAccess: 'write',
      phase: 'building',
      authorization: { mode: 'default', commandGrants: {} },
      override: { current: 'default' },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  test('planning phase allows read-only subagents and denies code subagents', () => {
    const exploreDecision = evaluateToolPolicy({
      request: {
        id: 'call-explore',
        name: 'task',
        args: { subagent_type: 'explore', task: 'trace state handling' },
        reason: 'research',
        protectedCommand: 'task explore',
      },
      workspaceAccess: 'write',
      phase: 'planning',
      authorization: { mode: 'default', commandGrants: {} },
    });
    const codeDecision = evaluateToolPolicy({
      request: {
        id: 'call-code',
        name: 'task',
        args: { subagent_type: 'code', task: 'implement the fix' },
        reason: 'implementation',
        protectedCommand: 'task code',
      },
      workspaceAccess: 'write',
      phase: 'planning',
      authorization: { mode: 'default', commandGrants: {} },
    });

    expect(exploreDecision.decision).toBe('allow');
    expect(codeDecision.decision).toBe('deny');
    expect(codeDecision.phaseConstraint).toBe('planning');
  });

  // ---- routing with override ----

  test('routes write_file to approval under default override', () => {
    expect(
      routeAfterAgent(
        {
          workspaceAccess: 'write',
          workspace: '/tmp/workspace',
          messages: [
            new AIMessage({
              content: '',
              tool_calls: [
                { id: 'call-1', name: 'write_file', args: { path: 'hello.txt', content: 'hi' } },
              ],
            }),
          ],
        } as unknown as CodeAgentState,
        { current: 'default' },
      ),
    ).toBe('approval');
  });

  test('routes shell_execute directly to tools under full_access override', () => {
    expect(
      routeAfterAgent(
        {
          workspaceAccess: 'write',
          phase: 'building',
          workspace: '/tmp/workspace',
          messages: [
            new AIMessage({
              content: '',
              tool_calls: [{ id: 'call-1', name: 'shell_execute', args: { command: 'bun test' } }],
            }),
          ],
        } as unknown as CodeAgentState,
        { current: 'full_access' },
      ),
    ).toBe('tools');
  });

  // ---- tool execution ----

  test('evaluateToolPolicy without override falls back to state authorization', () => {
    const decision = evaluateToolPolicy({
      request: {
        id: 'call-1',
        name: 'shell_execute',
        args: { command: 'bun test' },
        reason: 'test',
        protectedCommand: 'bun test',
      },
      workspaceAccess: 'write',
      phase: 'building',
      authorization: { mode: 'full_access', commandGrants: {} },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.grantUsed).toBe('full_access');
  });

  // ── Planning phase + full_access cross-verification ──

  test('planning phase denies write_file even with full_access authorization', () => {
    const decision = evaluateToolPolicy({
      request: {
        id: 'call-plan-write',
        name: 'write_file',
        args: { path: 'hello.txt', content: 'hi' },
        reason: 'write during planning',
        protectedCommand: 'write_file hello.txt',
      },
      workspaceAccess: 'write',
      phase: 'planning',
      authorization: { mode: 'full_access', commandGrants: {} },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.decision).toBe('deny');
    expect(decision.phaseConstraint).toBe('planning');
    expect(decision.reason).toContain('planning phase');
  });

  test('planning phase denies non-read-only shell_execute even with full_access', () => {
    const decision = evaluateToolPolicy({
      request: {
        id: 'call-plan-shell',
        name: 'shell_execute',
        args: { command: 'bun test' },
        reason: 'test during planning',
        protectedCommand: 'bun test',
      },
      workspaceAccess: 'write',
      phase: 'planning',
      authorization: { mode: 'full_access', commandGrants: {} },
    });
    // Planning phase must reject execution tools regardless of authorization mode.
    // Full mode is only valid during building phase.
    expect(decision.allowed).toBe(false);
    expect(decision.phaseConstraint).toBe('planning');
  });

  test('planning phase denies edit_file even with full_access', () => {
    const decision = evaluateToolPolicy({
      request: {
        id: 'call-plan-edit',
        name: 'edit_file',
        args: { path: 'src/main.ts', old_string: 'a', new_string: 'b' },
        reason: 'edit during planning',
        protectedCommand: 'edit_file src/main.ts',
      },
      workspaceAccess: 'write',
      phase: 'planning',
      authorization: { mode: 'full_access', commandGrants: {} },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.phaseConstraint).toBe('planning');
  });

  test('planning phase denies code subagent even with full_access', () => {
    const decision = evaluateToolPolicy({
      request: {
        id: 'call-plan-code',
        name: 'task',
        args: { subagent_type: 'code', task: 'implement the fix' },
        reason: 'implementation',
        protectedCommand: 'task code',
      },
      workspaceAccess: 'write',
      phase: 'planning',
      authorization: { mode: 'full_access', commandGrants: {} },
    });
    expect(decision.decision).toBe('deny');
    expect(decision.phaseConstraint).toBe('planning');
  });

  test('planning phase allows read tools even with full_access (no escalation needed)', () => {
    const decision = evaluateToolPolicy({
      request: {
        id: 'call-plan-read',
        name: 'read_file',
        args: { path: 'README.md' },
        reason: 'read during planning',
        protectedCommand: 'read_file README.md',
      },
      workspaceAccess: 'write',
      phase: 'planning',
      authorization: { mode: 'full_access', commandGrants: {} },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.risk).toBe('read');
  });
});

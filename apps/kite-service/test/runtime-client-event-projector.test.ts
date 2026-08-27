import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '../src/bootstrap/runtime/state-runtime';
import {
  projectRuntimeClientEvent,
  projectRuntimeToolDisplayName,
} from '../src/runtime-client/event-projector';

describe('Runtime Client event projector', () => {
  test('projects safe UI-ready fields while retaining local tool arguments with credential redaction', () => {
    expect(
      projectRuntimeClientEvent(
        {
          type: 'tool.queued',
          toolCallId: 'tool-1',
          name: 'write_file',
          args: { path: '/private/secret', content: 'password=hidden' },
        } as RuntimeEvent,
        { sessionRevision: 4 },
      ),
    ).toEqual({
      type: 'tool.queued',
      toolId: 'tool-1',
      toolName: 'write_file',
      presentation: 'standalone',
      arguments: { path: '/private/secret', content: '[redacted]' },
      summary: 'Queued.',
    });
    expect(
      projectRuntimeClientEvent(
        {
          type: 'tool.file_change',
          toolCallId: 'tool-1',
          path: '/private/secret',
          kind: 'edit',
        },
        { sessionRevision: 4 },
      ),
    ).toEqual({
      type: 'tool.file_changed',
      toolId: 'tool-1',
      change: 'modified',
      summary: 'Workspace file changed.',
    });
  });

  test('keeps closed canonical tool categories and bounded dynamic labels', () => {
    expect(projectRuntimeToolDisplayName('read_file')).toBe('read_file');
    expect(projectRuntimeToolDisplayName('mcp__github__read_private_issue')).toBe('mcp_tool');
    expect(projectRuntimeToolDisplayName('credential=super-secret')).toBe('other');
    expect(
      projectRuntimeClientEvent(
        {
          type: 'tool.queued',
          toolCallId: 'tool-2',
          name: 'mcp__github__read_private_issue',
          args: { token: 'super-secret', path: '/private/workspace' },
        } as RuntimeEvent,
        { sessionRevision: 4 },
      ),
    ).toEqual({
      type: 'tool.queued',
      toolId: 'tool-2',
      toolName: 'mcp_tool',
      displayLabel: 'mcp:dynamic_tool',
      presentation: 'standalone',
      arguments: { token: '[redacted]', path: '/private/workspace' },
      summary: 'Queued.',
    });
  });

  test('projects bounded local reasoning activity and credential-shaped user text', () => {
    const longReasoning = `local detail ${'x'.repeat(5_000)}`;
    expect(
      projectRuntimeClientEvent(
        { type: 'model.text_delta', requestId: 'request-1', text: 'partial answer' },
        { sessionRevision: 1 },
      ),
    ).toEqual({ type: 'model.text_delta', requestId: 'request-1', text: 'partial answer' });
    expect(
      projectRuntimeClientEvent(
        {
          type: 'model.reasoning_delta',
          requestId: 'request-1',
          segmentId: 'reasoning-1',
          text: longReasoning,
        },
        { sessionRevision: 1 },
      ),
    ).toEqual({
      type: 'reasoning.activity',
      requestId: 'request-1',
      state: 'streaming',
      segmentId: 'reasoning-1',
      text: longReasoning,
    });
    expect(
      projectRuntimeClientEvent(
        {
          type: 'model.reasoning_delta',
          requestId: 'request-1',
          text: 'legacy segment without an id',
        },
        { sessionRevision: 1 },
      ),
    ).toBeUndefined();
    expect(
      projectRuntimeClientEvent(
        {
          type: 'user.message_appended',
          messageId: 'message-1',
          content: 'authorization: Bearer super-secret',
        },
        { sessionRevision: 1 },
      ),
    ).toMatchObject({ text: '[redacted]' });
  });

  test('projects only closed responded metadata needed to retain pending narration', () => {
    expect(
      projectRuntimeClientEvent(
        {
          type: 'model.responded',
          invocationId: 'request-1',
          messageId: 'message-1',
          durationMs: 250,
          toolCalls: [
            { id: 'tool-1', name: 'read_file', args: { path: '/workspace/one.ts' } },
            { id: 'tool-2', name: 'search_content', args: { pattern: 'needle' } },
          ],
          reasoningText: 'private reasoning body',
        } as RuntimeEvent,
        { sessionRevision: 1 },
      ),
    ).toEqual({
      type: 'model.responded',
      requestId: 'request-1',
      messageId: 'message-1',
      durationMs: 250,
      toolCallCount: 2,
    });
  });

  test('projects child tool lifecycle as closed subagent steps', () => {
    const context = { sessionRevision: 1 };
    expect(
      projectRuntimeClientEvent(
        {
          type: 'subagent.step',
          subagent: {
            id: 'child-1',
            toolName: 'mcp__github__search',
            toolArgs: { path: '/workspace', token: 'secret' },
            durationMs: 12,
          },
        } as RuntimeEvent,
        context,
      ),
    ).toEqual({
      type: 'subagent.step',
      subagentId: 'child-1',
      toolName: 'mcp__github__search',
      displayLabel: 'mcp:dynamic_tool',
      status: 'started',
      arguments: { path: '/workspace', token: '[redacted]' },
      durationMs: 12,
    });
    expect(
      projectRuntimeClientEvent(
        {
          type: 'subagent.tool_result',
          subagent: {
            id: 'child-1',
            toolName: 'mcp__github__search',
            ok: false,
            failureReason: 'token=secret',
            totalLines: 3,
            durationMs: 20,
          },
        } as RuntimeEvent,
        context,
      ),
    ).toEqual({
      type: 'subagent.step',
      subagentId: 'child-1',
      toolName: 'mcp__github__search',
      displayLabel: 'mcp:dynamic_tool',
      status: 'failed',
      result: { ok: false },
      summary: '[redacted]',
      totalLines: 3,
      durationMs: 20,
    });
  });

  test('retains bounded, redacted tool progress chunks', () => {
    expect(
      projectRuntimeClientEvent(
        {
          type: 'tool.progress',
          toolCallId: 'tool-1',
          chunk: 'authorization: Bearer super-secret',
          stream: 'stderr',
          lineCount: 2,
        } as RuntimeEvent,
        { sessionRevision: 1 },
      ),
    ).toEqual({
      type: 'tool.progress',
      toolId: 'tool-1',
      summary: '[redacted]',
      stream: 'stderr',
      lineCount: 2,
    });
  });

  test('projects only closed tool presentation facts from raw tool metadata', () => {
    const context = { sessionRevision: 1 };
    const queued = (toolCallId: string, name: string, args: unknown) =>
      projectRuntimeClientEvent(
        { type: 'tool.queued', toolCallId, name, args } as RuntimeEvent,
        context,
      );

    expect(queued('read-1', 'read_file', { path: '/private/secret' })).toMatchObject({
      presentation: 'exploration',
    });
    expect(queued('search-1', 'search_content', { query: 'private' })).toMatchObject({
      presentation: 'exploration',
    });
    expect(
      queued('shell-1', 'shell_execute', { intent: 'inspect', command: 'rg token .' }),
    ).toMatchObject({
      presentation: 'exploration',
    });
    expect(
      queued('ls-1', 'shell_execute', { intent: 'inspect', command: 'ls -la src' }),
    ).toMatchObject({
      presentation: 'exploration',
    });
    expect(
      queued('compound-1', 'shell_execute', { intent: 'inspect', command: 'ls | tee output' }),
    ).toMatchObject({ presentation: 'standalone' });
    expect(
      queued('write-1', 'shell_execute', { intent: 'inspect', command: 'printf private > out' }),
    ).toMatchObject({ presentation: 'standalone' });
    expect(queued('task-1', 'task', { prompt: 'private' })).toMatchObject({
      presentation: 'hidden',
    });
    expect(queued('subagent-tool:1', 'read_file', { path: '/private/secret' })).toMatchObject({
      presentation: 'hidden',
    });
    const projected = queued('secret-1', 'shell_execute', {
      intent: 'inspect',
      command: 'rg secret /private/workspace',
    });
    expect(projected).toMatchObject({
      arguments: { intent: 'inspect', command: 'rg secret /private/workspace' },
    });
  });

  test('retains bounded terminal output without exposing private result metadata', () => {
    expect(
      projectRuntimeClientEvent(
        {
          type: 'tool.finished',
          toolCallId: 'tool-1',
          name: 'shell_execute',
          result: {
            ok: false,
            command: 'printf authorization: Bearer super-secret',
            exitCode: 1,
            stdout: 'path: /private/workspace\nauthorization: Bearer super-secret',
            stderr: 'api_key=super-secret',
            status: 'error',
            totalLines: 2,
            toolTokenCount: 10,
            resultMeta: { private: 'metadata' },
          },
        } as RuntimeEvent,
        { sessionRevision: 1 },
      ),
    ).toEqual({
      type: 'tool.finished',
      toolId: 'tool-1',
      toolName: 'shell_execute',
      presentation: 'standalone',
      result: {
        ok: false,
        exitCode: 1,
        stdout: 'path: /private/workspace\n[redacted]',
        stderr: '[redacted]',
        status: 'error',
        totalLines: 2,
        toolTokenCount: 10,
      },
      summary: 'Failed.',
    });
  });

  test('projects closed lifecycle and failure facts while omitting unknown State events', () => {
    expect(
      projectRuntimeClientEvent(
        {
          type: 'run.completed',
          turnId: 'run-safe-outcome',
          output: 'Done.',
          completionGuardVersion: 'completion_guard_v1',
          outcome: {
            version: 1,
            status: 'completed',
            reasonCode: 'completed',
            knownExternalEffects: 'known',
            safeRetry: false,
            recoveryEntry: 'none',
            pendingVerification: false,
          },
        },
        { sessionRevision: 1 },
      ),
    ).toEqual({
      type: 'run.terminal',
      runId: 'run-safe-outcome',
      status: 'completed',
      summary: 'Done.',
      outcome: {
        status: 'completed',
        reasonCode: 'completed',
        safeRetry: false,
        recoveryEntry: 'none',
      },
    });
    expect(
      projectRuntimeClientEvent(
        { type: 'planning.entered', taskId: 'task-1', source: 'user_command' },
        { sessionRevision: 1 },
      ),
    ).toEqual({ type: 'planning.entered', taskId: 'task-1' });
    expect(
      projectRuntimeClientEvent(
        { type: 'interaction_mode.changed', mode: 'full', source: 'user', changedAt: 'now' },
        { sessionRevision: 1 },
      ),
    ).toEqual({ type: 'interaction_mode.changed', mode: 'full' });
    expect(
      projectRuntimeClientEvent(
        { type: 'turn.aborted', turnId: 'turn-1', reason: 'Cancelled', cause: 'user' },
        { sessionRevision: 1 },
      ),
    ).toEqual({ type: 'turn.terminal', turnId: 'turn-1', status: 'cancelled', cause: 'user' });
    expect(
      projectRuntimeClientEvent(
        {
          type: 'plan.approved',
          interactionId: 'plan-review-1',
          toolCallId: 'plan-tool-1',
          planId: 'plan-1',
          version: 1,
          structuralDigest: 'digest-1',
          executionMode: 'accept_edits',
        },
        { sessionRevision: 2 },
      ),
    ).toEqual({
      type: 'plan.approved',
      interactionId: 'plan-review-1',
      sessionRevision: 2,
      mode: 'accept_edits',
    });
    expect(
      projectRuntimeClientEvent(
        { type: 'provider.action_started', interactionId: 'provider-action-1' },
        { sessionRevision: 3 },
      ),
    ).toBeUndefined();
    expect(
      projectRuntimeClientEvent(
        {
          type: 'run.error',
          message: 'private provider exception',
          recoverable: true,
          turnId: 'turn-1',
          failure: {
            kind: 'provider_unavailable',
            retryable: true,
            modelFixable: false,
            needsUserIntervention: false,
            terminatesTurn: true,
            journal: true,
            message: 'private provider exception',
          },
        },
        { sessionRevision: 1 },
      ),
    ).toEqual({
      type: 'run.failure',
      runId: 'turn-1',
      code: 'provider_unavailable',
      retryable: true,
      recoveryEntry: 'retry',
    });
    expect(
      projectRuntimeClientEvent(
        { type: 'runtime.action_ignored', reason: 'private' },
        { sessionRevision: 1 },
      ),
    ).toBeUndefined();
  });

  test('binds approval settlement to revision and generation with a bounded command projection', () => {
    const event = projectRuntimeClientEvent(
      {
        type: 'approval.requested',
        interactionId: 'interaction-1',
        toolCallId: 'tool-1',
        approval: {
          scope: 'once',
          cwd: '/private/workspace',
          threadId: 'session-1',
          tool: 'shell',
          command: 'git status --short',
          risk: 'execute_code',
          approvalHash: 'hash',
          summary: 'Run a command',
          reason: 'needs approval',
          expectedEffects: [],
          grantOptions: ['approve_once'],
          recommendedGrant: 'approve_once',
        },
        fullModeBypassEligible: false,
        fullModePolicyBypassAllowed: false,
        queueGeneration: 7,
        queueSequence: 3,
      },
      { sessionRevision: 12 },
    );
    expect(event).toMatchObject({
      type: 'approval.queued',
      queueSequence: 3,
      interaction: {
        interactionId: 'interaction-1',
        sessionRevision: 12,
        generation: 7,
        grants: ['approve_once'],
        command: 'git status --short',
      },
    });
    expect(JSON.stringify(event)).not.toContain('/private/workspace');
  });
});

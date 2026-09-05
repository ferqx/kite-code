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
          modelMessageId: 'model-message-1',
          name: 'write_file',
          args: { path: '/private/secret', content: 'password=hidden' },
        } as RuntimeEvent,
        { sessionRevision: 4 },
      ),
    ).toEqual({
      type: 'tool.queued',
      toolId: 'tool-1',
      presentationGroupId: 'model-message-1',
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

  test('uses the admission descriptor label for hashed dynamic MCP bindings', () => {
    expect(
      projectRuntimeClientEvent(
        {
          type: 'tool.queued',
          toolCallId: 'tool-3',
          name: 'mcp__docs__search_documentation_latest_123456789abc',
          displayLabel: 'search documentation / latest',
          args: { query: 'runtime binding' },
          presentation: 'exploration',
        } as RuntimeEvent,
        { sessionRevision: 4 },
      ),
    ).toEqual({
      type: 'tool.queued',
      toolId: 'tool-3',
      toolName: 'mcp_tool',
      displayLabel: 'search documentation / latest',
      presentation: 'exploration',
      arguments: { query: 'runtime binding' },
      summary: 'Queued.',
    });
  });

  test('consumes canonical terminal presentation facts without id-prefix inference', () => {
    expect(
      projectRuntimeClientEvent(
        {
          type: 'tool.failed',
          toolCallId: 'child-tool-step',
          presentation: 'hidden',
          failure: {
            kind: 'tool_runtime_error',
            message: 'failed',
            retryable: false,
            modelFixable: false,
            needsUserIntervention: false,
            terminatesTurn: false,
            journal: false,
          },
        },
        { sessionRevision: 4 },
      ),
    ).toEqual({
      type: 'tool.failed',
      toolId: 'child-tool-step',
      presentation: 'hidden',
      summary: 'Tool execution failed.',
    });
    expect(
      projectRuntimeClientEvent(
        {
          type: 'tool.rejected',
          toolCallId: 'shell-1',
          presentation: 'standalone',
          reason: 'not approved',
          failure: {
            kind: 'approval_rejected',
            message: 'not approved',
            retryable: false,
            modelFixable: false,
            needsUserIntervention: true,
            terminatesTurn: true,
            journal: false,
          },
        },
        { sessionRevision: 4 },
      ),
    ).toEqual({
      type: 'tool.rejected',
      toolId: 'shell-1',
      presentation: 'standalone',
      summary: 'not approved',
    });
    expect(
      projectRuntimeClientEvent(
        {
          type: 'tool.rejected',
          toolCallId: 'write-1',
          presentation: 'hidden',
          reason: 'planning policy denied',
        },
        { sessionRevision: 4 },
      ),
    ).toEqual({
      type: 'tool.rejected',
      toolId: 'write-1',
      presentation: 'hidden',
      summary: 'planning policy denied',
    });
    expect(
      projectRuntimeClientEvent(
        {
          type: 'tool.cancelled',
          toolCallId: 'shell-2',
          presentation: 'standalone',
          reason: 'user cancelled',
        },
        { sessionRevision: 4 },
      ),
    ).toEqual({
      type: 'tool.cancelled',
      toolId: 'shell-2',
      presentation: 'standalone',
      summary: 'Tool execution cancelled.',
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
    ).toEqual({ type: 'unavailable', reason: 'redacted' });
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
          type: 'subagent.started',
          subagent: {
            id: 'child-1',
            role: 'explore',
            name: 'Inspect runtime files',
            concurrencyGroupId: 'subagent-batch:tool-1',
          },
        } as RuntimeEvent,
        context,
      ),
    ).toEqual({
      type: 'subagent.started',
      subagentId: 'child-1',
      role: 'explore',
      name: 'Inspect runtime files',
      concurrencyGroupId: 'subagent-batch:tool-1',
    });
    expect(
      projectRuntimeClientEvent(
        {
          type: 'subagent.step',
          subagent: {
            id: 'child-1',
            stepId: 'step-1',
            toolCallId: 'child-tool-1',
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
      stepId: 'step-1',
      toolCallId: 'child-tool-1',
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
            stepId: 'step-1',
            toolCallId: 'child-tool-1',
            toolName: 'mcp__github__search',
            status: 'failed',
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
      stepId: 'step-1',
      toolCallId: 'child-tool-1',
      toolName: 'mcp__github__search',
      displayLabel: 'mcp:dynamic_tool',
      status: 'failed',
      summary: '[redacted]',
      totalLines: 3,
      durationMs: 20,
    });
    expect(
      projectRuntimeClientEvent(
        {
          type: 'subagent.completed',
          subagent: {
            id: 'child-1',
            summary: 'Inspection complete.',
            toolCallCount: 3,
            durationMs: 12_345,
          },
        } as RuntimeEvent,
        context,
      ),
    ).toEqual({
      type: 'subagent.completed',
      subagentId: 'child-1',
      summary: 'Inspection complete.',
      toolCallCount: 3,
      durationMs: 12_345,
    });
    expect(
      projectRuntimeClientEvent(
        {
          type: 'subagent.failed',
          subagent: {
            id: 'child-2',
            error: 'provider body must stay private',
            summary: 'Inspection failed.',
            toolCallCount: 2,
            durationMs: 9_000,
            diagnostic: {
              code: 'model_step_failed',
              stage: 'model_step',
              modelInvocationId: 'private-correlation',
            },
          },
        } as RuntimeEvent,
        context,
      ),
    ).toEqual({
      type: 'subagent.failed',
      subagentId: 'child-2',
      summary: 'Inspection failed.',
      toolCallCount: 2,
      durationMs: 9_000,
      diagnostic: { code: 'model_step_failed', stage: 'model_step' },
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

  test('consumes closed tool presentation facts from Kernel admission', () => {
    const context = { sessionRevision: 1 };
    const queued = (
      toolCallId: string,
      name: string,
      args: unknown,
      presentation: 'exploration' | 'standalone' | 'hidden',
    ) =>
      projectRuntimeClientEvent(
        { type: 'tool.queued', toolCallId, name, args, presentation } as RuntimeEvent,
        context,
      );

    expect(queued('read-1', 'read_file', { path: '/private/secret' }, 'exploration')).toMatchObject(
      {
        presentation: 'exploration',
      },
    );
    expect(
      queued('mcp-read-1', 'mcp__github__read_private_issue', { issue: 1 }, 'exploration'),
    ).toMatchObject({
      presentation: 'exploration',
      displayLabel: 'mcp:dynamic_tool',
    });
    expect(
      queued('same-name-standalone', 'read_file', { path: '/private/secret' }, 'standalone'),
    ).toMatchObject({
      presentation: 'standalone',
    });
    expect(
      queued('child-tool-1', 'read_file', { path: '/private/secret' }, 'hidden'),
    ).toMatchObject({
      presentation: 'hidden',
    });
    const projected = queued(
      'secret-1',
      'shell_execute',
      {
        command: 'rg secret /private/workspace',
      },
      'exploration',
    );
    expect(projected).toMatchObject({
      arguments: { command: 'rg secret /private/workspace' },
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
      type: 'run.terminal',
      runId: 'turn-1',
      status: 'failed',
      outcome: {
        status: 'unknown',
        reasonCode: 'provider_unavailable',
        safeRetry: true,
        recoveryEntry: 'retry',
      },
    });
    expect(
      projectRuntimeClientEvent(
        { type: 'run.error', message: 'unattributed failure', recoverable: false },
        { sessionRevision: 1 },
      ),
    ).toEqual({ type: 'unavailable', reason: 'redacted' });
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
        owner: { kind: 'root_tool', toolCallId: 'tool-1' },
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
    expect(
      projectRuntimeClientEvent(
        {
          type: 'approval.rejected',
          interactionId: 'interaction-1',
          toolCallId: 'tool-1',
          generation: 7,
          reason: 'Tool approval rejected by user.',
          owner: { kind: 'root_tool', toolCallId: 'tool-1' },
        },
        { sessionRevision: 13 },
      ),
    ).toEqual({
      type: 'approval.rejected',
      interactionId: 'interaction-1',
      generation: 7,
      owner: { kind: 'root_tool', toolCallId: 'tool-1' },
      summary: 'Tool approval rejected by user.',
    });
  });
});

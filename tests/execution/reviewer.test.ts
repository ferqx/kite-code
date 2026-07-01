import { describe, expect, test } from 'bun:test';
import { AIMessage } from '@langchain/core/messages';
import { parseArgs } from '../../src/app/cli/index';
import { configSchema } from '../../src/core/config/index';
import { reviewToolApproval } from '../../src/core/execution/reviewer';
import { routeAfterAgent } from '../../src/core/harness/routes';
import type { ToolApprovalPayload } from '../../src/core/harness/tool-policy';
import type { PendingToolRequest } from '../../src/core/harness/tool-requests';

describe('interaction mode', () => {
  test('config accepts provider-neutral interaction and auto review settings', () => {
    const parsed = configSchema.parse({
      interactionMode: 'unattended',
      autoReview: { provider: 'openai-compatible', model: 'fast-model', timeoutMs: 1000 },
    });

    expect(parsed.interactionMode).toBe('unattended');
    expect(parsed.autoReview?.model).toBe('fast-model');
  });

  test('cli parses interaction mode flags', () => {
    expect(parseArgs(['run', '--unattended', '--task', 'x']).interactionMode).toBe('unattended');
    expect(parseArgs(['run', '--auto-review', '--task', 'x']).interactionMode).toBe('auto_review');
    expect(parseArgs(['run', '--interactive', '--task', 'x']).interactionMode).toBe('interactive');
  });

  test('unattended ask_user routes to tools instead of user_input interrupt', () => {
    const state = {
      workspace: '/tmp/workspace',
      workspaceAccess: 'write',
      phase: 'building',
      threadId: 'thread-1',
      authorization: { mode: 'default', commandGrants: {} },
      interactionMode: 'unattended',
      messages: [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call-ask', name: 'ask_user', args: { question: 'Proceed?' } }],
        }),
      ],
    } as any;

    expect(routeAfterAgent(state)).toBe('tools');
  });
});

describe('auto approval reviewer', () => {
  const payload: ToolApprovalPayload = {
    scope: 'once' as const,
    cwd: '/tmp/workspace',
    threadId: 'thread-1',
    tool: 'shell_execute' as const,
    command: 'bun test',
    risk: 'execute_code' as const,
    approvalHash: 'hash',
    summary: 'Run tests',
    reason: 'Verification command',
    expectedEffects: ['Runs local test process'],
    grantOptions: ['approve_once', 'same_command', 'full_access'],
    recommendedGrant: 'approve_once' as const,
  };

  const request: PendingToolRequest = {
    id: 'call-1',
    name: 'shell_execute' as const,
    args: { command: 'bun test', intent: 'verify' as const },
    reason: 'Run verification',
    protectedCommand: 'bun test',
  };

  test('parses provider-neutral JSON suggestions', async () => {
    const result = await reviewToolApproval({
      model: {
        async invoke() {
          return new AIMessage(
            JSON.stringify({
              approved: true,
              grant: 'approve_once',
              reason: 'Local verification is appropriate.',
            }),
          );
        },
      },
      payload,
      request,
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.suggestion?.approved).toBe(true);
    expect(result.suggestion?.grant).toBe('approve_once');
  });

  test('rejects unsupported grants from the reviewer', async () => {
    const result = await reviewToolApproval({
      model: {
        async invoke() {
          return new AIMessage(
            JSON.stringify({ approved: true, grant: 'full_access', reason: 'too broad' }),
          );
        },
      },
      payload: { ...payload, grantOptions: ['approve_once'] },
      request,
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unsupported grant');
  });
});

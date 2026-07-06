import { describe, expect, test } from 'bun:test';
import { AIMessage } from '@langchain/core/messages';
import { parseArgs } from '../../src/app/cli/index';
import { type AgentConfig, configSchema } from '../../src/core/config/index';
import {
  createAutoReviewModel,
  resolveAutoReviewConfig,
  reviewToolApproval,
} from '../../src/core/execution/reviewer';
import { routeAfterAgent } from '../../src/core/harness/routes';
import type { CodeAgentState } from '../../src/core/harness/state';
import type { ToolApprovalPayload } from '../../src/core/harness/tool-policy';
import type { PendingToolRequest } from '../../src/core/harness/tool-requests';
import { runApprovedTool } from '../../src/core/harness/tool-runner';

describe('interaction mode', () => {
  test('config accepts provider-neutral interaction and auto review settings', () => {
    const parsed = configSchema.parse({
      interactionMode: 'full',
      autoReview: { provider: 'openai-compatible', model: 'fast-model', timeoutMs: 1000 },
    });

    expect(parsed.interactionMode).toBe('full');
    expect(parsed.autoReview?.model).toBe('fast-model');
  });

  test('cli parses interaction mode flags', () => {
    expect(parseArgs(['run', '--full', '--task', 'x']).interactionMode).toBe('full');
    expect(parseArgs(['run', '--auto', '--task', 'x']).interactionMode).toBe('auto');
    expect(parseArgs(['run', '--ask', '--task', 'x']).interactionMode).toBe('ask');
  });

  test('full ask_user routes to tools instead of user_input interrupt', () => {
    const state = {
      workspace: '/tmp/workspace',
      workspaceAccess: 'write',
      phase: 'building',
      threadId: 'thread-1',
      authorization: { mode: 'default', commandGrants: {} },
      interactionMode: 'full',
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

  test('rejects response without valid JSON', async () => {
    const result = await reviewToolApproval({
      model: {
        async invoke() {
          return new AIMessage('not json at all');
        },
      },
      payload,
      request,
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('did not return JSON');
  });

  test('rejects response with approved: false', async () => {
    const result = await reviewToolApproval({
      model: {
        async invoke() {
          return new AIMessage(
            JSON.stringify({ approved: false, grant: 'approve_once', reason: 'not safe' }),
          );
        },
      },
      payload,
      request,
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.suggestion?.approved).toBe(false);
  });

  test('handles model invoke error gracefully', async () => {
    const result = await reviewToolApproval({
      model: {
        async invoke() {
          throw new Error('network error');
        },
      },
      payload,
      request,
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('network error');
  });

  test('handles model returning non-string content', async () => {
    const result = await reviewToolApproval({
      model: {
        async invoke() {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ approved: true, grant: 'approve_once', reason: 'ok' }),
              },
            ],
          };
        },
      },
      payload,
      request,
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.suggestion?.approved).toBe(true);
  });
});

// ── resolveAutoReviewConfig and createAutoReviewModel ──

describe('resolveAutoReviewConfig', () => {
  const baseConfig: AgentConfig = {
    apiKey: 'test-key',
    baseURL: 'https://test.example.com',
    modelName: 'deepseek-v4-flash',
    providerName: 'deepseek',
    providerType: 'deepseek',
    sandbox: { enabled: true },
  };

  test('falls back to main model provider and name when autoReview has none', () => {
    const result = resolveAutoReviewConfig(baseConfig);
    expect(result.providerName).toBe('deepseek');
    expect(result.modelName).toBe('deepseek-v4-flash');
  });

  test('uses autoReview.provider when specified', () => {
    const result = resolveAutoReviewConfig({
      ...baseConfig,
      autoReview: { provider: 'openai' },
    });
    expect(result.providerName).toBe('openai');
    expect(result.modelName).toBe('deepseek-v4-flash'); // unchanged
  });

  test('uses autoReview.model when specified', () => {
    const result = resolveAutoReviewConfig({
      ...baseConfig,
      autoReview: { model: 'fast-model' },
    });
    expect(result.providerName).toBe('deepseek'); // unchanged
    expect(result.modelName).toBe('fast-model');
  });

  test('uses both autoReview.provider and autoReview.model when specified', () => {
    const result = resolveAutoReviewConfig({
      ...baseConfig,
      autoReview: { provider: 'openai', model: 'gpt-4o-mini' },
    });
    expect(result.providerName).toBe('openai');
    expect(result.modelName).toBe('gpt-4o-mini');
  });

  test('preserves other config fields', () => {
    const result = resolveAutoReviewConfig({
      ...baseConfig,
      reasoningEffort: 'max',
      autoReview: { model: 'fast' },
    });
    expect(result.reasoningEffort).toBe('max');
    expect(result.apiKey).toBe('test-key');
  });
});

describe('createAutoReviewModel', () => {
  test('returns a model instance with overridden config', () => {
    const config: AgentConfig = {
      apiKey: 'test-key',
      baseURL: 'https://test.example.com/v1',
      modelName: 'deepseek-v4-pro',
      providerName: 'deepseek',
      providerType: 'deepseek',
      sandbox: { enabled: true },
      autoReview: { model: 'deepseek-v4-flash' },
    };
    // createAutoReviewModel returns a SupportedChatModel — just verify it does not throw
    const model = createAutoReviewModel(config);
    expect(model).toBeDefined();
    expect(typeof (model as any).invoke).toBe('function');
  });
});

// ── Config schema boundary tests ──

describe('interactionMode config schema validation', () => {
  test('accepts ask', () => {
    expect(configSchema.parse({ interactionMode: 'ask' }).interactionMode).toBe('ask');
  });

  test('accepts auto', () => {
    expect(configSchema.parse({ interactionMode: 'auto' }).interactionMode).toBe('auto');
  });

  test('accepts full', () => {
    expect(configSchema.parse({ interactionMode: 'full' }).interactionMode).toBe('full');
  });

  test('rejects invalid interactionMode value', () => {
    expect(() => configSchema.parse({ interactionMode: 'invalid' as any })).toThrow();
  });

  test('rejects uppercase AUTO', () => {
    expect(() => configSchema.parse({ interactionMode: 'AUTO' as any })).toThrow();
  });

  test('rejects empty string', () => {
    expect(() => configSchema.parse({ interactionMode: '' as any })).toThrow();
  });

  test('allows undefined interactionMode (optional field)', () => {
    const result = configSchema.parse({});
    expect(result.interactionMode).toBeUndefined();
  });
});

// ── Full mode execution-level ask_user rejection ──

describe('full mode execution-level ask_user rejection', () => {
  test('runApprovedTool rejects ask_user with FULL_NO_USER_INTERACTION reasonCode', async () => {
    const result = await runApprovedTool({
      workspace: '/tmp/ws',
      threadId: 't1',
      request: {
        name: 'ask_user',
        args: { question: 'What should I do?', options: [], allow_free_text: true },
        reason: 'need clarification',
        protectedCommand: 'ask_user',
      },
      interactionMode: 'full',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('rejected');
    const stderr = JSON.parse(result.stderr);
    expect(stderr.rejected).toBe(true);
    expect(stderr.replan.reasonCode).toBe('FULL_NO_USER_INTERACTION');
    expect(stderr.replan.blockedCapability).toBe('ask_user');
  });

  test('runApprovedTool does NOT reject ask_user in ask mode (plain text stderr)', async () => {
    const result = await runApprovedTool({
      workspace: '/tmp/ws',
      threadId: 't1',
      request: {
        name: 'ask_user',
        args: { question: 'What should I do?', options: [], allow_free_text: true },
        reason: 'need clarification',
        protectedCommand: 'ask_user',
      },
      interactionMode: 'ask',
    });

    expect(result.ok).toBe(false);
    // In ask mode, the rejection message is a plain-text instruction (not structured JSON)
    expect(result.stderr).toContain('user_input interrupt node');
    expect(result.stderr).not.toContain('FULL_NO_USER_INTERACTION');
  });

  test('runApprovedTool does NOT reject ask_user in auto mode (plain text stderr)', async () => {
    const result = await runApprovedTool({
      workspace: '/tmp/ws',
      threadId: 't1',
      request: {
        name: 'ask_user',
        args: { question: 'What should I do?', options: [], allow_free_text: true },
        reason: 'need clarification',
        protectedCommand: 'ask_user',
      },
      interactionMode: 'auto',
    });

    expect(result.ok).toBe(false);
    // In auto mode, the rejection message is also a plain-text instruction
    expect(result.stderr).toContain('user_input interrupt node');
    expect(result.stderr).not.toContain('FULL_NO_USER_INTERACTION');
  });
});

// ── Route: auto mode still routes ask_user to user_input ──

describe('routeAfterAgent interaction mode routing', () => {
  function makeState(overrides: Partial<CodeAgentState> = {}): CodeAgentState {
    return {
      workspace: '/tmp/workspace',
      workspaceAccess: 'write',
      phase: 'building',
      threadId: 'thread-1',
      userId: 'test',
      authorization: { mode: 'default' as const, commandGrants: {} },
      interactionMode: 'ask',
      messages: [],
      approvedBatch: {},
      approvedToolRequest: null,
      approvedToolGrant: null,
      executionEnvironment: 'local_unsafe' as const,
      executionJournal: [],
      exhaustedFingerprints: {},
      pendingSubagentApproval: null,
      contextBudget: undefined,
      plan: null,
      planReviewed: false,
      final: '',
      modelProvider: '',
      modelName: '',
      thinkingLevel: null,
      activeSkillInstructions: '',
      ...overrides,
    } as CodeAgentState;
  }

  test('auto mode routes ask_user to user_input (does not skip)', () => {
    const state = makeState({
      interactionMode: 'auto',
      messages: [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call-1', name: 'ask_user', args: { question: 'Q?' } }],
        }),
      ],
    });
    expect(routeAfterAgent(state)).toBe('user_input');
  });

  test('ask mode routes ask_user to user_input', () => {
    const state = makeState({
      interactionMode: 'ask',
      messages: [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call-1', name: 'ask_user', args: { question: 'Q?' } }],
        }),
      ],
    });
    expect(routeAfterAgent(state)).toBe('user_input');
  });

  test('full mode skips ask_user, routes write_file to approval', () => {
    const state = makeState({
      interactionMode: 'full',
      messages: [
        new AIMessage({
          content: '',
          tool_calls: [
            { id: 'call-1', name: 'ask_user', args: { question: 'Q?' } },
            { id: 'call-2', name: 'write_file', args: { path: 'test.txt', content: 'hello' } },
          ],
        }),
      ],
    });
    // ask_user is skipped, write_file requires approval → routes to 'approval'
    expect(routeAfterAgent(state)).toBe('approval');
  });

  test('full mode with only ask_user routes to tools (all skipped)', () => {
    const state = makeState({
      interactionMode: 'full',
      messages: [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call-1', name: 'ask_user', args: { question: 'Q?' } }],
        }),
      ],
    });
    expect(routeAfterAgent(state)).toBe('tools');
  });

  test('full mode with read_file (no approval needed) routes to tools', () => {
    const state = makeState({
      interactionMode: 'full',
      messages: [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call-1', name: 'read_file', args: { path: 'test.txt' } }],
        }),
      ],
    });
    expect(routeAfterAgent(state)).toBe('tools');
  });
});

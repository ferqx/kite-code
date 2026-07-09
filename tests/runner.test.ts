import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { createPromptCacheStandardTracker } from '../src/core/cache-metrics';
import type { AgentConfig } from '../src/core/config/index';
import type { SupportedChatModel } from '../src/core/model/factory';
import { BunSqliteSaver } from '../src/core/persistence/checkpoint';
import {
  chunkToEvents,
  initialAgentPhaseForAccess,
  initialWorkspaceAccessForTask,
  isRecoverableError,
  normalizeGraphStream,
  runAgent,
  taskMessageForInitialAccess,
} from '../src/core/runner';
import type { ModelRetryEvent } from '../src/core/types';
import type { AgentEvent } from '../src/protocol/index';
import { StreamingMockModel } from './mock-model';

const fakeConfig: AgentConfig = {
  providerName: 'fake',
  providerType: 'openai-compatible',
  apiKey: 'noop',
  baseURL: 'http://localhost:9999',
  modelName: 'fake',
  sandbox: { enabled: true },
};

function tempWorkspace(prefix: string): string {
  const root = join(
    tmpdir(),
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  );
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

async function collectRunAgentEvents(input: {
  task: string;
  threadId: string;
  workspace: string;
  checkpointPath: string;
  model: StreamingMockModel;
}): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const provider = {
    onEvent(event: AgentEvent): void {
      events.push(event);
    },
    async requestAction() {
      return { type: 'cancel' as const };
    },
    submitAction() {},
    reset() {},
  };

  const generator = runAgent(provider, {
    task: input.task,
    userId: 'test-user',
    threadId: input.threadId,
    workspace: input.workspace,
    checkpointPath: input.checkpointPath,
    config: fakeConfig,
    model: input.model as unknown as SupportedChatModel,
  });
  for await (const _ of generator) {
  }
  return events;
}

// 测试 runner 的初始工作区访问权限选择逻辑 / Test runner initial workspace access selection logic
describe('runner initial workspace access selection', () => {
  // 验证所有任务以 write 工作区访问启动 / Verify all tasks start with write workspace access
  test('starts tasks with write workspace access', () => {
    expect(initialWorkspaceAccessForTask('/plan Create hello.txt')).toBe('write');
    expect(initialWorkspaceAccessForTask('   /plan inspect repo first')).toBe('write');
  });

  // 验证 initialWorkspaceAccessForTask 始终返回 write / Verify always returns write
  test('always returns write workspace access', () => {
    expect(initialWorkspaceAccessForTask('Create hello.txt', 'write')).toBe('write');
    expect(initialWorkspaceAccessForTask('Create hello.txt', 'builder')).toBe('write');
    expect(initialWorkspaceAccessForTask('Create hello.txt', 'auto')).toBe('write');
  });

  // 验证初始 phase 始终为 building / Verify initial phase is always building
  test('derives initial agent phase from workspace access', () => {
    expect(initialAgentPhaseForAccess('write')).toBe('building');
  });

  // 验证 auto 模式不再用启发式切换到只读，让模型自主决定是否调用 update_plan / Verify auto mode no longer heuristically switches to read-only
  test('leaves natural-language planning requests with write access in auto mode', () => {
    expect(initialWorkspaceAccessForTask('先计划，不要改代码，检查 graph 模式')).toBe('write');
    expect(initialWorkspaceAccessForTask('只计划一下实现方案，不要改文件')).toBe('write');
    expect(initialWorkspaceAccessForTask('Plan first and do not edit files yet')).toBe('write');
  });

  // 验证初始访问权限不会改写用户任务文本 / Verify initial access does not rewrite user task text
  test('keeps initial task messages unchanged', () => {
    expect(taskMessageForInitialAccess('先计划，不要改代码', 'write')).toBe('先计划，不要改代码');
    expect(taskMessageForInitialAccess('/plan inspect', 'write')).toBe('/plan inspect');
    expect(taskMessageForInitialAccess('Create hello.txt', 'write')).toBe('Create hello.txt');
  });

  // 验证普通任务默认使用可写工作区访问 / Verify normal tasks default to write workspace access
  test('starts non-plan tasks with write workspace access', () => {
    expect(initialWorkspaceAccessForTask('Create hello.txt')).toBe('write');
    expect(initialWorkspaceAccessForTask('')).toBe('write'); // 空任务也走 write / Empty task also uses write
  });
});

describe('normalizeGraphStream model retry events', () => {
  test('drains RuntimeEvent projections emitted while graph stream is consumed', async () => {
    const pendingRuntimeEvents: AgentEvent[] = [];
    const runtimePump = {
      drain(): AgentEvent[] {
        return pendingRuntimeEvents.splice(0);
      },
    };

    async function* mockStream() {
      pendingRuntimeEvents.push({
        type: 'tool_call',
        data: {
          call_id: 'call-queued',
          name: 'shell_execute',
          args: { command: 'echo queued' },
          status: 'queued',
        },
      });
      yield { agent: { messages: [] } };

      pendingRuntimeEvents.push({
        type: 'tool_started',
        data: { call_id: 'call-queued' },
      });
      yield { tools: { messages: [] } };
    }

    const events: AgentEvent[] = [];
    for await (const event of normalizeGraphStream(mockStream(), undefined, runtimePump as any)) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      'tool_call',
      'update',
      'tool_started',
      'update',
    ]);
    expect(events[0]).toEqual({
      type: 'tool_call',
      data: {
        call_id: 'call-queued',
        name: 'shell_execute',
        args: { command: 'echo queued' },
        status: 'queued',
      },
    });
  });

  test('yields model_retry events when agent chunk contains modelRetries', async () => {
    const retries: ModelRetryEvent[] = [
      { attempt: 1, maxAttempts: 5, error: 'ECONNRESET', delayMs: 500 },
      { attempt: 2, maxAttempts: 5, error: 'ECONNRESET', delayMs: 1000 },
    ];

    async function* mockStream() {
      yield {
        agent: {
          messages: [{ type: 'ai', content: 'done' }],
          modelRetries: retries,
        },
      };
    }

    const events: AgentEvent[] = [];
    for await (const event of normalizeGraphStream(mockStream())) {
      events.push(event);
    }

    const retryEvents = events.filter(
      (e): e is AgentEvent & { type: 'model_retry'; data: ModelRetryEvent } =>
        e.type === 'model_retry',
    );
    expect(retryEvents).toHaveLength(2);
    expect(retryEvents[0]!.data).toEqual(retries[0]!);
    expect(retryEvents[1]!.data).toEqual(retries[1]!);
  });

  test('does not yield model_retry when chunk has no modelRetries', async () => {
    async function* mockStream() {
      yield {
        agent: {
          messages: [{ type: 'ai', content: 'done' }],
        },
      };
    }

    const events: AgentEvent[] = [];
    for await (const event of normalizeGraphStream(mockStream())) {
      events.push(event);
    }

    const retryEvents = events.filter((e) => e.type === 'model_retry');
    expect(retryEvents).toHaveLength(0);
  });

  test('yields model_retry events correctly ordered (before cache_metrics when applicable)', async () => {
    const retries: ModelRetryEvent[] = [
      { attempt: 1, maxAttempts: 5, error: '500 Internal Error', delayMs: 500 },
    ];

    async function* mockStream() {
      yield {
        agent: {
          modelRetries: retries,
        },
      };
    }

    const events: Array<{ type: string }> = [];
    for await (const event of normalizeGraphStream(mockStream())) {
      events.push({ type: event.type });
    }

    // update always comes first, then model_retry
    expect(events.map((e) => e.type)).toEqual(['update', 'model_retry']);
  });
});

describe('runAgent multi-turn checkpoint continuation', () => {
  test('runs a second user task on the same completed thread', async () => {
    const workspace = tempWorkspace('kite-code-runner-multiturn');
    try {
      const checkpointPath = join(workspace, 'checkpoint.db');
      const threadId = 'same-thread';
      const model = new StreamingMockModel({
        responses: [
          { message: new AIMessage({ content: 'first response', id: 'm1' }) },
          { message: new AIMessage({ content: 'second response', id: 'm2' }) },
        ],
      });

      const firstEvents = await collectRunAgentEvents({
        task: 'first user task',
        threadId,
        workspace,
        checkpointPath,
        model,
      });
      const secondEvents = await collectRunAgentEvents({
        task: 'second user task',
        threadId,
        workspace,
        checkpointPath,
        model,
      });

      expect(model.callCount).toBe(2);
      expect(
        firstEvents.some((e) => e.type === 'text' && e.data.text.includes('first response')),
      ).toBe(true);
      expect(
        secondEvents.some((e) => e.type === 'text' && e.data.text.includes('second response')),
      ).toBe(true);

      const saver = new BunSqliteSaver(checkpointPath);
      try {
        const tuple = await saver.getTuple({ configurable: { thread_id: threadId } });
        const rawMessages = tuple?.checkpoint.channel_values?.messages;
        const messages = Array.isArray(rawMessages) ? (rawMessages as unknown[]) : [];
        expect(messages.map((m) => messageType(m))).toEqual(['human', 'ai', 'human', 'ai']);
        expect(messages.map((m) => messageContent(m))).toEqual([
          'first user task',
          'first response',
          'second user task',
          'second response',
        ]);
      } finally {
        saver.close();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('emits assistant text before plan review interrupt for tool-call responses', async () => {
    const workspace = tempWorkspace('kite-code-runner-plan-order');
    try {
      const checkpointPath = join(workspace, 'checkpoint.db');
      const threadId = 'plan-order-thread';
      const model = new StreamingMockModel({
        responses: [
          {
            message: new AIMessage({
              content: 'I will draft the plan first.',
              id: 'm1',
              tool_calls: [
                {
                  id: 'plan-call-1',
                  name: 'update_plan',
                  args: {
                    name: 'Plan order',
                    description: 'Verify TUI event ordering.',
                    status: 'pending',
                    steps: [{ step: 'Review event order', status: 'pending' }],
                  },
                },
              ],
            }),
          },
        ],
      });

      const events = await collectRunAgentEvents({
        task: 'make a plan',
        threadId,
        workspace,
        checkpointPath,
        model,
      });

      const textIndexes = events
        .map((event, index) =>
          event.type === 'text' && event.data.text === 'I will draft the plan first.' ? index : -1,
        )
        .filter((index) => index >= 0);
      const planReviewIndex = events.findIndex((event) => event.type === 'need_plan_review');

      expect(textIndexes).toHaveLength(1);
      expect(planReviewIndex).toBeGreaterThan(-1);
      expect(textIndexes[0]!).toBeLessThan(planReviewIndex);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

function messageType(message: unknown): string {
  const maybe = message as { _getType?: () => string; getType?: () => string };
  return maybe._getType?.() ?? maybe.getType?.() ?? '';
}

function messageContent(message: unknown): string {
  const maybe = message as { content?: unknown };
  return typeof maybe.content === 'string' ? maybe.content : '';
}

describe('chunkToEvents final dedup', () => {
  const cacheStandard = createPromptCacheStandardTracker();

  test('emits final even when text content is identical', () => {
    const ai = new AIMessage({ content: 'hello world' });
    const chunk = {
      agent: {
        messages: [ai],
        final: 'hello world',
      },
    };

    const events = chunkToEvents(chunk, 'write', cacheStandard);
    expect(events.filter((e) => e.type === 'text')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'final')).toHaveLength(1);
    expect(events.find((e) => e.type === 'final')?.data).toBe('hello world');
  });

  test('emits final when its content differs from text events', () => {
    const ai = new AIMessage({ content: 'actual response' });
    const chunk = {
      agent: {
        messages: [ai],
        final: 'summary of the full conversation',
      },
    };

    const events = chunkToEvents(chunk, 'write', cacheStandard);
    expect(events.filter((e) => e.type === 'text')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'final')).toHaveLength(1);
  });

  test('emits final when there are no text events', () => {
    const chunk = {
      agent: {
        final: 'done',
      },
    };

    const events = chunkToEvents(chunk, 'write', cacheStandard);
    expect(events.filter((e) => e.type === 'final')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'final')[0]!.data).toBe('done');
  });

  test('emits final when text events have different content', () => {
    const ai1 = new AIMessage({ content: 'step 1' });
    const ai2 = new AIMessage({ content: 'step 2' });
    const chunk = {
      agent: {
        messages: [ai1, ai2],
        final: 'unique summary',
      },
    };

    const events = chunkToEvents(chunk, 'write', cacheStandard);
    expect(events.filter((e) => e.type === 'text')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'final')).toHaveLength(1);
  });
});

describe('chunkToEvents event ordering (Phase B)', () => {
  const cacheStandard = createPromptCacheStandardTracker();

  test('final emitted before step_end for agent node', () => {
    const chunk = { agent: { messages: [], final: 'summary' } };
    const events = chunkToEvents(chunk, 'write', cacheStandard);
    const types = events.map((e) => e.type);

    const stepBeginIdx = types.indexOf('step_begin');
    const finalIdx = types.indexOf('final');
    const stepEndIdx = types.lastIndexOf('step_end');

    expect(stepBeginIdx).toBeLessThan(finalIdx);
    expect(finalIdx).toBeLessThan(stepEndIdx);
  });

  test('cache_metrics emitted before step_end for agent node', () => {
    const aiMsg = new AIMessage({
      content: 'ok',
      response_metadata: {
        usage: {
          prompt_tokens: 100,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 20,
        },
      },
    });
    const chunk = { agent: { messages: [aiMsg] } };
    const events = chunkToEvents(chunk, 'write', cacheStandard);

    const types = events.map((e) => e.type);
    const cacheIdx = types.indexOf('cache_metrics');
    const stepEndIdx = types.lastIndexOf('step_end');

    expect(cacheIdx).toBeGreaterThan(-1);
    expect(cacheIdx).toBeLessThan(stepEndIdx);
  });

  test('final not emitted for non-agent nodes', () => {
    // findFinal only looks in agent/agent_plan/agent_build keys
    const chunk = { tools: { messages: [], final: 'should not appear' } };
    const events = chunkToEvents(chunk, 'write', cacheStandard);
    expect(events.filter((e) => e.type === 'final')).toHaveLength(0);
  });

  test('final emitted once with multiple agent-type keys', () => {
    const chunk = {
      agent: { messages: [], final: 'first' },
      agent_plan: { messages: [], final: 'second' },
    };
    const events = chunkToEvents(chunk, 'write', cacheStandard);
    const finals = events.filter((e) => e.type === 'final');
    expect(finals).toHaveLength(1);
    expect((finals[0] as unknown as { data: string }).data).toBe('first');
  });

  test('spanId generated per node and shared by begin/end', () => {
    const chunk = { agent: { messages: [] } };
    const events = chunkToEvents(chunk, 'write', cacheStandard);
    const begin = events.find((e) => e.type === 'step_begin') as unknown as {
      data: { spanId: string };
    };
    const end = events.find((e) => e.type === 'step_end') as unknown as {
      data: { spanId: string };
    };
    expect(begin!.data.spanId).toBe(end!.data.spanId);
  });
});

// ── checkpointer close 安全测试 / checkpointer close safety test ──
// 验证 BunSqliteSaver 的 isClosed 守卫正确工作，确保 abort 后 close() 不崩溃
describe('checkpointer close safety', () => {
  test('close() is safe to call multiple times (no throw)', async () => {
    const { BunSqliteSaver } = await import('../src/core/persistence/checkpoint');
    const saver = new BunSqliteSaver(':memory:');
    saver.close();
    // 第二次 close() 不应抛出异常 / Second close() should not throw
    expect(() => saver.close()).not.toThrow();
  });
});

describe('isRecoverableError', () => {
  test('returns true for ETIMEDOUT', () => {
    expect(isRecoverableError(new Error('connect ETIMEDOUT'))).toBe(true);
  });

  test('returns true for ECONNRESET', () => {
    expect(isRecoverableError(new Error('read ECONNRESET'))).toBe(true);
  });

  test('returns true for 429', () => {
    expect(isRecoverableError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
  });

  test('returns true for 502/503', () => {
    expect(isRecoverableError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isRecoverableError(new Error('502 Bad Gateway'))).toBe(true);
  });

  test('returns true for overloaded', () => {
    expect(isRecoverableError(new Error('Model overloaded'))).toBe(true);
  });

  test('returns true for timeout', () => {
    expect(isRecoverableError(new Error('Request timeout'))).toBe(true);
  });

  test('returns true for rate limit text', () => {
    expect(isRecoverableError(new Error('Rate limit exceeded'))).toBe(true);
  });

  test('returns false for AbortError', () => {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    expect(isRecoverableError(err)).toBe(false);
  });

  test('returns false for config errors', () => {
    expect(isRecoverableError(new Error("Model provider 'x' requires apiKey"))).toBe(false);
  });

  test('returns false for non-Error types', () => {
    expect(isRecoverableError('some string')).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(isRecoverableError(new Error('ETIMEDOUT'))).toBe(true);
    expect(isRecoverableError(new Error('Rate Limit'))).toBe(true);
  });
});

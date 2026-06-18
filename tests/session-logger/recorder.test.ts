// tests/session-logger/recorder.test.ts
// 验证 AgentEvent → TraceRecord 全量映射，包括内容记录

import { describe, expect, test } from 'bun:test';
import { recordEvent } from '@/core/session-logger/recorder';

const TRACE = 'aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb';
const PARENT = 'cccccccccccccccc';

describe('recordEvent — 全量映射', () => {
  test('step_begin / step_end', () => {
    const r1 = recordEvent(
      { type: 'step_begin', data: { node: 'agent', spanId: '0000111122223333' } },
      TRACE,
      PARENT,
    );
    expect(r1.name).toBe('node.agent');
    expect(r1.kind).toBe(3); // CLIENT
    expect(r1.traceId).toBe(TRACE);
    expect(r1.parentSpanId).toBe(PARENT);
    expect(r1.attributes['openpx.node']).toBe('agent');

    const r2 = recordEvent(
      { type: 'step_end', data: { node: 'agent', spanId: '0000111122223333' } },
      TRACE,
      PARENT,
    );
    expect(r2.name).toBe('node.agent.end');
    expect(r2.attributes['openpx.node']).toBe('agent');
  });

  test('text — 记录实际内容而非仅长度', () => {
    const r = recordEvent({ type: 'text', data: { text: 'hello world' } }, TRACE, PARENT);
    expect(r.name).toBe('text');
    expect(r.attributes['openpx.text.length']).toBe(11);
    expect(r.attributes['openpx.text.content']).toBe('hello world');
  });

  test('reason — 记录实际推理内容', () => {
    const r = recordEvent(
      { type: 'reason', data: { text: 'Let me think about this...' } },
      TRACE,
      PARENT,
    );
    expect(r.name).toBe('reason');
    expect(r.attributes['openpx.reason.length']).toBe(26);
    expect(r.attributes['openpx.reason.content']).toBe('Let me think about this...');
  });

  test('text 超长内容截断', () => {
    const longText = 'x'.repeat(15_000);
    const r = recordEvent({ type: 'text', data: { text: longText } }, TRACE, PARENT);
    const content = r.attributes['openpx.text.content'] as string;
    expect(content.length).toBeLessThan(longText.length);
    expect(content).toContain('(truncated');
    expect(r.attributes['openpx.text.length']).toBe(15_000);
  });

  test('tool_call — 记录工具参数', () => {
    const r = recordEvent(
      {
        type: 'tool_call',
        data: {
          call_id: 'c1',
          name: 'read_file',
          args: { path: 'src/a.ts', offset: 1, limit: 100 },
        },
      },
      TRACE,
      PARENT,
    );
    expect(r.name).toBe('tool.read_file.call');
    expect(r.attributes['openpx.tool.name']).toBe('read_file');
    expect(r.attributes['openpx.tool.call_id']).toBe('c1');
    const args = JSON.parse(r.attributes['openpx.tool.args'] as string);
    expect(args.path).toBe('src/a.ts');
    expect(args.offset).toBe(1);
  });

  test('tool_done (成功) — 记录 summary', () => {
    const r = recordEvent(
      {
        type: 'tool_done',
        data: {
          call_id: 'c1',
          name: 'read_file',
          ok: true,
          summary: 'line 1\nline 2\nline 3',
          totalLines: 42,
        },
      },
      TRACE,
      PARENT,
    );
    expect(r.name).toBe('tool.read_file');
    expect(r.attributes['openpx.tool.ok']).toBe(true);
    expect(r.attributes['openpx.tool.total_lines']).toBe(42);
    expect(r.attributes['openpx.tool.summary']).toBe('line 1\nline 2\nline 3');
    expect(r.status.code).toBe('OK');
  });

  test('tool_done (失败) — 含 failure_reason + error event', () => {
    const r = recordEvent(
      {
        type: 'tool_done',
        data: {
          call_id: 'c1',
          name: 'shell_execute',
          ok: false,
          summary: 'command not found: jest',
        },
      },
      TRACE,
      PARENT,
    );
    expect(r.name).toBe('tool.shell_execute');
    expect(r.status.code).toBe('ERROR');
    expect(r.attributes['openpx.tool.failure_reason']).toBe('shell_command_not_found');
    expect(r.attributes['openpx.tool.summary']).toBe('command not found: jest');
    expect(r.events).toBeDefined();
    expect(r.events![0]!.name).toBe('tool.error');
    expect(r.events![0]!.attributes['tool.failure_reason']).toBe('shell_command_not_found');
  });

  test('need_approval — 记录 reason / expectedEffects / modelJustification / objective', () => {
    const r = recordEvent(
      {
        type: 'need_approval',
        data: {
          scope: 'once',
          cwd: '/tmp',
          threadId: 't1',
          tool: 'shell_execute',
          command: 'npm test -- --coverage',
          risk: 'execute_code',
          approvalHash: 'hash',
          summary: 'run tests',
          reason: 'Need to verify changes',
          expectedEffects: ['Runs test suite', 'Generates coverage report'],
          grantOptions: ['approve_once'],
          recommendedGrant: 'approve_once',
          modelJustification: 'Tests must pass before proceeding',
          objective: 'Verify code correctness',
        },
      },
      TRACE,
      PARENT,
    );
    expect(r.name).toBe('approval');
    expect(r.attributes['openpx.approval.tool']).toBe('shell_execute');
    expect(r.attributes['openpx.approval.risk']).toBe('execute_code');
    expect(r.attributes['openpx.approval.command']).toContain('npm test');
    expect(r.attributes['openpx.approval.reason']).toBe('Need to verify changes');
    expect(r.attributes['openpx.approval.expected_effects']).toContain('Runs test suite');
    expect(r.attributes['openpx.approval.model_justification']).toBe(
      'Tests must pass before proceeding',
    );
    expect(r.attributes['openpx.approval.objective']).toBe('Verify code correctness');
  });

  test('need_input — 记录 options 和 context', () => {
    const r = recordEvent(
      {
        type: 'need_input',
        data: {
          question: 'Which library should we use?',
          options: [{ id: 'a', label: 'Option A', description: 'First option' }],
          allow_free_text: true,
          context: 'We need a date formatting library',
        },
      },
      TRACE,
      PARENT,
    );
    expect(r.name).toBe('user_input');
    expect(r.attributes['openpx.input.question']).toBe('Which library should we use?');
    expect(r.attributes['openpx.input.options']).toBeDefined();
    const opts = JSON.parse(r.attributes['openpx.input.options'] as string);
    expect(opts[0].id).toBe('a');
    expect(r.attributes['openpx.input.context']).toBe('We need a date formatting library');
  });

  test('state_change — 记录 plan 和 authorization', () => {
    const r = recordEvent(
      {
        type: 'state_change',
        data: {
          phase: 'building',
          modelProvider: 'deepseek',
          plan: { name: 'my-plan', description: 'test', status: 'in_progress', steps: [] },
          authorization: { mode: 'full_access' },
        },
      },
      TRACE,
      PARENT,
    );
    expect(r.name).toBe('state_change');
    expect(r.attributes['openpx.phase']).toBe('building');
    expect(r.attributes['openpx.authorization_mode']).toBe('full_access');
    expect(r.attributes['openpx.plan']).toBeDefined();
    const plan = JSON.parse(r.attributes['openpx.plan'] as string);
    expect(plan.name).toBe('my-plan');
  });

  test('final — 记录实际内容', () => {
    const r = recordEvent({ type: 'final', data: 'Task completed successfully!' }, TRACE, PARENT);
    expect(r.name).toBe('final');
    expect(r.attributes['openpx.final.length']).toBe(28);
    expect(r.attributes['openpx.final.content']).toBe('Task completed successfully!');
  });

  test('cache_metrics', () => {
    const summary = {
      inputTokens: 150,
      cacheHitTokens: 100,
      cacheMissTokens: 50,
      hitRate: 0.67,
      totalCalls: 1,
      warmupCalls: 0,
      measuredCalls: 1,
      targetHitRate: 0.5,
      minimumMeasuredInputTokens: 100,
      hasEnoughMeasuredTokens: true,
      meetsTarget: true as boolean | null,
    };
    const r = recordEvent(
      {
        type: 'cache_metrics',
        data: {
          workspaceAccess: 'write',
          cacheHitTokens: 100,
          cacheMissTokens: 50,
          inputTokens: 150,
          outputTokens: 30,
          standard: {
            callIndex: 1,
            isWarmup: false,
            includedInStandard: true,
            targetHitRate: 0.5,
            minimumMeasuredInputTokens: 100,
            summary,
          },
        },
      },
      TRACE,
      PARENT,
    );
    expect(r.name).toBe('cache_metrics');
    expect(r.attributes['openpx.cache.hit_tokens']).toBe(100);
  });

  test('model_retry', () => {
    const r = recordEvent(
      {
        type: 'model_retry',
        data: { attempt: 3, maxAttempts: 5, error: 'ETIMEDOUT', delayMs: 2000 },
      },
      TRACE,
      PARENT,
    );
    expect(r.name).toBe('model.retry');
    expect(r.attributes['openpx.retry.attempt']).toBe(3);
    expect(r.events![0]!.name).toBe('model.retry');
    expect(r.events![0]!.attributes['model.retry.error']).toBe('ETIMEDOUT');
  });

  test('error', () => {
    const r = recordEvent(
      {
        type: 'error',
        data: { message: 'something broke', recoverable: false },
      },
      TRACE,
      PARENT,
    );
    expect(r.name).toBe('error');
    expect(r.status.code).toBe('ERROR');
    expect(r.attributes['openpx.error.recoverable']).toBe(false);
    expect(r.attributes['openpx.error.message']).toBe('something broke');
  });

  test('subagent_start / subagent_step / subagent_done / subagent_error — 含内容', () => {
    const r1 = recordEvent(
      {
        type: 'subagent_start',
        data: { id: 'sub-1', role: 'explore', task: 'find all security bugs in the codebase' },
      },
      TRACE,
      PARENT,
    );
    expect(r1.name).toBe('subagent.start');
    expect(r1.attributes['openpx.subagent.role']).toBe('explore');
    expect(r1.attributes['openpx.subagent.task']).toBe('find all security bugs in the codebase');

    const rStep = recordEvent(
      {
        type: 'subagent_step',
        data: { id: 'sub-1', toolName: 'read_file', toolArgs: { path: 'src/a.ts' } },
      },
      TRACE,
      PARENT,
    );
    expect(rStep.name).toBe('subagent.tool.read_file');
    const stepArgs = JSON.parse(rStep.attributes['openpx.tool.args'] as string);
    expect(stepArgs.path).toBe('src/a.ts');

    const r2 = recordEvent(
      {
        type: 'subagent_done',
        data: { id: 'sub-1', summary: 'found 3 critical bugs', toolCallCount: 5, durationMs: 3000 },
      },
      TRACE,
      PARENT,
    );
    expect(r2.name).toBe('subagent.done');
    expect(r2.attributes['openpx.subagent.summary']).toBe('found 3 critical bugs');
    expect(r2.status.code).toBe('OK');

    const r3 = recordEvent(
      {
        type: 'subagent_error',
        data: {
          id: 'sub-1',
          error: 'timeout after 30s',
          summary: 'partially completed',
          toolCallCount: 2,
          durationMs: 10000,
        },
      },
      TRACE,
      PARENT,
    );
    expect(r3.name).toBe('subagent.error');
    expect(r3.status.code).toBe('ERROR');
    expect(r3.attributes['openpx.subagent.summary']).toBe('partially completed');
  });

  test('subagent_tool_result — 记录 summary（成功时）', () => {
    const r = recordEvent(
      {
        type: 'subagent_tool_result',
        data: {
          id: 'sub-1',
          toolName: 'read_file',
          ok: true,
          summary: 'line 1\nline 2',
          durationMs: 15,
        },
      },
      TRACE,
      PARENT,
    );
    expect(r.name).toBe('subagent.tool.read_file.result');
    expect(r.attributes['openpx.tool.ok']).toBe(true);
    expect(r.attributes['openpx.tool.summary']).toBe('line 1\nline 2');
    expect(r.attributes['openpx.tool.duration_ms']).toBe(15);
    expect(r.status.code).toBe('OK');
  });

  test('subagent_cache_metrics', () => {
    const r = recordEvent(
      {
        type: 'subagent_cache_metrics',
        data: { subagentId: 'sub-1', cacheHitTokens: 50, cacheMissTokens: 10, inputTokens: 60 },
      },
      TRACE,
      PARENT,
    );
    expect(r.name).toBe('subagent.cache_metrics');
    expect(r.attributes['openpx.subagent.id']).toBe('sub-1');
    expect(r.attributes['openpx.cache.hit_tokens']).toBe(50);
  });

  test('interrupt / update — 记录原始数据', () => {
    const ri = recordEvent(
      {
        type: 'interrupt',
        data: { value: { kind: 'tool_approval' } },
      },
      TRACE,
      PARENT,
    );
    expect(ri.name).toBe('interrupt');
    expect(ri.attributes['openpx.interrupt.data']).toBeDefined();
    expect(ri.attributes['openpx.interrupt.data'] as string).toContain('tool_approval');

    const ru = recordEvent(
      {
        type: 'update',
        data: { agent: { messages: [] } },
      },
      TRACE,
      PARENT,
    );
    expect(ru.name).toBe('graph.update');
    expect(ru.attributes['openpx.update.data']).toBeDefined();
  });

  test('turn_begin / turn_end', () => {
    const r1 = recordEvent(
      { type: 'turn_begin', data: { index: 1, spanId: 'aaaa1111bbbb2222' } },
      TRACE,
      PARENT,
    );
    expect(r1.name).toBe('agent.turn.begin');
    expect(r1.attributes['openpx.turn.index']).toBe(1);

    const r2 = recordEvent({ type: 'turn_end', data: { index: 2 } }, TRACE, PARENT);
    expect(r2.name).toBe('agent.turn.end');
    expect(r2.attributes['openpx.turn.index']).toBe(2);
  });

  test('user_message — task', () => {
    const r = recordEvent(
      {
        type: 'user_message',
        data: { text: 'Create hello.txt', kind: 'task' },
      },
      TRACE,
      PARENT,
    );
    expect(r.name).toBe('user.task');
    expect(r.attributes['openpx.user.message']).toBe('Create hello.txt');
    expect(r.attributes['openpx.user.kind']).toBe('task');
  });

  test('user_message — answer with interruptType', () => {
    const r = recordEvent(
      {
        type: 'user_message',
        data: { text: 'Yes', kind: 'answer', interruptType: 'approval' },
      },
      TRACE,
      PARENT,
    );
    expect(r.name).toBe('user.answer');
    expect(r.attributes['openpx.user.interrupt_type']).toBe('approval');
  });

  test('step_begin uses spanId from event data', () => {
    const r = recordEvent(
      {
        type: 'step_begin',
        data: { node: 'agent', spanId: 'abc123def4567890' },
      },
      TRACE,
      PARENT,
    );
    expect(r.spanId).toBe('abc123def4567890');
  });

  test('step_begin records internal flag', () => {
    const r = recordEvent(
      {
        type: 'step_begin',
        data: { node: 'cleanup', spanId: 'abc123', internal: true },
      },
      TRACE,
      PARENT,
    );
    expect(r.attributes['openpx.internal']).toBe(true);
  });

  test('step_begin without internal flag does not record it', () => {
    const r = recordEvent(
      {
        type: 'step_begin',
        data: { node: 'agent', spanId: 'abc123' },
      },
      TRACE,
      PARENT,
    );
    expect(r.attributes['openpx.internal']).toBeUndefined();
  });

  test('每条记录都有唯一 spanId (auto-generated for non-step events)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const r = recordEvent({ type: 'text', data: { text: `msg${i}` } }, TRACE, PARENT);
      expect(ids.has(r.spanId)).toBe(false);
      ids.add(r.spanId);
    }
  });
});

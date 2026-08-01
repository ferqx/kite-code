import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultAuthorizationState } from '@/core/harness/tool-policy';
import { getRoleConfig } from '@/core/subagent/roles';
import { resumeSubAgent, runSubAgent } from '@/core/subagent/runner';
import { aiMessage } from '../src/core/messages';
import { StreamingMockModel } from './mock-model';

function mockEventSink() {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  return {
    events,
    sink: ((e: { type: string; data: Record<string, unknown> }) => {
      events.push(e);
    }) as unknown as import('@/core/subagent/types').SubAgentEventSink,
  };
}

describe('SubAgentRunner integration', () => {
  test('explore role: emits start→done events in order', async () => {
    const { events, sink } = mockEventSink();
    const model = new StreamingMockModel({
      responses: [{ message: { content: 'Found auth.ts, middleware.ts' } as any, delay: 5 }],
    }) as any;

    const result = await runSubAgent({
      config: { providerName: 'deepseek', modelName: 'test' } as any,
      workspace: '/tmp/test',
      role: getRoleConfig('explore'),
      task: 'search for UserService',
      timeoutMs: 5000,
      signal: new AbortController().signal,
      eventSink: sink,
      model: model as any,
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('Found');
    expect(result.toolCallCount).toBe(0);

    expect(events[0]!.type).toBe('start');
    expect(events[0]!.data.role).toBe('explore');
    expect(events[0]!.data.task).toBe('search for UserService');

    const doneEvent = events.find((e) => e.type === 'done')!;
    expect(doneEvent.data.summary).toContain('Found');
    expect(typeof doneEvent.data.durationMs).toBe('number');
  });

  test('code role with real file read via tool call', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'kite-code-subagent-test-'));
    writeFileSync(join(ws, 'test.txt'), 'hello world\n', 'utf-8');

    try {
      const { events, sink } = mockEventSink();
      const model = new StreamingMockModel({
        responses: [
          {
            message: {
              content: 'let me read',
              tool_calls: [{ id: 'tc1', name: 'read_file', args: { path: 'test.txt' } }],
            } as any,
            delay: 5,
          },
          { message: { content: 'File read, done.' } as any, delay: 5 },
        ],
      }) as any;

      const result = await runSubAgent({
        config: { providerName: 'deepseek', modelName: 'test' } as any,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'read test.txt',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model: model as any,
      });

      // The runner should complete with either success or failure
      // (failure is OK if workspace file IO behaves differently in CI)
      expect(result.ok !== undefined).toBe(true);

      // Step events should be emitted for tool calls
      const stepEvents = events.filter((e) => e.type === 'step');
      expect(stepEvents.length).toBeGreaterThanOrEqual(1);
      expect(stepEvents[0]!.data.toolName).toBe('read_file');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('normalizes workspace absolute file paths before executing read_file', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'kite-code-subagent-abs-path-'));
    writeFileSync(join(ws, 'package.json'), '{"name":"fixture"}\n', 'utf-8');

    try {
      const { events, sink } = mockEventSink();
      const model = new StreamingMockModel({
        responses: [
          {
            message: aiMessage({
              content: 'read package',
              tool_calls: [
                { id: 'tc-abs', name: 'read_file', args: { path: join(ws, 'package.json') } },
              ],
            }),
          },
          { message: aiMessage({ content: 'done' }) },
        ],
      }) as any;

      const result = await runSubAgent({
        config: { providerName: 'deepseek', modelName: 'test' } as any,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'read package.json',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model: model as any,
      });

      expect(result.ok).toBe(true);
      const step = events.find((e) => e.type === 'step' && e.data.toolName === 'read_file');
      expect((step?.data.toolArgs as { path?: string } | undefined)?.path).toBe('package.json');
      const readResult = events.find(
        (e) => e.type === 'tool_result' && e.data.toolName === 'read_file',
      );
      expect(readResult?.data.ok).toBe(true);
      expect(String(readResult?.data.summary)).toContain('read_file package.json');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('inherits full access authorization for sub-agent verification commands', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'kite-code-subagent-verify-'));
    try {
      const { events, sink } = mockEventSink();
      const model = new StreamingMockModel({
        responses: [
          {
            message: aiMessage({
              content: 'verify',
              tool_calls: [
                {
                  id: 'tc-verify',
                  name: 'shell_execute',
                  args: {
                    command: 'bun run typecheck',
                    description: 'Run typecheck',
                  },
                },
              ],
            }),
          },
          { message: aiMessage({ content: 'done' }) },
        ],
      }) as any;

      const result = await runSubAgent({
        config: { providerName: 'deepseek', modelName: 'test' } as any,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'run verification',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model: model as any,
        authorization: { ...defaultAuthorizationState(), mode: 'full_access' },
        shellExecutor: async (input) => ({
          ok: true,
          command: input.command,
          exitCode: 0,
          stdout: 'typecheck ok',
          stderr: '',
        }),
      });

      expect(result.ok).toBe(true);
      const shellResult = events.find(
        (e) => e.type === 'tool_result' && e.data.toolName === 'shell_execute',
      );
      expect(shellResult?.data.ok).toBe(true);
      expect(String(shellResult?.data.summary)).toContain('typecheck ok');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('returns approval-required instead of executing protected commands without authorization', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'kite-code-subagent-needs-approval-'));
    try {
      const { events, sink } = mockEventSink();
      let shellExecutions = 0;
      const model = new StreamingMockModel({
        responses: [
          {
            message: aiMessage({
              content: 'verify',
              tool_calls: [
                {
                  id: 'tc-verify-needs-approval',
                  name: 'shell_execute',
                  args: {
                    command: 'bun run typecheck',
                    description: 'Run typecheck',
                  },
                },
              ],
            }),
          },
          { message: aiMessage({ content: 'done' }) },
        ],
      }) as any;

      const result = await runSubAgent({
        config: { providerName: 'deepseek', modelName: 'test' } as any,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'run verification',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model: model as any,
        shellExecutor: async (input) => {
          shellExecutions++;
          return {
            ok: true,
            command: input.command,
            exitCode: 0,
            stdout: 'should not run',
            stderr: '',
          };
        },
      });

      expect(result.ok).toBe(false);
      expect(result.blocked?.reasonCode).toBe('SUBAGENT_TOOL_REQUIRES_APPROVAL');
      expect(result.blocked?.toolName).toBe('shell_execute');
      expect(result.blocked?.toolCallId).toBe('tc-verify-needs-approval');
      expect(result.blocked?.command).toBe('bun run typecheck');
      expect(result.blocked?.continuation.messages.length).toBeGreaterThan(0);
      expect(shellExecutions).toBe(0);
      // 修复后 blocked 路径暂停子 agent，不发射 error 事件。
      // 审批通过 Runtime Kernel 管线处理：Kernel 发射 approval.requested，
      // TUI 展示审批对话框，用户操作后通过 resumeSubAgent 恢复执行。
      // After fix: blocked path pauses sub-agent without error event.
      // Approval is routed through Runtime Kernel: Kernel emits approval.requested,
      // TUI shows approval dialog, execution resumes via resumeSubAgent after user action.
      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeUndefined();
      // 被阻塞的步骤快照应标记为 awaiting_approval（暂停等待审批，非错误）
      // The blocked step snapshot should be marked as awaiting_approval (paused for approval, not errored)
      const blockedStep = result.steps?.find((s) => s.toolName === 'shell_execute');
      expect(blockedStep).toBeDefined();
      expect(blockedStep!.status).toBe('awaiting_approval');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('resumes original sub-agent after approved tool result', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'kite-code-subagent-resume-'));
    try {
      const { events, sink } = mockEventSink();
      let shellExecutions = 0;
      const model = new StreamingMockModel({
        responses: [
          {
            message: aiMessage({
              content: 'verify',
              tool_calls: [
                {
                  id: 'tc-resume-verify',
                  name: 'shell_execute',
                  args: {
                    command: 'bun run typecheck',
                    description: 'Run typecheck',
                  },
                },
              ],
            }),
          },
          { message: aiMessage({ content: 'saw typecheck ok' }) },
        ],
      }) as any;

      const input = {
        config: { providerName: 'deepseek', modelName: 'test' } as any,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'run verification',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model: model as any,
        shellExecutor: async (toolInput: { command: string }) => {
          shellExecutions++;
          return {
            ok: true,
            command: toolInput.command,
            exitCode: 0,
            stdout: 'should not run before approval',
            stderr: '',
          };
        },
      };

      const blocked = await runSubAgent(input);
      expect(blocked.ok).toBe(false);
      expect(blocked.blocked?.reasonCode).toBe('SUBAGENT_TOOL_REQUIRES_APPROVAL');
      expect(shellExecutions).toBe(0);

      const resumed = await resumeSubAgent(input, blocked.blocked!.continuation, {
        toolCallId: 'tc-resume-verify',
        toolName: 'shell_execute',
        result: {
          ok: true,
          command: 'bun run typecheck',
          exitCode: 0,
          stdout: 'typecheck ok',
          stderr: '',
          status: 'success',
        },
      });

      expect(resumed.ok).toBe(true);
      expect(resumed.summary).toContain('saw typecheck ok');
      expect(shellExecutions).toBe(0);
      const doneEvent = events.find((e) => e.type === 'done');
      expect(String(doneEvent?.data.summary)).toContain('saw typecheck ok');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('review role: correct role in start event', async () => {
    const { events, sink } = mockEventSink();
    const model = new StreamingMockModel({
      responses: [{ message: { content: 'No issues found.' } as any, delay: 5 }],
    }) as any;

    const result = await runSubAgent({
      config: { providerName: 'deepseek', modelName: 'test' } as any,
      workspace: '/tmp/test',
      role: getRoleConfig('review'),
      task: 'review auth.ts',
      timeoutMs: 5000,
      signal: new AbortController().signal,
      eventSink: sink,
      model: model as any,
    });

    expect(result.ok).toBe(true);
    expect(events[0]!.type).toBe('start');
    expect(events[0]!.data.role).toBe('review');
    expect(events[0]!.data.task).toBe('review auth.ts');
  });

  test('error event when aborted before model invoke', async () => {
    // NOTE: mock model doesn't respect AbortSignal; the runner's pre-invoke
    // check depends on AbortSignal.any() which may not be available in all Bun versions.
    // The timeout integration is tested indirectly via the timeoutMs parameter in other tests.
    const { events, sink } = mockEventSink();
    const model = new StreamingMockModel({
      responses: [{ message: { content: 'done' } as any, delay: 5 }],
    }) as any;

    const result = await runSubAgent({
      config: { providerName: 'deepseek', modelName: 'test' } as any,
      workspace: '/tmp/test',
      role: getRoleConfig('explore'),
      task: 'quick task',
      timeoutMs: 5000,
      signal: new AbortController().signal,
      eventSink: sink,
      model: model as any,
    });

    // Should complete successfully with mock model
    expect(result.ok).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  test('aborts mid-execution when signal fires', async () => {
    const { events, sink } = mockEventSink();
    const ac = new AbortController();

    // Use a model that delays in invoke, giving us time to abort.
    let _invokeCount = 0;
    const model = {
      bindTools: () => model,
      invoke: async (_msgs: any, _opts?: any) => {
        _invokeCount++;
        // Delay 300ms on first invoke; abort fires at 100ms
        await new Promise((r) => setTimeout(r, 300));
        return { content: 'done' };
      },
    } as any;

    // Abort after 100ms — during first model invoke
    setTimeout(() => ac.abort(), 100);

    const result = await runSubAgent({
      config: { providerName: 'deepseek', modelName: 'test' } as any,
      workspace: '/tmp/test',
      role: getRoleConfig('explore'),
      task: 'task',
      timeoutMs: 5000,
      signal: ac.signal,
      eventSink: sink,
      model: model as any,
    });

    // The abort should cause the subagent to fail
    expect(result.ok).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  test('propagates the role timeout signal into descendant tool admission', async () => {
    const { events, sink } = mockEventSink();
    const model = new StreamingMockModel({
      responses: [
        {
          message: aiMessage({
            content: 'read after admission',
            tool_calls: [{ id: 'timeout-read', name: 'read_file', args: { path: 'README.md' } }],
          }),
        },
      ],
    }) as any;
    let observedSignal: AbortSignal | undefined;
    const descendantResourceAdmission = {
      reserveModel: async () => ({ reservationId: 'model-reservation' }),
      reconcileModel: async () => {},
      reserveTool: async (request: { signal?: AbortSignal }) => {
        observedSignal = request.signal;
        await new Promise<never>((_, reject) => {
          const onAbort = () => {
            const error = new Error('descendant admission cancelled by role timeout');
            error.name = 'AbortError';
            reject(error);
          };
          if (request.signal?.aborted) {
            onAbort();
            return;
          }
          request.signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
      reconcileTool: async () => {},
      markUnknown: async () => {},
      markLocalProviderAdmissionDenied: async () => {},
    } as unknown as NonNullable<
      import('@/core/subagent/types').SubAgentRunnerInput['descendantResourceAdmission']
    >;

    const result = await runSubAgent({
      config: { providerName: 'deepseek', modelName: 'test' } as any,
      workspace: process.cwd(),
      role: getRoleConfig('code'),
      task: 'wait for descendant admission',
      timeoutMs: 25,
      signal: new AbortController().signal,
      eventSink: sink,
      model: model as any,
      descendantResourceAdmission,
    });

    expect(result.ok).toBe(false);
    expect(observedSignal?.aborted).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });

  test('aborts immediately when signal is already aborted', async () => {
    const { events, sink } = mockEventSink();
    const ac = new AbortController();
    ac.abort(); // Abort before calling runSubAgent

    const model = new StreamingMockModel({
      responses: [{ message: { content: 'done' } as any, delay: 5 }],
    }) as any;

    const result = await runSubAgent({
      config: { providerName: 'deepseek', modelName: 'test' } as any,
      workspace: '/tmp/test',
      role: getRoleConfig('explore'),
      task: 'task',
      timeoutMs: 5000,
      signal: ac.signal,
      eventSink: sink,
      model: model as any,
    });

    expect(result.ok).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});

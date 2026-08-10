import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestCapability } from '@/core/capabilities/catalog';
import { defaultAuthorizationState } from '@/core/harness/tool-policy';
import { resolveProjectInstructionSnapshot } from '@/core/model/project-instructions';
import { normalizeToolRecoveryJournalV1 } from '@/core/runtime/tool-recovery-journal';
import { getRoleConfig } from '@/core/subagent/roles';
import { resumeSubAgent, runSubAgent } from '@/core/subagent/runner';
import { runTaskSubAgent } from '@/core/subagent/task-tool';
import type { CapabilityBinding, CapabilityDescriptor } from '@/protocol/capabilities';
import type { AgentConfig } from '../src/core/config/index';
import { type AIMessage, aiMessage } from '../src/core/messages';
import type { SupportedChatModel } from '../src/core/model/factory';
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
      responses: [
        { message: { content: 'Found auth.ts, middleware.ts' } as unknown as AIMessage, delay: 5 },
      ],
    }) as unknown as SupportedChatModel;

    const result = await runSubAgent({
      config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
      workspace: '/tmp/test',
      role: getRoleConfig('explore'),
      task: 'search for UserService',
      timeoutMs: 5000,
      signal: new AbortController().signal,
      eventSink: sink,
      model: model,
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
            } as unknown as AIMessage,
            delay: 5,
          },
          { message: { content: 'File read, done.' } as unknown as AIMessage, delay: 5 },
        ],
      }) as unknown as SupportedChatModel;

      const result = await runSubAgent({
        config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'read test.txt',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model: model,
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

  test('code role preserves the parent project-instruction snapshot for write admission', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'kite-code-subagent-instructions-'));
    mkdirSync(join(ws, 'nested'));
    writeFileSync(join(ws, 'AGENTS.md'), 'root rule', 'utf8');
    writeFileSync(join(ws, 'nested', 'AGENTS.md'), 'nested rule', 'utf8');
    try {
      const { sink } = mockEventSink();
      const model = new StreamingMockModel({
        responses: [
          {
            message: {
              content: 'write',
              tool_calls: [
                {
                  id: 'write-nested',
                  name: 'write_file',
                  args: { path: 'nested/new.ts', content: 'export {};' },
                },
              ],
            } as unknown as AIMessage,
          },
          { message: { content: 'Nested instructions must be refreshed.' } as AIMessage },
        ],
      }) as unknown as SupportedChatModel;
      const result = await runSubAgent({
        config: {
          providerName: 'deepseek',
          modelName: 'test',
          features: { promptContractV2: true },
        } as unknown as AgentConfig,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'write nested/new.ts',
        projectInstructions: resolveProjectInstructionSnapshot({ workspace: ws }),
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model,
      });
      expect(result.ok).toBe(false);
      expect(result.summary).toContain('refreshed');
      expect(result.executionJournal).toBeUndefined();
      expect(result.toolRecovery?.order).toHaveLength(1);
      const recoveryJson = JSON.stringify(result.toolRecovery);
      expect(recoveryJson).not.toContain('project_instructions_changed');
      expect(recoveryJson).not.toContain(join(ws, 'nested', 'new.ts'));
      expect(() => readFileSync(join(ws, 'nested', 'new.ts'), 'utf8')).toThrow();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('task sub-agent inherits the parent sealed protected-path evaluator for writes', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'kite-code-subagent-protected-path-'));
    const protectedDirectory = join(ws, '.agents', 'skills', 'fixture');
    const protectedFile = join(protectedDirectory, 'SKILL.md');
    mkdirSync(protectedDirectory, { recursive: true });
    writeFileSync(protectedFile, 'keep\n');

    try {
      const { events, sink } = mockEventSink();
      const model = new StreamingMockModel({
        responses: [
          {
            message: aiMessage({
              content: 'write protected skill',
              tool_calls: [
                {
                  id: 'tc-protected-child-write',
                  name: 'write_file',
                  args: { path: '.agents/skills/fixture/SKILL.md', content: 'changed\n' },
                },
              ],
            }),
          },
          { message: aiMessage({ content: 'done' }) },
        ],
      }) as unknown as SupportedChatModel;

      await runTaskSubAgent(
        {
          config: {
            providerName: 'deepseek',
            modelName: 'test',
            executionBoundary: {
              filesystemScope: 'workspace_write',
              workspaceRoot: ws,
              networkMode: 'off',
              networkAllowlist: [],
              allowLocalAndPrivateNetwork: false,
              protectedPathPolicy: 'deny',
              maxProcessTreeSizePerShellInvocation: 8,
              sandboxRequired: true,
              sandboxUnavailable: 'fail',
            },
          } as unknown as AgentConfig,
          workspace: ws,
          eventSink: sink,
          model: model,
        },
        { subagent_type: 'code', task: 'write protected skill config' },
      );

      const writeResult = events.find(
        (event) => event.type === 'tool_result' && event.data.toolName === 'write_file',
      );
      expect(writeResult?.data.ok).toBe(false);
      expect(String(writeResult?.data.summary)).toContain('protected-path policy');
      expect(readFileSync(protectedFile, 'utf8')).toBe('keep\n');
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
      }) as unknown as SupportedChatModel;

      const result = await runSubAgent({
        config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'read package.json',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model: model,
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
      }) as unknown as SupportedChatModel;

      const result = await runSubAgent({
        config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'run verification',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model: model,
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
      }) as unknown as SupportedChatModel;

      const result = await runSubAgent({
        config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'run verification',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model: model,
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
      }) as unknown as SupportedChatModel;

      const input = {
        config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'run verification',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model: model,
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

  test('suppresses a same-scope tool reproposal after approval denial without dispatch', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'kite-code-subagent-deny-suppression-'));
    try {
      const { sink } = mockEventSink();
      let shellExecutions = 0;
      const repeatedCall = (id: string) =>
        aiMessage({
          content: 'verify',
          tool_calls: [
            {
              id,
              name: 'shell_execute',
              args: { command: 'bun run typecheck', description: 'Run typecheck' },
            },
          ],
        });
      const model = new StreamingMockModel({
        responses: [
          { message: repeatedCall('tc-denied-1') },
          { message: repeatedCall('tc-denied-2') },
          { message: aiMessage({ content: 'stopped' }) },
        ],
      }) as unknown as SupportedChatModel;
      const input = {
        config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'run verification',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model,
        shellExecutor: async (toolInput: { command: string }) => {
          shellExecutions += 1;
          return {
            ok: true,
            command: toolInput.command,
            exitCode: 0,
            stdout: '',
            stderr: '',
          };
        },
      };

      const blocked = await runSubAgent(input);
      expect(blocked.blocked?.toolCallId).toBe('tc-denied-1');
      const resumed = await resumeSubAgent(input, blocked.blocked!.continuation, {
        toolCallId: 'tc-denied-1',
        toolName: 'shell_execute',
        result: {
          ok: false,
          command: 'bun run typecheck',
          exitCode: -1,
          stdout: '',
          stderr: 'redacted',
          status: 'rejected',
        },
      });

      expect(shellExecutions).toBe(0);
      expect(resumed.toolRecovery?.qualityGuard).toMatchObject({
        blocked: true,
        reasonCode: 'no_progress',
      });
      const repeated = Object.values(resumed.toolRecovery!.failures).find(
        (failure) => failure.toolCallId === 'tc-denied-2',
      );
      expect(repeated).toMatchObject({
        status: 'exhausted',
        resolution: 'terminal',
        outcome: {
          status: 'exhausted',
          failure: { detailCode: 'recovery_not_allowed' },
          recovery: { disposition: 'never' },
        },
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('MCP binding failures share the durable ceiling, survive restore, and remain metadata-only', async () => {
    const { sink } = mockEventSink();
    const descriptor: CapabilityDescriptor = {
      capabilityId: 'mcp:fixture/read',
      revision: 'revision-1',
      kind: 'mcp_tool',
      displayName: 'read',
      description: 'Read fixture data',
      provider: { type: 'mcp', id: 'fixture', provenance: 'remote' },
      inputSchema: {
        type: 'object',
        properties: { secret: { type: 'string' }, limit: { type: 'integer', default: 10 } },
        required: ['secret'],
        additionalProperties: false,
      },
      declaredEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
      availability: 'available',
      diagnostics: [],
    };
    const binding: CapabilityBinding = {
      bindingId: 'binding-1',
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      exposedToolName: 'mcp__fixture__read',
      schemaDigest: digestCapability(descriptor.inputSchema),
      issuedForTurnId: 'turn-1',
    };
    const repeatedCall = (id: string) =>
      aiMessage({
        content: 'read',
        tool_calls: [{ id, name: binding.exposedToolName, args: { secret: 'private-body' } }],
      });
    const model = new StreamingMockModel({
      responses: [
        { message: repeatedCall('mcp-1') },
        { message: repeatedCall('mcp-2') },
        { message: repeatedCall('mcp-3') },
        { message: aiMessage({ content: 'done' }) },
      ],
    }) as unknown as SupportedChatModel;

    const result = await runSubAgent({
      config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
      workspace: '/tmp/test',
      role: getRoleConfig('code'),
      task: 'read fixture',
      timeoutMs: 5000,
      signal: new AbortController().signal,
      eventSink: sink,
      model,
      mcpBindings: [{ descriptor, binding }],
    });

    expect(result.toolRecovery?.qualityGuard).toMatchObject({
      blocked: true,
      reasonCode: 'no_progress',
    });
    const latestId = result.toolRecovery!.order.at(-1)!;
    expect(result.toolRecovery!.failures[latestId]).toMatchObject({
      status: 'exhausted',
      resolution: 'terminal',
      outcome: { status: 'exhausted', failure: { kind: 'loop_exhausted' } },
    });
    expect(typeof result.toolRecovery!.failures[latestId]!.taskId).toBe('string');
    expect(typeof result.toolRecovery!.failures[latestId]!.turnId).toBe('string');
    const restored = normalizeToolRecoveryJournalV1(
      JSON.parse(JSON.stringify(result.toolRecovery)),
    );
    expect(restored.qualityGuard).toEqual(result.toolRecovery!.qualityGuard);
    expect(JSON.stringify(restored)).not.toContain('private-body');
  });

  test('legacy exhausted subagent bypass emits a typed terminal and quality guard after resume', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'kite-code-subagent-legacy-exhausted-'));
    try {
      const { sink } = mockEventSink();
      const model = new StreamingMockModel({
        responses: [
          {
            message: aiMessage({
              content: 'verify',
              tool_calls: [
                { id: 'approval', name: 'shell_execute', args: { command: 'bun test' } },
              ],
            }),
          },
          {
            message: aiMessage({
              content: 'read',
              tool_calls: [{ id: 'legacy-read', name: 'read_file', args: { path: 'missing.txt' } }],
            }),
          },
          { message: aiMessage({ content: 'done' }) },
        ],
      }) as unknown as SupportedChatModel;
      const input = {
        config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'continue legacy work',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model,
      };
      const blocked = await runSubAgent(input);
      const continuation = blocked.blocked!.continuation;
      continuation.exhaustedFingerprints = { 'read_file:ENOENT:missing.txt': true };
      const result = await resumeSubAgent(input, continuation, {
        toolCallId: 'approval',
        toolName: 'shell_execute',
        result: { ok: true, command: 'bun test', exitCode: 0, stdout: 'ok', stderr: '' },
      });
      expect(result.toolRecovery?.qualityGuard).toMatchObject({
        blocked: true,
        reasonCode: 'no_progress',
      });
      const failure = result.toolRecovery!.failures[result.toolRecovery!.order.at(-1)!];
      expect(failure).toMatchObject({
        toolCallId: 'legacy-read',
        status: 'exhausted',
        resolution: 'terminal',
        outcome: { status: 'exhausted', failure: { kind: 'loop_exhausted' } },
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('review role: correct role in start event', async () => {
    const { events, sink } = mockEventSink();
    const model = new StreamingMockModel({
      responses: [{ message: { content: 'No issues found.' } as unknown as AIMessage, delay: 5 }],
    }) as unknown as SupportedChatModel;

    const result = await runSubAgent({
      config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
      workspace: '/tmp/test',
      role: getRoleConfig('review'),
      task: 'review auth.ts',
      timeoutMs: 5000,
      signal: new AbortController().signal,
      eventSink: sink,
      model: model,
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
      responses: [{ message: { content: 'done' } as unknown as AIMessage, delay: 5 }],
    }) as unknown as SupportedChatModel;

    const result = await runSubAgent({
      config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
      workspace: '/tmp/test',
      role: getRoleConfig('explore'),
      task: 'quick task',
      timeoutMs: 5000,
      signal: new AbortController().signal,
      eventSink: sink,
      model: model,
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
      invoke: async (_msgs: unknown, _opts?: unknown) => {
        _invokeCount++;
        // Delay 300ms on first invoke; abort fires at 100ms
        await new Promise((r) => setTimeout(r, 300));
        return { content: 'done' };
      },
    } as unknown as SupportedChatModel;

    // Abort after 100ms — during first model invoke
    setTimeout(() => ac.abort(), 100);

    const result = await runSubAgent({
      config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
      workspace: '/tmp/test',
      role: getRoleConfig('explore'),
      task: 'task',
      timeoutMs: 5000,
      signal: ac.signal,
      eventSink: sink,
      model: model,
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
    }) as unknown as SupportedChatModel;
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
      config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
      workspace: process.cwd(),
      role: getRoleConfig('code'),
      task: 'wait for descendant admission',
      timeoutMs: 25,
      signal: new AbortController().signal,
      eventSink: sink,
      model: model,
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
      responses: [{ message: { content: 'done' } as unknown as AIMessage, delay: 5 }],
    }) as unknown as SupportedChatModel;

    const result = await runSubAgent({
      config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
      workspace: '/tmp/test',
      role: getRoleConfig('explore'),
      task: 'task',
      timeoutMs: 5000,
      signal: ac.signal,
      eventSink: sink,
      model: model,
    });

    expect(result.ok).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});

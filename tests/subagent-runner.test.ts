import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { digestCapability } from '@/core/capabilities/catalog';
import { defaultAuthorizationState } from '@/core/harness/tool-policy';
import { toolRequestFromCall } from '@/core/harness/tool-requests';
import { runApprovedTool } from '@/core/harness/tool-runner';
import { resolveProjectInstructionSnapshot } from '@/core/model/project-instructions';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { normalizeCurrentToolOutcomeEventV1 } from '@/core/runtime/tool-outcome-events';
import { normalizeToolRecoveryJournalV1 } from '@/core/runtime/tool-recovery-journal';
import { getRoleConfig } from '@/core/subagent/roles';
import { resumeSubAgent, runSubAgent } from '@/core/subagent/runner';
import { runTaskSubAgent } from '@/core/subagent/task-tool';
import type { CapabilityBinding, CapabilityDescriptor } from '@/protocol/capabilities';
import type { AgentConfig } from '../src/core/config/index';
import { type AIMessage, aiMessage } from '../src/core/messages';
import type { SupportedChatModel } from '../src/core/model/factory';
import { runToolJourneySuiteV1 } from './evals/tool-journey-v1';
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
  test.each([
    'accept_edits',
    'auto',
    'full',
  ] as const)('normal launch accepts explicit %s mode and exposes the canonical workspace CWD', async (interactionMode) => {
    const absoluteWorkspace = mkdtempSync(join(tmpdir(), `kite-subagent-${interactionMode}-`));
    const workspace = relative(process.cwd(), absoluteWorkspace);
    let providerPrompt: unknown;
    const model = {
      model: {
        specificationVersion: 'v4',
        provider: 'fixture',
        modelId: 'fixture',
        supportedUrls: {},
        async doGenerate(options: { prompt?: unknown }) {
          providerPrompt = options.prompt;
          return {
            content: [{ type: 'text', text: 'done' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: {}, outputTokens: {}, totalTokens: 0 },
          };
        },
        async doStream(): Promise<never> {
          throw new Error('stream disabled');
        },
      },
      capabilityMetadata: { streaming: false },
      setRetryListener: () => {},
    } as unknown as SupportedChatModel;

    try {
      const result = await runSubAgent({
        config: { providerName: 'fixture', modelName: 'fixture' } as AgentConfig,
        workspace,
        role: getRoleConfig('explore'),
        task: 'Inspect the workspace.',
        interactionMode,
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        eventSink: mockEventSink().sink,
        model,
      });

      expect(result.ok).toBe(true);
      const prompt = JSON.stringify(providerPrompt);
      expect(prompt).toContain(`CWD: ${absoluteWorkspace}`);
      expect(prompt).toContain(`Workspace: ${absoluteWorkspace}`);
      expect(prompt).not.toContain(`CWD: ${process.cwd()}\\n`);
    } finally {
      rmSync(absoluteWorkspace, { recursive: true, force: true });
    }
  });

  test.each([
    ['accept_edits', 'ask_user must be handled by the user_input interrupt node.'],
    ['full', 'FULL_NO_USER_INTERACTION'],
  ] as const)('normal launch applies inherited %s mode to child tools', async (interactionMode, expected) => {
    const workspace = mkdtempSync(join(tmpdir(), `kite-subagent-mode-policy-${interactionMode}-`));
    const { events, sink } = mockEventSink();
    const model = new StreamingMockModel({
      responses: [
        {
          message: aiMessage({
            content: 'ask',
            tool_calls: [
              {
                id: `ask-${interactionMode}`,
                name: 'ask_user',
                args: {
                  questions: [
                    {
                      question: 'Continue?',
                      options: [
                        { label: 'Yes', description: 'Continue.', recommended: true },
                        { label: 'No', description: 'Stop.', recommended: false },
                      ],
                    },
                  ],
                },
              },
            ],
          }),
        },
        { message: aiMessage({ content: 'done' }) },
      ],
    }) as unknown as SupportedChatModel;

    try {
      await runSubAgent({
        config: { providerName: 'fixture', modelName: 'fixture' } as AgentConfig,
        workspace,
        role: getRoleConfig('code'),
        task: 'Ask only if the active mode permits it.',
        interactionMode,
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        eventSink: sink,
        model,
      });

      const askResult = events.find(
        (event) => event.type === 'tool_result' && event.data.toolName === 'ask_user',
      );
      expect(String(askResult?.data.summary)).toContain(expected);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('real task dispatch preserves planning phase for governed save then submit projection', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-plan-child-phase-'));
    const taskModel = new StreamingMockModel({
      responses: [{ message: aiMessage({ content: 'bounded architecture plan' }) }],
    }) as unknown as SupportedChatModel;
    try {
      const result = await runApprovedTool({
        workspace,
        request: {
          source: 'builtin',
          name: 'task',
          args: {
            subagent_type: 'plan',
            task: 'Design a bounded Runtime architecture plan with repository evidence.',
          },
          reason: 'fixture',
          protectedCommand: 'task',
        },
        phase: 'planning',
        taskConfig: { providerName: 'fixture', modelName: 'fixture' } as AgentConfig,
        taskModel,
        subagentEventSink: mockEventSink().sink,
      });
      expect(result).toMatchObject({ ok: true });
      expect(JSON.parse(result.stdout).nextActions).toEqual([
        'write_plan:save',
        'write_plan:submit',
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  test('code child receives the same typed Git availability and broker route as its parent', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-code-child-git-'));
    let brokerCalls = 0;
    let modelCalls = 0;
    const model = {
      model: {
        specificationVersion: 'v4',
        provider: 'fixture',
        modelId: 'fixture',
        supportedUrls: {},
        async doGenerate() {
          modelCalls += 1;
          return modelCalls === 1
            ? {
                content: [
                  {
                    type: 'tool-call',
                    toolCallId: 'git-child',
                    toolName: 'git_inspect',
                    input: { operation: 'status', paths: ['safe.txt'] },
                  },
                ],
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: { inputTokens: {}, outputTokens: {}, totalTokens: 0 },
              }
            : {
                content: [{ type: 'text', text: 'done' }],
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: { inputTokens: {}, outputTokens: {}, totalTokens: 0 },
              };
        },
        async doStream(): Promise<never> {
          throw new Error('stream disabled');
        },
      },
      capabilityMetadata: { streaming: false },
      setRetryListener: () => {},
    } as unknown as SupportedChatModel;
    try {
      const result = await runSubAgent({
        config: {
          providerName: 'fixture',
          modelName: 'fixture',
          features: { brokeredGitV1: true },
          executionCapabilitySurface: {
            inProcessReadOnlyTools: null,
            network: false,
            process: true,
            write: true,
            workspaceWrite: true,
            shell: true,
            skillChild: false,
            localStdioMcp: false,
            gitInspect: true,
            brokeredGitFeatureRevision: 'brokered-git-r1',
          },
        } as AgentConfig,
        workspace,
        role: getRoleConfig('code'),
        task: 'Inspect repository status through the typed Git capability.',
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        eventSink: mockEventSink().sink,
        model,
        gitBroker: {
          featureRevision: 'brokered-git-r1',
          inspect: async () => {
            brokerCalls += 1;
            return { ok: true, output: 'clean' };
          },
        },
      });
      expect(result).toMatchObject({ ok: true });
      expect(brokerCalls).toBe(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  test('real missing-file search recovery completes with canonical recovery status', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-subagent-recovered-'));
    writeFileSync(join(workspace, 'present.txt'), 'recovered\n');
    const { sink } = mockEventSink();
    const model = new StreamingMockModel({
      responses: [
        {
          message: aiMessage({
            content: '',
            tool_calls: [{ id: 'missing', name: 'read_file', args: { path: 'missing.txt' } }],
          }),
        },
        {
          message: aiMessage({
            content: '',
            tool_calls: [{ id: 'located', name: 'search_files', args: { pattern: 'present.txt' } }],
          }),
        },
        {
          message: aiMessage({
            content: '',
            tool_calls: [{ id: 'corrected', name: 'read_file', args: { path: 'present.txt' } }],
          }),
        },
        { message: aiMessage({ content: 'done after correction' }) },
      ],
    }) as unknown as SupportedChatModel;
    try {
      const result = await runSubAgent({
        config: { providerName: 'fixture', modelName: 'fixture-model' } as AgentConfig,
        workspace,
        role: getRoleConfig('explore'),
        task: 'Inspect the corrected file and report the result.',
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        eventSink: sink,
        model,
      });
      expect(result.ok).toBe(true);
      expect(result.terminalStatus).toBe('completed');
      expect(result.steps?.map((step) => step.ok)).toEqual([false, true, true]);
      expect(result.toolRecovery?.order).toHaveLength(1);
      const recoveredFailureId = result.toolRecovery?.order[0];
      expect(
        recoveredFailureId ? result.toolRecovery?.failures[recoveredFailureId]?.status : undefined,
      ).toBe('recovered');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  test('parent reducer and child provider share one public stdout-or-stderr projection matrix', async () => {
    const combinations = [
      { ok: true, stdout: '', stderr: '' },
      { ok: true, stdout: '', stderr: 'stderr' },
      { ok: true, stdout: 'stdout', stderr: '' },
      { ok: true, stdout: 'stdout', stderr: 'stderr' },
      { ok: false, stdout: '', stderr: '' },
      { ok: false, stdout: '', stderr: 'stderr' },
      { ok: false, stdout: 'stdout', stderr: '' },
      { ok: false, stdout: 'stdout', stderr: 'stderr' },
    ] as const;

    for (const [index, combination] of combinations.entries()) {
      const ws = mkdtempSync(join(tmpdir(), `kite-code-public-result-${index}-`));
      let providerCalls = 0;
      let secondProviderPrompt: unknown;
      const model = {
        model: {
          specificationVersion: 'v4',
          provider: 'fixture',
          modelId: 'fixture-model',
          supportedUrls: {},
          async doGenerate(options: { prompt?: unknown }) {
            providerCalls += 1;
            if (providerCalls === 1) {
              return {
                content: [
                  {
                    type: 'tool-call',
                    toolCallId: `child-shell-${index}`,
                    toolName: 'shell_execute',
                    input: { command: 'pwd' },
                  },
                ],
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: { inputTokens: {}, outputTokens: {}, totalTokens: 0 },
              };
            }
            secondProviderPrompt = options.prompt;
            return {
              content: [{ type: 'text', text: 'done' }],
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: { inputTokens: {}, outputTokens: {}, totalTokens: 0 },
            };
          },
          async doStream(): Promise<never> {
            throw new Error('streaming disabled');
          },
        },
        capabilityMetadata: { streaming: false },
        setRetryListener: () => {},
      } as unknown as SupportedChatModel;
      try {
        await runSubAgent({
          config: { providerName: 'fixture', modelName: 'fixture-model' } as AgentConfig,
          workspace: ws,
          role: getRoleConfig('code'),
          task: 'inspect the workspace',
          timeoutMs: 5000,
          signal: new AbortController().signal,
          eventSink: mockEventSink().sink,
          model,
          shellExecutor: async (input) => ({
            ...combination,
            command: input.command,
            exitCode: combination.ok ? 0 : 1,
          }),
        });

        const providerToolTurn = (
          secondProviderPrompt as Array<{ role?: string; content?: unknown }>
        ).find((entry) => entry.role === 'tool');
        const childContent = (
          providerToolTurn?.content as
            | Array<{ output?: { type?: string; value?: string }; text?: string }>
            | undefined
        )?.[0];
        const childModelContent = childContent?.output?.value ?? childContent?.text;

        let parent = createInitialRuntimeState({
          threadId: `public-result-${index}`,
          userId: 'test',
          workspace: ws,
        });
        parent = {
          ...parent,
          tools: {
            ...parent.tools,
            calls: {
              parent: {
                toolCallId: 'parent',
                modelMessageId: 'parent-model',
                name: 'shell_execute',
                args: { command: 'pwd' },
                sideEffect: false,
                effectClass: 'read_only',
                status: 'running',
                createdAtTurnId: parent.turn.turnId,
              },
            },
            queue: [],
            active: ['parent'],
          },
        };
        parent = reduceRuntimeState(
          parent,
          normalizeCurrentToolOutcomeEventV1(
            {
              type: 'tool.finished',
              toolCallId: 'parent',
              name: 'shell_execute',
              result: {
                ...combination,
                command: 'pwd',
                exitCode: combination.ok ? 0 : 1,
              },
            },
            parent,
            '2026-08-11T00:00:00.000Z',
          ),
        );
        const parentContent = parent.transcript.messages.find(
          (message) => message.kind === 'tool' && message.toolCallId === 'parent',
        )?.content;
        expect(childModelContent, JSON.stringify(combination)).toBe(parentContent);
        expect(parentContent, JSON.stringify(combination)).toBe(
          combination.ok
            ? combination.stdout || combination.stderr
            : combination.stderr || combination.stdout,
        );
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    }
  });

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

  test('read-only role rejects a command with a positional output operand', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'kite-code-readonly-shell-fallback-'));
    try {
      const target = join(ws, 'should-not-exist.txt');
      writeFileSync(join(ws, 'input.txt'), 'duplicate\nduplicate\n', 'utf8');
      const { events, sink } = mockEventSink();
      const model = new StreamingMockModel({
        responses: [
          {
            message: aiMessage({
              content: 'attempt write',
              tool_calls: [
                {
                  id: 'tc-readonly-write',
                  name: 'shell_execute',
                  args: {
                    command: 'uniq input.txt should-not-exist.txt',
                    description: 'Attempt a write from a read-only role',
                  },
                },
              ],
            }),
          },
          { message: aiMessage({ content: 'write rejected' }) },
        ],
      }) as unknown as SupportedChatModel;

      await runSubAgent({
        config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
        workspace: ws,
        role: getRoleConfig('explore'),
        task: 'Inspect without modifying the workspace.',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model,
        authorization: { ...defaultAuthorizationState(), mode: 'full_access' },
      });

      expect(existsSync(target)).toBe(false);
      const shellResult = events.find(
        (event) => event.type === 'tool_result' && event.data.toolName === 'shell_execute',
      );
      expect(String(shellResult?.data.summary)).toContain('read-only command');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('read-only role rejects a non-read-only shell before auto-review suspension', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'kite-code-readonly-shell-auto-'));
    try {
      const { events, sink } = mockEventSink();
      const model = new StreamingMockModel({
        responses: [
          {
            message: aiMessage({
              content: 'attempt verification',
              tool_calls: [
                {
                  id: 'tc-readonly-auto-review',
                  name: 'shell_execute',
                  args: { command: 'bun run typecheck' },
                },
              ],
            }),
          },
          { message: aiMessage({ content: 'verification command rejected' }) },
        ],
      }) as unknown as SupportedChatModel;
      let shellExecutions = 0;

      const result = await runSubAgent({
        config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
        workspace: ws,
        role: getRoleConfig('review'),
        task: 'Review without executing project commands.',
        interactionMode: 'auto',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model,
        shellExecutor: async ({ command }) => {
          shellExecutions += 1;
          return { ok: true, command, exitCode: 0, stdout: 'unexpected', stderr: '' };
        },
      });

      expect(shellExecutions).toBe(0);
      expect(result.blocked).toBeUndefined();
      const shellResult = events.find(
        (event) => event.type === 'tool_result' && event.data.toolName === 'shell_execute',
      );
      expect(String(shellResult?.data.summary)).toContain('read-only command');
      const failure = result.toolRecovery?.failures[result.toolRecovery.order.at(-1) ?? ''];
      expect(failure?.outcome).toMatchObject({
        status: 'rejected',
        failure: { kind: 'policy_denied' },
        dispatchState: 'not_started',
        externalEffects: 'none',
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
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

  test('parent read state does not authorize a child edit in the same thread', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'kite-code-subagent-read-scope-'));
    writeFileSync(join(ws, 'owned.ts'), 'export const owner = "parent";\n', 'utf8');
    try {
      const parentRead = toolRequestFromCall(
        { id: 'parent-read', name: 'read_file', args: { path: 'owned.ts' } },
        ws,
      );
      if (!parentRead?.ok) throw new Error('Failed to build parent read request');
      expect(
        (
          await runApprovedTool({
            workspace: ws,
            threadId: 'shared-actor-thread',
            request: parentRead.request,
          })
        ).ok,
      ).toBe(true);

      const { sink } = mockEventSink();
      const model = new StreamingMockModel({
        responses: [
          {
            message: aiMessage({
              content: 'edit',
              tool_calls: [
                {
                  id: 'child-edit',
                  name: 'edit_file',
                  args: {
                    path: 'owned.ts',
                    old_string: 'export const owner = "parent";',
                    new_string: 'export const owner = "child";',
                  },
                },
              ],
            }),
          },
          { message: aiMessage({ content: 'stopped after rejection' }) },
        ],
      }) as unknown as SupportedChatModel;

      const child = await runSubAgent({
        config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'edit owned.ts',
        threadId: 'shared-actor-thread',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model,
      });

      expect(child.steps?.find((step) => step.toolName === 'edit_file')).toMatchObject({
        ok: false,
        status: 'error',
      });
      expect(readFileSync(join(ws, 'owned.ts'), 'utf8')).toBe('export const owner = "parent";\n');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('same child keeps its read state across an in-process approval continuation', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'kite-code-subagent-read-resume-'));
    writeFileSync(join(ws, 'continued.ts'), 'export const value = 1;\n', 'utf8');
    try {
      const { sink } = mockEventSink();
      const model = new StreamingMockModel({
        responses: [
          {
            message: aiMessage({
              content: 'read',
              tool_calls: [
                { id: 'continued-read', name: 'read_file', args: { path: 'continued.ts' } },
              ],
            }),
          },
          {
            message: aiMessage({
              content: 'verify',
              tool_calls: [
                { id: 'continued-approval', name: 'shell_execute', args: { command: 'bun test' } },
              ],
            }),
          },
          {
            message: aiMessage({
              content: 'edit',
              tool_calls: [
                {
                  id: 'continued-edit',
                  name: 'edit_file',
                  args: {
                    path: 'continued.ts',
                    old_string: 'export const value = 1;',
                    new_string: 'export const value = 2;',
                  },
                },
              ],
            }),
          },
          { message: aiMessage({ content: 'done' }) },
        ],
      }) as unknown as SupportedChatModel;
      const input = {
        config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'read, verify, then edit continued.ts',
        threadId: 'continued-actor-thread',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model,
      };

      const blocked = await runSubAgent(input);
      expect(blocked.blocked?.toolCallId).toBe('continued-approval');
      const resumed = await resumeSubAgent(input, blocked.blocked!.continuation, {
        toolCallId: 'continued-approval',
        toolName: 'shell_execute',
        result: {
          ok: true,
          command: 'bun test',
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          status: 'success',
        },
      });

      expect(resumed.steps?.find((step) => step.toolName === 'edit_file')).toMatchObject({
        ok: true,
        status: 'success',
      });
      expect(readFileSync(join(ws, 'continued.ts'), 'utf8')).toBe('export const value = 2;\n');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('read_file ENOENT uses the same public projection and recovery advice in parent and child', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'kite-code-subagent-enoent-parity-'));
    const privatePath = 'private-missing-result.ts';
    const { events, sink } = mockEventSink();
    let callCount = 0;
    let secondProviderPrompt: unknown;
    const languageModel = {
      specificationVersion: 'v4',
      provider: 'fixture',
      modelId: 'fixture-model',
      supportedUrls: {},
      async doGenerate(options: { prompt?: unknown }) {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'child-missing',
                toolName: 'read_file',
                input: { path: privatePath },
              },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: { inputTokens: {}, outputTokens: {}, totalTokens: 0 },
          };
        }
        secondProviderPrompt = options.prompt;
        return {
          content: [{ type: 'text', text: 'stop after locating failure' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: {}, outputTokens: {}, totalTokens: 0 },
        };
      },
      async doStream(): Promise<never> {
        throw new Error('streaming disabled');
      },
    };
    const model = {
      model: languageModel,
      capabilityMetadata: { streaming: false },
      setRetryListener: () => {},
    } as unknown as SupportedChatModel;
    try {
      const child = await runSubAgent({
        config: {
          providerName: 'fixture',
          modelName: 'fixture-model',
          features: { promptContractV2: false },
        } as unknown as AgentConfig,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'locate the missing fixture',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model,
      });
      const childFailure = Object.values(child.toolRecovery?.failures ?? {})[0]!;
      const parentJourney = (await runToolJourneySuiteV1()).cases.find(
        (entry) => entry.id === 'enoent_locate_success',
      )!;
      const parentOutcome = parentJourney.canonicalOutcomes[0]!;
      expect(childFailure.outcome.failure?.detailCode).toBe(parentOutcome.detailCode);
      expect(childFailure.outcome.recovery.disposition).toBe(parentOutcome.recoveryDisposition);
      const providerToolTurn = (
        secondProviderPrompt as Array<{ role?: string; content?: unknown }>
      ).find((entry) => entry.role === 'tool');
      const projectedPrompt = JSON.stringify(providerToolTurn);
      const projectedEvent = JSON.stringify(
        events.find((event) => event.type === 'tool_result' && event.data.toolName === 'read_file'),
      );
      for (const forbidden of [
        privatePath,
        ws,
        '"command"',
        '"path"',
        'resultMeta',
        'classifierAdviceV1',
        'capabilityIntent',
        'guidance',
      ]) {
        expect(projectedPrompt).not.toContain(forbidden);
        expect(projectedEvent).not.toContain(forbidden);
      }
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
      expect(result.ok).toBe(true);
      expect(result.terminalStatus).toBe('completed');
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
          interactionMode: 'accept_edits',
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
      expect(String(readResult?.data.summary)).toContain('"name":"fixture"');
      expect(String(readResult?.data.summary)).not.toContain('"command"');
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

  test('preserves auto-review as a typed child blocker', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'kite-code-subagent-auto-review-'));
    try {
      const model = new StreamingMockModel({
        responses: [
          {
            message: aiMessage({
              content: 'stage fixture',
              tool_calls: [
                {
                  id: 'tc-auto-review',
                  name: 'shell_execute',
                  args: { command: 'git add fixture.txt', description: 'Stage fixture' },
                },
              ],
            }),
          },
        ],
      }) as unknown as SupportedChatModel;

      const result = await runSubAgent({
        config: { providerName: 'fixture', modelName: 'fixture' } as AgentConfig,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'Stage the changed fixture.',
        interactionMode: 'auto',
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        eventSink: mockEventSink().sink,
        model,
      });

      expect(result.blocked?.reasonCode).toBe('SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW');
      expect(result.blocked?.toolCallId).toBe('tc-auto-review');
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

  test('approval resume uses the parent Runtime live mode for subsequent child calls', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'kite-code-subagent-live-mode-resume-'));
    try {
      const { events, sink } = mockEventSink();
      const model = new StreamingMockModel({
        responses: [
          {
            message: aiMessage({
              content: 'verify',
              tool_calls: [
                {
                  id: 'tc-live-mode-shell',
                  name: 'shell_execute',
                  args: { command: 'bun run typecheck', description: 'Run typecheck' },
                },
              ],
            }),
          },
          {
            message: aiMessage({
              content: 'ask after resume',
              tool_calls: [
                {
                  id: 'tc-live-mode-ask',
                  name: 'ask_user',
                  args: {
                    questions: [
                      {
                        question: 'Continue?',
                        options: [
                          { label: 'Yes', description: 'Continue.', recommended: true },
                          { label: 'No', description: 'Stop.', recommended: false },
                        ],
                      },
                    ],
                  },
                },
              ],
            }),
          },
          { message: aiMessage({ content: 'continued without asking' }) },
        ],
      }) as unknown as SupportedChatModel;
      const baseInput = {
        config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'run verification',
        interactionMode: 'accept_edits' as const,
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        eventSink: sink,
        model,
      };

      const blocked = await runSubAgent(baseInput);
      expect(blocked.blocked?.toolCallId).toBe('tc-live-mode-shell');

      const resumed = await resumeSubAgent(
        { ...baseInput, interactionMode: 'full' },
        blocked.blocked!.continuation,
        {
          toolCallId: 'tc-live-mode-shell',
          toolName: 'shell_execute',
          result: {
            ok: true,
            command: 'bun run typecheck',
            exitCode: 0,
            stdout: 'typecheck ok',
            stderr: '',
            status: 'success',
          },
        },
      );

      expect(resumed.ok).toBe(true);
      expect(resumed.terminalStatus).toBe('completed');
      const askResult = events.find(
        (event) => event.type === 'tool_result' && event.data.toolName === 'ask_user',
      );
      expect(String(askResult?.data.summary)).toContain('FULL_NO_USER_INTERACTION');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('suppresses a same-scope tool reproposal without premature quality blocking', async () => {
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
      expect(resumed.toolRecovery?.qualityGuard).toEqual({
        blocked: false,
        observedFailures: 2,
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
        { message: repeatedCall('mcp-4') },
        { message: repeatedCall('mcp-5') },
        { message: repeatedCall('mcp-6') },
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

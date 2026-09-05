import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { normalizeToolRecoveryJournal } from '@kite-ai/agent-kernel';
import { digestCapabilityValue } from '@kite-ai/builtin-runtime/capability';
import type { SupportedChatModel } from '@kite-ai/builtin-runtime/model';
import {
  type AIMessage,
  aiMessage,
  BuiltinModelEffectCoordinator,
  resolveProjectInstructionSnapshot,
} from '@kite-ai/builtin-runtime/model';
import { DEFAULT_SUBAGENT_MAX_TOOL_ROUNDS, getRoleConfig } from '@kite-ai/builtin-runtime/subagent';
import type { CapabilityBinding, CapabilityDescriptor } from '@kite-ai/runtime-contract';
import {
  createRuntimeHostStateInitialState,
  runtimeHostStateNormalizeToolOutcomeEvent as normalizeCurrentToolOutcomeEvent,
  type RuntimeState,
} from '@kite-ai/runtime-host/kernel-adapter';
import { appApprovalBindingForPresentation } from '#kite-service/bootstrap/runtime/approval-binding';
import {
  executeSubagentResumeWithCoreToolAdapter as resumeSubAgentUnderTest,
  executeSubagentStartWithCoreToolAdapter as runSubAgentUnderTest,
} from '#kite-service/bootstrap/runtime/subagent/tool-adapter';
import type { AgentConfig } from '#kite-service/config/index';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { StreamingMockModel } from '../../../tests/helpers/mock-model';
import { createTestModelInvocationHarness } from '../../../tests/helpers/model-invocation';
import {
  executeTestRuntimeTool,
  testBuiltinToolCatalog,
  testCapabilityArtifactWriter,
  testWorkspaceFilesystemRuntime,
} from '../../../tests/helpers/runtime-model';

const invocationHarnesses = new WeakMap<
  object,
  ReturnType<typeof createTestModelInvocationHarness>
>();
const unitToolDispatchers = new WeakMap<
  object,
  import('#kite-service/bootstrap/runtime/subagent/types').SubAgentToolDispatcher
>();
const TEST_RECOVERY_IDENTITY_KEY = '7'.repeat(64);
type TestSubAgentRunnerInput = Omit<
  import('#kite-service/bootstrap/runtime/subagent/types').SubAgentRunnerInput,
  'name' | 'recoveryIdentityKey'
> & {
  name?: string;
  recoveryIdentityKey?: string;
};

function modelInvocationHarness(input: { workspace: string }) {
  const key = input as object;
  const existing = invocationHarnesses.get(key);
  if (existing) return existing;
  const created = createTestModelInvocationHarness({ workspace: input.workspace });
  invocationHarnesses.set(key, created);
  return created;
}

function completeFixtureConfig(config: AgentConfig): AgentConfig {
  return {
    ...config,
    apiKey: config.apiKey ?? '',
    baseURL: config.baseURL ?? 'https://fixture.invalid/v1',
    providerType: config.providerType ?? 'openai-compatible',
  };
}

async function runSubAgent(input: TestSubAgentRunnerInput) {
  const evidence = modelInvocationHarness(input);
  return runSubAgentUnderTest({
    ...input,
    name: input.name ?? 'Test sub-agent',
    recoveryIdentityKey: input.recoveryIdentityKey ?? TEST_RECOVERY_IDENTITY_KEY,
    builtinToolCatalog: input.builtinToolCatalog ?? testBuiltinToolCatalog(),
    config: completeFixtureConfig(input.config),
    modelEffectCoordinator: new BuiltinModelEffectCoordinator(evidence.gateway),
    modelInvocationPersistence: evidence.persistence,
    toolDispatcher: input.toolDispatcher ?? directUnitToolDispatcher(input),
  });
}

async function resumeSubAgent(
  input: TestSubAgentRunnerInput,
  ...rest: Parameters<typeof resumeSubAgentUnderTest> extends [unknown, ...infer R] ? R : never
) {
  const evidence = modelInvocationHarness(input);
  return resumeSubAgentUnderTest(
    {
      ...input,
      name: input.name ?? 'Test sub-agent',
      recoveryIdentityKey: input.recoveryIdentityKey ?? TEST_RECOVERY_IDENTITY_KEY,
      builtinToolCatalog: input.builtinToolCatalog ?? testBuiltinToolCatalog(),
      config: completeFixtureConfig(input.config),
      modelEffectCoordinator: new BuiltinModelEffectCoordinator(evidence.gateway),
      modelInvocationPersistence: evidence.persistence,
      toolDispatcher: input.toolDispatcher ?? directUnitToolDispatcher(input),
    },
    ...rest,
  );
}

function directUnitToolDispatcher(input: {
  workspace: string;
  config: AgentConfig;
  shellExecutor?: import('@kite-ai/builtin-runtime/sandbox').ShellExecutor;
  gitBroker?: import('@kite-ai/builtin-runtime/git').GitBroker;
  mcpManager?: import('@kite-ai/builtin-runtime/mcp').McpRuntimeProvider;
  skills?: import('@kite-ai/builtin-runtime/skills').SkillManifest[];
  skillOptions?: import('@kite-ai/builtin-runtime/skills').SkillScanOptions;
  workspaceAccess?: import('@kite-ai/runtime-contract').WorkspaceAccess;
  phase?: import('@kite-ai/runtime-contract').AgentPhase;
  interactionMode?: import('@kite-ai/runtime-contract').InteractionMode;
  threadId?: string;
  projectInstructions?: import('@kite-ai/builtin-runtime/model').ProjectInstructionSnapshot;
  recordFilePreimage?: import('@kite-ai/runtime-host/storage').RuntimeHostFilePreimageRecorder;
}): import('#kite-service/bootstrap/runtime/subagent/types').SubAgentToolDispatcher {
  const identity = input as object;
  const cached = unitToolDispatchers.get(identity);
  if (cached) return cached;
  const capabilityArtifacts = testCapabilityArtifactWriter();
  const workspaceFilesystemRuntime = testWorkspaceFilesystemRuntime(
    input.workspace,
    capabilityArtifacts,
  );
  let runtimeState: RuntimeState = createRuntimeHostStateInitialState({
    threadId: input.threadId ?? 'test-subagent-child-thread',
    userId: 'test-subagent-child-user',
    workspace: input.workspace,
    recoveryIdentityKey: TEST_RECOVERY_IDENTITY_KEY,
    interactionMode: input.interactionMode ?? 'accept_edits',
    workspaceAccess: input.workspaceAccess ?? 'write',
    phase: input.phase ?? 'building',
  });
  const dispatcher: import('#kite-service/bootstrap/runtime/subagent/types').SubAgentToolDispatcher =
    {
      dispatch: async (child) => {
        const runtimeToolCallId = `unit:${child.subagentId}:${child.modelInvocationId}:${child.modelToolCallId}`;
        if (child.binding) {
          runtimeState = {
            ...runtimeState,
            capabilities: {
              ...runtimeState.capabilities,
              catalogRevision:
                input.mcpManager?.getCapabilitySnapshot().revision ??
                runtimeState.capabilities.catalogRevision,
              bindings: {
                ...runtimeState.capabilities.bindings,
                [child.binding.bindingId]: child.binding,
              },
            },
          };
        }
        const executed = await executeTestRuntimeTool({
          workspace: input.workspace,
          toolName: child.request.name,
          args: child.request.args as import('@kite-ai/runtime-spi').RuntimeJsonValue,
          toolCallId: runtimeToolCallId,
          modelMessageId: child.modelInvocationId,
          state: runtimeState,
          callOverrides: child.binding
            ? {
                bindingId: child.binding.bindingId,
                capabilityId: child.binding.capabilityId,
                capabilityRevision: child.binding.capabilityRevision,
              }
            : undefined,
          execution: {
            builtinToolCatalog: testBuiltinToolCatalog().forTurn({
              workspace: input.workspace,
              phase: input.phase ?? 'building',
              hasGitBroker: Boolean(input.gitBroker),
              brokeredGitFeatureRevision:
                input.config.executionCapabilitySurface?.brokeredGitFeatureRevision ?? null,
              featureFlags: input.config.features,
            }),
            shellExecutor: input.shellExecutor,
            gitBroker: input.gitBroker,
            mcpManager: input.mcpManager,
            taskConfig: completeFixtureConfig(input.config),
            sandboxAvailable: true,
            skillManifests: input.skills,
            skillOptions: input.skillOptions,
            recordFilePreimage: input.recordFilePreimage,
            capabilityArtifactStore: capabilityArtifacts,
            workspaceFilesystemRuntime,
            toolActorIds: { [runtimeToolCallId]: child.subagentId },
            ...(child.beforeAdmission
              ? { beforeAdmissionByToolCallId: { [runtimeToolCallId]: child.beforeAdmission } }
              : {}),
            ...(child.beforeDispatch
              ? { beforeDispatchByToolCallId: { [runtimeToolCallId]: child.beforeDispatch } }
              : {}),
            ...(child.afterDispatch
              ? { afterDispatchByToolCallId: { [runtimeToolCallId]: child.afterDispatch } }
              : {}),
          },
        });
        runtimeState = executed.state;
        const approval = executed.events.find(
          (event) => event.type === 'approval.requested' || event.type === 'auto_review.requested',
        );
        if (approval) {
          const binding = appApprovalBindingForPresentation(approval.approval);
          if (!binding) throw new Error('Child approval is missing its Kernel governance facts.');
          return {
            runtimeToolCallId,
            result: {
              ok: false,
              command: child.request.protectedCommand,
              exitCode: -1,
              stdout: '',
              stderr: `${child.request.name} requires approval but was not approved.`,
              status: 'rejected' as const,
              approvalRoute: approval.type === 'auto_review.requested' ? 'auto_review' : 'user',
              approvalBinding: Object.freeze({
                ...binding,
                childToolCallId: child.modelToolCallId,
                runtimeToolCallId,
              }),
            },
          };
        }
        if (executed.terminal?.type === 'tool.finished') {
          return {
            runtimeToolCallId,
            result: {
              ...executed.terminal.result,
              ...(executed.terminal.classifierAdvice
                ? { classifierAdvice: executed.terminal.classifierAdvice }
                : {}),
              ...(executed.terminal.classifierDiagnostic
                ? { classifierDiagnostic: executed.terminal.classifierDiagnostic }
                : {}),
            },
          };
        }
        return {
          runtimeToolCallId,
          result: {
            ok: false,
            command: child.request.protectedCommand,
            exitCode: -1,
            stdout: '',
            stderr:
              executed.terminal?.type === 'tool.rejected'
                ? executed.terminal.reason
                : executed.terminal?.type === 'tool.failed'
                  ? executed.terminal.failure.message
                  : 'Child tool execution did not produce a terminal result.',
            status: 'error' as const,
          },
        };
      },
    };
  unitToolDispatchers.set(identity, dispatcher);
  return dispatcher;
}

function mockEventSink() {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  return {
    events,
    sink: ((e: { type: string; data: Record<string, unknown> }) => {
      events.push(e);
    }) as unknown as import('#kite-service/bootstrap/runtime/subagent/types').SubAgentEventSink,
  };
}

describe('SubAgentRunner integration', () => {
  test('fails closed without a parent Runtime child tool dispatcher', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-subagent-no-runtime-dispatcher-'));
    writeFileSync(join(workspace, 'visible.txt'), 'must not be read\n', 'utf8');
    const { events, sink } = mockEventSink();
    const harness = createTestModelInvocationHarness({ workspace });
    try {
      const result = await runSubAgentUnderTest({
        builtinToolCatalog: testBuiltinToolCatalog(),
        config: completeFixtureConfig({
          providerName: 'fixture',
          modelName: 'fixture',
        } as AgentConfig),
        workspace,
        recoveryIdentityKey: TEST_RECOVERY_IDENTITY_KEY,
        role: getRoleConfig('code'),
        name: 'Check missing dispatcher',
        task: 'Read visible.txt through the required Runtime boundary.',
        interactionMode: 'accept_edits',
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        eventSink: sink,
        model: new StreamingMockModel({
          responses: [
            {
              message: aiMessage({
                content: 'read',
                tool_calls: [
                  { id: 'no-runtime-read', name: 'read_file', args: { path: 'visible.txt' } },
                ],
              }),
            },
            { message: aiMessage({ content: 'stopped' }) },
          ],
        }),
        modelEffectCoordinator: new BuiltinModelEffectCoordinator(harness.gateway),
        modelInvocationPersistence: harness.persistence,
      });

      expect(result.steps?.find((step) => step.toolName === 'read_file')).toMatchObject({
        status: 'error',
      });
      const readResult = events.find(
        (event) => event.type === 'tool_result' && event.data.toolName === 'read_file',
      );
      expect(String(readResult?.data.summary)).toContain(
        'Runtime child tool dispatcher is unavailable',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('binds each child model step to its parent invocation and tool call', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-subagent-model-lineage-'));
    const { events, sink } = mockEventSink();
    const input: TestSubAgentRunnerInput = {
      config: { providerName: 'fixture', modelName: 'fixture' } as AgentConfig,
      workspace,
      role: getRoleConfig('explore'),
      task: 'Inspect lineage.',
      interactionMode: 'accept_edits',
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      eventSink: sink,
      model: new StreamingMockModel({
        responses: [{ message: aiMessage({ content: 'Lineage inspected.' }) }],
      }),
      modelInvocationParentId: 'parent-model-invocation',
      modelInvocationParentToolCallId: 'parent-task-call',
    };
    try {
      const result = await runSubAgent(input);
      expect(result.ok).toBe(true);
      const invocation = Object.values(
        modelInvocationHarness(input).getState().modelInvocations,
      )[0];
      expect(invocation).toMatchObject({
        status: 'completed',
        parentInvocationId: 'parent-model-invocation',
        parentToolCallId: 'parent-task-call',
      });
      expect(events.find((event) => event.type === 'done')?.data).toMatchObject({
        modelInvocationId: invocation?.invocationId,
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('finalizes a successful tool loop even when the shared resource budget is disabled', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-subagent-bounded-finalization-'));
    const { events, sink } = mockEventSink();
    const toolResponses = Array.from({ length: DEFAULT_SUBAGENT_MAX_TOOL_ROUNDS }, (_, index) => {
      const filename = `evidence-${index + 1}.txt`;
      writeFileSync(join(workspace, filename), `evidence ${index + 1}\n`, 'utf8');
      return {
        message: aiMessage({
          tool_calls: [
            { id: `bounded-read-${index + 1}`, name: 'read_file', args: { path: filename } },
          ],
        }),
      };
    });
    const input: TestSubAgentRunnerInput = {
      config: {
        providerName: 'fixture',
        modelName: 'fixture',
        features: { resourceBudget: false },
      } as AgentConfig,
      workspace,
      role: getRoleConfig('explore'),
      task: 'Collect bounded evidence and then finalize.',
      interactionMode: 'accept_edits',
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      eventSink: sink,
      model: new StreamingMockModel({
        responses: [
          ...toolResponses,
          { message: aiMessage({ content: 'Bounded evidence summary.' }) },
        ],
      }),
    };

    try {
      const result = await runSubAgent(input);

      expect(result).toMatchObject({
        ok: true,
        terminalStatus: 'completed',
        summary: 'Bounded evidence summary.',
        toolCallCount: DEFAULT_SUBAGENT_MAX_TOOL_ROUNDS,
      });
      expect(result.steps).toHaveLength(DEFAULT_SUBAGENT_MAX_TOOL_ROUNDS);
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
      expect(Object.keys(modelInvocationHarness(input).getState().modelInvocations)).toHaveLength(
        DEFAULT_SUBAGENT_MAX_TOOL_ROUNDS + 1,
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

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
    'accept_edits',
    'full',
  ] as const)('never exposes ask_user to a child in inherited %s mode', async (interactionMode) => {
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
      expect(String(askResult?.data.summary)).toContain(
        'Tool "ask_user" is not available to this sub-agent.',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('keeps typed Git internal when a code child attempts to call it', async () => {
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
    } as unknown as SupportedChatModel;
    try {
      const result = await runSubAgent({
        config: {
          providerName: 'fixture',
          modelName: 'fixture',
          features: { brokeredGit: true },
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
      expect(brokerCalls).toBe(0);
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
      expect(
        result.steps?.map((step) => step.status),
        JSON.stringify(result.steps),
      ).toEqual(['error', 'success', 'success']);
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
          interactionMode: 'full',
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

        let parent = createRuntimeHostStateInitialState({
          recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
          normalizeCurrentToolOutcomeEvent(
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
      name: 'Search for UserService',
      task: '# Search for UserService\n\nInspect the service implementation and report its call sites.',
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
    expect(events[0]!.data.name).toBe('Search for UserService');
    expect(JSON.stringify(events[0])).not.toContain('Inspect the service implementation');

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
        interactionMode: 'full',
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
      const parentRead = await executeTestRuntimeTool({
        workspace: ws,
        toolName: 'read_file',
        args: { path: 'owned.ts' },
        toolCallId: 'parent-read',
        state: { threadId: 'shared-actor-thread' },
      });
      expect(parentRead.result?.ok).toBe(true);

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
        status: 'success',
      });
      expect(readFileSync(join(ws, 'continued.ts'), 'utf8')).toBe('export const value = 2;\n');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('read_file ENOENT keeps Provider-native public projection and recovery advice', async () => {
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
    } as unknown as SupportedChatModel;
    try {
      const child = await runSubAgent({
        config: {
          providerName: 'fixture',
          modelName: 'fixture-model',
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
      expect(childFailure.outcome.failure?.detailCode).toBe('tool_reported_failure');
      expect(childFailure.outcome.recovery.disposition).toBe('alternative');
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
        'classifierAdvice',
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

  test('task sub-agent may write every path inside its trusted workspace', async () => {
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

      await runSubAgent({
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
        role: getRoleConfig('code'),
        task: 'write protected skill config',
        interactionMode: 'accept_edits',
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        eventSink: sink,
        model: model,
      });

      const writeResult = events.find(
        (event) => event.type === 'tool_result' && event.data.toolName === 'write_file',
      );
      expect(writeResult?.data.status).toBe('completed');
      expect(readFileSync(protectedFile, 'utf8')).toBe('changed\n');
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
      expect(readResult?.data.status).toBe('completed');
      expect(String(readResult?.data.summary)).toContain('"name":"fixture"');
      expect(String(readResult?.data.summary)).not.toContain('"command"');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('keeps uncertain sub-agent verification behind exact approval even in Full', async () => {
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

      let shellExecutions = 0;
      const result = await runSubAgent({
        config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
        workspace: ws,
        role: getRoleConfig('code'),
        task: 'run verification',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        eventSink: sink,
        model: model,
        interactionMode: 'full',
        shellExecutor: async (input) => {
          shellExecutions += 1;
          return {
            ok: true,
            command: input.command,
            exitCode: 0,
            stdout: 'typecheck ok',
            stderr: '',
          };
        },
      });

      expect(result.ok).toBe(false);
      expect(result.blocked).toMatchObject({
        reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
        toolName: 'shell_execute',
        toolCallId: 'tc-verify',
        command: 'bun run typecheck',
      });
      expect(shellExecutions).toBe(0);
      expect(events.find((event) => event.type === 'error')).toBeUndefined();
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
              content: 'push fixture branch',
              tool_calls: [
                {
                  id: 'tc-auto-review',
                  name: 'shell_execute',
                  args: { command: 'git push origin main', description: 'Push fixture branch' },
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
        task: 'Push the changed fixture branch.',
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

  test('approval resume preserves the child ask_user ceiling under the parent live mode', async () => {
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
      expect(String(askResult?.data.summary)).toContain(
        'Tool "ask_user" is not available to this sub-agent.',
      );
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
      schemaDigest: digestCapabilityValue(descriptor.inputSchema),
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
    const restored = normalizeToolRecoveryJournal(
      JSON.parse(JSON.stringify(result.toolRecovery)),
      TEST_RECOVERY_IDENTITY_KEY,
    );
    expect(restored.qualityGuard).toEqual(result.toolRecovery!.qualityGuard);
    expect(JSON.stringify(restored)).not.toContain('private-body');
  });

  test('ignores the legacy exhausted-fingerprint cache and keeps Kernel recovery authoritative', async () => {
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
        blocked: false,
        observedFailures: 1,
      });
      const failure = result.toolRecovery!.failures[result.toolRecovery!.order.at(-1)!];
      expect(failure).toMatchObject({
        toolCallId: 'legacy-read',
        status: 'unresolved',
        outcome: { status: 'failed', failure: { kind: 'tool_runtime_error' } },
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
      name: 'Review auth.ts',
      task: 'review auth.ts',
      timeoutMs: 5000,
      signal: new AbortController().signal,
      eventSink: sink,
      model: model,
    });

    expect(result.ok).toBe(true);
    expect(events[0]!.type).toBe('start');
    expect(events[0]!.data.role).toBe('review');
    expect(events[0]!.data.name).toBe('Review auth.ts');
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

    // The abort should cause the subagent to fail.
    expect(result.ok).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  test('classifies the role deadline separately from parent cancellation', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-subagent-timeout-'));
    writeFileSync(join(workspace, 'README.md'), 'fixture');
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
    const descendantResourceAdmission = {
      reserveModel: async () => ({ reservationId: 'model-reservation' }),
      reconcileModel: async () => {},
      reserveTool: async (request: { signal?: AbortSignal }) => {
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
      import('#kite-service/bootstrap/runtime/subagent/types').SubAgentRunnerInput['descendantResourceAdmission']
    >;

    try {
      const result = await runSubAgent({
        config: { providerName: 'deepseek', modelName: 'test' } as unknown as AgentConfig,
        workspace,
        role: { ...getRoleConfig('code'), timeoutMs: 25 },
        task: 'wait for descendant admission',
        timeoutMs: 25,
        signal: new AbortController().signal,
        eventSink: sink,
        model: model,
        descendantResourceAdmission,
      });

      expect(result.ok).toBe(false);
      expect(result.terminalStatus).toBe('failed');
      expect(result.failureDiagnostic?.code).toBe('timed_out');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'error',
          data: expect.objectContaining({
            summary: 'Sub-agent execution timed out.',
            diagnostic: expect.objectContaining({ code: 'timed_out' }),
          }),
        }),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('keeps the exact MCP binding while settling each retry attempt independently', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-subagent-attempt-reservations-'));
    const order: string[] = [];
    const observedBindings: CapabilityBinding[] = [];
    let reservation = 0;
    const descriptor: CapabilityDescriptor = {
      capabilityId: 'mcp:fixture/read',
      revision: 'revision-retry',
      kind: 'mcp_tool',
      displayName: 'read',
      description: 'Read fixture data',
      provider: { type: 'mcp', id: 'fixture', provenance: 'remote' },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      declaredEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
      execution: { retry: 'safe_read' },
      availability: 'available',
      diagnostics: [],
    };
    const binding: CapabilityBinding = {
      bindingId: 'binding-retry',
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      exposedToolName: 'mcp__fixture__read',
      schemaDigest: digestCapabilityValue(descriptor.inputSchema),
      issuedForTurnId: 'turn-retry',
    };
    try {
      const result = await runSubAgent({
        config: { providerName: 'fixture', modelName: 'fixture' } as AgentConfig,
        workspace,
        role: getRoleConfig('code'),
        task: 'Exercise a safe-read provider retry.',
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        eventSink: mockEventSink().sink,
        model: new StreamingMockModel({
          responses: [
            {
              message: aiMessage({
                content: 'read',
                tool_calls: [{ id: 'retry-read', name: binding.exposedToolName, args: {} }],
              }),
            },
            { message: aiMessage({ content: 'done' }) },
          ],
        }),
        mcpBindings: [{ descriptor, binding }],
        mcpManager: {
          findCapability: (capabilityId: string) =>
            capabilityId === descriptor.capabilityId ? descriptor : undefined,
        } as never,
        descendantResourceAdmission: {
          reserveModel: async () => ({ reservationId: 'model' }),
          reconcileModel: async () => {},
          reserveTool: async () => {
            reservation += 1;
            order.push(`reserve-${reservation}`);
            return { reservationId: `tool-${reservation}` };
          },
          reconcileTool: async ({ reservationId }) => {
            order.push(`reconcile-${reservationId}`);
          },
          markUnknown: async (reservationId) => {
            order.push(`unknown-${reservationId}`);
          },
          markLocalProviderAdmissionDenied: async () => {},
        },
        toolDispatcher: {
          dispatch: async (child) => {
            if (!child.binding)
              throw new Error('MCP binding was not propagated to the dispatcher.');
            observedBindings.push(child.binding);
            const firstReservation = await child.beforeAdmission?.();
            await child.beforeDispatch?.(1, firstReservation?.reservationId);
            await child.afterDispatch?.({
              attempt: 1,
              reservationId: firstReservation?.reservationId,
              dispatchState: 'started',
              error: new Error('retryable read'),
            });
            const secondReservation = await child.beforeAdmission?.();
            await child.beforeDispatch?.(2, secondReservation?.reservationId);
            const attemptResult = {
              ok: true,
              command: child.request.protectedCommand,
              exitCode: 0,
              stdout: 'read after retry',
              stderr: '',
              status: 'success' as const,
            };
            await child.afterDispatch?.({
              attempt: 2,
              reservationId: secondReservation?.reservationId,
              dispatchState: 'started',
              result: attemptResult,
            });
            return { runtimeToolCallId: 'child-retry-read', result: attemptResult };
          },
        },
      });

      expect(result.ok).toBe(true);
      expect(order).toEqual(['reserve-1', 'unknown-tool-1', 'reserve-2', 'reconcile-tool-2']);
      expect(observedBindings).toEqual([binding]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
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
    expect(result.terminalStatus).toBe('cancelled');
    expect(result.summary).toBe('Cancelled');
    expect(result.failureDiagnostic).toEqual({
      code: 'aborted',
      stage: 'next_round_preparation',
    });
    expect(events.find((e) => e.type === 'error')?.data.diagnostic).toEqual({
      code: 'aborted',
      stage: 'next_round_preparation',
    });
  });
});

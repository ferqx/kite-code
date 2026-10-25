// Isolated production-renderer fixture; never mounted by ordinary Native entrypoints.
import {
  canonicalModelBody,
  type Execution,
  type Message,
  type ModelOutputSnapshot,
  type ModelSettingsView,
  type Run,
} from '@kite-ai/client';
import { SessionPage, type Message as ToolMessage } from '@kite-ai/ui/desktop';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { NativeDesktop } from '../src/native';
import type {
  NativeBridge,
  NativeEvent,
  NativeModelSettingsSubmission,
  NativeProviderSubmission,
  NativeRequest,
  NativeResult,
} from '../src/native-bridge';
import { nativeRunFact } from '../src/tool-messages-bridge';
import { backgroundItem } from './background-item.fixture';
import { sessionSwitchBridge } from './session-switch-bridge.fixture';
import '../src/native-tailwind.css';
import '../src/native-startup.css';
import '@kite-ai/ui/desktop/style.css';

declare const __KITE_FIXTURE_EMPTY_MODEL_CHOICE__: boolean;
const control = sessionSwitchBridge({ active: true });
const base = backgroundItem();
const raw = 'PRIVATE_RAW_RECEIPT_SENTINEL';
const messages: Message[] = [
  {
    id: 'original-user',
    sessionId: 'a',
    runId: 'run-a',
    seq: '1',
    role: 'user',
    status: 'complete',
    content: '检查连续混合工具的完整执行过程。',
  },
];
const run: Run = {
  ...base.run!,
  id: 'run-a',
  sessionId: 'a',
  status: 'running',
  isActive: true,
  createdAt: Date.now(),
  finishedAt: null,
  reason: null,
  ...(__KITE_FIXTURE_EMPTY_MODEL_CHOICE__
    ? {
        configuration: {
          modelId: 'model-a',
          snapshot: {
            version: 1,
            digest: 'f'.repeat(64),
            configuration: {
              models: [
                {
                  id: 'model-a',
                  provider: 'compatible',
                  model: 'Model A',
                  protocol: 'chat-completions',
                },
              ],
            },
          },
        },
      }
    : {}),
};
const executions: Execution[] = [];
const facts = new Map<string, Execution>();
type NativeShellCase =
  | 'launch'
  | 'read'
  | 'wait'
  | 'stop'
  | 'execute'
  | 'execute-large'
  | 'execute-model-late'
  | 'execute-live'
  | 'execute-failed'
  | 'execute-unknown'
  | 'execute-rejected';
const nativeShellCases = new Map<
  NativeShellCase,
  {
    execution: Execution;
    command?: string;
    shellId: string;
    operation: 'execute' | 'launch' | 'read' | 'wait' | 'stop';
  }
>();
let nativeShellMetadataHeld = false;
const nativeShellMetadataPending: (() => void)[] = [];
const nativeShellMetadataPages: { entries: unknown[]; modelStatuses: string[] }[] = [];
const pending: (() => void)[] = [];
const requests: NativeRequest[] = [];
export type SettingsFixtureSnapshot = {
  providerSettingsSubmissions: NativeProviderSubmission[];
  modelSettingsSubmissions: NativeModelSettingsSubmission[];
  audit: { method: string; input?: unknown }[];
  revision: number;
  defaultModelId: string;
  models: ModelSettingsView['models'];
  connection: { name: string; baseURL: string; modelNames: string[] };
  pending: number;
  pendingModelReads: number;
  pendingProviderReads: number;
  pendingLookups: number;
  concurrentWrites: number;
  maxConcurrentWrites: number;
  receipts: import('@kite-ai/client').HostMutation[];
};
let settingsEnabled = false;
const settingsListeners = new Set<(event: NativeEvent) => void>();
let settingsState: SettingsFixtureSnapshot | undefined;
const settingsId = crypto.randomUUID();
let settingsScope = { generation: 1, selection: 1, storeId: 'store', sessionId: 'a' };
async function settingsRequest(input?: NativeRequest, action?: string) {
  const response = await fetch('/native-settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: settingsId, input, action, scope: settingsScope }),
  });
  const result = (await response.json()) as {
    value?: NativeResult;
    state: SettingsFixtureSnapshot;
    error?: { code: string };
  };
  settingsState = result.state;
  for (const listener of settingsListeners)
    listener({ kind: 'changed', generation: settingsScope.generation });
  if (result.error) throw Object.assign(Error(result.error.code), { code: result.error.code });
  return result;
}
const modelSnapshots = new Map<string, ModelOutputSnapshot>();
const modelReaders = new Map<string, Uint8Array>();
let historyHeld = false;
const historyPending: (() => void)[] = [];
const definitions = [
  ['files.read', '4', { path: 'src/entry.ts' }],
  ['files.write', '2', { path: 'src/output.ts', content: 'fixture' }],
  ['shell.launch', '1', { command: 'bun test ./test/example.test.ts' }],
  ['mcp.fixture.search', '7', { query: 'mixed tools' }],
  ['task.message', '1', { task_id: 'child', message: '核对工具状态' }],
  ['files.search', '4', { pattern: 'ToolActivity' }],
  ['files.edit', '2', { path: 'src/entry.ts' }],
] as const;
function add(index: number) {
  const [definitionId, definitionVersion, toolInput] =
    definitions[(index - 1) % definitions.length]!;
  const execution: Execution = {
    id: `execution-${index}`,
    originStoreId: 'store',
    sessionId: 'a',
    kind: 'tool',
    runId: 'run-a',
    definitionId,
    definitionVersion,
    status: 'running',
    toolCallId: `call-${index}`,
    toolInput,
    result: null,
    resultRevision: '0',
    cancelRequestedAt: null,
  };
  executions.push(execution);
  facts.set(execution.id, execution);
}
const bridge: NativeBridge = {
  ...control.bridge,
  watch(listener) {
    const unwatch = control.bridge.watch(listener);
    settingsListeners.add(listener);
    return () => {
      settingsListeners.delete(listener);
      unwatch();
    };
  },
  async request(request) {
    requests.push(request);
    if (
      settingsEnabled &&
      request.method.startsWith('settings.') &&
      (request.method.startsWith('settings.models.') ||
        request.method.startsWith('settings.general.models.') ||
        request.method.startsWith('settings.providers.'))
    ) {
      return (await settingsRequest(request)).value ?? null;
    }
    if (request.method === 'messages') {
      const selected = request.sessionId === 'a' ? messages : [];
      const page = structuredClone({
        messages: selected.filter(
          (message) =>
            BigInt(message.seq) > BigInt(request.afterSeq ?? '0') &&
            BigInt(message.seq) <= BigInt(request.upperSeq!),
        ),
        nextAfterSeq: null,
        highWaterSeq: request.upperSeq!,
      });
      if (historyHeld) await new Promise<void>((resolve) => historyPending.push(resolve));
      return page;
    }
    if (request.method === 'modelOutput.open') {
      const snapshot = modelSnapshots.get(request.executionId);
      if (!snapshot) throw Error('fixture_model_snapshot_missing');
      const wire = new TextEncoder().encode(JSON.stringify(snapshot));
      modelReaders.set(request.readId, wire);
      return {
        kind: 'modelOutput.opened',
        readId: request.readId,
        viewGeneration: 1,
        viewSelection: 2,
        storeId: 'store',
        sessionId: 'a',
        executionId: snapshot.executionId,
        wireBytes: String(wire.length),
        bodyHash: snapshot.bodyHash,
        bodyBytes: snapshot.bodyBytes,
      };
    }
    if (request.method === 'modelOutput.read') {
      const wire = modelReaders.get(request.readId);
      if (!wire) throw Error('fixture_model_reader_missing');
      const next = Math.min(wire.length, request.offset + request.limit);
      return {
        kind: 'modelOutput.chunk',
        readId: request.readId,
        offset: request.offset,
        nextOffset: next,
        eof: next === wire.length,
        data: btoa(String.fromCharCode(...wire.slice(request.offset, next))),
      };
    }
    if (request.method === 'modelOutput.close') {
      modelReaders.delete(request.readId);
      return null;
    }
    const result = await control.bridge.request(request);
    if (
      __KITE_FIXTURE_EMPTY_MODEL_CHOICE__ &&
      request.method === 'input.models.read' &&
      result &&
      'models' in result &&
      'kind' in result &&
      result.kind === 'settings.models'
    ) {
      // This anonymous Session has no persisted explicit route despite its global default.
      const { selectedModelId: _selectedModelId, ...facts } = result;
      return facts;
    }
    if (
      (request.method === 'attach' || request.method === 'state' || request.method === 'select') &&
      result &&
      'selection' in result &&
      result.selection
    ) {
      settingsScope = {
        generation: result.generation,
        selection: result.selection.viewSelection ?? 0,
        storeId: result.selection.storeId,
        sessionId: result.selection.session.id,
      };
      const selected = result.selection.session.id === 'a';
      return structuredClone({
        ...result,
        ...(settingsState
          ? {
              providerSettingsSubmissions: settingsState.providerSettingsSubmissions,
              modelSettingsSubmissions: settingsState.modelSettingsSubmissions,
            }
          : {}),
        selection: {
          ...result.selection,
          session: {
            ...result.selection.session,
            nextSeq: String(selected ? messages.length + 1 : 1),
          },
          runs: selected ? [run] : [],
          executions: selected
            ? executions.map((execution) => {
                if (!nativeShellCases.size) return execution;
                const { toolInput: _savedInput, ...observed } = execution;
                return observed;
              })
            : [],
          canReadModelOutput: true,
        },
      });
    }
    if (request.method === 'directory' && result && 'sessions' in result)
      return {
        ...result,
        sessions: result.sessions.map((session) => ({
          ...session,
          nextSeq: String(session.id === 'a' ? messages.length + 1 : 1),
        })),
      };
    if (
      request.method === 'toolMessages.runs' &&
      result &&
      'kind' in result &&
      result.kind === 'toolMessages.runs' &&
      'scope' in result
    )
      return { ...result, runs: result.scope.sessionId === 'a' ? [nativeRunFact(run)] : [] };
    if (
      request.method === 'toolMessages.list' &&
      result &&
      'kind' in result &&
      result.kind === 'toolMessages.page' &&
      'scope' in result
    ) {
      if (nativeShellCases.size) {
        if (nativeShellMetadataHeld)
          await new Promise<void>((resolve) => nativeShellMetadataPending.push(resolve));
        const response = await fetch('/native-shell-metadata', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messageIds: request.messageIds,
            commandOffsets: request.commandOffsets,
            input: request,
            scope: result.scope,
            observedExecutions: executions.map(
              ({ toolInput: _savedInput, ...observed }) => observed,
            ),
            messages,
            executions: [...facts.values()],
          }),
        });
        if (!response.ok) throw Error(`fixture_native_shell_metadata_${response.status}`);
        const entries = await response.json();
        nativeShellMetadataPages.push({
          entries,
          modelStatuses: messages
            .filter((message) => message.role === 'assistant')
            .map((message) => message.status),
        });
        return { ...result, entries };
      }
      return new Promise((resolve) =>
        pending.push(() =>
          resolve({
            ...result,
            entries: request.messageIds.flatMap((messageId) => {
              const message = messages.find((item) => item.id === messageId);
              const execution = facts.get(message?.sourceIds?.[0] ?? '');
              return execution
                ? [
                    {
                      messageId,
                      executionId: execution.id,
                      definitionId: execution.definitionId,
                      definitionVersion: execution.definitionVersion,
                      status: execution.status,
                      resultRevision: execution.resultRevision,
                      target:
                        execution.definitionId === 'web_fetch'
                          ? (execution.toolInput as { url: string }).url
                          : `fixture-target-${execution.id}`,
                      ...(execution.authorization
                        ? { authorization: execution.authorization }
                        : {}),
                    },
                  ]
                : [];
            }),
          }),
        ),
      );
    }
    if (
      request.method === 'toolMessages.usage' &&
      result &&
      'kind' in result &&
      result.kind === 'toolMessages.usage'
    )
      return { ...result, entries: [] };
    if (
      request.method === 'fileTargets.list' &&
      result &&
      'kind' in result &&
      result.kind === 'fileTargets.page'
    )
      return { ...result, entries: [] };
    if (
      request.method === 'fileChanges.list' &&
      result &&
      'kind' in result &&
      result.kind === 'fileChanges.page'
    )
      return { ...result, entries: [] };
    return result;
  },
};
export interface LiveAggregationFixture {
  requests: NativeRequest[];
  settings(
    action:
      | 'start'
      | 'state'
      | 'hold'
      | 'release'
      | 'unknown-next'
      | 'hold-model-reads'
      | 'release-model-reads'
      | 'hold-provider-reads'
      | 'release-provider-reads'
      | 'failed-next'
      | 'failed-read-next'
      | 'foreign-read-next'
      | 'hold-lookups'
      | 'release-lookups'
      | 'failed-provider-read-next',
  ): Promise<SettingsFixtureSnapshot>;
  pending(): number;
  add(index: number): void;
  settle(
    index: number,
    status?: 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown',
    remove?: boolean,
  ): void;
  flush(): void;
  finish(): void;
  model(
    id: string,
    phase: 'empty' | 'empty-no-body' | 'tool-only' | 'body-preview-empty' | 'narration',
  ): Promise<void>;
  holdHistory(): void;
  releaseHistory(): void;
  historyPending(): number;
  longGroup(): {
    error: string;
    approval: string;
    matrix: {
      definitionId: string;
      approval: string;
      status: string;
      issue: boolean;
      reason?: string;
    }[];
  };
  startNativeShell(kind: NativeShellCase): {
    command?: string;
    shellId: string;
    definitionId: string;
  };
  settleNativeShell(kind: NativeShellCase): void;
  completeNativeShellModel(kind: NativeShellCase): Message;
  phaseNativeShell(kind: NativeShellCase, phase: 'auto' | 'human' | 'running'): void;
  nativeShellMetadataPages(): { entries: unknown[]; modelStatuses: string[] }[];
  holdNativeShellMetadata(): void;
  releaseNativeShellMetadata(): void;
  nativeShellMetadataPending(): number;
}
declare global {
  interface Window {
    liveAggregationFixture: LiveAggregationFixture;
  }
}
window.liveAggregationFixture = {
  requests,
  async settings(action) {
    if (action === 'start') settingsEnabled = true;
    return (await settingsRequest(undefined, action)).state;
  },
  pending: () => pending.length,
  holdHistory() {
    historyHeld = true;
  },
  releaseHistory() {
    historyHeld = false;
    for (const release of historyPending.splice(0)) release();
  },
  historyPending: () => historyPending.length,
  holdNativeShellMetadata() {
    nativeShellMetadataHeld = true;
  },
  releaseNativeShellMetadata() {
    nativeShellMetadataHeld = false;
    for (const release of nativeShellMetadataPending.splice(0)) release();
  },
  nativeShellMetadataPending: () => nativeShellMetadataPending.length,
  nativeShellMetadataPages: () => nativeShellMetadataPages,
  phaseNativeShell(kind, phase) {
    const execution = nativeShellCases.get(kind)!.execution;
    execution.status = phase === 'running' ? 'running' : 'planned';
    execution.authorization = {
      dispatched: phase === 'running',
      check: {
        executionId: `check-${execution.id}`,
        status: phase === 'auto' ? 'running' : 'succeeded',
        decision: phase === 'auto' ? 'unavailable' : 'ask_user',
        reason: '匿名 Shell 审批状态',
        requireApproval: true,
      },
      ...(phase === 'human'
        ? {
            human: {
              interactionId: `approval-${execution.id}`,
              state: 'pending',
              revision: '1',
              acceptedDecisionRevision: null,
              accepted: false,
              decision: null,
            },
          }
        : phase === 'running'
          ? {
              human: {
                interactionId: `approval-${execution.id}`,
                state: 'answered',
                revision: '2',
                acceptedDecisionRevision: '2',
                accepted: true,
                decision: 'approve',
                grant: 'approve_once',
              },
            }
          : {}),
    };
    control.publish();
  },
  completeNativeShellModel(kind) {
    const execution = nativeShellCases.get(kind)!.execution;
    const previous = messages.findIndex((message) => message.id === `model-${execution.id}`);
    messages[previous] = {
      ...messages[previous]!,
      status: 'complete',
      toolCalls: [
        {
          id: execution.toolCallId!,
          name: execution.definitionId,
          arguments: JSON.stringify(execution.toolInput),
        },
      ],
    };
    control.publish();
    return messages[previous]!;
  },
  startNativeShell(kind) {
    const operation =
      kind === 'execute' ||
      kind === 'execute-large' ||
      kind === 'execute-model-late' ||
      kind === 'execute-live' ||
      kind === 'execute-failed' ||
      kind === 'execute-unknown' ||
      kind === 'execute-rejected'
        ? 'execute'
        : kind;
    const shellId = operation === 'execute' ? `native-${kind}` : 'native-main';
    const command =
      operation === 'execute' || operation === 'launch'
        ? `python3 - <<'PY'\n${kind === 'execute' || kind === 'execute-large' || kind === 'execute-live' ? Array.from({ length: kind === 'execute-large' ? 1200 : 320 }, (_, index) => `# 原命令 👩 ${index} 保持完整字节和多行\n`).join('') : ''}print('Native Shell 中文 👩')\nPY`
        : undefined;
    const id = `native-shell-${kind}`;
    const input: Record<string, string | number> = command
      ? { key: shellId, command }
      : {
          shellId,
          ...(operation === 'wait' ? { timeoutMs: 0 } : {}),
          ...(operation === 'stop' ? { commandId: 'native-stop-original' } : {}),
        };
    messages.push({
      id: `model-${id}`,
      role: 'assistant',
      status: kind === 'execute-model-late' ? 'incomplete' : 'complete',
      content: '',
      firstOutput: 'tool_calls',
      sessionId: 'a',
      runId: 'run-a',
      seq: String(messages.length + 1),
      ...(kind === 'execute-model-late'
        ? { toolCalls: [], sourceIds: [`original-model-${id}`] }
        : kind === 'execute-large'
          ? {
              toolCalls: [],
              sourceIds: [`omitted-call-model-${id}`],
              outputBody: {
                kind: 'model_output' as const,
                executionId: `omitted-call-model-${id}`,
                complete: true,
                contentBytes: '0',
                reasoningBytes: '0',
                toolCallCount: 1,
              },
            }
          : {
              toolCalls: [
                { id: `call-${id}`, name: `shell.${operation}`, arguments: JSON.stringify(input) },
              ],
            }),
    });
    const execution: Execution = {
      id,
      originStoreId: 'store',
      sessionId: 'a',
      runId: 'run-a',
      kind: 'tool',
      definitionId: `shell.${operation}`,
      definitionVersion: '1',
      status: kind === 'execute-rejected' || kind === 'execute-live' ? 'planned' : 'running',
      toolCallId: `call-${id}`,
      toolInput: input,
      ...(kind === 'execute-large' ? { parentExecutionId: null } : {}),
      result: null,
      resultRevision: '0',
      cancelRequestedAt: null,
      ...(kind === 'execute-rejected'
        ? {
            authorization: {
              dispatched: false,
              check: {
                executionId: 'native-shell-reject-check',
                status: 'running' as const,
                decision: 'unavailable' as const,
                reason: '正在核对审批',
                requireApproval: true,
              },
            },
          }
        : {}),
    };
    facts.set(id, execution);
    executions.push(execution);
    nativeShellCases.set(kind, { execution, command, shellId, operation });
    control.publish();
    return { command, shellId, definitionId: execution.definitionId };
  },
  settleNativeShell(kind) {
    const entry = nativeShellCases.get(kind)!;
    const execution = entry.execution;
    const ref = {
      extensionId: 'builtin.shell',
      key: entry.shellId,
      sessionId: 'a',
      originStoreId: 'store',
      commandId: `job-command-${entry.shellId}`,
      executionId: `job-${entry.shellId}`,
    };
    const jobStatus =
      kind === 'execute' ||
      kind === 'execute-large' ||
      kind === 'execute-model-late' ||
      kind === 'execute-live'
        ? 'succeeded'
        : kind === 'execute-failed'
          ? 'failed'
          : kind === 'execute-unknown'
            ? 'outcome_unknown'
            : 'running';
    const terminal = ['succeeded', 'failed', 'outcome_unknown'].includes(jobStatus);
    const job = {
      ...base.execution,
      id: ref.executionId,
      sessionId: 'a',
      rootSessionId: 'a',
      kind: 'job',
      definitionId: 'shell.command',
      definitionVersion: '1',
      status: jobStatus,
      originCommandId: ref.commandId,
      resultRevision: terminal ? '1' : '0',
      result: terminal
        ? {
            outcome: jobStatus,
            content: `original-job-${jobStatus}`,
            details: {
              ...(jobStatus === 'succeeded'
                ? { exitCode: 0 }
                : jobStatus === 'failed'
                  ? { exitCode: 7 }
                  : {}),
            },
          }
        : null,
    };
    const stdout =
      kind === 'execute-model-late'
        ? `${Array.from({ length: 40 }, (_, index) => `匿名迟到Model输出 ${index + 1}`).join('\n')}\nNATIVE_LATE_MODEL_OUTPUT_END\n`
        : `Native ${kind} 原输出\n第二行 👩\n`;
    const stderr =
      kind === 'execute-failed'
        ? 'NATIVE_REAL_FAILURE_REASON\n'
        : kind === 'execute-unknown'
          ? 'NATIVE_OUTCOME_UNKNOWN_REASON\n'
          : '';
    const details =
      entry.operation === 'launch'
        ? { accepted: true, shellId: entry.shellId, ref, presentation: 'standalone' }
        : {
            ref,
            execution: job,
            ...(entry.operation === 'execute'
              ? {
                  stdout,
                  stderr,
                  stdoutBytes: String(new TextEncoder().encode(stdout).length),
                  stderrBytes: String(new TextEncoder().encode(stderr).length),
                  droppedBytes: '0',
                  truncated: false,
                  timedOut: false,
                  presentation: 'standalone',
                }
              : {}),
            ...(entry.operation === 'read'
              ? {
                  output: {
                    highWaterSeq: '2',
                    items: [
                      {
                        executionId: ref.executionId,
                        seq: '1',
                        throughSeq: '1',
                        stream: 'stdout',
                        content: stdout,
                        droppedBytes: null,
                      },
                      {
                        executionId: ref.executionId,
                        seq: '2',
                        throughSeq: '2',
                        stream: 'stderr',
                        content: 'Native stderr\n',
                        droppedBytes: null,
                      },
                    ],
                  },
                }
              : {}),
            ...(entry.operation === 'wait' ? { timedOut: true } : {}),
            ...(entry.operation === 'stop' ? { cancelRequested: true } : {}),
          };
    execution.status =
      kind === 'execute-failed' || kind === 'execute-rejected'
        ? 'failed'
        : kind === 'execute-unknown'
          ? 'outcome_unknown'
          : 'succeeded';
    const content =
      kind === 'execute-rejected' ? 'NATIVE_APPROVAL_REJECTION_REASON' : JSON.stringify(details);
    execution.result = {
      outcome: execution.status,
      content,
      ...(kind === 'execute-rejected' ? {} : { details: JSON.parse(content) }),
    };
    execution.resultRevision = '1';
    if (kind === 'execute-rejected')
      execution.authorization = {
        dispatched: false,
        check: {
          executionId: 'native-shell-reject-check',
          status: 'succeeded',
          decision: 'reject',
          reason: content,
          requireApproval: true,
        },
      };
    messages.push({
      id: `receipt-${execution.id}`,
      role: 'tool',
      status: 'complete',
      content,
      sessionId: 'a',
      runId: 'run-a',
      seq: String(messages.length + 1),
      toolCallId: execution.toolCallId,
      sourceIds: [execution.id],
    });
    control.publish();
  },
  longGroup() {
    const error = `FAILED_WRITE_DETAIL_START\n${'写入失败的完整原因：文件版本已变化，保留原始内容与实际错误。\n'.repeat(28)}FAILED_WRITE_DETAIL_END`;
    const approval = `APPROVAL_REJECTION_START\n${'自动审批拒绝的完整原因：本项操作没有获得所需的授权，未派发执行。\n'.repeat(26)}APPROVAL_REJECTION_END`;
    const auto = (
      index: number,
      dispatched: boolean,
      status: Execution['status'],
      decision: 'reject' | 'ask_user' | 'approve_once' | 'unavailable',
      reason: string,
    ): NonNullable<Execution['authorization']> => ({
      dispatched,
      check: {
        executionId: `authorization-check-${index}`,
        status,
        decision,
        reason,
        requireApproval: true,
      },
    });
    const human = (
      state: 'pending' | 'answered',
      decision: 'approve' | 'deny' | null,
      dispatched: boolean,
    ): NonNullable<Execution['authorization']> => ({
      dispatched,
      human: {
        interactionId: `interaction-${decision ?? 'pending'}`,
        state,
        revision: '1',
        acceptedDecisionRevision: state === 'answered' ? '1' : null,
        accepted: state === 'answered',
        decision,
        ...(decision === 'approve' ? { grant: 'same_command' as const } : {}),
      },
    });
    const matrix: {
      index: number;
      key: string;
      executionStatus: Execution['status'];
      authorization: NonNullable<Execution['authorization']>;
      approval: string;
      status: string;
      issue: boolean;
      reason?: string;
    }[] = [
      {
        index: 4,
        key: 'auto-reject',
        executionStatus: 'failed',
        authorization: auto(4, false, 'succeeded', 'reject', approval),
        approval: '自动审批未通过',
        status: '',
        issue: false,
        reason: approval,
      },
      {
        index: 9,
        key: 'human-reject',
        executionStatus: 'failed',
        authorization: human('answered', 'deny', false),
        approval: '人工审批已拒绝',
        status: '',
        issue: false,
        reason: 'MATRIX_HUMAN_REJECT_REASON\n人工拒绝的原始原因。',
      },
      {
        index: 10,
        key: 'auto-stop',
        executionStatus: 'cancelled',
        authorization: auto(
          10,
          false,
          'cancelled',
          'unavailable',
          'MATRIX_AUTO_STOP_REASON\n自动审批已停止，未派发。',
        ),
        approval: '自动审批已停止',
        status: '',
        issue: false,
        reason: 'MATRIX_AUTO_STOP_REASON\n自动审批已停止，未派发。',
      },
      {
        index: 11,
        key: 'human-wait',
        executionStatus: 'planned',
        authorization: {
          ...human('pending', null, false),
          ...auto(11, false, 'succeeded', 'ask_user', 'MATRIX_WAIT_REASON'),
        },
        approval: '等待人工审批',
        status: '',
        issue: false,
      },
      {
        index: 12,
        key: 'auto-approved-running',
        executionStatus: 'running',
        authorization: auto(
          12,
          true,
          'succeeded',
          'approve_once',
          'MATRIX_APPROVAL_SUCCESS_REASON_MUST_STAY_HIDDEN',
        ),
        approval: '已自动批准',
        status: '执行中',
        issue: false,
      },
      {
        index: 13,
        key: 'auto-approved-failed',
        executionStatus: 'failed',
        authorization: auto(
          13,
          true,
          'succeeded',
          'approve_once',
          'MATRIX_APPROVAL_SUCCESS_REASON_MUST_STAY_HIDDEN',
        ),
        approval: '已自动批准',
        status: '失败',
        issue: true,
        reason: 'MATRIX_EXECUTION_FAILURE_REASON\n已派发后的真实执行失败。',
      },
      {
        index: 14,
        key: 'approved-unknown',
        executionStatus: 'outcome_unknown',
        authorization: auto(
          14,
          true,
          'succeeded',
          'approve_once',
          'MATRIX_APPROVAL_SUCCESS_REASON_MUST_STAY_HIDDEN',
        ),
        approval: '已自动批准',
        status: '结果未知',
        issue: true,
        reason: 'MATRIX_UNKNOWN_REASON\n执行结果无法确认。',
      },
      {
        index: 15,
        key: 'human-approved-running',
        executionStatus: 'running',
        authorization: human('answered', 'approve', true),
        approval: '已人工批准 · 本会话相同命令',
        status: '执行中',
        issue: false,
      },
      {
        index: 16,
        key: 'auto-checking',
        executionStatus: 'planned',
        authorization: auto(16, false, 'running', 'unavailable', 'checking'),
        approval: '正在自动审批',
        status: '',
        issue: false,
      },
      {
        index: 17,
        key: 'auto-approved-success',
        executionStatus: 'succeeded',
        authorization: auto(
          17,
          true,
          'succeeded',
          'approve_once',
          'MATRIX_APPROVAL_SUCCESS_REASON_MUST_STAY_HIDDEN',
        ),
        approval: '已自动批准',
        status: '',
        issue: false,
      },
      {
        index: 18,
        key: 'approval-and-tool-unknown',
        executionStatus: 'outcome_unknown',
        authorization: auto(
          18,
          false,
          'outcome_unknown',
          'unavailable',
          'MATRIX_APPROVAL_UNKNOWN_REASON',
        ),
        approval: '自动审批结果未知',
        status: '结果未知',
        issue: true,
        reason: 'MATRIX_APPROVAL_UNKNOWN_REASON',
      },
    ];
    for (let index = 1; index <= 36; index++) {
      add(index);
      const execution = facts.get(`execution-${index}`)!;
      const approvalCase = matrix.find((entry) => entry.index === index);
      execution.status = index === 2 || index === 4 ? 'failed' : 'succeeded';
      execution.resultRevision = '1';
      const webIndex = index >= 29 && index <= 34 ? index - 29 : undefined;
      if (webIndex !== undefined) {
        execution.definitionId = 'web_fetch';
        execution.definitionVersion = '1';
        execution.toolInput = {
          url: `https://github.com/${['ollama/ollama', 'immich-app/immich', 'n8n-io/n8n', 'astral-sh/uv', 'open-webui/open-webui', 'AppFlowy-IO/AppFlowy'][webIndex]}?token=WEB_QUERY_MUST_STAY_PRIVATE#WEB_FRAGMENT_PRIVATE`,
        };
        execution.status = webIndex === 5 ? 'failed' : 'succeeded';
        execution.authorization = auto(
          index,
          true,
          'succeeded',
          'approve_once',
          'WEB_APPROVAL_REASON_MUST_STAY_HIDDEN',
        );
      }
      if (approvalCase) {
        execution.definitionId = `approval.fixture.${approvalCase.key}`;
        execution.definitionVersion = '1';
        execution.authorization = approvalCase.authorization;
        execution.status = approvalCase.executionStatus;
      }
      if (execution.status === 'planned' || execution.status === 'running') {
        execution.resultRevision = '0';
        continue;
      }
      messages.push({
        id: `receipt-${index}`,
        role: 'tool',
        status: 'complete',
        sessionId: 'a',
        runId: 'run-a',
        seq: String(messages.length + 1),
        sourceIds: [execution.id],
        toolCallId: execution.toolCallId,
        content:
          index === 2
            ? error
            : webIndex === 5
              ? 'web_timeout'
              : (approvalCase?.reason ?? 'Tool completed.'),
      });
    }
    control.publish();
    return {
      error,
      approval,
      matrix: matrix.map((entry) => ({
        definitionId: `approval.fixture.${entry.key}`,
        approval: entry.approval,
        status: entry.status,
        issue: entry.issue,
        reason: entry.reason,
      })),
    };
  },
  async model(id, phase) {
    const complete = phase === 'tool-only' || phase === 'narration';
    const content =
      phase === 'body-preview-empty' || phase === 'narration' ? '接着核对下一组工具。' : '';
    const output = {
      content,
      reasoning: '',
      complete,
      toolCalls: complete
        ? [
            {
              id: 'call-2',
              name: 'files.write',
              arguments: '{"path":"src/output.ts","content":"fixture"}',
            },
          ]
        : [],
    };
    const bytes = new TextEncoder().encode(canonicalModelBody(output));
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const executionId = `model-${id}`;
    modelSnapshots.set(executionId, {
      storeId: 'store',
      sessionId: 'a',
      rootSessionId: 'a',
      runId: 'run-a',
      executionId,
      originCommandId: run.originCommandId ?? 'start',
      rootWorkCommandId: run.rootWorkCommandId ?? 'start',
      rootWorkSeq: run.rootWorkSeq ?? '1',
      attempt: 1,
      status: complete ? 'succeeded' : 'running',
      bodyHash: hash,
      bodyBytes: String(bytes.length),
      contentBytes: String(new TextEncoder().encode(content).length),
      reasoningBytes: '0',
      snapshotCursor: '1',
      output,
    });
    const previous = messages.findIndex((message) => message.id === id);
    const message: Message = {
      id,
      sessionId: 'a',
      runId: 'run-a',
      seq: previous < 0 ? String(messages.length + 1) : messages[previous]!.seq,
      role: 'assistant',
      status: complete ? 'complete' : 'incomplete',
      content: phase === 'narration' ? content : '',
      firstOutput:
        phase === 'tool-only' || phase === 'empty' || phase === 'empty-no-body'
          ? 'tool_calls'
          : 'content',
      sourceIds: [executionId],
      outputBody: {
        kind: 'model_output',
        executionId,
        complete,
        contentBytes: String(new TextEncoder().encode(content).length),
        reasoningBytes: '0',
        toolCallCount: output.toolCalls.length,
      },
      ...(complete ? { toolCalls: output.toolCalls } : {}),
    };
    if (phase === 'empty-no-body') delete message.outputBody;
    if (previous < 0) messages.push(message);
    else messages[previous] = message;
    control.publish();
  },
  add(index) {
    add(index);
    control.publish();
  },
  settle(index, status = 'succeeded', remove = false) {
    const execution = facts.get(`execution-${index}`)!;
    execution.status = status;
    execution.resultRevision = '1';
    messages.push({
      id: `receipt-${index}`,
      role: 'tool',
      status: 'complete',
      sessionId: 'a',
      runId: 'run-a',
      seq: String(messages.length + 1),
      sourceIds: [execution.id],
      toolCallId: execution.toolCallId,
      content: JSON.stringify({ result: raw, execution: execution.id }),
    });
    if (remove) executions.splice(executions.indexOf(execution), 1);
    control.publish();
  },
  flush() {
    for (const release of pending.splice(0)) release();
  },
  finish() {
    run.status = 'completed';
    run.isActive = false;
    run.finishedAt = Date.now();
    messages.push({
      id: 'final-reply',
      role: 'assistant',
      status: 'complete',
      sessionId: 'a',
      runId: 'run-a',
      seq: String(messages.length + 1),
      content: '混合工具执行已结束，保留各项真实结果。',
    });
    control.publish();
  },
};
Object.defineProperty(window, 'kiteNative', { value: bridge });
document.documentElement.dataset.nativeWindow = 'true';
document.documentElement.dataset.platform = 'darwin';
export interface ToolScrollIsland {
  appendShell(): void;
  finishShell(): void;
  groupTools(): void;
  shellText(): string;
  diffText(): string;
  shellScenario(
    scenario:
      | 'execute-running'
      | 'execute-success'
      | 'execute-failed'
      | 'execute-unknown'
      | 'execute-rejected'
      | 'launch-accepted'
      | 'launch-running'
      | 'read-running'
      | 'wait-timeout'
      | 'stop-requested'
      | 'cancelled-before-dispatch'
      | 'legacy-success',
  ): void;
  commandText(): string;
}
declare global {
  interface Window {
    toolScrollIsland: ToolScrollIsland;
  }
}
function ToolScrollIslandPage() {
  const [output, setOutput] = useState(
    Array.from({ length: 85 }, (_, index) => `shell line ${index + 1}: fixture output`).join('\n'),
  );
  const [finished, setFinished] = useState(false);
  const [shellScenario, setShellScenario] =
    useState<Parameters<ToolScrollIsland['shellScenario']>[0]>('execute-running');
  const [grouped, setGrouped] = useState(false);
  const command = `python3 - <<'PY'\nfrom pathlib import Path\nprint("中文 👩 Shell 原命令")\nprint(Path('fixture-output.txt'))\nPY`;
  const diff = `DIFF_FULL_START\n${Array.from({ length: 95 }, (_, index) => `${index % 2 ? '+' : '-'} ${index + 1} ${'wide_diff_column_'.repeat(35)}`).join('\n')}\nDIFF_FULL_END`;
  window.toolScrollIsland = {
    appendShell() {
      flushSync(() =>
        setOutput(
          (previous) =>
            `${previous}\n${Array.from({ length: 20 }, (_, index) => `appended shell ${index + 1}: fixture output`).join('\n')}`,
        ),
      );
    },
    finishShell() {
      flushSync(() => {
        setFinished(true);
        setShellScenario('execute-success');
      });
    },
    groupTools() {
      flushSync(() => setGrouped(true));
    },
    shellText: () => output,
    diffText: () => diff,
    shellScenario(scenario) {
      flushSync(() => {
        setShellScenario(scenario);
        setFinished(scenario === 'execute-success' || scenario === 'legacy-success');
      });
    },
    commandText: () => command,
  };
  const operation: 'execute' | 'launch' | 'read' | 'wait' | 'stop' = shellScenario.startsWith(
    'launch-',
  )
    ? 'launch'
    : shellScenario === 'read-running'
      ? 'read'
      : shellScenario === 'wait-timeout'
        ? 'wait'
        : shellScenario === 'stop-requested'
          ? 'stop'
          : 'execute';
  const denied = shellScenario === 'execute-rejected',
    stoppedBeforeDispatch = shellScenario === 'cancelled-before-dispatch';
  const failed = shellScenario === 'execute-failed',
    unknown = shellScenario === 'execute-unknown';
  const terminalTool =
    operation !== 'execute' || finished || denied || stoppedBeforeDispatch || failed || unknown;
  const shellStatus: ToolMessage['status'] = denied
    ? 'rejected'
    : stoppedBeforeDispatch
      ? 'cancelled'
      : failed
        ? 'failed'
        : unknown
          ? 'unknown'
          : terminalTool
            ? 'completed'
            : 'running';
  const shellFacts = {
    operation,
    command,
    shellId: 'island-shell-original',
    ...(shellScenario === 'launch-accepted' ? { accepted: true } : {}),
    ...(!denied && !stoppedBeforeDispatch && shellScenario !== 'launch-accepted'
      ? {
          jobStatus: finished
            ? ('succeeded' as const)
            : failed
              ? ('failed' as const)
              : unknown
                ? ('outcome_unknown' as const)
                : ('running' as const),
        }
      : {}),
    stdout: denied || stoppedBeforeDispatch || shellScenario === 'launch-accepted' ? '' : output,
    ...(failed ? { stderr: 'SHELL_REAL_FAILURE_REASON', exitCode: 7 } : {}),
    ...(finished ? { exitCode: 0 } : {}),
    ...(unknown ? { stderr: 'SHELL_OUTCOME_UNKNOWN_REASON' } : {}),
    ...(shellScenario === 'wait-timeout' ? { timedOut: true } : {}),
    ...(shellScenario === 'stop-requested' ? { cancelRequested: true } : {}),
  };
  const messages: ToolMessage[] = [
    { id: 'island-intro', role: 'assistant', text: '工具滚动与完整输出验证。', settled: true },
    {
      id: 'tool:legacy-shell',
      role: 'tool',
      toolName: operation === 'execute' ? 'shell_execute' : `shell.${operation}`,
      ...(shellScenario !== 'legacy-success' ? { shell: shellFacts } : {}),
      ...(grouped ? { presentationGroupId: 'tool-scroll-island-group' } : {}),
      target: command,
      arguments: { command },
      text: '',
      settled: terminalTool,
      status: shellStatus,
      ...(denied
        ? {
            approval: {
              state: 'rejected' as const,
              source: 'auto' as const,
              reason: 'SHELL_APPROVAL_REJECTION_REASON',
            },
            dispatchCommitted: false,
          }
        : {}),
      ...(stoppedBeforeDispatch
        ? {
            approval: {
              state: 'cancelled' as const,
              source: 'auto' as const,
              reason: 'SHELL_APPROVAL_STOP_REASON',
            },
            dispatchCommitted: false,
          }
        : {}),
      ...(terminalTool
        ? {
            toolResult: {
              ok: !(denied || stoppedBeforeDispatch || failed || unknown),
              stdout: shellFacts.stdout,
              ...(failed ? { stderr: shellFacts.stderr, exitCode: 7 } : {}),
              ...(finished ? { exitCode: 0 } : {}),
            },
          }
        : { toolProgress: { stdout: output } }),
    },
    ...(!grouped
      ? [
          {
            id: 'island-separator',
            role: 'assistant' as const,
            text: '工具返回的完整文件差异。',
            settled: true,
          },
        ]
      : []),
    {
      id: 'tool:file-diff',
      role: 'tool',
      toolName: 'edit_file',
      ...(grouped ? { presentationGroupId: 'tool-scroll-island-group' } : {}),
      changedFile: 'fixture-diff.ts',
      changeConfirmed: true,
      text: '',
      settled: true,
      status: 'completed',
      toolResult: {
        ok: true,
        stdout: diff,
      },
    },
  ];
  return (
    <SessionPage
      workspaces={[]}
      selected="island"
      sessionLabel="Tool scroll fixture"
      readingKey="tool-scroll-island"
      messages={messages}
      loading={false}
      connected
      connectionLabel="isolated"
      actions={{}}
      composer={{
        draft: 'fixture draft',
        onChange: () => {},
        onSend: () => {},
        active: false,
        stopping: false,
        disabled: false,
      }}
    />
  );
}
const toolDetailsIsland = new URL(location.href).searchParams.get('island') === 'tool-details';
if (new URL(location.href).searchParams.get('cold-shell') === 'execute-live') {
  window.liveAggregationFixture.startNativeShell('execute-live');
  window.liveAggregationFixture.phaseNativeShell('execute-live', 'running');
  window.liveAggregationFixture.settleNativeShell('execute-live');
  executions.length = 0;
  run.status = 'completed';
  run.isActive = false;
  run.finishedAt = Date.now();
}
if (toolDetailsIsland)
  document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
createRoot(document.getElementById('root')!).render(
  toolDetailsIsland ? <ToolScrollIslandPage /> : <NativeDesktop nativeWindow />,
);

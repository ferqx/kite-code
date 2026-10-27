import type { Execution, Message } from '@kite-ai/client';
import {
  type Message as DesktopMessage,
  ToolActivity,
  ToolRow,
  useDesktopDiagnostics,
} from '@kite-ai/ui/desktop';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeBridge, NativeSelection } from './native-bridge';
import { NativeDisplayCache } from './native-display-cache';
import type {
  NativeRunFact,
  NativeToolExecution,
  NativeToolMessageFact,
} from './tool-messages-bridge';
import { nativeShellCommandChunkBytes } from './tool-messages-bridge';
import { nativeToolRequestTarget } from './tool-request-target';

const emptyToolFacts: NativeToolMessageFact[] = [];

const labels: Record<string, readonly [readonly string[], string]> = {
  'files.read': [['2', '3', '4', '5'], '读取'],
  'files.read_path': [['1', '2'], '读取'],
  'files.write_path': [['1'], '写入用户文件'],
  'files.edit_path': [['1'], '修改用户文件'],
  'files.write': [['2', '3'], '写入'],
  'files.edit': [['2'], '修改'],
  'files.glob': [['2', '3'], '查找文件'],
  'files.search': [['2', '3', '4', '5'], '搜索内容'],
  'files.list': [['1'], '列出目录'],
  'shell.launch': [['1'], '启动后台 Shell'],
  'shell.execute': [['1'], '运行命令'],
  'shell.read': [['1'], '读取后台 Shell'],
  'shell.wait': [['1'], '等待后台 Shell'],
  'shell.stop': [['1'], '请求停止后台 Shell'],
  ask_user: [['1'], '询问用户'],
  web_fetch: [['1'], '读取网页'],
  'task.spawn': [['1'], '创建子 Agent'],
  'task.follow_up': [['1'], '继续子 Agent'],
  'task.message': [['1'], '发送 Agent 消息'],
  'task.events': [['1'], '等待 Agent 事件'],
  'task.list': [['1'], '列出子 Agent'],
  'task.interrupt': [['1'], '中断子 Agent'],
  'planning.read': [['1'], '读取计划'],
  'planning.write': [['1'], '编写计划'],
  'planning.review': [['1'], '请求计划审阅'],
  'planning.update': [['1'], '更新计划'],
  'validation.define': [['1'], '定义验证检查'],
  'validation.check': [['1'], '运行验证'],
  'validation.rebind': [['1'], '关联修复结果'],
  'validation.request_waiver': [['1'], '请求验证豁免'],
  'validation.auto_check': [['1'], '检查文件变更'],
  'mcp.tools.search': [['1'], '搜索 MCP 工具'],
  'mcp.resources.list': [['1'], '列出 MCP 资源'],
  'mcp.resources.read': [['1'], '读取 MCP 资源'],
};
const exploration = new Set([
  'files.read',
  'files.read_path',
  'files.glob',
  'files.search',
  'files.list',
]);

/** Names follow stable IDs; structured presentation still requires a supported version. */
export function desktopToolPresentation(
  fact: Pick<NativeToolMessageFact, 'definitionId' | 'definitionVersion'> &
    Pick<Partial<NativeToolMessageFact>, 'label'>,
): Pick<DesktopMessage, 'toolName' | 'title' | 'presentation' | 'shell'> {
  const label = labels[fact.definitionId];
  const known = label?.[0].includes(fact.definitionVersion);
  const mcp = /^mcp\.([A-Za-z0-9_-]{1,128})\.[a-f0-9]{32}$/.test(fact.definitionId);
  return {
    toolName: known
      ? ((
          {
            'files.read': 'read_file',
            'files.read_path': 'read_file',
            'files.search': 'search_content',
            'files.write': 'write_file',
            'files.edit': 'edit_file',
            'shell.execute': 'shell_execute',
            'task.spawn': 'spawn_agent',
            'task.follow_up': 'follow_up_agent',
            'task.message': 'send_agent_message',
            'task.events': 'wait_agent_events',
            'task.list': 'list_agents',
            'task.interrupt': 'interrupt_agent',
          } as Record<string, string>
        )[fact.definitionId] ?? fact.definitionId)
      : undefined,
    title: label ? label[1] : mcp ? (fact.label ?? 'MCP 工具') : fact.definitionId,
    ...(known && fact.definitionId.startsWith('shell.')
      ? {
          shell: {
            operation: fact.definitionId.slice('shell.'.length) as NonNullable<
              DesktopMessage['shell']
            >['operation'],
          },
        }
      : {}),
    ...(known && exploration.has(fact.definitionId)
      ? { presentation: 'exploration' as const }
      : {}),
  };
}

/** Reading identity only; receipts keep their original IDs for metadata and I/O. */
export function nativeToolPresentationKey(
  storeId: string,
  sessionId: string,
  runId: string,
  executionId: string,
) {
  return JSON.stringify(['native-tool', storeId, sessionId, runId, executionId]);
}

/** Tool identity and readable boundaries own a block before receipt metadata arrives. */
export function groupNativeToolMessages(messages: readonly DesktopMessage[]): DesktopMessage[] {
  let boundary: string | undefined;
  return messages.map((message) => {
    if (message.role === 'tool' && message.turnId)
      return {
        ...message,
        presentationGroupId: JSON.stringify(['native-tools', message.turnId, boundary]),
      };
    if (
      message.role !== 'thinking' &&
      message.systemKind !== 'turn_timing' &&
      message.systemKind !== 'turn_terminal' &&
      message.presentation !== 'hidden' &&
      !(message.role === 'assistant' && message.settled && !message.text)
    )
      boundary = message.id;
    return message;
  });
}
const sameReceipt = (left: Message, right: Message) =>
  left.sessionId === right.sessionId &&
  left.seq === right.seq &&
  left.content === right.content &&
  left.runId === right.runId &&
  left.status === right.status &&
  left.contentFormat === right.contentFormat &&
  left.toolCallId === right.toolCallId &&
  left.sourceIds?.[0] === right.sourceIds?.[0] &&
  left.sourceIds?.length === right.sourceIds?.length &&
  JSON.stringify(left.originMessage) === JSON.stringify(right.originMessage);

function shellInputMissing(fact: NativeToolMessageFact | undefined) {
  const input = fact?.definitionVersion === '1' ? fact.shellInput : undefined;
  return (
    !!input &&
    (!input.shellId ||
      (['execute', 'launch'].includes(input.operation) && input.command === undefined))
  );
}
function withoutToolInput(fact: NativeToolMessageFact): NativeToolMessageFact {
  return {
    ...fact,
    target: undefined,
    inputPending: true,
    inputSource: undefined,
    ...(fact.shellInput
      ? {
          shellInput: { operation: fact.shellInput.operation },
          shellResultVerified: undefined,
        }
      : {}),
  };
}
function shellCallCompatible(
  message: Message,
  messages: readonly Message[],
  fact: NativeToolMessageFact,
) {
  if (!fact.inputSource || fact.inputSource.toolCallId !== message.toolCallId) return false;
  const origin = message.originMessage ?? message;
  const matches = messages.flatMap((candidate) => {
    const source = candidate.originMessage ?? candidate;
    return candidate.role === 'assistant' &&
      candidate.sessionId === message.sessionId &&
      candidate.originMessage?.storeId === message.originMessage?.storeId &&
      source.sessionId === origin.sessionId &&
      source.runId === origin.runId &&
      BigInt(candidate.seq) < BigInt(message.seq)
      ? (candidate.toolCalls ?? [])
          .filter((call) => call.id === message.toolCallId)
          .map((call) => ({ candidate, call }))
      : [];
  });
  if (!matches.length) return true;
  if (
    matches.length !== 1 ||
    matches[0]!.candidate.status !== 'complete' ||
    matches[0]!.candidate.contentFormat === 'unsupported' ||
    matches[0]!.call.name !== fact.definitionId
  )
    return false;
  try {
    const args = JSON.parse(matches[0]!.call.arguments);
    return ['execute', 'launch'].includes(fact.shellInput?.operation ?? '')
      ? fact.shellInput?.command !== undefined &&
          args.command === fact.shellInput.command &&
          args.key === fact.shellInput.shellId
      : args.shellId === fact.shellInput?.shellId;
  } catch {
    return false;
  }
}

/** Track only the Model facts Main needs to resolve this original call, never growing prose. */
function toolInputRevision(message: Message, messages: readonly Message[]) {
  if (!message.toolCallId) return { call: undefined, omission: undefined };
  const source = message.originMessage ?? message;
  const candidates = messages.filter((candidate) => {
    const origin = candidate.originMessage ?? candidate;
    return (
      candidate.role === 'assistant' &&
      candidate.sessionId === message.sessionId &&
      candidate.originMessage?.storeId === message.originMessage?.storeId &&
      origin.sessionId === source.sessionId &&
      origin.runId === source.runId &&
      BigInt(candidate.seq) < BigInt(message.seq)
    );
  });
  const latest = candidates.reduce<Message | undefined>(
    (previous, candidate) =>
      !previous || BigInt(candidate.seq) > BigInt(previous.seq) ? candidate : previous,
    undefined,
  );
  return {
    call: JSON.stringify(
      candidates.flatMap((candidate) => {
        const calls = candidate.toolCalls?.filter((call) => call.id === message.toolCallId);
        return calls?.length
          ? [[candidate.id, candidate.seq, candidate.status, candidate.contentFormat, calls]]
          : [];
      }),
    ),
    omission: JSON.stringify(
      latest && [
        latest.id,
        latest.seq,
        latest.status,
        latest.contentFormat,
        latest.sourceIds,
        latest.toolCalls?.length ?? 0,
        latest.outputBody && [
          latest.outputBody.executionId,
          latest.outputBody.complete,
          latest.outputBody.toolCallCount,
          latest.outputBody.readAvailability,
        ],
      ],
    ),
  };
}
export function authorizationApproval(
  authorization: Execution['authorization'],
): DesktopMessage['approval'] {
  const human = authorization?.human;
  if (human) {
    const state =
      human.state === 'cancelled'
        ? 'cancelled'
        : human.state === 'pending'
          ? 'awaiting_user'
          : human.decision === 'deny'
            ? 'rejected'
            : human.decision === 'approve'
              ? human.accepted && human.acceptedDecisionRevision === human.revision
                ? 'approved'
                : 'submitted'
              : undefined;
    if (state)
      return {
        source: 'user',
        state,
        interactionId: human.interactionId,
        grant: human.grant,
        ...(state === 'awaiting_user' && (authorization?.check ?? authorization?.review)?.reason
          ? { reason: (authorization.check ?? authorization.review)!.reason }
          : {}),
      };
  }
  const check = authorization?.check ?? authorization?.review;
  if (!check) return;
  return {
    source: 'auto',
    state: ['planned', 'dispatching', 'running'].includes(check.status)
      ? 'checking'
      : check.status === 'cancelled' && !authorization?.dispatched
        ? 'cancelled'
        : check.decision === 'approve_once'
          ? 'approved'
          : check.decision === 'reject'
            ? 'rejected'
            : 'unavailable',
    reason: check.reason,
  };
}

export function desktopToolMessage(
  fact: Pick<NativeToolMessageFact, 'definitionId' | 'definitionVersion' | 'status' | 'target'> &
    Pick<
      Partial<NativeToolMessageFact>,
      'ask' | 'authorization' | 'decisionRefresh' | 'shellInput' | 'shellResultVerified' | 'label'
    >,
  id: string,
  text: string,
): DesktopMessage {
  const shell = desktopShell(fact, text);
  return {
    id,
    role: 'tool',
    text,
    settled: !['planned', 'dispatching', 'running'].includes(fact.status),
    ...desktopToolPresentation(fact),
    target: fact.target,
    ...(shell ? { shell } : {}),
    ...(fact.ask ? { ask: fact.ask } : {}),
    ...(fact.status === 'failed' && fact.decisionRefresh
      ? { decisionRefresh: fact.decisionRefresh }
      : {}),
    ...(fact.authorization
      ? {
          approval: authorizationApproval(fact.authorization),
          dispatchCommitted: fact.authorization.dispatched,
        }
      : {}),
    status:
      fact.status === 'failed' && fact.decisionRefresh
        ? 'not_executed'
        : fact.status === 'succeeded'
          ? 'completed'
          : fact.status === 'outcome_unknown'
            ? 'unknown'
            : fact.status === 'planned'
              ? 'queued'
              : fact.status === 'dispatching'
                ? 'running'
                : fact.status,
  };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const decimal = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);

/** Display only: a Tool receipt never promotes acceptance to a completed Shell Job. */
function desktopShell(
  fact: Pick<NativeToolMessageFact, 'definitionId' | 'definitionVersion' | 'status'> &
    Pick<Partial<NativeToolMessageFact>, 'shellInput' | 'shellResultVerified' | 'target'>,
  text: string,
): DesktopMessage['shell'] {
  const operation = fact.definitionId.slice('shell.'.length);
  if (
    fact.definitionVersion !== '1' ||
    !fact.definitionId.startsWith('shell.') ||
    !['execute', 'launch', 'read', 'wait', 'stop'].includes(operation)
  )
    return;
  const input = fact.shellInput;
  const shell: NonNullable<DesktopMessage['shell']> = {
    operation: operation as NonNullable<DesktopMessage['shell']>['operation'],
    ...(input?.shellId ? { shellId: input.shellId } : {}),
    ...(input?.command === undefined && fact.target && ['execute', 'launch'].includes(operation)
      ? { commandPreview: fact.target }
      : {}),
    ...(input?.command !== undefined &&
    input.commandOffset === 0 &&
    input.commandNextOffset === null
      ? { command: input.command }
      : {}),
  };
  if (!fact.shellResultVerified) return shell;
  let result: Record<string, unknown> | undefined;
  try {
    result = record(JSON.parse(text));
  } catch {
    return shell;
  }
  if (!result) return shell;
  const ref = record(result.ref);
  if (ref?.extensionId !== 'builtin.shell' || ref.key !== shell.shellId) return shell;
  if (operation === 'launch')
    return result.accepted === true && result.shellId === shell.shellId
      ? { ...shell, accepted: true }
      : shell;
  const job = record(result.execution);
  if (
    !job ||
    job.id !== ref.executionId ||
    job.sessionId !== ref.sessionId ||
    job.originStoreId !== ref.originStoreId ||
    job.kind !== 'job' ||
    job.definitionId !== 'shell.command' ||
    job.definitionVersion !== '1' ||
    ![
      'planned',
      'dispatching',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'outcome_unknown',
    ].includes(String(job.status))
  )
    return shell;
  const terminal = ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(
    String(job.status),
  );
  const jobResult = record(job.result);
  if (
    terminal &&
    (!jobResult || jobResult.outcome !== job.status || typeof jobResult.content !== 'string')
  )
    return shell;
  if (
    operation === 'execute' &&
    (!terminal ||
      fact.status !==
        (result.timedOut === true && job.status === 'cancelled' ? 'failed' : job.status))
  )
    return shell;
  const details = record(jobResult?.details);
  const status = job.status as NonNullable<DesktopMessage['shell']>['jobStatus'];
  const verified = {
    ...shell,
    jobStatus: status,
    ...(Number.isSafeInteger(details?.exitCode) ? { exitCode: details!.exitCode as number } : {}),
    ...(typeof result.timedOut === 'boolean' ? { timedOut: result.timedOut } : {}),
    ...(operation === 'stop' && result.cancelRequested === true ? { cancelRequested: true } : {}),
  };
  if (operation === 'execute') {
    if (
      typeof result.stdout !== 'string' ||
      typeof result.stderr !== 'string' ||
      typeof result.truncated !== 'boolean' ||
      !decimal(result.droppedBytes) ||
      !decimal(result.stdoutBytes) ||
      !decimal(result.stderrBytes) ||
      (!result.truncated &&
        (BigInt(result.stdoutBytes) !== BigInt(new TextEncoder().encode(result.stdout).length) ||
          BigInt(result.stderrBytes) !== BigInt(new TextEncoder().encode(result.stderr).length)))
    )
      return result.cancellationObserved === true ? { ...verified, outputComplete: false } : shell;
    const truncated = result.truncated || BigInt(result.droppedBytes) > 0n;
    return {
      ...verified,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated,
      outputComplete: !truncated,
    };
  }
  if (operation !== 'read') return { ...verified, outputComplete: false };
  const output = record(result.output);
  if (!output || !decimal(output.highWaterSeq) || !Array.isArray(output.items)) return shell;
  let cursor = -1n,
    orderedOutput = '',
    stdout = '',
    stderr = '',
    dropped = false;
  for (const value of output.items) {
    const item = record(value);
    if (
      !item ||
      item.executionId !== ref.executionId ||
      !decimal(item.seq) ||
      !decimal(item.throughSeq) ||
      BigInt(item.seq) <= cursor ||
      BigInt(item.throughSeq) < BigInt(item.seq) ||
      BigInt(item.throughSeq) > BigInt(output.highWaterSeq) ||
      !['stdout', 'stderr', 'progress'].includes(String(item.stream)) ||
      typeof item.content !== 'string' ||
      (item.droppedBytes !== null && !decimal(item.droppedBytes))
    )
      return shell;
    cursor = BigInt(item.throughSeq);
    if (item.stream === 'stdout') stdout += item.content;
    if (item.stream === 'stderr') stderr += item.content;
    if (item.stream === 'stdout' || item.stream === 'stderr') orderedOutput += item.content;
    if (decimal(item.droppedBytes) && BigInt(item.droppedBytes) > 0n) dropped = true;
  }
  return {
    ...verified,
    stdout,
    stderr,
    output: orderedOutput,
    truncated: dropped,
    outputComplete: false,
  };
}
export function nativeShellInputPresentation(fact: NativeToolMessageFact) {
  return desktopShell({ ...fact, shellResultVerified: false }, '');
}
export function NativeToolMessage({ message }: { message: DesktopMessage }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <ToolActivity
      messages={[message]}
      expanded={expanded}
      onToggle={setExpanded}
      renderChildren={() => null}
    />
  );
}
export function liveToolMessages(
  selection:
    | {
        storeId: string;
        session: { id: string };
        runs: readonly NativeRunFact[];
        executions: readonly (NativeToolExecution & Partial<Pick<Execution, 'toolInput'>>)[];
        interactions?: NativeSelection['interactions'];
      }
    | undefined,
  messages: readonly Message[],
  executionUnconfirmed = false,
  inputFacts: readonly NativeToolMessageFact[] = [],
): { message: DesktopMessage; execution: NativeToolExecution }[] {
  if (!selection) return [];
  const runIds = new Set(selection.runs.filter((run) => run.isActive).map((run) => run.id));
  const results = new Set(
    messages
      .filter(
        (message) =>
          message.role === 'tool' &&
          message.status === 'complete' &&
          message.sessionId === selection.session.id &&
          message.sourceIds?.length === 1 &&
          (!message.originMessage || message.originMessage.storeId === selection.storeId),
      )
      .map((message) =>
        JSON.stringify([
          message.sourceIds![0],
          message.originMessage ? message.originMessage.runId : message.runId,
        ]),
      ),
  );
  return selection.executions
    .filter(
      (execution) =>
        execution.kind === 'tool' &&
        execution.originStoreId === selection.storeId &&
        execution.sessionId === selection.session.id &&
        !!execution.runId &&
        runIds.has(execution.runId) &&
        !results.has(JSON.stringify([execution.id, execution.runId])),
    )
    .map((execution) => {
      const input = inputFacts.find(
        (fact) =>
          fact.messageId === `native-execution:${execution.id}` &&
          fact.executionId === execution.id &&
          fact.definitionId === execution.definitionId &&
          fact.definitionVersion === execution.definitionVersion &&
          fact.inputSource?.storeId === selection.storeId &&
          fact.inputSource.sessionId === selection.session.id &&
          fact.inputSource.runId === execution.runId,
      );
      const run = selection.runs.find(
        (run) =>
          run.id === execution.runId &&
          run.isActive &&
          run.originStoreId === selection.storeId &&
          run.sessionId === selection.session.id,
      );
      const approvals =
        selection.interactions?.filter(
          (card) =>
            card.kind === 'approval' &&
            card.state === 'pending' &&
            card.originStoreId === selection.storeId &&
            card.sessionId === execution.sessionId &&
            card.runId === execution.runId &&
            card.executionId === execution.id &&
            card.definitionId === execution.definitionId &&
            card.definitionVersion === execution.definitionVersion,
        ) ?? [];
      return {
        execution,
        message: {
          ...desktopToolMessage(
            {
              ...execution,
              target: execution.definitionId.startsWith('shell.')
                ? undefined
                : (execution.target ??
                  nativeToolRequestTarget(
                    execution.toolInput,
                    execution.definitionId,
                    execution.definitionVersion,
                  )),
            },
            `native-execution:${execution.id}`,
            '',
          ),
          ...(input ? { shell: nativeShellInputPresentation(input) } : {}),
          presentationKey: nativeToolPresentationKey(
            selection.storeId,
            selection.session.id,
            execution.runId!,
            execution.id,
          ),
          executionUnconfirmed,
          ...(run
            ? {
                turnId: JSON.stringify([
                  'native-run',
                  selection.storeId,
                  selection.session.id,
                  run.id,
                ]),
              }
            : {}),
          ...(approvals.length === 1
            ? {
                approval: {
                  state: 'awaiting_user' as const,
                  source: 'user' as const,
                  interactionId: approvals[0]!.id,
                  reason:
                    (execution.authorization?.check ?? execution.authorization?.review)?.reason ??
                    undefined,
                },
              }
            : {}),
        },
      };
    });
}

/** Admit whole tool rows independently; a pending sibling never hides a complete one. */
export function completeNativeToolMessages(
  messages: readonly DesktopMessage[],
  facts: readonly NativeToolMessageFact[],
  pendingMessageIds?: ReadonlySet<string>,
): DesktopMessage[] {
  const complete = new Set(
    facts
      .filter((fact) => !fact.inputPending && !pendingMessageIds?.has(fact.messageId))
      .map((fact) => fact.messageId),
  );
  return messages.filter((message) => message.role !== 'tool' || complete.has(message.id));
}

export function nativeLiveToolPresentationReady(
  entry: {
    message: DesktopMessage;
    execution: NativeToolExecution & Partial<Pick<Execution, 'toolInput'>>;
  },
  facts: readonly NativeToolMessageFact[],
): boolean {
  if (!entry.message.shell)
    return entry.execution.inputReady === true || entry.execution.toolInput !== undefined;
  return facts.some(
    (fact) =>
      fact.messageId === entry.message.id &&
      fact.executionId === entry.execution.id &&
      !fact.inputPending &&
      fact.shellInput !== undefined &&
      fact.shellInput.commandNextOffset == null,
  );
}

/** Retain only previously complete, exact-identity rows while replacement metadata loads. */
export class NativeToolPresentation {
  private scope: string | undefined;
  private complete = new Map<string, DesktopMessage>();
  private readonly cached = new NativeDisplayCache<readonly [string, DesktopMessage][]>();
  private boundary: string | undefined;
  private bridge: unknown;

  project(
    scope: string,
    messages: readonly DesktopMessage[],
    facts: readonly NativeToolMessageFact[],
    live: readonly {
      message: DesktopMessage;
      execution: NativeToolExecution & Partial<Pick<Execution, 'toolInput'>>;
    }[],
    boundary?: { bridge: unknown; key: string },
  ): DesktopMessage[] {
    if (boundary && (boundary.bridge !== this.bridge || boundary.key !== this.boundary)) {
      this.bridge = boundary.bridge;
      this.boundary = boundary.key;
      this.cached.clear();
      this.complete.clear();
      this.scope = undefined;
    }
    if (this.scope !== scope) {
      this.scope = scope;
      this.complete = new Map(this.cached.get(scope));
    }
    const completeIds = new Set(
      completeNativeToolMessages(messages, facts).map((message) => message.id),
    );
    const liveById = new Map(live.map((entry) => [entry.message.id, entry]));
    const keep = new Set<string>();
    const result = [...messages, ...live.map((entry) => entry.message)].flatMap((message) => {
      if (message.role !== 'tool') return [message];
      const key = message.presentationKey ?? message.id;
      keep.add(key);
      const entry = liveById.get(message.id);
      const ready = entry
        ? nativeLiveToolPresentationReady(entry, facts)
        : completeIds.has(message.id);
      if (ready) {
        this.complete.set(key, message);
        return [message];
      }
      const pending = facts.some(
        (fact) =>
          fact.inputPending &&
          (fact.messageId === message.id || fact.executionId === entry?.execution.id),
      );
      if (pending) {
        this.complete.delete(key);
        return [];
      }
      if (entry) {
        this.complete.delete(key);
        return [];
      }
      const prior = this.complete.get(key);
      if (!prior) return [];
      return [
        {
          ...prior,
          id: message.id,
          turnId: message.turnId,
          presentationGroupId: message.presentationGroupId,
          settled: message.settled,
          status: prior.settled ? prior.status : undefined,
          executionUnconfirmed: true,
        },
      ];
    });
    for (const key of this.complete.keys()) if (!keep.has(key)) this.complete.delete(key);
    this.cached.set(scope, [...this.complete]);
    return result;
  }
}
export function NativeLiveToolMessage({
  message,
  execution,
  unavailable,
}: {
  message: DesktopMessage;
  execution: NativeToolExecution;
  unavailable: boolean;
}) {
  const diagnostics = useDesktopDiagnostics();
  return (
    <>
      <ToolRow message={message} />
      {!message.executionUnconfirmed && execution.cancelRequestedAt !== null ? (
        <p role="status">已请求停止，等待执行结果。</p>
      ) : unavailable && diagnostics ? (
        <p role="status">上次确认状态</p>
      ) : null}
    </>
  );
}

function useNativeLiveShellInputs({
  bridge,
  generation,
  selection,
  messages,
  historyEpoch,
  retryRevision,
  suspended,
}: {
  bridge?: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  messages: readonly Message[];
  historyEpoch: number;
  retryRevision: number;
  suspended: boolean;
}) {
  const scope = JSON.stringify([
    generation,
    selection?.storeId,
    selection?.session.id,
    selection?.viewSelection ?? selection?.viewGeneration,
    historyEpoch,
  ]);
  const targets = liveToolMessages(selection, messages).filter((item) => !!item.message.shell);
  const identity = JSON.stringify(
    targets.map(({ execution }) => [
      execution.id,
      execution.runId,
      execution.originStoreId,
      execution.sessionId,
      execution.definitionId,
      execution.definitionVersion,
      selection?.executions.find((item) => item.id === execution.id)?.toolCallId,
    ]),
  );
  const cache = useRef({
    scope,
    retryRevision,
    failed: false,
    facts: new Map<string, NativeToolMessageFact | undefined>(),
    commandPending: new Set<string>(),
    keys: new Map<string, string>(),
  });
  const [state, setState] = useState<{
    scope: string;
    facts: NativeToolMessageFact[];
    error?: string;
  }>({
    scope,
    facts: [],
  });
  const available = !!selection && !suspended && !selection.permissionUnavailable;
  const latest = useRef({ selection, targets, generation, historyEpoch });
  latest.current = { selection, targets, generation, historyEpoch };
  useEffect(() => {
    const { selection, targets, generation, historyEpoch } = latest.current;
    if (cache.current.scope !== scope || cache.current.retryRevision !== retryRevision)
      cache.current = {
        scope,
        retryRevision,
        failed: false,
        facts: new Map(),
        commandPending: new Set(),
        keys: new Map(),
      };
    const current = cache.current;
    const publish = () =>
      setState({
        scope,
        facts: [...current.facts.values()].flatMap((fact) => (fact ? [fact] : [])),
        error: current.failed ? '部分工具状态尚无法核实，保留原始结果。' : undefined,
      });
    if (!bridge || !selection || !available) return;
    if (identity === '[]') {
      publish();
      return;
    }
    let active = true,
      readId: string | undefined;
    const { storeId, session } = selection;
    const viewSelection = selection.viewSelection ?? selection.viewGeneration;
    const key = (execution: NativeToolExecution) =>
      JSON.stringify([
        execution.id,
        execution.originStoreId,
        execution.sessionId,
        execution.runId,
        execution.definitionId,
        execution.definitionVersion,
        selection.executions.find((item) => item.id === execution.id)?.toolCallId,
      ]);
    // A changed target list cancels this effect and discards its local fragments.
    // Restart incomplete commands at offset zero; complete siblings stay cached.
    const pending = targets.filter(
      (target) =>
        !current.facts.has(target.execution.id) ||
        current.commandPending.has(target.execution.id) ||
        current.keys.get(target.execution.id) !== key(target.execution),
    );
    void (async () => {
      for (let index = 0; index < pending.length; index += 32) {
        let batch = pending.slice(index, index + 32);
        const commands = new Map<string, string>();
        let commandOffsets: Record<string, number> | undefined;
        try {
          do {
            readId = crypto.randomUUID();
            const page = await bridge.request({
              method: 'toolMessages.list',
              generation,
              viewSelection,
              historyEpoch,
              readId,
              messageIds: [],
              executionIds: batch.map((item) => item.execution.id),
              ...(commandOffsets ? { commandOffsets } : {}),
            });
            if (!active) return;
            if (
              !page ||
              !('kind' in page) ||
              !('entries' in page) ||
              page.kind !== 'toolMessages.page' ||
              page.readId !== readId ||
              page.scope.generation !== generation ||
              page.scope.storeId !== storeId ||
              page.scope.sessionId !== session.id ||
              page.scope.workspaceId !== session.workspaceId ||
              page.scope.viewSelection !== viewSelection ||
              page.scope.historyEpoch !== historyEpoch ||
              new Set(page.entries.map((fact) => fact.executionId)).size !== page.entries.length ||
              page.entries.some(
                (fact) =>
                  !batch.some(
                    ({ execution }) =>
                      fact.executionId === execution.id &&
                      fact.messageId === `native-execution:${execution.id}` &&
                      fact.definitionId === execution.definitionId &&
                      fact.definitionVersion === execution.definitionVersion &&
                      fact.inputSource?.storeId === storeId &&
                      fact.inputSource.sessionId === session.id &&
                      fact.inputSource.runId === execution.runId,
                  ),
              )
            )
              throw Error('tool_message_identity_mismatch');
            const next: Record<string, number> = {};
            for (const item of batch) {
              const id = item.execution.id;
              let fact = page.entries.find((entry) => entry.executionId === id);
              const input = fact?.shellInput;
              if (input?.command !== undefined) {
                const offset = commandOffsets?.[fact!.messageId] ?? 0;
                if (
                  input.commandOffset !== offset ||
                  new TextEncoder().encode(JSON.stringify(input.command)).length >
                    nativeShellCommandChunkBytes + 2 ||
                  (input.commandNextOffset !== null &&
                    (input.commandNextOffset !== offset + input.command.length ||
                      !input.command.length))
                )
                  throw Error('tool_message_command_offset_invalid');
                const command = (commands.get(id) ?? '') + input.command;
                if (command.length > 524288) throw Error('tool_message_command_offset_invalid');
                commands.set(id, command);
                if (input.commandNextOffset !== null) {
                  next[fact!.messageId] = input.commandNextOffset!;
                  fact = {
                    ...fact!,
                    inputPending: true,
                    shellInput: { operation: input.operation, shellId: input.shellId },
                  };
                } else fact = { ...fact!, shellInput: { ...input, command, commandOffset: 0 } };
              } else if (commandOffsets?.[`native-execution:${id}`] !== undefined)
                throw Error('tool_message_command_offset_invalid');
              current.facts.set(id, fact);
              if (Object.hasOwn(next, `native-execution:${id}`)) current.commandPending.add(id);
              else current.commandPending.delete(id);
              current.keys.set(id, key(item.execution));
            }
            publish();
            commandOffsets = next;
            batch = batch.filter((item) =>
              Object.hasOwn(next, `native-execution:${item.execution.id}`),
            );
          } while (batch.length && active);
        } catch {
          if (!active) return;
          current.failed = true;
          for (const item of batch) {
            current.commandPending.delete(item.execution.id);
            if (
              !current.facts.has(item.execution.id) ||
              current.keys.get(item.execution.id) !== key(item.execution)
            )
              current.facts.set(item.execution.id, undefined);
            current.keys.set(item.execution.id, key(item.execution));
          }
          publish();
        }
      }
    })();
    publish();
    return () => {
      active = false;
      if (readId)
        void bridge.request({ method: 'toolMessages.close', generation, readId }).catch(() => {});
    };
  }, [bridge, scope, identity, retryRevision, available]);
  return state.scope === scope
    ? { facts: state.facts, error: state.error }
    : { facts: emptyToolFacts };
}

/** Exact history metadata, including receipts beyond the bounded current View. */
export function useNativeToolMessages({
  bridge,
  generation,
  selection,
  historyEpoch,
  messages,
  observationRevision,
  suspended = false,
}: {
  bridge?: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  historyEpoch: number;
  messages: readonly Message[];
  observationRevision: number;
  suspended?: boolean;
}) {
  const storeId = selection?.storeId,
    sessionId = selection?.session.id,
    workspaceId = selection?.session.workspaceId;
  const viewSelection = selection?.viewSelection ?? selection?.viewGeneration;
  const scope = JSON.stringify([generation, storeId, sessionId, viewSelection, historyEpoch]);
  const unavailable =
    suspended || !selection || selection.viewLoading || selection.permissionUnavailable;
  const candidates = messages.filter(
    (message) =>
      message.role === 'tool' &&
      message.status === 'complete' &&
      message.sourceIds?.length === 1 &&
      message.contentFormat !== 'unsupported',
  );
  const receiptCache = useRef(candidates);
  if (
    receiptCache.current.length !== candidates.length ||
    candidates.some((message, index) => !sameReceipt(message, receiptCache.current[index]!))
  )
    receiptCache.current = candidates;
  const eligible = receiptCache.current;
  const [retryRevision, setRetryRevision] = useState(0);
  const liveRead = useNativeLiveShellInputs({
    bridge,
    generation,
    selection,
    messages,
    historyEpoch,
    retryRevision,
    suspended,
  });
  const liveInputs = liveRead.facts;
  const cache = useRef({
    scope,
    retryRevision,
    read: new Map<
      string,
      {
        message: Message;
        fact?: NativeToolMessageFact;
        observationRevision: number;
        commandPending?: boolean;
        inputRevision?: string;
        callRevision?: string;
        inputReadFailed?: boolean;
      }
    >(),
  });
  const [state, setState] = useState<{
    scope: string;
    entries: NativeToolMessageFact[];
    error?: string;
  }>({ scope, entries: [] });
  const revisions = new Map(
    eligible.map((message) => {
      const previous =
        cache.current.scope === scope ? cache.current.read.get(message.id) : undefined;
      const live = liveInputs.find(
        (entry) =>
          entry.executionId === message.sourceIds?.[0] &&
          entry.inputSource?.toolCallId === message.toolCallId &&
          entry.shellInput?.command !== undefined,
      );
      const fact = previous?.fact;
      const proof = fact?.inputSource
        ? fact.shellInput?.command !== undefined
          ? fact
          : (live ?? fact)
        : undefined;
      return [
        message.id,
        proof && previous && shellCallCompatible(message, messages, proof)
          ? { call: previous.callRevision, omission: previous.inputRevision }
          : toolInputRevision(message, messages),
      ] as const;
    }),
  );
  const revisionIdentity = JSON.stringify([...revisions]);
  const revisionCache = useRef({ identity: revisionIdentity, revisions });
  if (revisionCache.current.identity !== revisionIdentity)
    revisionCache.current = { identity: revisionIdentity, revisions };
  const inputRevisions = revisionCache.current.revisions;
  useEffect(() => {
    if (cache.current.scope !== scope || cache.current.retryRevision !== retryRevision)
      cache.current = { scope, retryRevision, read: new Map() };
    const current = cache.current;
    let active = true,
      readId: string | undefined;
    const publish = (error?: string) =>
      setState({
        scope,
        entries: [...current.read.values()].flatMap((item) => (item.fact ? [item.fact] : [])),
        error:
          error ??
          ([...current.read.values()].some((item) => item.inputReadFailed)
            ? '部分工具状态尚无法核实，保留原始结果。'
            : undefined),
      });
    if (
      !bridge ||
      !storeId ||
      !sessionId ||
      !workspaceId ||
      viewSelection === undefined ||
      unavailable
    )
      return;
    // A terminal receipt is immutable; its input presentation also depends on
    // independently streamed Model declarations. Recheck only changed call proof,
    // or a changed omission boundary when the exact Shell input is still missing.
    // Unknown results retain their existing observation-based recalibration.
    const pending = eligible.filter((message) => {
      const previous = current.read.get(message.id);
      return (
        !previous ||
        previous.commandPending ||
        (!previous.inputReadFailed &&
          previous.fact &&
          (!previous.fact.definitionId.startsWith('shell.') || previous.fact.shellInput) &&
          (previous.callRevision !== inputRevisions.get(message.id)?.call ||
            (shellInputMissing(previous.fact) &&
              previous.inputRevision !== inputRevisions.get(message.id)?.omission))) ||
        (previous.fact?.status === 'outcome_unknown' &&
          previous.observationRevision !== observationRevision) ||
        !sameReceipt(previous.message, message)
      );
    });
    // Mark the new read as pending now; retaining the last error would report
    // loading=false and let background recovery restart this in-flight request.
    publish();
    void (async () => {
      let readError = false;
      for (let index = 0; index < pending.length; index += 32) {
        let batch = pending.slice(index, index + 32);
        const assembled = new Map<string, { command: string; fact: NativeToolMessageFact }>();
        let commandOffsets: Record<string, number> | undefined;
        try {
          do {
            readId = crypto.randomUUID();
            const page = await bridge.request({
              method: 'toolMessages.list',
              generation,
              viewSelection,
              historyEpoch,
              readId,
              messageIds: batch.map((message) => message.id),
              ...(commandOffsets ? { commandOffsets } : {}),
            });
            if (!active) return;
            if (
              !page ||
              !('entries' in page) ||
              !('kind' in page) ||
              page.kind !== 'toolMessages.page' ||
              page.readId !== readId ||
              page.scope.generation !== generation ||
              page.scope.storeId !== storeId ||
              page.scope.sessionId !== sessionId ||
              page.scope.workspaceId !== workspaceId ||
              page.scope.viewSelection !== viewSelection ||
              page.scope.historyEpoch !== historyEpoch ||
              new Set(page.entries.map((entry) => entry.messageId)).size !== page.entries.length ||
              page.entries.some(
                (entry) =>
                  !batch.some(
                    (message) =>
                      message.id === entry.messageId &&
                      message.sourceIds?.[0] === entry.executionId,
                  ),
              )
            )
              throw Error('tool_message_identity_mismatch');
            const next: Record<string, number> = {};
            for (const message of batch) {
              let fact = page.entries.find((entry) => entry.messageId === message.id);
              const input = fact?.shellInput;
              let inputReadFailed = false;
              try {
                if (input?.command !== undefined) {
                  const offset = commandOffsets?.[message.id] ?? 0;
                  const previous = assembled.get(message.id);
                  if (
                    input.commandOffset !== offset ||
                    new TextEncoder().encode(JSON.stringify(input.command)).length >
                      nativeShellCommandChunkBytes + 2 ||
                    (input.commandNextOffset !== null &&
                      (input.commandNextOffset !== offset + input.command.length ||
                        !input.command.length)) ||
                    (previous &&
                      (previous.fact.executionId !== fact!.executionId ||
                        previous.fact.status !== fact!.status ||
                        previous.fact.resultRevision !== fact!.resultRevision ||
                        previous.fact.definitionId !== fact!.definitionId ||
                        previous.fact.definitionVersion !== fact!.definitionVersion ||
                        previous.fact.shellInput?.shellId !== input.shellId ||
                        previous.fact.shellInput?.operation !== input.operation))
                  )
                    throw Error('tool_message_command_offset_invalid');
                  const command = (previous?.command ?? '') + input.command;
                  if (command.length > 524288) throw Error('tool_message_command_offset_invalid');
                  assembled.set(message.id, { command, fact: fact! });
                  if (input.commandNextOffset !== null) {
                    next[message.id] = input.commandNextOffset!;
                    fact = {
                      ...fact!,
                      inputPending: true,
                      shellInput: { operation: input.operation, shellId: input.shellId },
                    };
                  } else fact = { ...fact!, shellInput: { ...input, command, commandOffset: 0 } };
                } else if (commandOffsets?.[message.id] !== undefined) {
                  throw Error('tool_message_command_offset_invalid');
                }
              } catch {
                readError = true;
                inputReadFailed = true;
                delete next[message.id];
                const previous = current.read.get(message.id);
                fact =
                  previous && sameReceipt(previous.message, message)
                    ? previous.fact &&
                      (previous.callRevision !== inputRevisions.get(message.id)?.call
                        ? withoutToolInput(previous.fact)
                        : previous.fact)
                    : fact && {
                        ...fact,
                        ...(input
                          ? { shellInput: { operation: input.operation, shellId: input.shellId } }
                          : {}),
                      };
              }
              current.read.set(message.id, {
                message,
                fact,
                observationRevision,
                commandPending: Object.hasOwn(next, message.id),
                inputRevision: inputRevisions.get(message.id)?.omission,
                callRevision: inputRevisions.get(message.id)?.call,
                inputReadFailed,
              });
            }
            publish(readError ? '部分工具状态尚无法核实，保留原始结果。' : undefined);
            commandOffsets = next;
            batch = batch.filter((message) => Object.hasOwn(next, message.id));
          } while (batch.length && active);
        } catch {
          if (!active) return;
          readError = true;
          // A command continuation cannot invalidate metadata already checked on its first page.
          for (const message of batch) {
            const previous = current.read.get(message.id);
            current.read.set(message.id, {
              message,
              fact:
                previous && sameReceipt(previous.message, message)
                  ? previous.fact &&
                    (previous.callRevision !== inputRevisions.get(message.id)?.call
                      ? withoutToolInput(previous.fact)
                      : previous.fact)
                  : undefined,
              observationRevision,
              commandPending: false,
              inputRevision: inputRevisions.get(message.id)?.omission,
              callRevision: inputRevisions.get(message.id)?.call,
              inputReadFailed: true,
            });
          }
          publish('部分工具状态尚无法核实，保留原始结果。');
        }
      }
      if (active) publish(readError ? '部分工具状态尚无法核实，保留原始结果。' : undefined);
    })().catch(() => {
      if (active) publish('部分工具状态尚无法核实，保留原始结果。');
    });
    return () => {
      active = false;
      if (readId)
        void bridge.request({ method: 'toolMessages.close', generation, readId }).catch(() => {});
    };
  }, [
    bridge,
    scope,
    generation,
    storeId,
    sessionId,
    workspaceId,
    viewSelection,
    historyEpoch,
    retryRevision,
    unavailable,
    observationRevision,
    eligible,
    inputRevisions,
  ]);
  const error = state.scope === scope ? state.error : undefined;
  const pendingMessageIds = new Set(
    error
      ? []
      : eligible
          .filter((message) => {
            if (cache.current.scope !== scope || cache.current.retryRevision !== retryRevision)
              return true;
            const previous = cache.current.read.get(message.id);
            return !previous || previous.commandPending || !sameReceipt(previous.message, message);
          })
          .map((message) => message.id),
  );
  return {
    pendingMessageIds,
    entries: useMemo(() => {
      if (state.scope !== scope) return liveInputs;
      const messagesById = new Map(messages.map((message) => [message.id, message]));
      return [
        ...liveInputs,
        ...state.entries.flatMap((fact) => {
          const record = cache.current.read.get(fact.messageId);
          const original = record?.message;
          const current = messagesById.get(fact.messageId);
          if (!original || !current || !sameReceipt(original, current)) return [];
          return [
            record.callRevision !== inputRevisions.get(fact.messageId)?.call
              ? withoutToolInput(fact)
              : fact,
          ];
        }),
      ];
    }, [state, scope, messages, inputRevisions, liveInputs]),
    loading: pendingMessageIds.size > 0,
    error: error ?? liveRead.error,
    retry: () => setRetryRevision((value) => value + 1),
  };
}

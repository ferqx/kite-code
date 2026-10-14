import type { Execution, Message, ModelOutputSnapshot, SessionView } from '@kite-ai/client';
import { Box } from 'ink';
import { type TuiSnapshot, terminalText } from './controller';
import ConcurrentSubAgentBlock from './ink/ConcurrentSubAgentBlock';
import { getToolDetail, getToolPreview } from './ink/render-utils';
import SubAgentBlock from './ink/SubAgentBlock';
import TaskProgressBlock from './ink/TaskProgressBlock';
import ToolCardBlock from './ink/ToolCardBlock';
import ToolSummaryBlock from './ink/ToolSummaryBlock';
import { buildToolSummaryLine } from './ink/tool-summary-line';
import type { AgentPlan, ConsolidatedToolEntry, OutputBlock, ToolDisplayStatus } from './ink/types';
import { TuiText as Text, useTuiPresentation } from './presentation';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const parsed = (value: string) => {
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
};
function planningBinding(
  execution: Execution,
  snapshot: TuiSnapshot,
): Record<string, unknown> | undefined {
  if (!scope(execution, snapshot)) return undefined;
  const runs = snapshot.view.runs.filter(
    (run) =>
      run.id === execution.runId &&
      run.sessionId === execution.sessionId &&
      run.originStoreId === execution.originStoreId,
  );
  if (runs.length !== 1) return undefined;
  return record(record(record(runs[0]!.configuration)?.snapshot)?.planning)?.binding as
    | Record<string, unknown>
    | undefined;
}
function frozenBuiltin(
  execution: Execution,
  snapshot: TuiSnapshot,
  extensionId: string,
  definitionId: string,
): boolean {
  if (execution.definitionId === `${extensionId}/${definitionId}`)
    return scope(execution, snapshot);
  if (execution.definitionId !== definitionId) return false;
  const tools = planningBinding(execution, snapshot)?.tools;
  if (!Array.isArray(tools)) return false;
  const matches = tools
    .map(record)
    .filter(
      (tool) =>
        tool?.definitionId === definitionId &&
        tool.definitionVersion === execution.definitionVersion,
    );
  return matches.length === 1 && matches[0]?.extensionId === extensionId;
}
/** Frozen host read-only classification is a presentation fact, never a new permission decision. */
export function inkReadOnlyExecution(execution: Execution, snapshot: TuiSnapshot): boolean {
  if (execution.kind !== 'tool') return false;
  const definitions = planningBinding(execution, snapshot)?.readOnlyDefinitions;
  if (!Array.isArray(definitions)) return false;
  return definitions.some((value) => {
    const def = record(value);
    return (
      def?.kind === 'tool' &&
      def.definitionId === execution.definitionId &&
      def.definitionVersion === execution.definitionVersion
    );
  });
}
/** Exact registrations in Agent builtin files/shell/web/ask-user/task owners; unknown IDs remain exact. */
export function inkToolName(
  definitionId: string,
  execution?: Execution,
  snapshot?: TuiSnapshot,
): string {
  if (execution && snapshot) {
    const labels = (
      snapshot as TuiSnapshot & {
        toolLabels?: readonly {
          executionId: string;
          originStoreId: string;
          sessionId: string;
          definitionId: string;
          definitionVersion: string;
          label: string;
        }[];
      }
    ).toolLabels;
    const matches =
      labels?.filter(
        (label) =>
          label.executionId === execution.id &&
          label.originStoreId === execution.originStoreId &&
          label.sessionId === execution.sessionId &&
          label.definitionId === execution.definitionId &&
          label.definitionVersion === execution.definitionVersion,
      ) ?? [];
    if (matches.length === 1) return terminalText(matches[0]!.label);
  }
  const names: Readonly<Record<string, string>> = {
    'builtin.files/files.read': 'read_file',
    'builtin.files/files.write': 'write_file',
    'builtin.files/files.edit': 'edit_file',
    'builtin.files/files.glob': 'search_files',
    'builtin.files/files.search': 'search_content',
    'builtin.shell/shell.launch': 'shell_execute',
    'builtin.web/web_fetch': 'web_fetch',
    'builtin.ask-user/ask_user': 'ask_user',
    'builtin.task/task': 'task',
  };
  if (Object.hasOwn(names, definitionId)) return names[definitionId]!;
  if (execution && snapshot)
    for (const [qualified, name] of Object.entries(names)) {
      const [extension, tool] = qualified.split('/');
      if (extension && tool && frozenBuiltin(execution, snapshot, extension, tool)) return name;
    }
  return definitionId;
}
export function inkExecutionStatus(execution: Execution): ToolDisplayStatus {
  return execution.status === 'succeeded'
    ? 'done'
    : execution.status === 'failed'
      ? 'error'
      : execution.status === 'cancelled'
        ? 'cancelled'
        : execution.status === 'planned'
          ? 'queued'
          : execution.status === 'outcome_unknown'
            ? 'error'
            : 'running';
}
function scope(execution: Execution, snapshot: TuiSnapshot): boolean {
  return (
    execution.originStoreId === snapshot.storeId && execution.sessionId === snapshot.view.session.id
  );
}
export function inkToolArguments(
  execution: Execution,
  snapshot: TuiSnapshot,
  loadedOutputs: ReadonlyMap<string, ModelOutputSnapshot['output']> = new Map(),
): Record<string, unknown> | undefined {
  if (execution.kind !== 'tool' || !scope(execution, snapshot)) return undefined;
  const saved = record(execution.toolInput);
  if (saved) return saved;
  const results = snapshot.messages.filter(
    (message) =>
      message.role === 'tool' &&
      message.sessionId === execution.sessionId &&
      message.runId === execution.runId &&
      (message.sourceIds ?? []).includes(execution.id) &&
      (!message.originMessage ||
        (message.originMessage.storeId === execution.originStoreId &&
          message.originMessage.sessionId === execution.sessionId &&
          message.originMessage.runId === execution.runId)),
  );
  const callId =
    execution.toolCallId ?? (results.length === 1 ? results[0]?.toolCallId : undefined);
  if (!callId) return undefined;
  const matches: string[] = [];
  for (const message of snapshot.messages) {
    if (
      message.role !== 'assistant' ||
      message.sessionId !== execution.sessionId ||
      message.runId !== execution.runId ||
      (message.originMessage &&
        (message.originMessage.storeId !== execution.originStoreId ||
          message.originMessage.sessionId !== execution.sessionId ||
          message.originMessage.runId !== execution.runId))
    )
      continue;
    for (const call of loadedOutputs.get(message.id)?.toolCalls ?? message.toolCalls ?? [])
      if (call.id === callId) matches.push(call.arguments);
  }
  return matches.length === 1 ? parsed(matches[0]!) : undefined;
}
export function inkResultSummary(result: unknown): string {
  const object = record(result);
  if (typeof object?.content === 'string') return object.content;
  if (typeof result === 'string') return result;
  return result === null ? '' : (JSON.stringify(result, null, 2) ?? '');
}
function displayArguments(args: Record<string, unknown>): Record<string, unknown> {
  const safe = (value: unknown): unknown =>
    typeof value === 'string'
      ? terminalText(value)
      : Array.isArray(value)
        ? value.map(safe)
        : record(value)
          ? Object.fromEntries(
              Object.entries(value as Record<string, unknown>).map(([key, part]) => [
                terminalText(key),
                safe(part),
              ]),
            )
          : value;
  return safe(args) as Record<string, unknown>;
}
export function projectInkTool(
  execution: Execution,
  snapshot: TuiSnapshot,
  loadedOutputs: ReadonlyMap<string, ModelOutputSnapshot['output']> = new Map(),
  expanded?: boolean,
): Extract<OutputBlock, { kind: 'tool_card' }> {
  const shellParent =
    execution.kind === 'job' && scope(execution, snapshot) && execution.parentExecutionId
      ? snapshot.view.executions.find(
          (item) =>
            item.id === execution.parentExecutionId &&
            item.kind === 'tool' &&
            frozenBuiltin(item, snapshot, 'builtin.shell', 'shell.launch') &&
            item.originStoreId === execution.originStoreId &&
            item.sessionId === execution.sessionId &&
            item.runId === execution.runId,
        )
      : undefined;
  const shellArgs = shellParent
    ? inkToolArguments(shellParent, snapshot, loadedOutputs)
    : undefined;
  const name =
    shellParent && shellArgs
      ? 'shell_execute'
      : terminalText(inkToolName(execution.definitionId, execution, snapshot));
  const args = displayArguments(
    shellArgs ?? inkToolArguments(execution, snapshot, loadedOutputs) ?? {},
  );
  const tailMatches =
    (
      snapshot as TuiSnapshot & {
        jobTails?: readonly {
          executionId: string;
          content: string;
          totalLines?: number;
          incomplete?: boolean;
        }[];
      }
    ).jobTails?.filter((item) => item.executionId === execution.id) ?? [];
  const tail = shellParent && tailMatches.length === 1 ? tailMatches[0] : undefined;
  const timing = scope(execution, snapshot) ? snapshot.executionTimings?.[execution.id] : undefined;
  const confirmed = timing?.availability === 'recorded_dispatch' && timing.startedAt !== undefined;
  const summary =
    execution.status === 'outcome_unknown'
      ? 'Outcome unknown; original work remains unverified.'
      : inkResultSummary(execution.result);
  return {
    id: 0,
    kind: 'tool_card',
    callId: execution.toolCallId ?? execution.id,
    name,
    args,
    status: inkExecutionStatus(execution),
    summary: terminalText(
      tail && ['succeeded', 'failed', 'cancelled'].includes(execution.status)
        ? tail.content
        : summary,
    ),
    ...(tail
      ? {
          liveOutput: terminalText(tail.content),
          ...(tail.totalLines === undefined ? {} : { liveTotalLines: tail.totalLines }),
        }
      : {}),
    preview: getToolPreview(name, args),
    detail: getToolDetail(name, args),
    expanded,
    ...(confirmed
      ? {
          startedAt: timing.startedAt,
          ...(timing.finishedAt !== undefined && timing.finishedAt >= timing.startedAt!
            ? { elapsedMs: timing.finishedAt - timing.startedAt! }
            : {}),
        }
      : {}),
  };
}
/** A child Agent requires the actual carrier parent to be the registered task Tool, never a similar name. */
export function projectInkChild(
  execution: Execution,
  snapshot: TuiSnapshot,
  loadedOutputs: ReadonlyMap<string, ModelOutputSnapshot['output']> = new Map(),
  expanded?: boolean,
): Extract<OutputBlock, { kind: 'subagent' }> | undefined {
  if (
    execution.kind !== 'job' ||
    !execution.childSessionId ||
    !execution.parentExecutionId ||
    !scope(execution, snapshot)
  )
    return undefined;
  const parent = snapshot.view.executions.find(
    (item) =>
      item.id === execution.parentExecutionId &&
      item.kind === 'tool' &&
      frozenBuiltin(item, snapshot, 'builtin.task', 'task') &&
      item.originStoreId === execution.originStoreId &&
      item.sessionId === execution.sessionId &&
      item.runId === execution.runId,
  );
  if (!parent) return undefined;
  const args = inkToolArguments(parent, snapshot, loadedOutputs);
  if (typeof args?.role !== 'string') return undefined;
  const childViews = (
    snapshot as TuiSnapshot & { childViews?: readonly { executionId: string; view: SessionView }[] }
  ).childViews;
  const matches =
    childViews?.filter(
      (child) =>
        child.executionId === execution.id &&
        child.view.storeId === snapshot.storeId &&
        child.view.session.id === execution.childSessionId &&
        child.view.session.parentSessionId === execution.sessionId &&
        child.view.session.rootSessionId === snapshot.view.session.rootSessionId &&
        child.view.session.workspaceId === snapshot.view.session.workspaceId,
    ) ?? [];
  const child = matches.length === 1 ? matches[0]!.view : undefined;
  const childSnapshot = child
    ? { ...snapshot, view: child, messages: child.messages, executionTimings: undefined }
    : undefined;
  const steps = childSnapshot
    ? childSnapshot.view.executions
        .filter(
          (item) =>
            item.kind === 'tool' &&
            item.originStoreId === snapshot.storeId &&
            item.sessionId === child!.session.id,
        )
        .map((item) => ({
          stepId: item.id,
          toolCallId: item.toolCallId ?? item.id,
          toolName: terminalText(inkToolName(item.definitionId, item, childSnapshot)),
          toolArgs: displayArguments(inkToolArguments(item, childSnapshot) ?? {}),
          status:
            item.status === 'succeeded'
              ? ('success' as const)
              : item.status === 'failed' || item.status === 'outcome_unknown'
                ? ('error' as const)
                : item.status === 'cancelled'
                  ? ('cancelled' as const)
                  : ('pending' as const),
          summary: inkResultSummary(item.result),
        }))
    : [];
  const pendingChild = child?.executions.find(
    (item) =>
      item.kind === 'tool' &&
      item.originStoreId === snapshot.storeId &&
      item.sessionId === child.session.id &&
      ['planned', 'dispatching', 'running'].includes(item.status) &&
      (item.authorization?.human?.state === 'pending' ||
        item.authorization?.review?.status === 'planned' ||
        item.authorization?.review?.status === 'running'),
  );
  const approvalState =
    pendingChild?.authorization?.human?.state === 'pending'
      ? ('awaiting_user' as const)
      : pendingChild?.authorization?.review?.status === 'running'
        ? ('auto_reviewing' as const)
        : pendingChild?.authorization?.review?.status === 'planned'
          ? ('queued_auto_review' as const)
          : undefined;
  const input = record(args.input);
  const task =
    typeof args.input === 'string'
      ? args.input
      : typeof input?.content === 'string'
        ? input.content
        : typeof input?.task === 'string'
          ? input.task
          : typeof args.key === 'string'
            ? args.key
            : (child?.session.title ?? execution.definitionId);
  return {
    id: 0,
    kind: 'subagent',
    subagentId: execution.childSessionId,
    role: terminalText(args.role),
    task: terminalText(task),
    status:
      execution.status === 'succeeded'
        ? 'done'
        : execution.status === 'failed'
          ? 'error'
          : execution.status === 'outcome_unknown'
            ? 'suspended'
            : execution.status === 'cancelled'
              ? 'cancelled'
              : execution.status === 'planned'
                ? 'creating'
                : 'running',
    summary: inkResultSummary(execution.result),
    toolCallCount: steps.length,
    ...(approvalState ? { approvalState, awaitingApproval: true } : {}),
    steps,
    expanded,
  };
}
export function InkExecution({
  execution,
  snapshot,
  loadedOutputs = new Map(),
  expanded,
  columns = 80,
}: {
  execution: Execution;
  snapshot: TuiSnapshot;
  loadedOutputs?: ReadonlyMap<string, ModelOutputSnapshot['output']>;
  expanded?: boolean;
  columns?: number;
}) {
  const { t } = useTuiPresentation();
  const child = projectInkChild(execution, snapshot, loadedOutputs, expanded);
  const tail = (
    snapshot as TuiSnapshot & {
      jobTails?: readonly { executionId: string; incomplete?: boolean }[];
    }
  ).jobTails?.find((item) => item.executionId === execution.id);
  const tool = projectInkTool(execution, snapshot, loadedOutputs, expanded);
  if (!child && tool.name === execution.definitionId) {
    const args = inkToolArguments(execution, snapshot, loadedOutputs);
    if (args && Object.keys(args).length) {
      tool.preview = terminalText(JSON.stringify(args));
      tool.detail = tool.preview;
    }
  }
  return (
    <Box flexDirection="column">
      {child ? (
        <SubAgentBlock block={child} columns={columns} />
      ) : (
        <ToolCardBlock block={tool} columns={columns} />
      )}
      {tail?.incomplete && (
        <Text color="yellow">
          Output preview incomplete · open recorded output to read full history
        </Text>
      )}
      {execution.cancelRequestedAt !== null &&
        ['planned', 'dispatching', 'running'].includes(execution.status) && (
          <Text color="yellow">{t(' · cancel requested; cleanup not confirmed')}</Text>
        )}
    </Box>
  );
}
/** Grouping is one exact original Model message's calls; no concurrency batch is inferred. */
export function projectInkThought(
  message: Message,
  snapshot: TuiSnapshot,
  loadedOutputs: ReadonlyMap<string, ModelOutputSnapshot['output']> = new Map(),
): Extract<OutputBlock, { kind: 'tool_summary' }> {
  const body = loadedOutputs.get(message.id),
    calls = body?.toolCalls ?? message.toolCalls ?? [];
  const tools = calls.map((call) => {
    const matches = snapshot.view.executions.filter(
      (item) =>
        item.kind === 'tool' &&
        item.originStoreId === snapshot.storeId &&
        item.sessionId === message.sessionId &&
        item.runId === message.runId &&
        item.toolCallId === call.id,
    );
    const source = matches.length === 1 ? matches[0] : undefined;
    return {
      callId: call.id,
      name: terminalText(inkToolName(source?.definitionId ?? call.name, source, snapshot)),
      args: displayArguments(parsed(call.arguments) ?? {}),
      ok: source?.status === 'succeeded',
      summary: source ? inkResultSummary(source.result) : '',
      status: source ? inkExecutionStatus(source) : ('queued' as const),
    };
  });
  const models = snapshot.view.executions.filter(
    (item) =>
      item.kind === 'model' &&
      item.originStoreId === snapshot.storeId &&
      item.sessionId === message.sessionId &&
      item.runId === message.runId &&
      (message.sourceIds ?? []).includes(item.id),
  );
  const active =
    models.length === 1 && ['planned', 'dispatching', 'running'].includes(models[0]!.status);
  const timing = models.length === 1 ? snapshot.executionTimings?.[models[0]!.id] : undefined;
  const startedAt =
    timing?.availability === 'recorded_dispatch' &&
    Number.isSafeInteger(timing.startedAt) &&
    timing.startedAt! >= 0
      ? timing.startedAt
      : undefined;
  const finishedAt =
    startedAt !== undefined &&
    Number.isSafeInteger(timing?.finishedAt) &&
    timing!.finishedAt! >= startedAt
      ? timing!.finishedAt
      : undefined;
  return {
    id: 0,
    kind: 'tool_summary',
    tools,
    createdAt: 0,
    active,
    hasThought: true,
    hasThinking:
      !!body?.reasoning ||
      (message.outputBody?.reasoningBytes !== undefined &&
        message.outputBody.reasoningBytes !== '0'),
    summaryLine: buildToolSummaryLine(tools),
    ...(startedAt !== undefined && finishedAt !== undefined
      ? { totalElapsedMs: finishedAt - startedAt }
      : {}),
    ...(active && startedAt !== undefined && finishedAt === undefined
      ? { liveModelStartedAt: startedAt }
      : {}),
    ...(active && body?.reasoning
      ? { latestActivity: { kind: 'thinking' as const, text: body.reasoning } }
      : {}),
  };
}
export function InkThought({
  message,
  snapshot,
  loadedOutputs,
  columns = 80,
}: {
  message: Message;
  snapshot: TuiSnapshot;
  loadedOutputs?: ReadonlyMap<string, ModelOutputSnapshot['output']>;
  columns?: number;
}) {
  return (
    <ToolSummaryBlock
      block={projectInkThought(message, snapshot, loadedOutputs)}
      columns={columns}
    />
  );
}
/** Explicit read-only plan display model. No plan is guessed from model prose. */
export function InkTaskProgress({ plan }: { plan: AgentPlan }) {
  return <TaskProgressBlock plan={plan} />;
}

export type InkExecutionGroup =
  | {
      key: string;
      messageId: string;
      kind: 'readonly_tools';
      executionIds: readonly string[];
      block: Extract<OutputBlock, { kind: 'tool_summary' }>;
    }
  | {
      key: string;
      messageId: string;
      kind: 'concurrent_subagents';
      executionIds: readonly string[];
      blocks: Extract<OutputBlock, { kind: 'subagent' }>[];
    };

function originalMessage(message: Message, snapshot: TuiSnapshot): boolean {
  return (
    message.role === 'assistant' &&
    message.sessionId === snapshot.view.session.id &&
    (!message.originMessage ||
      (message.originMessage.storeId === snapshot.storeId &&
        message.originMessage.sessionId === message.sessionId &&
        message.originMessage.runId === message.runId))
  );
}
/** Same original Model-call batch plus overlapping persisted lifetimes, never names or co-presence. */
function overlap(first: Execution, second: Execution, snapshot: TuiSnapshot): boolean {
  if (first.status === 'running' && second.status === 'running') return true; // One fixed public view proves both live execution states.
  const a = snapshot.executionTimings?.[first.id],
    b = snapshot.executionTimings?.[second.id];
  if (
    a?.availability !== 'recorded_dispatch' ||
    b?.availability !== 'recorded_dispatch' ||
    a.startedAt === undefined ||
    b.startedAt === undefined
  )
    return false;
  const end = (job: Execution, timing: NonNullable<typeof a>) =>
    timing.finishedAt ?? (['running', 'dispatching'].includes(job.status) ? Infinity : undefined);
  const ae = end(first, a),
    be = end(second, b);
  return (
    ae !== undefined && be !== undefined && Math.max(a.startedAt, b.startedAt) < Math.min(ae, be)
  );
}
export function projectInkExecutionGroups(
  snapshot: TuiSnapshot,
  loadedOutputs: ReadonlyMap<string, ModelOutputSnapshot['output']> = new Map(),
  expanded = false,
): readonly InkExecutionGroup[] {
  const groups: InkExecutionGroup[] = [],
    messages = snapshot.messages.filter((message) => originalMessage(message, snapshot));
  const counts = new Map<string, number>(),
    callKey = (message: Message, id: string) => JSON.stringify([message.runId, id]);
  for (const message of messages)
    for (const call of loadedOutputs.get(message.id)?.toolCalls ?? message.toolCalls ?? [])
      counts.set(callKey(message, call.id), (counts.get(callKey(message, call.id)) ?? 0) + 1);
  for (const message of messages) {
    const calls = loadedOutputs.get(message.id)?.toolCalls ?? message.toolCalls ?? [];
    const models = snapshot.view.executions.filter(
      (item) =>
        item.kind === 'model' &&
        scope(item, snapshot) &&
        item.runId === message.runId &&
        (message.sourceIds ?? []).includes(item.id),
    );
    if (models.length !== 1) continue;
    const sources = calls.map((call) => {
      if (counts.get(callKey(message, call.id)) !== 1) return undefined;
      const matches = snapshot.view.executions.filter(
        (item) =>
          item.kind === 'tool' &&
          scope(item, snapshot) &&
          item.runId === message.runId &&
          item.toolCallId === call.id,
      );
      return matches.length === 1 ? matches[0] : undefined;
    });
    let reads: Execution[] = [];
    const flush = () => {
      if (reads.length >= 2) {
        const tools: ConsolidatedToolEntry[] = reads.map((source) => {
          const card = projectInkTool(source, snapshot, loadedOutputs);
          return {
            callId: source.toolCallId!,
            name: card.name,
            args: card.args,
            status: card.status,
            ok: source.status === 'succeeded',
            summary: card.summary,
          };
        });
        const phase = projectInkThought(message, snapshot, loadedOutputs);
        const active =
          phase.active ||
          reads.some((source) => ['planned', 'dispatching', 'running'].includes(source.status));
        groups.push({
          key: JSON.stringify([message.id, 'read', ...reads.map((item) => item.id)]),
          messageId: message.id,
          kind: 'readonly_tools',
          executionIds: reads.map((item) => item.id),
          block: {
            id: 0,
            kind: 'tool_summary',
            tools,
            createdAt: 0,
            summaryLine: buildToolSummaryLine(tools),
            active,
            hasThought: true,
            hasThinking: phase.hasThinking,
            ...(phase.totalElapsedMs === undefined ? {} : { totalElapsedMs: phase.totalElapsedMs }),
            ...(phase.liveModelStartedAt === undefined
              ? {}
              : { liveModelStartedAt: phase.liveModelStartedAt }),
            ...(phase.latestActivity === undefined ? {} : { latestActivity: phase.latestActivity }),
          },
        });
      }
      reads = [];
    };
    for (const source of sources) {
      if (source && inkReadOnlyExecution(source, snapshot)) reads.push(source);
      else flush();
    }
    flush();
    const carriers = sources
      .flatMap((source) =>
        source && frozenBuiltin(source, snapshot, 'builtin.task', 'task')
          ? snapshot.view.executions
              .filter(
                (job) =>
                  job.kind === 'job' &&
                  scope(job, snapshot) &&
                  job.runId === message.runId &&
                  job.parentExecutionId === source.id &&
                  !!job.childSessionId,
              )
              .map((job) => ({
                job,
                parent: source,
                block: projectInkChild(job, snapshot, loadedOutputs, expanded),
              }))
          : [],
      )
      .filter(
        (entry): entry is typeof entry & { block: Extract<OutputBlock, { kind: 'subagent' }> } =>
          !!entry.block,
      );
    const remaining = new Set(carriers.map((_, index) => index));
    while (remaining.size) {
      const first = remaining.values().next().value!;
      remaining.delete(first);
      const component = [first];
      for (let at = 0; at < component.length; at++)
        for (const index of remaining)
          if (overlap(carriers[component[at]!]!.job, carriers[index]!.job, snapshot)) {
            remaining.delete(index);
            component.push(index);
          }
      if (component.length < 2) continue;
      const members = component.map((index) => carriers[index]!);
      groups.push({
        key: JSON.stringify([message.id, 'children', ...members.map((item) => item.job.id)]),
        messageId: message.id,
        kind: 'concurrent_subagents',
        executionIds: members.flatMap((item) => [item.parent.id, item.job.id]),
        blocks: members.map((item) => item.block),
      });
    }
  }
  return groups;
}
export function InkExecutionGroupView({
  group,
  columns = 80,
}: {
  group: InkExecutionGroup;
  columns?: number;
}) {
  return group.kind === 'readonly_tools' ? (
    <Box flexDirection="column">
      <ToolSummaryBlock block={group.block} columns={columns} />
      {group.block.tools
        .filter((tool) =>
          ['error', 'exhausted', 'rejected', 'cancelled', 'timeout'].includes(tool.status),
        )
        .map((tool) => (
          <ToolCardBlock
            key={tool.callId}
            block={{ ...tool, id: 0, kind: 'tool_card', expanded: true }}
            columns={columns}
          />
        ))}
    </Box>
  ) : (
    <ConcurrentSubAgentBlock blocks={group.blocks} columns={columns} />
  );
}

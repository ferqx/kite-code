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
export function planningBinding(
  execution: Execution,
  snapshot: TuiSnapshot,
): Record<string, unknown> | undefined {
  if (!inkExecutionScope(execution, snapshot)) return undefined;
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
export function frozenBuiltin(
  execution: Execution,
  snapshot: TuiSnapshot,
  extensionId: string,
  definitionId: string,
): boolean {
  if (execution.definitionId === `${extensionId}/${definitionId}`)
    return inkExecutionScope(execution, snapshot);
  if (execution.definitionId !== definitionId) return false;
  const tools = planningBinding(execution, snapshot)?.tools;
  const registrations = snapshot.view.runs.filter(
    (run) =>
      run.id === execution.runId &&
      run.sessionId === execution.sessionId &&
      run.originStoreId === execution.originStoreId,
  );
  const registered =
    registrations.length === 1 ? record(registrations[0]!.configuration)?.tools : undefined;
  const matches = (Array.isArray(tools) ? tools : [])
    .map(record)
    .filter(
      (tool) =>
        tool?.definitionId === definitionId &&
        tool.definitionVersion === execution.definitionVersion,
    );
  if (matches.length) return matches.length === 1 && matches[0]?.extensionId === extensionId;
  const actual = (Array.isArray(registered) ? registered : [])
    .map(record)
    .filter((tool) => tool?.id === definitionId && tool.version === execution.definitionVersion);
  return actual.length === 1 && actual[0]?.extensionId === extensionId;
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
function mcpResourceReceipt(execution: Execution, snapshot: TuiSnapshot) {
  if (
    !inkExecutionScope(execution, snapshot) ||
    execution.kind !== 'tool' ||
    execution.status !== 'succeeded' ||
    execution.definitionVersion !== '1' ||
    ![
      'mcp.resources.list',
      'mcp.resources.read',
      'builtin.mcp/mcp.resources.list',
      'builtin.mcp/mcp.resources.read',
    ].includes(execution.definitionId)
  )
    return undefined;
  const details = record(record(execution.result)?.details),
    binding = record(details?.binding),
    input = record(execution.toolInput);
  if (
    binding?.executionId !== execution.id ||
    binding.originalStoreId !== snapshot.storeId ||
    binding.sessionId !== execution.sessionId ||
    binding.runId !== execution.runId ||
    binding.definitionId !== execution.definitionId ||
    binding.definitionVersion !== execution.definitionVersion ||
    typeof binding.inputDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(binding.inputDigest) ||
    !input ||
    binding.serverId !== input.serverId ||
    binding.connectionKey !== input.connectionKey ||
    binding.configDigest !== input.configDigest ||
    binding.generation !== input.generation ||
    details?.recordKey !== `resources/${execution.id}`
  )
    return undefined;
  return details;
}
/** Exact registrations and scoped immutable builtin receipts; unknown IDs remain exact. */
export function inkToolName(
  definitionId: string,
  execution?: Execution,
  snapshot?: TuiSnapshot,
): string {
  if (execution && snapshot && mcpResourceReceipt(execution, snapshot))
    return definitionId.endsWith('.list') ? 'list_mcp_resources' : 'read_mcp_resource';
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
    'builtin.files.path/files.write_path': 'write_file',
    'builtin.files.path/files.edit_path': 'edit_file',
    'builtin.files/files.glob': 'search_files',
    'builtin.files/files.search': 'search_content',
    'builtin.shell/shell.launch': 'shell_execute',
    'builtin.shell/shell.execute': 'shell_execute',
    'builtin.web/web_fetch': 'web_fetch',
    'builtin.ask-user/ask_user': 'ask_user',
    'builtin.task/task': 'task',
    'builtin.task/task.execute': 'task',
    'builtin.task/task.spawn': 'spawn_agent',
    'builtin.task/task.follow_up': 'follow_up_agent',
    'builtin.task/task.message': 'send_agent_message',
    'builtin.task/task.events': 'wait_agent_events',
    'builtin.task/task.list': 'list_agents',
    'builtin.task/task.interrupt': 'interrupt_agent',
    'builtin.mcp/mcp.resources.list': 'list_mcp_resources',
    'builtin.mcp/mcp.resources.read': 'read_mcp_resource',
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
export function inkExecutionScope(execution: Execution, snapshot: TuiSnapshot): boolean {
  return (
    execution.originStoreId === snapshot.storeId && execution.sessionId === snapshot.view.session.id
  );
}
export function inkToolArguments(
  execution: Execution,
  snapshot: TuiSnapshot,
  loadedOutputs: ReadonlyMap<string, ModelOutputSnapshot['output']> = new Map(),
): Record<string, unknown> | undefined {
  if (execution.kind !== 'tool' || !inkExecutionScope(execution, snapshot)) return undefined;
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
function actualCarrierParent(job: Execution, tool: Execution, snapshot: TuiSnapshot): boolean {
  return (
    job.originStoreId === tool.originStoreId &&
    job.sessionId === tool.sessionId &&
    typeof job.rootWorkCommandId === 'string' &&
    job.rootWorkCommandId === tool.rootWorkCommandId &&
    typeof job.rootWorkSeq === 'string' &&
    job.rootWorkSeq === tool.rootWorkSeq &&
    tool.runId !== null &&
    (job.runId === null || job.runId === tool.runId) &&
    snapshot.view.runs.some(
      (run) =>
        run.id === tool.runId &&
        run.originStoreId === tool.originStoreId &&
        run.sessionId === tool.sessionId,
    )
  );
}
function taskCarrierTool(tool: Execution, snapshot: TuiSnapshot): boolean {
  return (
    frozenBuiltin(tool, snapshot, 'builtin.task', 'task') ||
    frozenBuiltin(tool, snapshot, 'builtin.task', 'task.execute') ||
    (tool.definitionVersion === '1' &&
      (frozenBuiltin(tool, snapshot, 'builtin.task', 'task.spawn') ||
        frozenBuiltin(tool, snapshot, 'builtin.task', 'task.follow_up')))
  );
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
/** Bind only the registered Shell carrier to one exact producer in the same Run. */
export function inkShellParent(job: Execution, snapshot: TuiSnapshot): Execution | undefined {
  if (
    job.kind !== 'job' ||
    !inkExecutionScope(job, snapshot) ||
    job.definitionVersion !== '1' ||
    !['shell.command', 'builtin.shell/shell.command'].includes(job.definitionId)
  )
    return undefined;
  const candidates = snapshot.view.executions.filter((tool) => {
    if (
      tool.kind !== 'tool' ||
      tool.definitionVersion !== '1' ||
      tool.originStoreId !== job.originStoreId ||
      tool.sessionId !== job.sessionId ||
      !actualCarrierParent(job, tool, snapshot) ||
      !(
        frozenBuiltin(tool, snapshot, 'builtin.shell', 'shell.launch') ||
        frozenBuiltin(tool, snapshot, 'builtin.shell', 'shell.execute')
      )
    )
      return false;
    if (job.parentExecutionId) return job.parentExecutionId === tool.id;
    const details = record(record(tool.result)?.details);
    const ref = record(details?.ref);
    return (
      ref?.executionId === job.id &&
      ref.originStoreId === job.originStoreId &&
      ref.sessionId === job.sessionId &&
      ref.extensionId === 'builtin.shell' &&
      typeof ref.commandId === 'string' &&
      typeof ref.key === 'string'
    );
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}
export function inkShellCarrier(tool: Execution, snapshot: TuiSnapshot): Execution | undefined {
  const carriers = snapshot.view.executions.filter(
    (job) => inkShellParent(job, snapshot)?.id === tool.id,
  );
  return carriers.length === 1 ? carriers[0] : undefined;
}
/** A display receipt from a scoped, successful builtin mutation with both original baselines. */
function inkFileChangePresentation(
  execution: Execution,
  snapshot: TuiSnapshot,
  args: Record<string, unknown>,
): { notice: string; text?: string; truncated: boolean } | undefined {
  if (
    !inkExecutionScope(execution, snapshot) ||
    execution.kind !== 'tool' ||
    execution.status !== 'succeeded' ||
    !/^[1-9][0-9]*$/.test(execution.resultRevision) ||
    !(
      (execution.definitionVersion === '2' &&
        (frozenBuiltin(execution, snapshot, 'builtin.files', 'files.write') ||
          frozenBuiltin(execution, snapshot, 'builtin.files', 'files.edit'))) ||
      (execution.definitionVersion === '1' &&
        record(record(execution.result)?.details)?.fileScope === 'external_path' &&
        record(record(execution.result)?.details)?.workspaceCheckpoint === false &&
        (frozenBuiltin(execution, snapshot, 'builtin.files.path', 'files.write_path') ||
          frozenBuiltin(execution, snapshot, 'builtin.files.path', 'files.edit_path')))
    )
  )
    return undefined;
  const result = record(execution.result),
    change = record(record(result?.details)?.fileChange);
  const baseline = (value: unknown) => {
    const b = record(value);
    return b &&
      Object.keys(b).length === 4 &&
      typeof b.hash === 'string' &&
      /^[a-f0-9]{64}$/.test(b.hash) &&
      typeof b.size === 'number' &&
      Number.isSafeInteger(b.size) &&
      b.size >= 0 &&
      typeof b.device === 'string' &&
      /^[0-9]+$/.test(b.device) &&
      typeof b.inode === 'string' &&
      /^[0-9]+$/.test(b.inode)
      ? b
      : undefined;
  };
  if (
    !change ||
    result?.outcome !== 'succeeded' ||
    change.version !== 1 ||
    !['line_diff', 'file_content'].includes(String(change.format)) ||
    typeof change.path !== 'string' ||
    change.path !== args.path ||
    typeof change.text !== 'string' ||
    Buffer.from(change.text, 'utf8').toString('utf8') !== change.text ||
    Buffer.byteLength(change.text) > 65536 ||
    typeof change.truncated !== 'boolean' ||
    !baseline(change.after) ||
    (change.before !== null && !baseline(change.before))
  )
    return undefined;
  const before = baseline(change.before),
    after = baseline(change.after)!;
  const unchanged = before && before.hash === after.hash && before.size === after.size;
  const resultBody = typeof result.content === 'string' ? parsed(result.content) : undefined;
  const published = baseline(resultBody?.baseline);
  if (
    !published ||
    resultBody?.path !== change.path ||
    ['hash', 'size', 'device', 'inode'].some((key) => published[key] !== after[key]) ||
    (change.before === null
      ? args.base !== null
      : !baseline(args.base) ||
        ['hash', 'size', 'device', 'inode'].some(
          (key) => baseline(args.base)![key] !== before![key],
        ))
  )
    return undefined;
  const path = change.path;
  const presentation = (notice: string) => ({
    notice,
    ...(unchanged ? {} : { text: change.text as string }),
    truncated: change.truncated as boolean,
  });
  try {
    const observedRoot = snapshot.environment?.workspacePath;
    const uri = observedRoot?.startsWith('file:') ? new URL(observedRoot) : undefined;
    if (uri && (uri.search || uri.hash)) return undefined;
    const root = uri
      ? `${uri.hostname && uri.hostname !== 'localhost' ? `//${uri.hostname}` : ''}${decodeURIComponent(uri.pathname)}`.replace(
          /^\/([A-Za-z]:)/,
          '$1',
        )
      : observedRoot;
    const windows = /^[A-Za-z]:[\\/]|^\\|^\/\//.test(root ?? path);
    const absolute = (value: string) => /^(?:\/|\\|[A-Za-z]:)/.test(value);
    const encoded = (value: string) =>
      encodeURI(windows ? value.replaceAll('\\', '/') : value).replace(/[?#]/g, encodeURIComponent);
    // This is only a lexical display label. File authority and actual target
    // containment remain in Agent; the portable UI must not import node:path.
    if (!root) {
      if (absolute(path)) return undefined;
      const base = 'file:///workspace-display/';
      return new URL(encoded(path), base).href.startsWith(base)
        ? presentation(unchanged ? 'File content unchanged.' : 'Workspace file changed.')
        : undefined;
    }
    if (!absolute(root) || (windows && /^[A-Za-z]:[^\\/]/.test(path))) return undefined;
    const fileUrl = (value: string) => {
      const normalized = encoded(value);
      return new URL(
        normalized.startsWith('//')
          ? `file:${normalized}`
          : `file:///${normalized.replace(/^\//, '')}`,
      );
    };
    const base = fileUrl(`${root.replace(/[\\/]$/, '')}/`);
    const target =
      windows && /^[A-Za-z]:[\\/]|^\\\\/.test(path) ? fileUrl(path) : new URL(encoded(path), base);
    const compare = (value: string) => (windows ? value.toLowerCase() : value);
    const prefix = compare(base.href);
    const actual = compare(target.href);
    if (unchanged) return presentation('File content unchanged.');
    return presentation(
      actual === prefix.slice(0, -1) || actual.startsWith(prefix)
        ? 'Workspace file changed.'
        : 'External file changed.',
    );
  } catch {
    return undefined;
  }
}
export function inkFileChangeSummary(
  execution: Execution,
  snapshot: TuiSnapshot,
  args: Record<string, unknown>,
): string | undefined {
  return inkFileChangePresentation(execution, snapshot, args)?.notice;
}
export function projectInkTool(
  execution: Execution,
  snapshot: TuiSnapshot,
  loadedOutputs: ReadonlyMap<string, ModelOutputSnapshot['output']> = new Map(),
  expanded?: boolean,
): Extract<OutputBlock, { kind: 'tool_card' }> {
  const shellParent = inkShellParent(execution, snapshot);
  const shellArgs = shellParent
    ? inkToolArguments(shellParent, snapshot, loadedOutputs)
    : undefined;
  const proxy = /^mcp\.([A-Za-z0-9_-]{1,128})\.([a-f0-9]{32})$/.exec(execution.definitionId);
  const labels = snapshot.toolLabels?.filter(
    (label) =>
      label.executionId === execution.id &&
      label.originStoreId === execution.originStoreId &&
      label.sessionId === execution.sessionId &&
      label.definitionId === execution.definitionId &&
      label.definitionVersion === execution.definitionVersion,
  );
  let discoveredName: string | undefined;
  if (proxy && inkExecutionScope(execution, snapshot))
    for (const source of snapshot.view.executions) {
      if (
        source.kind !== 'tool' ||
        source.definitionId !== 'mcp.tools.search' ||
        source.definitionVersion !== '1' ||
        source.status !== 'succeeded' ||
        !inkExecutionScope(source, snapshot)
      )
        continue;
      const result = record(source.result),
        body = typeof result?.content === 'string' ? parsed(result.content) : undefined;
      if (body?.source !== 'frozen_selected_mcp_catalogue' || !Array.isArray(body.items)) continue;
      const rows = body.items
        .map(record)
        .filter(
          (row) =>
            !!row &&
            row.serverId === proxy[1] &&
            row.definitionId === execution.definitionId &&
            row.definitionVersion === execution.definitionVersion &&
            typeof row.remoteName === 'string',
        );
      if (rows.length === 1) discoveredName = terminalText(String(rows[0]!.remoteName));
    }
  const name =
    proxy && labels?.length === 1
      ? discoveredName
        ? 'mcp:dynamic_tool'
        : 'mcp_tool'
      : shellParent && shellArgs
        ? 'shell_execute'
        : terminalText(inkToolName(execution.definitionId, execution, snapshot));
  const args = displayArguments(
    proxy ? {} : (shellArgs ?? inkToolArguments(execution, snapshot, loadedOutputs) ?? {}),
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
  const timing = inkExecutionScope(execution, snapshot)
    ? snapshot.executionTimings?.[execution.id]
    : undefined;
  const confirmed = timing?.availability === 'recorded_dispatch' && timing.startedAt !== undefined;
  const result = record(execution.result),
    failure = record(result?.details);
  const summary =
    execution.status === 'outcome_unknown'
      ? 'Outcome unknown; original work remains unverified.'
      : execution.kind === 'tool' &&
          execution.status === 'failed' &&
          inkExecutionScope(execution, snapshot) &&
          result?.outcome === 'failed' &&
          result.content === 'approval_denied' &&
          failure?.code === 'approval_denied' &&
          failure.dispatchCommitted === false &&
          failure.adapterAttempted === false
        ? 'Tool approval rejected by user.'
        : inkResultSummary(execution.result);
  const privateMcpSummary = proxy
    ? execution.status === 'outcome_unknown'
      ? 'Outcome unknown; original work remains unverified.'
      : execution.status === 'failed'
        ? 'MCP call failed.'
        : ''
    : undefined;
  const resourceList =
    name === 'list_mcp_resources' && execution.status === 'succeeded'
      ? mcpResourceReceipt(execution, snapshot)
      : undefined;
  const resourceBinding = record(resourceList?.binding);
  const resourceReferences =
    inkExecutionScope(execution, snapshot) &&
    resourceBinding?.executionId === execution.id &&
    resourceBinding.originalStoreId === snapshot.storeId &&
    resourceBinding.sessionId === execution.sessionId &&
    resourceBinding.runId === execution.runId &&
    resourceBinding.definitionId === execution.definitionId &&
    resourceBinding.definitionVersion === execution.definitionVersion &&
    Array.isArray(resourceList?.descriptors)
      ? resourceList.descriptors
          .map((value) => record(record(value)?.descriptor)?.uri)
          .filter((value): value is string => typeof value === 'string')
          .map(terminalText)
      : undefined;
  const fileChange = inkFileChangePresentation(execution, snapshot, args);
  return {
    id: 0,
    kind: 'tool_card',
    callId: execution.toolCallId ?? execution.id,
    name,
    args,
    status: inkExecutionStatus(execution),
    ...(resourceReferences ? { resourceReferences } : {}),
    ...(fileChange
      ? { fileNotice: fileChange.notice, filePreviewTruncated: fileChange.truncated }
      : {}),
    ...(name === 'write_file' && fileChange
      ? { fileAction: args.base === null ? ('Create' as const) : ('Write' as const) }
      : {}),
    summary:
      privateMcpSummary ??
      (name === 'read_mcp_resource' || name === 'list_mcp_resources' ? '' : undefined) ??
      (fileChange && terminalText(fileChange.text ?? fileChange.notice)) ??
      terminalText(
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
    preview: proxy ? discoveredName : getToolPreview(name, args),
    detail: proxy ? discoveredName : getToolDetail(name, args),
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
    !inkExecutionScope(execution, snapshot)
  )
    return undefined;
  const parent = snapshot.view.executions.find(
    (item) =>
      item.id === execution.parentExecutionId &&
      item.kind === 'tool' &&
      taskCarrierTool(item, snapshot) &&
      item.originStoreId === execution.originStoreId &&
      item.sessionId === execution.sessionId &&
      actualCarrierParent(execution, item, snapshot),
  );
  if (!parent) return undefined;
  const args = inkToolArguments(parent, snapshot, loadedOutputs);
  if (!args) return undefined;
  const legacy =
    frozenBuiltin(parent, snapshot, 'builtin.task', 'task') ||
    frozenBuiltin(parent, snapshot, 'builtin.task', 'task.execute');
  if (legacy && typeof args.role !== 'string') return undefined;
  const role =
    typeof args.role === 'string'
      ? args.role
      : typeof args.preset === 'string'
        ? args.preset
        : 'worker';
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
  const runMatches =
    child?.runs.filter(
      (run) =>
        ((run.carrierExecutionId === execution.id &&
          run.rootWorkCommandId === execution.rootWorkCommandId &&
          run.rootWorkSeq === execution.rootWorkSeq) ||
          (run.carrierExecutionId === undefined &&
            run.originCommandId === `child-start-${execution.id}`)) &&
        run.originStoreId === execution.originStoreId &&
        run.sessionId === execution.childSessionId &&
        (run.rootWorkCommandId === undefined ||
          run.rootWorkCommandId === execution.rootWorkCommandId) &&
        (run.rootWorkSeq === undefined || run.rootWorkSeq === execution.rootWorkSeq),
    ) ?? [];
  const activeRuns = runMatches.filter((run) => run.isActive);
  const childRun =
    activeRuns.length === 1 ? activeRuns[0] : runMatches.length === 1 ? runMatches[0] : undefined;
  const childRunIds = new Set(runMatches.map((run) => run.id));
  const exactChildExecution = (item: Execution) =>
    childRunIds.size > 0 &&
    item.kind === 'tool' &&
    item.originStoreId === snapshot.storeId &&
    item.sessionId === child!.session.id &&
    item.runId !== null &&
    childRunIds.has(item.runId) &&
    item.rootWorkCommandId === execution.rootWorkCommandId &&
    item.rootWorkSeq === execution.rootWorkSeq;
  const childSnapshot = child
    ? { ...snapshot, view: child, messages: child.messages, executionTimings: undefined }
    : undefined;
  const steps = childSnapshot
    ? childSnapshot.view.executions.filter(exactChildExecution).map((item) => ({
        stepId: item.id,
        toolCallId: item.toolCallId ?? item.id,
        toolName: terminalText(inkToolName(item.definitionId, item, childSnapshot)),
        toolArgs: displayArguments(
          frozenBuiltin(item, childSnapshot, 'builtin.files', 'files.search') &&
            (inkToolArguments(item, childSnapshot)?.path === undefined ||
              inkToolArguments(item, childSnapshot)?.path === '')
            ? { ...inkToolArguments(item, childSnapshot), path: '.' }
            : (inkToolArguments(item, childSnapshot) ?? {}),
        ),
        status:
          item.status === 'succeeded'
            ? ('success' as const)
            : item.status === 'failed' || item.status === 'outcome_unknown'
              ? ('error' as const)
              : item.status === 'cancelled'
                ? ('cancelled' as const)
                : ('pending' as const),
        summary: inkResultSummary(item.result),
        fileNotice: inkFileChangeSummary(
          item,
          childSnapshot,
          inkToolArguments(item, childSnapshot) ?? {},
        ),
      }))
    : [];
  const pendingChild =
    ['planned', 'dispatching', 'running'].includes(execution.status) &&
    execution.cancelRequestedAt === null &&
    childRun?.isActive
      ? child?.executions.find(
          (item) =>
            exactChildExecution(item) &&
            item.runId === childRun.id &&
            item.cancelRequestedAt === null &&
            ['planned', 'dispatching', 'running'].includes(item.status) &&
            (item.authorization?.human?.state === 'pending' ||
              item.authorization?.review?.status === 'planned' ||
              item.authorization?.review?.status === 'dispatching' ||
              item.authorization?.review?.status === 'running'),
        )
      : undefined;
  const approvalState =
    pendingChild?.authorization?.human?.state === 'pending'
      ? ('awaiting_user' as const)
      : pendingChild?.authorization?.review?.status === 'running' ||
          pendingChild?.authorization?.review?.status === 'dispatching'
        ? ('auto_reviewing' as const)
        : pendingChild?.authorization?.review?.status === 'planned'
          ? ('queued_auto_review' as const)
          : undefined;
  const input = record(args.input);
  const task =
    typeof args.taskName === 'string' && args.taskName.trim()
      ? args.taskName
      : typeof args.prompt === 'string'
        ? args.prompt
        : typeof args.content === 'string'
          ? args.content
          : typeof input?.name === 'string'
            ? input.name
            : typeof args.input === 'string'
              ? args.input
              : typeof input?.content === 'string'
                ? input.content
                : typeof input?.task === 'string'
                  ? input.task
                  : typeof args.key === 'string'
                    ? args.key
                    : (child?.session.title ?? execution.definitionId);
  const timing = snapshot.executionTimings?.[execution.id];
  const startedAt =
    timing?.availability === 'recorded_dispatch' &&
    Number.isSafeInteger(timing.startedAt) &&
    timing.startedAt! >= 0
      ? timing.startedAt
      : undefined;
  const durationMs =
    startedAt !== undefined &&
    Number.isSafeInteger(timing?.finishedAt) &&
    timing!.finishedAt! >= startedAt
      ? timing!.finishedAt! - startedAt
      : undefined;
  return {
    id: 0,
    kind: 'subagent',
    subagentId: execution.childSessionId,
    role: terminalText(
      (
        {
          'agent/explore': 'explore',
          'agent/plan': 'plan',
          'agent/code': 'code',
          'agent/review': 'review',
        } as Readonly<Record<string, string>>
      )[role] ?? role,
    ),
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
              : execution.status === 'planned' && !childRun?.isActive
                ? 'creating'
                : 'running',
    summary: inkResultSummary(execution.result),
    toolCallCount: steps.length,
    ...(approvalState ? { approvalState, awaitingApproval: true } : {}),
    steps,
    expanded,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}
export function InkExecution({
  execution,
  snapshot,
  loadedOutputs = new Map(),
  expanded,
  columns = 80,
  maxVisibleSteps,
}: {
  execution: Execution;
  snapshot: TuiSnapshot;
  loadedOutputs?: ReadonlyMap<string, ModelOutputSnapshot['output']>;
  expanded?: boolean;
  columns?: number;
  maxVisibleSteps?: number;
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
        <SubAgentBlock block={child} columns={columns} maxVisibleSteps={maxVisibleSteps} />
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
      ((message.sourceIds ?? []).includes(item.id) || message.outputBody?.executionId === item.id),
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
  finalReasoning,
}: {
  message: Message;
  snapshot: TuiSnapshot;
  loadedOutputs?: ReadonlyMap<string, ModelOutputSnapshot['output']>;
  columns?: number;
  finalReasoning?: string;
}) {
  return (
    <ToolSummaryBlock
      block={projectInkThought(message, snapshot, loadedOutputs)}
      columns={columns}
      finalReasoning={finalReasoning}
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
        inkExecutionScope(item, snapshot) &&
        item.runId === message.runId &&
        ((message.sourceIds ?? []).includes(item.id) ||
          message.outputBody?.executionId === item.id),
    );
    if (models.length !== 1) continue;
    const sources = calls.map((call) => {
      if (counts.get(callKey(message, call.id)) !== 1) return undefined;
      const matches = snapshot.view.executions.filter(
        (item) =>
          item.kind === 'tool' &&
          inkExecutionScope(item, snapshot) &&
          item.runId === message.runId &&
          item.toolCallId === call.id,
      );
      return matches.length === 1 ? matches[0] : undefined;
    });
    let reads: Execution[] = [];
    const flush = () => {
      if (reads.length >= 1) {
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
        source && taskCarrierTool(source, snapshot)
          ? snapshot.view.executions
              .filter(
                (job) =>
                  job.kind === 'job' &&
                  inkExecutionScope(job, snapshot) &&
                  actualCarrierParent(job, source, snapshot) &&
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
  maxVisibleSteps,
  maxVisibleChildren,
  allowExpanded,
}: {
  group: InkExecutionGroup;
  columns?: number;
  maxVisibleSteps?: number;
  maxVisibleChildren?: number;
  allowExpanded?: boolean;
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
    <ConcurrentSubAgentBlock
      blocks={group.blocks}
      columns={columns}
      maxVisibleSteps={maxVisibleSteps}
      maxVisibleChildren={maxVisibleChildren}
      allowExpanded={allowExpanded}
    />
  );
}

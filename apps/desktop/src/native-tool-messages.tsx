import type { Execution, Message } from '@kite-ai/client';
import {
  type Message as DesktopMessage,
  ToolActivity,
  ToolRow,
  useDesktopDiagnostics,
} from '@kite-ai/ui/desktop';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeBridge, NativeResult, NativeSelection } from './native-bridge';
import { NativeDisplayCache } from './native-display-cache';
import { nativeReadDeadline } from './native-read-deadline';
import { desktopShell } from './native-shell-receipt';
import type {
  NativeRunFact,
  NativeToolExecution,
  NativeToolMessageFact,
} from './tool-messages-bridge';
import { nativeShellCommandChunkBytes, nativeShellJobMatches } from './tool-messages-bridge';
import { nativeToolRequestTarget } from './tool-request-target';

const emptyToolFacts: NativeToolMessageFact[] = [];

export const PLAN_PROGRESS_TOOL = 'planning.update';

const labels: Record<string, readonly [readonly string[], string]> = {
  'files.read': [['2', '3', '4', '5'], '读取'],
  'files.write': [['2', '3'], '写入'],
  'files.edit': [['2'], '修改'],
  'files.view_images': [['1'], '查看图像'],
  'files.reinspect_images': [['1'], '复看图像'],
  'shell.launch': [['1'], '启动后台 Shell'],
  'shell.execute': [['1'], '运行命令'],
  'shell.read': [['1'], '读取后台 Shell'],
  'shell.wait': [['1'], '等待后台 Shell'],
  'shell.stop': [['1'], '请求停止后台 Shell'],
  'git.worktree': [['1'], 'Git 工作树'],
  ask_user: [['1'], '询问用户'],
  web_fetch: [['1'], '读取网页'],
  'web.search': [['1'], '网页搜索'],
  'task.spawn': [['1'], '创建子 Agent'],
  'task.follow_up': [['1'], '继续子 Agent'],
  'task.message': [['1'], '发送 Agent 消息'],
  'task.events': [['1'], '等待 Agent 事件'],
  'task.list': [['1'], '列出子 Agent'],
  'task.interrupt': [['1'], '中断子 Agent'],
  'planning.read': [['1'], '读取计划'],
  'planning.write': [['1'], '编写计划'],
  'planning.review': [['1'], '请求计划审阅'],
  [PLAN_PROGRESS_TOOL]: [['1'], '更新计划'],
  'mcp.tools.search': [['1'], '搜索 MCP 工具'],
  'mcp.resources.list': [['1'], '列出 MCP 资源'],
  'mcp.resources.read': [['1'], '读取 MCP 资源'],
  'skills.load': [['1'], '加载技能'],
  'skills.resource': [['1'], '读取技能资料'],
  'browser.execute': [['1'], '浏览器操作'],
  'browser.structured.navigate': [['1'], '打开网页'],
  'browser.structured.snapshot': [['1'], '读取网页'],
  'browser.structured.click': [['1'], '点击网页元素'],
  'browser.structured.type': [['1'], '填写网页字段'],
  'browser.structured.fill_form': [['1'], '填写网页表单'],
  'browser.structured.tabs': [['1'], '管理浏览器标签页'],
  'browser.structured.screenshot': [['1'], '截取网页图像'],
  'browser.structured.press': [['1'], '发送浏览器按键'],
  'browser.structured.wait': [['1'], '等待网页状态'],
  'browser.structured.dialog': [['1'], '处理网页对话框'],
  'browser.structured.history': [['1'], '浏览网页历史'],
  'browser.structured.pointer': [['1'], '操作网页图像'],
};
const exploration = new Set(['files.read']);
const standalone = new Set(['task.spawn', 'planning.review']);

/** Names follow stable IDs; structured presentation still requires a supported version. */
export function desktopToolPresentation(
  fact: Pick<NativeToolMessageFact, 'definitionId' | 'definitionVersion'> &
    Pick<Partial<NativeToolMessageFact>, 'label'>,
): Pick<
  DesktopMessage,
  'toolName' | 'toolSummaryCategory' | 'webSearchReceipt' | 'title' | 'presentation' | 'shell'
> {
  const label = labels[fact.definitionId];
  const known = label?.[0].includes(fact.definitionVersion);
  const mcp = /^mcp\.([A-Za-z0-9_-]{1,128})\.[a-f0-9]{32}$/.test(fact.definitionId);
  return {
    ...(known && fact.definitionId === 'web.search' ? { webSearchReceipt: true as const } : {}),
    // Classification follows the original definition, not a remote display name.
    // It changes only completed Trace summaries, not versioned result rendering.
    ...(mcp
      ? { toolSummaryCategory: 'mcp' as const }
      : known && fact.definitionId === 'skills.load'
        ? { toolSummaryCategory: 'skill' as const }
        : {}),
    toolName: known
      ? ((
          {
            'web.search': 'web_search',
            'files.read': 'read_file',
            'files.write': 'write_file',
            'files.edit': 'edit_file',
            'files.view_images': 'view_images',
            'files.reinspect_images': 'reinspect_images',
            'shell.execute': 'shell_execute',
            'task.spawn': 'spawn_agent',
            'task.follow_up': 'follow_up_agent',
            'task.message': 'send_agent_message',
            'task.events': 'wait_agent_events',
            'task.list': 'list_agents',
            'task.interrupt': 'interrupt_agent',
            'skills.load': 'load_skill',
            'skills.resource': 'read_skill_resource',
            'browser.execute': 'browser_execute',
          } as Record<string, string>
        )[fact.definitionId] ??
        (fact.definitionId.startsWith('browser.structured.')
          ? 'browser_execute'
          : fact.definitionId))
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
    ...(standalone.has(fact.definitionId)
      ? { presentation: 'standalone' as const }
      : known && exploration.has(fact.definitionId)
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
export const sameToolReceipt = (left: Message, right: Message) =>
  left.id === right.id &&
  left.sessionId === right.sessionId &&
  left.seq === right.seq &&
  left.content === right.content &&
  left.deferredText?.sha256 === right.deferredText?.sha256 &&
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
    (['execute', 'launch'].includes(input.operation)
      ? input.command === undefined
      : !input.shellId && !input.sessionId)
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
          shellSession: undefined,
          shellJobExecutionId: undefined,
          shellJobSettlement: undefined,
          shellOutputReceipt: undefined,
          shellOutputLimit: undefined,
          shellDisplay: undefined,
          shellOutputError: undefined,
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
          (Object.hasOwn(args, 'key')
            ? args.key === fact.shellInput.shellId
            : fact.definitionId === 'shell.execute') &&
          (fact.definitionId !== 'shell.execute' ||
            (args.background === true) === (fact.shellInput.operation === 'launch')) &&
          nativeToolRequestTarget(args, fact.definitionId, fact.definitionVersion) === fact.target
      : args.shellId === (fact.shellInput?.shellId ?? fact.shellInput?.sessionId);
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
        optionId: human.optionId,
        optionKind: human.optionKind,
        presentation: human.presentation,
        ...(state === 'awaiting_user' && authorization?.check?.reason
          ? { reason: authorization.check!.reason }
          : {}),
      };
  }
  const check = authorization?.check;
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
      | 'ask'
      | 'authorization'
      | 'decisionRefresh'
      | 'fileEditBatchRejectedMember'
      | 'fileMissing'
      | 'fileCreated'
      | 'images'
      | 'reinspectedImages'
      | 'imageSourcesListed'
      | 'agentMessageAccepted'
      | 'agentWait'
      | 'webFetchBatch'
      | 'shellInput'
      | 'shellDisplay'
      | 'shellOutputLimit'
      | 'shellOutputReceipt'
      | 'shellResultVerified'
      | 'shellSession'
      | 'shellJobExecutionId'
      | 'shellJobSettlement'
      | 'worktreeFailure'
      | 'label'
    >,
  id: string,
  text: string,
): DesktopMessage {
  const shell = desktopShell(fact, text);
  const worktreeIssue = desktopWorktreeFailure(fact);
  const wait = fact.agentWait;
  const waitText =
    wait?.reason === 'failed'
      ? {
          invalid_cursor: '事件游标无效，子 Agent 可继续运行。',
          cursor_expired: '事件游标已过期，需要重新观察。',
          invalid_request: '等待参数无效。',
          invalid_work_reference: '无法核实要等待的子 Agent 工作。',
          agent_unavailable: '无法读取所选子 Agent 的状态。',
          permission_denied: '当前权限无法查看子 Agent 事件。',
          operation_cancelled: '本次事件观察已取消，子 Agent 可继续运行。',
          receipt_unverifiable: '暂时无法核实子 Agent 事件。',
        }[wait.code]
      : wait?.historyGap
        ? wait.events
          ? `收到 ${wait.events} 条子 Agent 事件，较早事件已过期`
          : '较早的子 Agent 事件已过期，已从保留位置继续'
        : wait &&
          {
            events: `收到 ${wait.events} 条子 Agent 事件`,
            completed: '所等待的子 Agent 工作已结束',
            input: '收到新输入，已结束等待',
            timeout: '等待期间暂无新事件',
          }[wait.reason];
  const messageAccepted =
    fact.agentMessageAccepted &&
    fact.definitionId === 'task.message' &&
    fact.definitionVersion === '1' &&
    fact.status === 'succeeded';
  const planRead = fact.definitionId === 'planning.read' && fact.definitionVersion === '1';
  const webFetchBatch =
    fact.definitionId === 'web_fetch' &&
    fact.definitionVersion === '1' &&
    (fact.status === 'succeeded' || fact.status === 'failed')
      ? fact.webFetchBatch
      : undefined;
  return {
    id,
    role: 'tool',
    text:
      planRead || webFetchBatch || fact.fileEditBatchRejectedMember
        ? ''
        : (waitText ??
          (messageAccepted
            ? '消息已提交'
            : shell && (fact.shellResultVerified || /^[\s\uFEFF]*[[{]/u.test(text))
              ? ''
              : text)),
    ...(waitText ? { agentWait: true as const } : {}),
    ...(webFetchBatch ? { webFetchBatch } : {}),
    settled: !['planned', 'dispatching', 'running'].includes(fact.status),
    ...(fact.fileEditBatchRejectedMember ? { fileEditBatchRejectedMember: true } : {}),
    ...desktopToolPresentation(fact),
    target: fact.target,
    ...(shell ? { shell } : {}),
    ...(worktreeIssue ? { toolResult: { ok: false, stderr: worktreeIssue } } : {}),
    ...(fact.ask ? { ask: fact.ask } : {}),
    ...(fact.fileMissing && fact.status === 'succeeded' ? { fileMissing: true } : {}),
    ...(fact.fileCreated && fact.status === 'succeeded' ? { fileCreated: true } : {}),
    ...(fact.status === 'succeeded' && fact.definitionId === 'files.view_images'
      ? { toolImageCount: fact.images?.length ?? 0 }
      : fact.status === 'succeeded' && fact.definitionId === 'files.reinspect_images'
        ? { toolImageCount: fact.reinspectedImages, imageSourcesListed: fact.imageSourcesListed }
        : {}),
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
      fact.status === 'failed' && (fact.decisionRefresh || fact.fileEditBatchRejectedMember)
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

function desktopWorktreeFailure(
  fact: Pick<NativeToolMessageFact, 'definitionId' | 'definitionVersion' | 'status'> &
    Pick<Partial<NativeToolMessageFact>, 'worktreeFailure'>,
): string | undefined {
  const failure = fact.worktreeFailure;
  if (
    !failure ||
    typeof failure.category !== 'string' ||
    fact.definitionId !== 'git.worktree' ||
    fact.definitionVersion !== '1' ||
    !['failed', 'outcome_unknown'].includes(fact.status)
  )
    return;
  const category = {
    process_start:
      'Git 进程启动失败。请检查 Git 安装、可执行路径和系统进程启动限制；进程启动错误本身不能说明用户拒绝授权。',
    permission_denied:
      'Git 工作树权限拒绝（文件系统）。请检查来源仓库、Git 公共目录和目标路径的实际访问权限。',
    git_command: `Git 命令执行失败${failure.exitCode === undefined ? '' : `（退出码 ${failure.exitCode}）`}。Git 进程已启动，请核对仓库、分支和目标目录的状态。`,
    verification: 'Git 工作树操作未通过核验。请保留并核对原操作记录和实际仓库状态。',
    authorization_denied:
      '当前权限策略未批准本次 Git 工作树调用。该记录只确认策略未批准，未记录用户明确拒绝；请核对该调用的授权原因和原请求范围。',
    unclassified: '旧记录未提供失败分类。请核对原操作记录和 Job，保留原始错误。',
  }[failure.category];
  if (!category || !['not_started', 'completed', 'partial', 'unknown'].includes(failure.mutation))
    return;
  const effects =
    fact.status === 'outcome_unknown' || failure.mutation === 'unknown'
      ? '本次变更结果仍未确认；请只核对原操作 key 和 Job，不要重复创建或删除。'
      : failure.mutation === 'partial'
        ? '本次已发生部分变更；请先核对原操作 key、Job、目录和分支，不要重复创建或删除。'
        : failure.mutation === 'completed'
          ? '本次已有完成的变更；请核对原操作 key 和 Job 的结果，不要重复创建或删除。'
          : '本次观察确认尚未开始工作树变更；请先核对原操作记录，修复原因本身不代表可以自动重试。';
  return `${category}${failure.errno ? ` 系统错误：${failure.errno}。` : ''}${failure.cleanupUnconfirmed ? ' 相关进程或输出资源的清理尚未确认。' : ''}\n${effects}`;
}

export function nativeShellInputPresentation(fact: NativeToolMessageFact) {
  return desktopShell({ ...fact, shellDisplay: undefined, shellResultVerified: false }, '');
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
  submittedInteractions: ReadonlySet<string> = new Set(),
  unconfirmedApprovals: ReadonlySet<string> = new Set(),
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
        execution.definitionId !== PLAN_PROGRESS_TOOL &&
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
      const cards =
        selection.interactions?.filter(
          (card) =>
            card.state === 'pending' &&
            card.originStoreId === selection.storeId &&
            card.sessionId === execution.sessionId &&
            card.presentationSessionId === selection.session.id &&
            card.runId === execution.runId &&
            card.executionId === execution.id &&
            card.definitionId === execution.definitionId &&
            card.definitionVersion === execution.definitionVersion,
        ) ?? [];
      const approval = cards.find((card) => card.kind === 'approval');
      const question =
        execution.definitionId === 'ask_user' && cards.find((card) => card.kind === 'question');
      return {
        execution,
        message: {
          ...desktopToolMessage(
            {
              ...execution,
              ...(input?.label ? { label: input.label } : {}),
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
          ...(input?.shellInput
            ? { shell: nativeShellInputPresentation(input), target: input.target }
            : {}),
          presentationKey: nativeToolPresentationKey(
            selection.storeId,
            selection.session.id,
            execution.runId!,
            execution.id,
          ),
          executionUnconfirmed,
          toolStopping: !executionUnconfirmed && execution.cancelRequestedAt !== null,
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
          ...(approval
            ? {
                approval: {
                  state: submittedInteractions.has(approval.id)
                    ? ('submitted' as const)
                    : unconfirmedApprovals.has(approval.id)
                      ? ('submission_unconfirmed' as const)
                      : ('awaiting_user' as const),
                  source: 'user' as const,
                  interactionId: approval.id,
                  reason: execution.authorization?.check?.reason ?? undefined,
                },
              }
            : {}),
          ...(question
            ? {
                questionState: submittedInteractions.has(question.id)
                  ? ('submitted' as const)
                  : ('pending' as const),
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

type CompleteToolPresentation = {
  message: DesktopMessage;
  fact?: NativeToolMessageFact;
};

/** Retain only previously complete, exact-identity rows while replacement metadata loads. */
export class NativeToolPresentation {
  private scope: string | undefined;
  private complete = new Map<string, CompleteToolPresentation>();
  private order = new Map<string, number>();
  private nextOrder = 0;
  private started = new Map<string, number>();
  private nextStart = 0;
  private readonly cached = new NativeDisplayCache<{
    complete: readonly [string, CompleteToolPresentation][];
    order: readonly string[];
    started: readonly [string, number][];
  }>();
  private boundary: string | undefined;
  private bridge: unknown;

  /** Previously admitted display facts only, never a fresh read or control capability. */
  retainedFact(message: DesktopMessage): NativeToolMessageFact | undefined {
    const prior = this.complete.get(message.presentationKey ?? message.id);
    return prior?.message.id === message.id ? prior.fact : undefined;
  }

  retainsLiveRow(message: DesktopMessage) {
    return (
      message.executionUnconfirmed === true &&
      message.id.startsWith('native-execution:') &&
      this.complete.get(message.presentationKey ?? message.id)?.message.id === message.id
    );
  }

  project(
    scope: string,
    messages: readonly DesktopMessage[],
    facts: readonly NativeToolMessageFact[],
    live: readonly {
      message: DesktopMessage;
      execution: NativeToolExecution & Partial<Pick<Execution, 'toolInput'>>;
    }[],
    boundary?: { bridge: unknown; key: string },
    pendingMessageIds?: ReadonlySet<string>,
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
      const saved = this.cached.get(scope);
      this.complete = new Map(saved?.complete);
      this.order = new Map(saved?.order.map((key, index) => [key, index]));
      this.nextOrder = this.order.size;
      this.started = new Map(saved?.started);
      this.nextStart = 0;
      for (const order of this.started.values()) this.nextStart = Math.max(this.nextStart, order);
    }
    const completeIds = new Set(
      completeNativeToolMessages(messages, facts).map((message) => message.id),
    );
    const liveById = new Map(live.map((entry) => [entry.message.id, entry]));
    for (const { message, execution } of live) {
      if (execution.status !== 'running' || execution.authorization?.dispatched === false) continue;
      const key = message.presentationKey ?? message.id;
      if (!this.started.has(key)) this.started.set(key, ++this.nextStart);
    }
    const keep = new Set<string>();
    const result = [...messages, ...live.map((entry) => entry.message)].flatMap((message) => {
      if (message.role !== 'tool') return [message];
      const key = message.presentationKey ?? message.id;
      keep.add(key);
      if (!this.order.has(key)) this.order.set(key, this.nextOrder++);
      const entry = liveById.get(message.id);
      const ready = entry
        ? nativeLiveToolPresentationReady(entry, facts)
        : completeIds.has(message.id);
      if (ready) {
        this.complete.set(key, {
          message,
          fact: facts.find((fact) => fact.messageId === message.id && !fact.inputPending),
        });
        const started = this.started.get(key);
        return [started === undefined ? message : { ...message, toolStartOrder: started }];
      }
      const prior = this.complete.get(key)?.message;
      if (
        !entry &&
        message.presentationKey &&
        prior?.id.startsWith('native-execution:') &&
        pendingMessageIds?.has(message.id)
      ) {
        // The receipt owns the same execution, but its input may span multiple pages.
        // Keep the previously verified row mounted until the complete receipt takes over.
        return [{ ...prior, executionUnconfirmed: true, toolStopping: false }];
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
    for (const key of this.order.keys()) if (!keep.has(key)) this.order.delete(key);
    for (const key of this.started.keys()) if (!keep.has(key)) this.started.delete(key);
    // History receipts can arrive ahead of still-running View entries. Replace
    // tools in their first observed order inside each original readable block,
    // without moving tools across narration, guidance, or Run boundaries.
    const positions: { key: string; indices: number[] }[] = [];
    groupNativeToolMessages(result).forEach((message, index) => {
      if (message.role !== 'tool' || !message.presentationGroupId) return;
      if (positions.at(-1)?.key !== message.presentationGroupId)
        positions.push({ key: message.presentationGroupId, indices: [] });
      positions.at(-1)!.indices.push(index);
    });
    for (const { indices } of positions) {
      const tools = indices
        .map((index) => result[index]!)
        .sort(
          (left, right) =>
            this.order.get(left.presentationKey ?? left.id)! -
            this.order.get(right.presentationKey ?? right.id)!,
        );
      indices.forEach((index, offset) => {
        result[index] = tools[offset]!;
      });
    }
    this.cached.set(scope, {
      complete: [...this.complete],
      order: [...this.order.keys()],
      started: [...this.started],
    });
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

function useNativeLiveToolInputs({
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
  const targets = liveToolMessages(selection, messages).filter(
    (item) =>
      !!item.message.shell ||
      /^mcp\.([A-Za-z0-9_-]{1,128})\.[a-f0-9]{32}$/.test(item.execution.definitionId),
  );
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
            const page: NativeResult = await nativeReadDeadline(
              bridge.request({
                method: 'toolMessages.list',
                generation,
                viewSelection,
                historyEpoch,
                readId,
                messageIds: [],
                executionIds: batch.map((item) => item.execution.id),
                ...(commandOffsets ? { commandOffsets } : {}),
              }),
            );
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
  executions = selection?.executions,
  finishedShellJobs,
  suspended = false,
}: {
  bridge?: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  historyEpoch: number;
  messages: readonly Message[];
  observationRevision: number;
  executions?: readonly NativeToolExecution[];
  finishedShellJobs?: readonly (readonly [string, string])[];
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
    candidates.some((message, index) => !sameToolReceipt(message, receiptCache.current[index]!))
  )
    receiptCache.current = candidates;
  const eligible = receiptCache.current;
  const [retryRevision, setRetryRevision] = useState(0);
  const liveRead = useNativeLiveToolInputs({
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
        shellJobRevision?: string;
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
  const knownJobIds = new Set<string>();
  if (cache.current.scope === scope && cache.current.retryRevision === retryRevision)
    for (const message of eligible) {
      const receipt = cache.current.read.get(message.id);
      const id = receipt?.fact?.shellJobExecutionId;
      if (id && sameToolReceipt(receipt.message, message)) knownJobIds.add(id);
    }
  const completions = new Map((finishedShellJobs ?? []).filter(([id]) => knownJobIds.has(id)));
  const terminalJobs = (executions ?? []).filter(
    (job) =>
      knownJobIds.has(job.id) &&
      !completions.has(job.id) &&
      job.kind === 'job' &&
      job.definitionId === 'shell.command' &&
      job.definitionVersion === '1' &&
      job.originStoreId === storeId &&
      job.sessionId === sessionId &&
      ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(job.status),
  );
  const jobIdentity = JSON.stringify([
    storeId,
    sessionId,
    terminalJobs.map(({ id, runId, parentExecutionId, status, resultRevision }) => [
      id,
      runId,
      parentExecutionId,
      status,
      resultRevision,
    ]),
    [...completions],
  ]);
  const jobCache = useRef({
    identity: '',
    jobs: new Map<string, NativeToolExecution>(),
    completions: new Map<string, string>(),
  });
  if (jobCache.current.identity !== jobIdentity)
    jobCache.current = {
      identity: jobIdentity,
      jobs: new Map(terminalJobs.map((job) => [job.id, job])),
      completions,
    };
  const observedJobs = jobCache.current;
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
    const shellJobRevision = (message: Message, fact: NativeToolMessageFact | undefined) => {
      if (
        message.originMessage ||
        message.sessionId !== sessionId ||
        !message.runId ||
        !fact?.shellJobExecutionId ||
        fact.status !== 'succeeded' ||
        !fact.shellResultVerified ||
        (fact.shellInput?.operation !== 'launch' && !fact.shellSession)
      )
        return;
      const jobExecutionId = fact.shellJobExecutionId;
      const job = observedJobs.jobs.get(jobExecutionId);
      if (
        nativeShellJobMatches(job, {
          executionId: fact.executionId,
          jobExecutionId,
          originStoreId: storeId,
          sessionId,
          runId: message.runId,
        })
      )
        return JSON.stringify([job.id, job.status, job.resultRevision]);
      // A previously watched Job can leave the bounded View when it finishes.
      // Only its exact completion event merits a read; absence alone proves nothing.
      const completion = observedJobs.completions.get(jobExecutionId);
      return completion ? JSON.stringify([jobExecutionId, 'finished', completion]) : undefined;
    };
    // A terminal Tool receipt is immutable, but the separately owned Job can settle later.
    // A settlement-only read keeps the verified command and does not page it again.
    const settlementOnly = new Map<string, string>();
    const pending = eligible.filter((message) => {
      const previous = current.read.get(message.id);
      if (
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
        !sameToolReceipt(previous.message, message)
      )
        return true;
      const revision = shellJobRevision(message, previous.fact);
      if (!revision || previous.fact?.shellJobSettlement || previous.shellJobRevision === revision)
        return false;
      settlementOnly.set(message.id, revision);
      return true;
    });
    // Mark the new read as pending now; retaining the last error would report
    // loading=false and let background recovery restart this in-flight request.
    publish();
    void (async () => {
      let readError = false;
      const batches: Message[][] = [];
      for (let index = 0; index < pending.length; index += 32)
        batches.push(pending.slice(index, index + 32));
      for (const messages of batches) {
        let batch = messages;
        const assembled = new Map<string, { command: string; fact: NativeToolMessageFact }>();
        let commandOffsets: Record<string, number> | undefined;
        try {
          do {
            readId = crypto.randomUUID();
            const page: NativeResult = await nativeReadDeadline(
              bridge.request({
                method: 'toolMessages.list',
                generation,
                viewSelection,
                historyEpoch,
                readId,
                messageIds: batch.map((message) => message.id),
                ...(commandOffsets ? { commandOffsets } : {}),
              }),
            );
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
              const settlementRevision = settlementOnly.get(message.id);
              const previous = current.read.get(message.id);
              if (settlementRevision && previous?.fact) {
                const saved = previous.fact;
                current.read.set(message.id, {
                  ...previous,
                  shellJobRevision: settlementRevision,
                  fact:
                    fact?.shellJobSettlement &&
                    fact.shellJobExecutionId === saved.shellJobExecutionId &&
                    fact.executionId === saved.executionId &&
                    fact.resultRevision === saved.resultRevision &&
                    fact.definitionId === saved.definitionId &&
                    fact.definitionVersion === saved.definitionVersion &&
                    fact.status === saved.status
                      ? { ...saved, shellJobSettlement: fact.shellJobSettlement }
                      : saved,
                });
                continue;
              }
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
                  if (previous)
                    fact = {
                      ...fact!,
                      shellDisplay: previous.fact.shellDisplay,
                      shellOutputError: previous.fact.shellOutputError,
                      shellJobSettlement:
                        fact!.shellJobSettlement ?? previous.fact.shellJobSettlement,
                    };
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
                  previous && sameToolReceipt(previous.message, message)
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
                shellJobRevision: shellJobRevision(message, fact),
              });
            }
            publish(readError ? '部分工具状态尚无法核实，保留原始结果。' : undefined);
            commandOffsets = next;
            batch = batch.filter((message) => Object.hasOwn(next, message.id));
          } while (batch.length && active);
        } catch (error) {
          if (!active) return;
          if (
            !commandOffsets &&
            batch.length > 1 &&
            error instanceof Error &&
            ['tool_message_page_too_large', 'native_response_too_large'].includes(error.message)
          ) {
            const middle = Math.ceil(batch.length / 2);
            batches.push(batch.slice(0, middle), batch.slice(middle));
            continue;
          }
          readError ||= batch.some((message) => !settlementOnly.has(message.id));
          // A command continuation cannot invalidate metadata already checked on its first page.
          for (const message of batch) {
            const previous = current.read.get(message.id);
            const settlementRevision = settlementOnly.get(message.id);
            if (settlementRevision && previous) {
              current.read.set(message.id, { ...previous, shellJobRevision: settlementRevision });
              continue;
            }
            current.read.set(message.id, {
              message,
              fact:
                previous && sameToolReceipt(previous.message, message)
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
          publish(readError ? '部分工具状态尚无法核实，保留原始结果。' : undefined);
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
    observedJobs,
  ]);
  const error = state.scope === scope ? state.error : undefined;
  const pendingMessageIds = useMemo(() => {
    if (state.scope === scope && state.error) return new Set<string>();
    return new Set(
      eligible
        .filter((message) => {
          if (cache.current.scope !== scope || cache.current.retryRevision !== retryRevision)
            return true;
          const previous = cache.current.read.get(message.id);
          return (
            !previous || previous.commandPending || !sameToolReceipt(previous.message, message)
          );
        })
        .map((message) => message.id),
    );
  }, [eligible, retryRevision, scope, state]);
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
          if (!original || !current || !sameToolReceipt(original, current)) return [];
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

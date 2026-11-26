import { type Interaction, readApprovalOptions } from '@kite-ai/client';
import {
  type InteractionAnswer,
  type InteractionSubmission,
  requiresInteractionAttachment,
} from '@kite-ai/ui';
import { Approval } from '@kite-ai/ui/desktop';
import { nativeFileEditBatchApproval } from './native-file-edit-batch-approval';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const ordinaryMcpTool = /^mcp\.[A-Za-z0-9_-]{1,128}\.[a-f0-9]{32}$/;

function plainApprovalText(value: unknown, limit: number) {
  if (typeof value !== 'string') return;
  const text = value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!text) return;
  const points = Array.from(text.slice(0, limit * 2 + 2));
  return points.length > limit ? `${points.slice(0, limit).join('')}…` : text;
}

// Read names only from the original host-authored approval policy (or its checked fallback).
function mcpApprovalSummary(policy: unknown): string | undefined {
  const pending = [policy];
  while (pending.length) {
    const entry = object(pending.pop());
    if (!entry) continue;
    if (Array.isArray(entry.policies)) pending.push(...entry.policies);
    if (entry.kind === 'approval_after_check_timeout') pending.push(entry.originalRequest);
    const names = object(entry.mcpApprovalNames);
    const server = plainApprovalText(names?.serverName, 200);
    const tool = plainApprovalText(names?.toolName, 200);
    if (server && tool) return `${server} · ${tool}`;
  }
  return undefined;
}
// These are the frozen host policy wrappers, not fields in the model's tool arguments.
function approvalPolicy(policy: unknown) {
  const pending = [policy];
  let scope: { outside: boolean; online: boolean } | undefined;
  let ambiguous = false;
  let nativeWindows = false;
  let external = false;
  let network = false;
  while (pending.length) {
    const entry = object(pending.pop());
    if (!entry) continue;
    if (Array.isArray(entry.policies)) pending.push(...entry.policies);
    if (entry.kind === 'approval_after_check_timeout') pending.push(entry.originalRequest);
    if (entry.windowsNativeUserProcess === true) nativeWindows = true;
    if (Array.isArray(entry.effects)) {
      if (entry.effects.includes('external')) external = true;
      if (entry.effects.includes('network')) network = true;
    }
    if (entry.executionScope === undefined) continue;
    const { filesystem, network: networkScope } = object(entry.executionScope) ?? {};
    if (
      (filesystem !== 'workspace_write' && filesystem !== 'full_access') ||
      (networkScope !== 'none' && networkScope !== 'internet')
    ) {
      ambiguous = true;
      continue;
    }
    const next = { outside: filesystem === 'full_access', online: networkScope === 'internet' };
    if (scope && (scope.outside !== next.outside || scope.online !== next.online)) ambiguous = true;
    scope = next;
  }
  return { scope, ambiguous, nativeWindows, external, network };
}

function shellOnceLabel(policy: ReturnType<typeof approvalPolicy>) {
  if (policy.nativeWindows) return '仅此次';
  if (policy.ambiguous) return '批准（范围未确认）';
  if (policy.scope?.outside && policy.scope.online) return '允许联网及工作区外写入';
  if (policy.scope?.outside) return '允许写入工作区外';
  if (policy.scope?.online) return '允许联网';
  return policy.scope ? '允许运行' : undefined;
}

function canonicalWebOrigin(value: unknown) {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && url.origin === value) return value;
  } catch {}
  return undefined;
}

/** Only change how recognized existing scope options are displayed, never what can be submitted. */
function scopePresentation(
  request: Record<string, unknown> | undefined,
  options: ReturnType<typeof readApprovalOptions>,
  {
    fileEdit,
    shell,
    webFetch,
    policy,
  }: {
    fileEdit: boolean;
    shell: boolean;
    webFetch: boolean;
    policy: ReturnType<typeof approvalPolicy>;
  },
) {
  const descriptions = new Map<string, { label: string; description: string; title?: string }>();
  if (!Array.isArray(request?.options) || !options.some((option) => option.kind === 'scope'))
    return descriptions;
  for (const value of request.options) {
    const option = object(value);
    if (option?.kind !== 'scope' || typeof option.optionId !== 'string') continue;
    const scope = object(option.scope);
    if (
      fileEdit &&
      option.ruleId === 'builtin.files.location' &&
      option.contractId === 'builtin.files.exact-location' &&
      typeof scope?.path === 'string'
    ) {
      descriptions.set(option.optionId, {
        label: '允许后续编辑',
        description: '仅限当前会话、此文件位置，不包含其他文件。',
      });
    } else if (
      shell &&
      !policy.nativeWindows &&
      option.ruleId === 'builtin.shell.command' &&
      option.contractId === 'builtin.shell.exact-command' &&
      typeof scope?.commandDigest === 'string'
    ) {
      const networkOnly = !policy.ambiguous && policy.scope?.online && !policy.scope.outside;
      const extra =
        !policy.ambiguous && policy.scope?.outside && policy.scope.online
          ? '本选项包含联网和工作区外写入。'
          : '';
      descriptions.set(option.optionId, {
        label: networkOnly ? '允许此命令后续联网' : '允许后续运行此命令',
        description: `仅限当前会话中命令、执行环境及权限范围均相同的调用。${extra}`,
      });
    } else if (
      webFetch &&
      option.ruleId === 'builtin.web.origin' &&
      option.contractId === 'builtin.web.exact-origin'
    ) {
      const origin = canonicalWebOrigin(scope?.origin);
      if (origin)
        descriptions.set(option.optionId, {
          label: '允许后续访问此站点',
          description: `仅限当前会话访问 ${origin}。`,
          title: origin,
        });
    }
  }
  return descriptions;
}

/** Original form; the enclosing InteractionCard owns attachment proof and answer authority. */
export function NativeApproval({
  interaction,
  disabled,
  onAnswer,
  completeContent,
  submission,
  attachment,
  embedded = false,
}: {
  embedded?: boolean;
  interaction: Interaction;
  disabled: boolean;
  onAnswer?: (interaction: Interaction, answer: InteractionAnswer) => void | Promise<void>;
  completeContent?: string;
  submission?: InteractionSubmission;
  attachment?: { phase: 'idle' | 'loading' | 'failed' | 'loaded'; retry?: () => void };
}) {
  let request = object(interaction.request);
  if (requiresInteractionAttachment(interaction)) {
    request = undefined;
    if (completeContent !== undefined) {
      try {
        request = object(JSON.parse(completeContent));
      } catch {}
    }
  }
  const exact =
    request?.definitionId === interaction.definitionId &&
    request?.definitionVersion === interaction.definitionVersion;
  const input = object(request?.input),
    policy = object(request?.policy);
  const hasFileEditBatch = request !== undefined && Object.hasOwn(request, 'fileEditBatch');
  const batch =
    hasFileEditBatch &&
    exact &&
    interaction.definitionId === 'files.edit' &&
    interaction.definitionVersion === '2'
      ? nativeFileEditBatchApproval(request?.fileEditBatch, input)
      : undefined;
  const options =
    exact && (!hasFileEditBatch || batch !== undefined)
      ? readApprovalOptions(request).filter((option) => !batch || option.kind === 'once')
      : [];
  const shell = ['shell.execute', 'shell.launch', 'shell.command'].includes(
    interaction.definitionId,
  );
  const command =
    exact && shell && interaction.definitionVersion === '1' && typeof input?.command === 'string'
      ? input.command
      : undefined;
  const verifiedPolicy = approvalPolicy(exact ? policy : undefined);
  const tool = `${interaction.definitionId}@${interaction.definitionVersion}`;
  const fileEdit =
    exact &&
    typeof input?.path === 'string' &&
    (tool === 'files.write@3' || tool === 'files.edit@2');
  const fileRead = exact && typeof input?.path === 'string' && tool === 'files.read@5';
  const webFetch = exact && tool === 'web_fetch@1' && verifiedPolicy.network;
  const webTarget = webFetch
    ? typeof input?.url === 'string'
      ? input.url
      : Array.isArray(input?.urls) &&
          input.urls.length > 0 &&
          input.urls.length <= 5 &&
          input.urls.every((url) => typeof url === 'string')
        ? input.urls.join(' · ')
        : undefined
    : undefined;
  const search = interaction.definitionId === 'web.search';
  const worktree = interaction.definitionId === 'git.worktree';
  const worktreeAction = exact && tool === 'git.worktree@1' ? input?.action : undefined;
  const worktreeCopy =
    worktreeAction === 'create'
      ? { label: '创建 Git 工作树', once: '允许创建' }
      : worktreeAction === 'remove'
        ? { label: '移除 Git 工作树', once: '允许移除' }
        : undefined;
  const worktreeTarget = worktreeCopy
    ? typeof input?.path === 'string' && input.path.trim()
      ? input.path
      : worktreeAction === 'create' && input && !Object.hasOwn(input, 'path')
        ? '默认位置'
        : '目标路径尚未核实'
    : undefined;
  const ordinaryMcp = ordinaryMcpTool.test(interaction.definitionId);
  const mcp =
    interaction.definitionId.startsWith('mcp.') ||
    interaction.definitionId.startsWith('builtin.mcp/');
  const searchQuery =
    exact && tool === 'web.search@1' && input && Object.keys(input).length === 1
      ? plainApprovalText(input.query, 1024)
      : undefined;
  const mcpSummary = exact && ordinaryMcp ? mcpApprovalSummary(policy) : undefined;
  const unavailableSummary =
    attachment?.phase === 'failed'
      ? '完整审批内容核对失败'
      : attachment?.phase === 'loading'
        ? '正在核对完整审批内容…'
        : '完整审批内容尚不可用';
  const onceLabel =
    worktreeCopy?.once ??
    (command !== undefined
      ? shellOnceLabel(verifiedPolicy)
      : webFetch
        ? '允许联网'
        : searchQuery
          ? '允许搜索'
          : mcpSummary
            ? '允许调用'
            : batch || (verifiedPolicy.external && fileEdit)
              ? '允许编辑'
              : verifiedPolicy.external && fileRead
                ? '允许读取'
                : undefined);
  const summary = search
    ? (searchQuery ?? (exact ? '未能核对搜索内容' : unavailableSummary))
    : mcp
      ? (mcpSummary ?? (exact ? (ordinaryMcp ? '工具不可用' : '') : unavailableSummary))
      : worktree
        ? (worktreeTarget ?? (exact ? '未能核对工作树操作' : unavailableSummary))
        : (webTarget ??
          (request
            ? typeof input?.path === 'string'
              ? input.path
              : typeof policy?.reason === 'string'
                ? policy.reason
                : JSON.stringify(input ?? request)
            : unavailableSummary));
  const toolLabel = search
    ? '网页搜索'
    : mcp
      ? ordinaryMcp
        ? 'MCP 工具'
        : 'MCP 操作'
      : shell
        ? 'Shell'
        : worktree
          ? (worktreeCopy?.label ?? 'Git 工作树')
          : webFetch
            ? '读取网页'
            : verifiedPolicy.external && fileEdit
              ? '编辑文件'
              : verifiedPolicy.external && fileRead
                ? '读取文件'
                : interaction.definitionId;
  const tooltipText =
    search || mcp
      ? (searchQuery ?? mcpSummary)
      : worktree
        ? exact && request
          ? JSON.stringify(request, null, 2)
          : undefined
        : shell
          ? command
          : request
            ? JSON.stringify(request, null, 2)
            : summary;
  return (
    <article aria-label={`approval ${interaction.id}`}>
      {command !== undefined && verifiedPolicy.nativeWindows && (
        <p className="approval-native-scope">
          此命令将以当前 Windows 用户权限运行，可访问该用户的文件和网络，不限于工作区。
        </p>
      )}
      <Approval
        embedded={embedded}
        command={command}
        summary={batch ? undefined : summary}
        toolLabel={toolLabel}
        editRows={batch}
        tooltipText={batch ? undefined : tooltipText}
        attachment={attachment}
        status={
          submission
            ? submission.phase === 'unknown'
              ? '审批提交结果未知，请核对原提交。'
              : submission.phase === 'failed'
                ? '审批提交失败，请核对原提交。'
                : undefined
            : undefined
        }
        options={ordinaryMcp && !mcpSummary ? [] : options}
        onceLabel={onceLabel}
        scopePresentation={scopePresentation(request, options, {
          fileEdit,
          shell: command !== undefined,
          webFetch,
          policy: verifiedPolicy,
        })}
        disabled={disabled || !onAnswer}
        onDecide={(decision) => {
          if (
            disabled ||
            !onAnswer ||
            (decision !== null &&
              ((ordinaryMcp && !mcpSummary) ||
                !options.some((option) => option.optionId === decision)))
          )
            return;
          void onAnswer(
            interaction,
            decision === null
              ? { kind: 'approval', decision: 'deny' }
              : { kind: 'approval', decision: 'approve', optionId: decision },
          );
        }}
      />
    </article>
  );
}

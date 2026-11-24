import { ClientError, type Interaction } from '@kite-ai/client';
import type { InputRequest } from './input';
import type { NativeSelection } from './native-bridge';
import type { NativeModelChoice } from './native-model-picker';

function pendingRootInteraction(card: Interaction, selection: NativeSelection) {
  return (
    card.state === 'pending' &&
    card.originStoreId === selection.storeId &&
    card.sessionId === selection.session.id &&
    card.presentationSessionId === selection.session.id
  );
}

export function isNativeAskUserQuestion(card: Interaction): boolean {
  return card.kind === 'question' && card.definitionId === 'ask_user';
}

export function nativeAskUserAwaitingAnswer(selection: NativeSelection | undefined): boolean {
  if (!selection) return false;
  return (
    selection.interactions.some(
      (card) => isNativeAskUserQuestion(card) && pendingRootInteraction(card, selection),
    ) || runningToolAwaitingAnswer(selection, 'ask_user')
  );
}

export function nativePlanReviewAwaitingAnswer(selection: NativeSelection | undefined): boolean {
  if (!selection) return false;
  return (
    selection.interactions.some(
      (card) => card.kind === 'plan_review' && pendingRootInteraction(card, selection),
    ) || runningToolAwaitingAnswer(selection, 'planning.review')
  );
}

function runningToolAwaitingAnswer(selection: NativeSelection, definitionId: string): boolean {
  const { session, storeId } = selection;

  // The pending page can omit a card while its original Run is still waiting.
  const waitingRun = selection.runs.find(
    (run) =>
      run.isActive &&
      run.status === 'waiting_interaction' &&
      run.originStoreId === storeId &&
      run.sessionId === session.id,
  );
  return (
    !!waitingRun &&
    selection.executions.some(
      (execution) =>
        execution.kind === 'tool' &&
        execution.definitionId === definitionId &&
        execution.originStoreId === storeId &&
        execution.sessionId === session.id &&
        execution.runId === waitingRun.id &&
        (execution.status === 'dispatching' || execution.status === 'running'),
    )
  );
}

export function nativeInputErrorText(phase: 'failed' | 'unknown', reason?: string): string {
  if (phase === 'unknown') return '发送结果尚未确认，稍后将自动核对原提交。';
  if (reason === 'shell_asset_unavailable' || reason === 'native_asset_unavailable')
    return '本地执行环境尚未就绪，请恢复后重新发送。';
  if (reason === 'file_native_unavailable')
    return '本地文件处理组件不可用，消息未发送。请保留草稿和附件，待文件处理恢复后重试。';
  if (reason === 'native_request_too_large') return '消息或附件过大，请减少内容后重新发送。';
  if (reason === 'input_image_invalid')
    return '无法读取某张图片，消息未发送。请移除损坏或格式不符的图片，再重新发送。';
  if (reason === 'git_workspace_dirty')
    return '项目里有未提交的改动，消息未发送。请先处理这些改动，再切换分支。';
  if (reason === 'git_active_work')
    return '当前项目还有任务在运行，消息未发送。请等待任务结束后再切换分支。';
  if (reason === 'draft_changed_before_send')
    return '草稿在发送前已更新，消息没有发送。请确认当前内容后重新发送。';
  if (
    reason &&
    [
      'draft_storage_unavailable',
      'draft_revision_conflict',
      'browser_draft_save_unconfirmed',
      'draft_not_loaded',
    ].includes(reason)
  )
    return '草稿尚未确认保存，消息没有发送。请保留当前内容，重新打开会话核对后重试。';
  return '发送失败，请检查模型和执行环境后重试。';
}

/** Freeze the click's observed Run and selection; subsequent refresh cannot retarget it. */
export function nativeTextIntent(
  selection: NativeSelection,
  commandId: string,
  content: string,
  plan = false,
  modelChoice?: NativeModelChoice,
): InputRequest {
  if (selection.permissionUnavailable || selection.viewLoading)
    throw new ClientError('session_view_unavailable');
  const base = {
    expectedStoreId: selection.storeId,
    commandId,
    content,
    ...(plan
      ? {
          extensionInputs: [
            { extensionId: 'builtin.planning', definitionVersion: '1', input: { mode: 'plan' } },
          ],
        }
      : {}),
  };
  const next = {
    ...base,
    ...(modelChoice?.modelId ? { modelId: modelChoice.modelId } : {}),
    ...(modelChoice?.reasoningEffort ? { reasoningEffort: modelChoice.reasoningEffort } : {}),
  };
  const run = selection.runs.find((value) => value.isActive);
  if (!run) return { ...next, kind: 'run.start' };
  const command = selection.activeCommand;
  if (
    !command ||
    command.id !== run.originCommandId ||
    command.sessionId !== selection.session.id ||
    command.originStoreId !== selection.storeId
  )
    throw new ClientError('active_command_identity_unavailable');
  const contextSelectionId = selection.session.contextSelectionId;
  return { ...next, kind: 'input.follow_up', afterRunId: run.id, contextSelectionId };
}

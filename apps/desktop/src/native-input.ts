import { ClientError } from '@kite-ai/client';
import type { Message as DesktopMessage } from '@kite-ai/ui/desktop';
import type { InputRequest } from './input';
import type { NativeSelection } from './native-bridge';
import type { NativeModelChoice } from './native-model-picker';

/** A rejected original Command can fail before any Run exists. */
export function nativeInputFailureMessage(commandId: string, reason?: string): DesktopMessage {
  const environment = reason === 'shell_asset_unavailable' || reason === 'native_asset_unavailable';
  const summary = environment ? '本地执行环境尚未就绪，本轮未能启动' : '本轮未能启动';
  return {
    id: `native-input-failure:${commandId}`,
    role: 'system',
    systemKind: 'turn_failure',
    text: environment
      ? '原消息已保留。请在本地执行环境恢复后重新发送。'
      : '原消息已保留，请检查模型和执行环境后重新发送。',
    settled: true,
    status: 'failed',
    failure: { summary },
  };
}

/** Freeze the click's observed Run and selection; subsequent refresh cannot retarget it. */
export function nativeTextIntent(
  selection: NativeSelection,
  commandId: string,
  content: string,
  plan = false,
  modelChoice?: NativeModelChoice,
  forceFollowUp = false,
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
  return forceFollowUp ||
    plan ||
    ['context.compress', 'context.compression.reset'].includes(command.kind)
    ? { ...next, kind: 'input.follow_up', afterRunId: run.id, contextSelectionId }
    : { ...base, kind: 'input.steer', targetRunId: run.id, contextSelectionId };
}

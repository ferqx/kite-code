import { ClientError } from '@kite-ai/client';
import type { InputRequest } from './input';
import type { NativeSelection } from './native-bridge';
import type { NativeModelChoice } from './native-model-picker';

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
  return plan || ['context.compress', 'context.compression.reset'].includes(command.kind)
    ? { ...next, kind: 'input.follow_up', afterRunId: run.id, contextSelectionId }
    : { ...base, kind: 'input.steer', targetRunId: run.id, contextSelectionId };
}

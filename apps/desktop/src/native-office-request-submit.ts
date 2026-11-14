import type { OutputFileSummary } from '@kite-ai/client';
import { composeBrowserDraft } from './browser-annotation-content';
import type { NativeBridge, NativeSelection } from './native-bridge';
import { nativeTextIntent } from './native-input';
import type { NativeModelChoice } from './native-model-picker';
import type { OfficeEditContext, OfficeRequestOutcome } from './output-files-bridge';

/** One invocation owns one command; transport ambiguity must never trigger a retry. */
export async function submitOfficeRequest(options: {
  bridge: NativeBridge;
  generation: number;
  selection: NativeSelection;
  file: OutputFileSummary;
  context: OfficeEditContext;
  prompt: string;
  isCurrent: () => boolean;
  modelReady: boolean;
  modelChoice?: NativeModelChoice;
  plan?: boolean;
}): Promise<OfficeRequestOutcome> {
  const { bridge, generation, selection, file, isCurrent } = options;
  if (
    !options.prompt.trim() ||
    !isCurrent() ||
    file.storeId !== selection.storeId ||
    file.sessionId !== selection.session.id
  )
    return { status: 'failed', message: '会话已变化或请求为空，请重新选择。' };
  const id = crypto.randomUUID();
  const commandId = crypto.randomUUID();
  const target = {
    storeId: file.storeId,
    sessionId: file.sessionId,
    fileId: file.fileId,
    locator: file.locator,
  };
  const officeDocument = {
    content: options.prompt,
    outputFiles: [
      {
        id,
        name: file.name,
        ownerRunId: file.ownerRunId,
        target,
        context: options.context,
      },
    ],
  };
  let dispatched = false;
  let preparationAttempted = false;
  try {
    const intent = nativeTextIntent(
      selection,
      commandId,
      composeBrowserDraft(officeDocument),
      options.plan,
      options.modelChoice,
    );
    if (intent.kind !== 'input.steer' && !options.modelReady)
      throw Error('model_selection_unavailable');
    preparationAttempted = true;
    await bridge.request({
      method: 'input.files.fromOutput',
      generation,
      id,
      target,
      context: options.context,
    });
    if (!isCurrent()) throw Error('native_selection_changed');
    dispatched = true;
    const result = await bridge.request({
      method: 'submit',
      generation,
      sessionId: selection.session.id,
      intent,
      fileIds: [id],
      officeDocument,
    });
    const phase = result && 'phase' in result ? result.phase : 'unknown';
    if (['accepted', 'applied', 'terminal'].includes(phase)) return { status: 'accepted' };
    if (['failed', 'rejected'].includes(phase))
      return {
        status: 'failed',
        message: '请求未发送，请检查会话状态后重试。',
      };
    return {
      status: 'unknown',
      message: '发送结果待核实，请检查会话，勿重复发送。',
    };
  } catch {
    return dispatched
      ? {
          status: 'unknown',
          message: '发送结果待核实，请检查会话，勿重复发送。',
        }
      : {
          status: 'failed',
          message: '请求未发送，请检查模型、文件和会话状态后重试。',
        };
  } finally {
    // This id belongs only to the inline request. Imported files and caller journal
    // references are durable and are not removed by releasing local staging.
    if (preparationAttempted)
      await bridge.request({ method: 'input.files.release', generation, id }).catch(() => {});
  }
}

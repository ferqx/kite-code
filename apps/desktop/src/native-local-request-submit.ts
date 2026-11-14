import type { NativeBridge, NativeSelection } from './native-bridge';
import { nativeTextIntent } from './native-input';
import type { NativeModelChoice } from './native-model-picker';
import type { LocalOfficeRequest, OfficeRequestOutcome } from './output-files-bridge';

/** Main resolves the frozen request and original path; renderer cannot supply either. */
export async function submitLocalOfficeRequest(options: {
  bridge: NativeBridge;
  generation: number;
  selection: NativeSelection;
  request: LocalOfficeRequest;
  isCurrent: () => boolean;
  modelReady: boolean;
  modelChoice?: NativeModelChoice;
}): Promise<OfficeRequestOutcome> {
  let dispatched = false;
  try {
    if (!options.isCurrent()) throw Error('native_selection_changed');
    const intent = nativeTextIntent(
      options.selection,
      crypto.randomUUID(),
      'PDF 标注请求',
      false,
      options.modelChoice,
    );
    if (intent.kind !== 'input.steer' && !options.modelReady)
      throw Error('model_selection_unavailable');
    dispatched = true;
    const result = await options.bridge.request({
      method: 'localPreview.submit',
      generation: options.generation,
      sessionId: options.selection.session.id,
      intent,
      ...options.request,
    });
    const phase = result && 'phase' in result ? result.phase : 'unknown';
    if (['accepted', 'applied', 'terminal'].includes(phase)) return { status: 'accepted' };
    if (['failed', 'rejected'].includes(phase))
      return { status: 'failed', message: '请求失败，请检查会话状态。' };
    return { status: 'unknown', message: '发送结果待核实，请检查会话，勿重复发送。' };
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : error instanceof Error
          ? error.message
          : '';
    if (
      [
        'local_preview_changed',
        'local_preview_released',
        'local_preview_replaced',
        'local_preview_request_replaced',
      ].includes(code)
    )
      return {
        status: 'failed',
        message: '文件或预览已变化，请重新打开并选择后发送；本次未提交。',
      };
    return dispatched
      ? { status: 'unknown', message: '发送结果待核实，请检查会话，勿重复发送。' }
      : { status: 'failed', message: '请求未发送，请检查模型、文件和会话状态后重试。' };
  }
}

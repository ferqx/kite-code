/** Only persisted, closed reason codes determine this copy. Never display provider text,
 * archived paths, hashes, or a speculative HTTP/network cause in the transcript. */
export function nativeImageFailure(
  reason: string | null | undefined,
): { summary: string; text: string } | undefined {
  switch (reason) {
    case 'image_window_outcome_unknown':
    case 'image_observation_outcome_unknown':
    case 'image_delivery_outcome_unknown':
      return {
        summary: '图片处理结果未确认',
        text: '未能确认本次图片请求是否完整完成，已停止自动重发。请先核对本轮已保存的回复与工具结果；确认模型连接可用后，可发送继续请求并说明需要查看的图片。',
      };
    case 'image_member_provider_limit':
      return {
        summary: '单张图片仍超出模型服务限制',
        text: '分批后，模型服务仍拒绝包含单张图片的请求，本轮已停止。请改用可接收该请求的模型，或明确指定较小的图片副本后继续；原图不会被自动裁剪或压缩替换。',
      };
    case 'image_context_too_large':
      return {
        summary: '此前图片累计超限',
        text: '此前这轮因图片累计超限而停止，失败记录保持不变。可先发送文字继续请求，说明需要查看哪些图片，按需使用本会话已归档的图片，无需先缩图或重跑原工具；若归档副本不可用，仍需重新提供原图。继续请求仍受当前访问权限和模型服务限制。',
      };
    case 'image_window_member_too_large':
    case 'image_member_local_limit':
      return {
        summary: '图片超出本次可处理范围',
        text: '当前图片无法放入本次请求的图片预算，未自动缩小或丢弃。请指定较小的图片副本，或减少本次需要查看的图片后继续。',
      };
    case 'image_delivery_limit':
    case 'model_request_body_too_large':
      return {
        summary: '图片请求仍被模型服务拒绝',
        text: '模型服务拒绝了本次请求，已停止进一步自动重试。请减少本次请求的内容，或更换模型后继续；这不表示图片已成功交付。',
      };
    case 'image_source_missing':
      return {
        summary: '历史图片副本不可用',
        text: '本次所需的受管图片副本缺失，无法完成读取。请重新提供需要查看的原图并发送继续请求；未自动用其他图片替代。',
      };
    case 'image_source_unverified':
    case 'image_window_scope_invalid':
    case 'tool_images_invalid':
    case 'image_window_invalid_input':
      return {
        summary: '图片来源无法核验',
        text: '无法确认本次图片的来源、完整性或当前访问资格，已停止处理。请重新提供可访问的原图，或检查当前会话和权限后继续。',
      };
    case 'image_window_not_dispatched':
      return {
        summary: '图片请求未发送',
        text: '发送前的会话或访问条件已变化，本次图片请求未发送。请确认当前会话、输入和权限后，再决定是否继续。',
      };
    case 'image_observation_invalid':
    case 'image_observation_incomplete':
    case 'image_delivery_unconfirmed':
      return {
        summary: '图片处理未完成',
        text: '本次图片处理未取得可确认的完整结果，未将其记作处理成功。请核对已保存的结果后，明确需要继续查看的图片。',
      };
    case 'image_delivery_pending':
      return {
        summary: '图片尚未处理完成',
        text: '仍有图片未确认交付，暂不能压缩这部分上下文。请先继续原任务完成图片处理，再压缩上下文。',
      };
    default:
      return undefined;
  }
}

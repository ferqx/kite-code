// 统一的 token 计数工具，不依赖特定 provider 的 API 响应字段。
// Provider-agnostic token counting, independent of provider-specific API response fields.
import { countTokens as gptCountTokens } from 'gpt-tokenizer/encoding/cl100k_base';

/** 计算文本的 token 数量 / Count tokens in a text string */
export function countTokens(text: string): number {
  return gptCountTokens(text);
}

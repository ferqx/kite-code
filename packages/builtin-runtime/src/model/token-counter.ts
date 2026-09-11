// 统一的 token 计数工具，不依赖特定 provider 的 API 响应字段。
// Provider-agnostic token counting, independent of provider-specific API response fields.

/** 计算文本的 token 数量 / Count tokens in a text string */
export function countTokens(text: string): number {
  // Initialize the vocabulary only when execution first needs token accounting.
  // The literal require remains bundled in the standalone Service and uses its module cache.
  const tokenizer =
    require('gpt-tokenizer/encoding/cl100k_base') as typeof import('gpt-tokenizer/encoding/cl100k_base');
  return tokenizer.countTokens(text);
}

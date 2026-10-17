/** Both public entrypoints share one bundle graph; no SDK package fallback at runtime. */
export const aiBundledDependencies: readonly string[] = Object.freeze([
  'ai',
  '@ai-sdk/openai',
  '@ai-sdk/openai-compatible',
]);

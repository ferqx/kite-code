/** Pure JS packages in the main chunks or the separately built Workers.
 * Native modules, WASM and jsdom's runtime resources remain external.
 */
export const agentBundledDependencies: readonly string[] = Object.freeze([
  '@modelcontextprotocol/sdk',
  'ajv',
  'drizzle-orm',
  'gpt-tokenizer',
  'ignore',
  'yaml',
  '@mozilla/readability',
  'turndown',
]);

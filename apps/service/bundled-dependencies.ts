/** Protocol/server JS shares the Service's chunks; workspace owners remain external. */
export const serviceBundledDependencies: readonly string[] = Object.freeze([
  '@modelcontextprotocol/sdk',
  'hono',
  'zod',
]);

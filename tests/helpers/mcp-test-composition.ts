import type { McpConfigCatalog, McpConfigCommand, McpConfigRepository } from '#app/config';

/**
 * Explicit in-memory composition for Builtin MCP supervisor tests.
 *
 * Production supplies the application-owned repository. Tests must do the
 * same through a deterministic repository seam rather than relying on a
 * supervisor fallback or a filesystem-global configuration loader.
 */
export function createInMemoryMcpConfigRepositoryV1(
  source: McpConfigCatalog | ((workspace: string) => McpConfigCatalog),
): McpConfigRepository {
  let current: McpConfigCatalog | undefined;
  const listeners = new Set<() => void>();
  const resolveCatalog = (workspace: string): McpConfigCatalog =>
    typeof source === 'function' ? source(workspace) : source;

  return {
    load: async (workspace) => {
      current = resolveCatalog(workspace);
      return current;
    },
    mutate: async (_command: McpConfigCommand) => {
      if (!current) throw new Error('MCP test repository must be loaded before mutate.');
      return current;
    },
    watch: (_workspace, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const maxWorkspaceNameBytes = 4096;

export function isWorkspaceDisplayName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name === name.trim() &&
    !/[\r\n]/.test(name) &&
    new TextEncoder().encode(name).length <= maxWorkspaceNameBytes
  );
}

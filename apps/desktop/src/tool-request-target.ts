const versions: Readonly<Record<string, readonly string[]>> = {
  'files.read': ['2', '3', '4', '5'],
  'files.read_path': ['1', '2'],
  'files.write': ['2', '3'],
  'files.edit': ['2'],
  'files.write_path': ['1'],
  'files.edit_path': ['1'],
  'files.list': ['1'],
  'files.glob': ['2', '3'],
  'files.search': ['2', '3', '4', '5'],
  web_fetch: ['1'],
  'shell.execute': ['1'],
  'shell.launch': ['1'],
  'shell.read': ['1'],
  'shell.wait': ['1'],
  'shell.stop': ['1'],
  'mcp.tools.search': ['1'],
  'mcp.connect': ['1'],
  'mcp.catalogue.refresh': ['1'],
  'mcp.reconnection': ['1'],
  'mcp.resources.list': ['1'],
  'mcp.resources.read': ['1'],
  'mcp.prompts.list': ['1'],
  'mcp.prompts.get': ['1'],
  'planning.write': ['1'],
  'planning.review': ['1'],
  'planning.update': ['1'],
  activate_skill: ['1'],
  read_skill_reference: ['1'],
};

/** Keep request text bounded without splitting Unicode code points. */
function bounded(value: string): string {
  const points: string[] = [];
  for (const point of value) {
    if (points.length === 4096) return `${points.slice(0, 4095).join('')}…`;
    points.push(point);
  }
  return points.join('');
}

/** Display only: the caller must first verify the original Execution identity and input.
 * A target never grants file, resource, or execution authority. Shell input uses its own
 * verified bounded command reader; arbitrary extension arguments are never summarized.
 */
export function nativeToolRequestTarget(
  input: unknown,
  definitionId: string,
  definitionVersion: string,
): string | undefined {
  if (
    !Object.hasOwn(versions, definitionId) ||
    !versions[definitionId]?.includes(definitionVersion) ||
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  )
    return undefined;
  const request = input as Record<string, unknown>;
  const text = (key: string) => {
    const value = request[key];
    return typeof value === 'string' && value.trim() ? bounded(value) : undefined;
  };
  const join = (...parts: (string | undefined)[]) =>
    bounded(parts.filter((part): part is string => part !== undefined).join(' · ')) || undefined;
  switch (definitionId) {
    case 'files.read':
    case 'files.read_path':
    case 'files.write':
    case 'files.edit':
    case 'files.write_path':
    case 'files.edit_path':
      return text('path');
    case 'files.list':
      return request.path === undefined || request.path === '' ? '.' : text('path');
    case 'files.glob':
      return text('pattern') ? join(text('pattern'), text('path')) : undefined;
    case 'files.search':
      return text('text') ? join(text('text'), text('path')) : undefined;
    case 'web_fetch':
      // URL credentials/query removal remains the shared UI's responsibility.
      return text('url');
    case 'shell.execute':
    case 'shell.launch':
      return text('command');
    case 'shell.read':
    case 'shell.wait':
    case 'shell.stop':
      return text('shellId');
    case 'mcp.tools.search':
      return text('query');
    case 'mcp.connect':
    case 'mcp.catalogue.refresh':
    case 'mcp.reconnection':
    case 'mcp.resources.list':
    case 'mcp.prompts.list':
      return text('serverId');
    case 'mcp.resources.read':
      return join(text('serverId'), text('uri'));
    case 'mcp.prompts.get':
      return join(text('serverId'), text('name'));
    case 'planning.write':
      return text('title') ?? text('planId');
    case 'planning.review':
      return text('planId');
    case 'planning.update':
      return join(text('planId'), text('stepId'));
    case 'activate_skill':
      return text('skill_id');
    case 'read_skill_reference':
      return text('path');
    default:
      return undefined;
  }
}

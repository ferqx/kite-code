import type { ConsolidatedToolEntry } from '../types';

/** Build the compact statistics shown in an exploration Thought header. */
export function buildToolSummaryLine(tools: ConsolidatedToolEntry[]): string {
  let readFiles = 0;
  let searched = 0;
  let filePatterns = 0;
  let readMcp = 0;
  let ranCommands = 0;

  for (const tool of tools) {
    if (tool.name === 'read_file') readFiles += 1;
    else if (tool.name === 'search_content') searched += 1;
    else if (tool.name === 'search_files') filePatterns += 1;
    else if (tool.name === 'read_mcp_resource') readMcp += 1;
    else if (tool.name === 'shell_execute' || tool.name === 'bash') ranCommands += 1;
  }

  const parts: string[] = [];
  if (readFiles > 0) parts.push(`read ${readFiles} file${readFiles > 1 ? 's' : ''}`);
  if (searched > 0) parts.push(`searched for ${searched} pattern${searched > 1 ? 's' : ''}`);
  if (filePatterns > 0)
    parts.push(`searched ${filePatterns} file pattern${filePatterns > 1 ? 's' : ''}`);
  if (readMcp > 0) parts.push(`read ${readMcp} MCP resource${readMcp > 1 ? 's' : ''}`);
  if (ranCommands > 0) parts.push(`ran ${ranCommands} shell command${ranCommands > 1 ? 's' : ''}`);

  return parts.length > 0
    ? parts.join(', ')
    : `${tools.length} tool call${tools.length > 1 ? 's' : ''}`;
}

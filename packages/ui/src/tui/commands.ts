/** Explicit development command vocabulary: unknown slash text is never a Model task. */
export type TuiCommand =
  | {
      kind:
        | 'theme'
        | 'language'
        | 'effort'
        | 'model'
        | 'mcp'
        | 'help'
        | 'new'
        | 'resume'
        | 'recovery'
        | 'exit'
        | 'context'
        | 'management_requests'
        | 'rewind'
        | 'status'
        | 'skills'
        | 'permissions'
        | 'clear'
        | 'export';
    }
  | { kind: 'drafts' }
  | { kind: 'plan'; task?: string }
  | { kind: 'draft'; id: string }
  | { kind: 'compact'; focus?: string }
  | { kind: 'compact_reset' }
  | { kind: 'rename'; title: string }
  | { kind: 'delete' }
  | { kind: 'fork'; title: string }
  | { kind: 'background'; action?: 'stop' | 'output' | 'child'; id?: string };
export function parseTuiCommand(text: string): TuiCommand {
  const parts = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!parts) throw new Error('invalid_tui_command');
  const rawName = parts[1]!.toLowerCase(),
    name = rawName === 'bg' ? 'background' : rawName === 'c' ? 'clear' : rawName,
    tail = parts[2]?.trim() ?? '';
  if (name === 'context' && tail.toLowerCase() === 'requests')
    return { kind: 'management_requests' };
  const fixed: Record<string, TuiCommand['kind']> = {
    theme: 'theme',
    language: 'language',
    effort: 'effort',
    model: 'model',
    mcp: 'mcp',
    help: 'help',
    h: 'help',
    new: 'new',
    resume: 'resume',
    recovery: 'recovery',
    exit: 'exit',
    quit: 'exit',
    q: 'exit',
    context: 'context',
    rewind: 'rewind',
    status: 'status',
    skills: 'skills',
    permissions: 'permissions',
    clear: 'clear',
    export: 'export',
    drafts: 'drafts',
  };
  if (name in fixed) {
    if (tail) throw new Error('unexpected_command_arguments');
    return { kind: fixed[name]! } as TuiCommand;
  }
  if (name === 'background') {
    if (!tail) return { kind: 'background' };
    const choice = /^(stop|output|child) ([A-Za-z0-9_-]{1,128})$/.exec(tail);
    if (!choice) throw Error('background_requires_original_execution_id');
    return { kind: 'background', action: choice[1] as 'stop' | 'output' | 'child', id: choice[2]! };
  }
  if (name === 'plan') return { kind: 'plan', ...(tail ? { task: tail } : {}) };
  if (name === 'draft') {
    if (!/^[a-f0-9]{64}$/.test(tail)) throw new Error('invalid_tui_draft_id');
    return { kind: 'draft', id: tail };
  }
  if (name === 'compact')
    return tail === 'reset'
      ? { kind: 'compact_reset' }
      : { kind: 'compact', ...(tail ? { focus: tail } : {}) };
  if (name === 'session') {
    const choice = /^(rename|delete|fork)(?:\s+([\s\S]*))?$/i.exec(tail),
      operation = choice?.[1]?.toLowerCase(),
      value = choice?.[2]?.trim();
    if (operation === 'delete' && value === 'confirm') return { kind: 'delete' };
    if ((operation === 'rename' || operation === 'fork') && value)
      return { kind: operation, title: value };
    throw new Error('session_command_requires_explicit_choice');
  }
  throw new Error('tui_command_unavailable');
}

/** Reserved grammar always wins over a compiled Skill name, including aliases. */
export function isFixedTuiCommandName(name: string): boolean {
  return [
    'background',
    'bg',
    'plan',
    'theme',
    'language',
    'effort',
    'model',
    'mcp',
    'help',
    'h',
    'new',
    'resume',
    'recovery',
    'exit',
    'quit',
    'q',
    'context',
    'rewind',
    'status',
    'skills',
    'permissions',
    'clear',
    'c',
    'export',
    'drafts',
    'draft',
    'compact',
    'session',
  ].includes(name.toLowerCase());
}

/** Only implemented fixed commands; dynamic Skills and files use their own public directories. */
export const fixedTuiCommands = [
  '/effort',
  '/model',
  '/theme',
  '/language',
  '/resume',
  '/new',
  '/plan',
  '/compact',
  '/permissions',
  '/mcp',
  '/rewind',
  '/export',
  '/context',
  '/status',
  '/background',
  '/clear',
  '/help',
  '/exit',
] as const;
/** Additional new-architecture readers remain explicitly discoverable after the original menu. */
export const additionalTuiCommands = [
  '/recovery',
  '/context requests',
  '/skills',
  '/drafts',
] as const;

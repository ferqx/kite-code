/**
 * TUI's source-owned public command surface.
 *
 * This module intentionally remains data-only: it must not import runtime
 * configuration, release evaluation, or UI hooks. Consumers that need those
 * capabilities compose them around the parsed action instead.
 */
export interface SlashCommandDef {
  name: string;
  aliases: string[];
  description: string;
  args?: string;
}

export const SLASH_COMMAND_DEFS: SlashCommandDef[] = [
  { name: 'effort', aliases: [], description: '设置推理深度', args: 'low|medium|high|max' },
  { name: 'model', aliases: [], description: '打开模型选择器' },
  {
    name: 'theme',
    aliases: [],
    description: '切换色彩主题',
    args: 'teal|blue|purple|cyan|mono',
  },
  { name: 'sessions', aliases: [], description: '浏览会话历史' },
  { name: 'new', aliases: [], description: '新建会话' },
  { name: 'plan', aliases: [], description: '进入规划模式', args: '[任务]' },
  {
    name: 'compact',
    aliases: [],
    description: '压缩对话上下文',
    args: '[reset|自定义摘要指令]',
  },
  {
    name: 'permissions',
    aliases: [],
    description: '设置权限模式',
    args: 'accept_edits|auto|full',
  },
  { name: 'release', aliases: [], description: 'Show release profile and Gate status' },
  { name: 'telemetry', aliases: [], description: 'Show telemetry consent and export status' },
  {
    name: 'mcp',
    aliases: [],
    description: '管理 MCP Server',
  },
  { name: 'rewind', aliases: [], description: '回退检查点并恢复文件' },
  { name: 'export', aliases: [], description: '导出当前会话' },
  { name: 'context', aliases: [], description: '显示上下文用量' },
  { name: 'clear', aliases: ['c'], description: '清空输出' },
  { name: 'help', aliases: ['h'], description: '打开帮助面板' },
  { name: 'exit', aliases: ['quit', 'q'], description: '退出 Kite Code' },
];

export const SLASH_COMMANDS = SLASH_COMMAND_DEFS.map((command) => command.name);

export function findSlashCommandDefs(partial: string): SlashCommandDef[] {
  const normalized = partial.toLowerCase();
  return SLASH_COMMAND_DEFS.filter(
    (command) =>
      command.name.startsWith(normalized) ||
      command.aliases.some((alias) => alias.startsWith(normalized)),
  );
}

export type SlashAction =
  | { type: 'effort'; level: string }
  | { type: 'model' }
  | { type: 'theme'; preset?: string }
  | { type: 'sessions'; id?: string }
  | { type: 'plan'; task?: string }
  | { type: 'permissions'; mode?: string }
  | { type: 'release' }
  | { type: 'telemetry' }
  | { type: 'clear' }
  | { type: 'help' }
  | { type: 'new' }
  | { type: 'exit' }
  | { type: 'mcp' }
  | { type: 'rewind' }
  | { type: 'export' }
  | { type: 'context' }
  | { type: 'compact'; customInstructions?: string }
  | { type: 'compact_reset' }
  | { type: 'unknown'; raw: string };

export function parseSlashCommand(input: string): SlashAction | null {
  if (!input.startsWith('/')) return null;
  const trimmed = input.slice(1).trim();
  const [rawCommand, ...args] = trimmed.split(/\s+/);
  const normalizedCommand = rawCommand?.toLowerCase();
  const cmd =
    SLASH_COMMAND_DEFS.find(
      (definition) =>
        definition.name === normalizedCommand ||
        definition.aliases.includes(normalizedCommand ?? ''),
    )?.name ?? normalizedCommand;
  const arg = args.join(' ');

  switch (cmd) {
    case 'effort':
      return { type: 'effort', level: arg || 'max' };
    case 'model':
      return args.length === 0 ? { type: 'model' } : { type: 'unknown', raw: input };
    case 'theme':
      return { type: 'theme', preset: arg || undefined };
    case 'sessions':
      return { type: 'sessions' };
    case 'plan':
      return { type: 'plan', task: arg || undefined };
    case 'permissions':
      return { type: 'permissions', mode: arg || undefined };
    case 'release':
      return args.length === 0 ? { type: 'release' } : { type: 'unknown', raw: input };
    case 'telemetry':
      return args.length === 0 ? { type: 'telemetry' } : { type: 'unknown', raw: input };
    case 'clear':
      return { type: 'clear' };
    case 'help':
      return { type: 'help' };
    case 'new':
      return { type: 'new' };
    case 'mcp':
      return args.length === 0 ? { type: 'mcp' } : { type: 'unknown', raw: input };
    case 'rewind':
      return { type: 'rewind' };
    case 'export':
      return { type: 'export' };
    case 'context':
      return { type: 'context' };
    case 'compact':
      if (args[0] === 'reset' && args.length === 1) {
        return { type: 'compact_reset' };
      }
      return { type: 'compact', ...(arg ? { customInstructions: arg } : {}) };
    case 'exit':
      return { type: 'exit' };
    default:
      return { type: 'unknown', raw: input };
  }
}

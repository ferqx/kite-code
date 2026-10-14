import type { InkI18n } from './presentation';

/** UI-only metadata. Parser and host retain all command behavior and authorization. */
export interface TuiCommandDescription {
  command: string;
  aliases: readonly string[];
  description: string;
  args?: string;
}
const definitions: Readonly<
  Record<
    string,
    {
      key?: Parameters<InkI18n['t']>[0];
      aliases?: string[];
      args?: string;
      en?: string;
      zh?: string;
    }
  >
> = {
  effort: { key: 'command.effort' },
  model: { key: 'command.model' },
  theme: { key: 'command.theme' },
  language: { key: 'command.language' },
  resume: { key: 'command.resume' },
  new: { key: 'command.new' },
  plan: { key: 'command.plan', args: '[task]' },
  compact: { key: 'command.compact', args: '[reset|focus]' },
  permissions: { key: 'command.permissions' },
  mcp: { key: 'command.mcp' },
  rewind: { key: 'command.rewind' },
  export: { key: 'command.export' },
  context: { key: 'command.context' },
  status: { key: 'command.status' },
  background: { key: 'command.background', aliases: ['bg'], args: '[stop|output|child ID]' },
  clear: { key: 'command.clear', aliases: ['c'] },
  help: { key: 'command.help', aliases: ['h'] },
  exit: { key: 'command.exit', aliases: ['quit', 'q'] },
  recovery: { en: 'Resume saved execution recovery', zh: '恢复已保存的执行' },
  skills: { en: 'Browse available Skills', zh: '查看可用 Skills' },
  drafts: { en: 'Browse saved local drafts', zh: '查看本机保存的草稿' },
  draft: { en: 'Restore a saved draft', zh: '恢复保存的草稿', args: 'ID' },
  session: {
    en: 'Rename, fork or delete the current session',
    zh: '重命名、分支或删除当前会话',
    args: 'rename|fork TITLE / delete confirm',
  },
  'context requests': {
    en: 'Read original context and session requests',
    zh: '查看原上下文与会话申请',
  },
};
export function describeTuiCommand(value: string, i18n: InkI18n): TuiCommandDescription {
  const command = value.replace(/^\//, '');
  const def = definitions[command];
  return {
    command,
    aliases: def?.aliases ?? [],
    description: def?.key
      ? i18n.t(def.key)
      : i18n.language === 'zh-CN'
        ? (def?.zh ?? '')
        : (def?.en ?? ''),
    args:
      command === 'plan'
        ? i18n.t('slash.args.plan')
        : command === 'compact'
          ? i18n.t('slash.args.compact')
          : def?.args,
  };
}
export function slashGhostSuffix(
  value: string,
  candidates: readonly string[],
  selected: number,
): string {
  if (!/^\/[a-z0-9_-]+$/i.test(value) || !candidates.length) return '';
  const choice =
    candidates[((selected % candidates.length) + candidates.length) % candidates.length];
  return choice?.toLowerCase().startsWith(value.toLowerCase()) ? choice.slice(value.length) : '';
}

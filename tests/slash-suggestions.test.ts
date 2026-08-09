import { describe, expect, test } from 'bun:test';
import { findSlashCommandDefs, SLASH_COMMANDS } from '../src/app/tui/hooks/useSlashSuggestions';

describe('slash command suggestions', () => {
  test('suggests /mcp with its management hint', () => {
    expect(findSlashCommandDefs('mc')).toEqual([
      {
        name: 'mcp',
        aliases: [],
        description: '管理 MCP Server',
      },
    ]);
  });

  test('exposes every executable built-in command to completion', () => {
    expect(SLASH_COMMANDS).toEqual([
      'effort',
      'model',
      'theme',
      'sessions',
      'new',
      'plan',
      'compact',
      'permissions',
      'release',
      'telemetry',
      'mcp',
      'rewind',
      'export',
      'context',
      'clear',
      'help',
      'exit',
    ]);
  });

  test('presents permissions as a selector command without manual mode arguments', () => {
    expect(findSlashCommandDefs('permissions')[0]?.args).toBeUndefined();
  });

  test('exposes /model as a selector command without a model-name argument', () => {
    expect(findSlashCommandDefs('model')).toEqual([
      {
        name: 'model',
        aliases: [],
        description: '打开模型选择器',
      },
    ]);
  });
});

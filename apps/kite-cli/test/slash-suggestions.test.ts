import { describe, expect, test } from 'bun:test';
import { findSlashCommandDefs, SLASH_COMMANDS } from '../src/tui/hooks/useSlashSuggestions';

describe('slash command suggestions', () => {
  test('suggests /mcp with its management hint', () => {
    expect(findSlashCommandDefs('mc')).toEqual([
      { name: 'mcp', aliases: [], descriptionKey: 'command.mcp' },
    ]);
  });

  test('exposes every executable built-in command to completion', () => {
    expect(SLASH_COMMANDS).toEqual([
      'effort',
      'model',
      'theme',
      'language',
      'resume',
      'new',
      'plan',
      'compact',
      'permissions',
      'mcp',
      'rewind',
      'export',
      'context',
      'status',
      'clear',
      'help',
      'exit',
    ]);
  });

  test('removes the separate /web command', () => {
    expect(findSlashCommandDefs('web')).toEqual([]);
  });

  test('presents permissions as a selector command without manual mode arguments', () => {
    expect(findSlashCommandDefs('permissions')[0]?.argsKey).toBeUndefined();
  });

  test('exposes /model as a selector command without a model-name argument', () => {
    expect(findSlashCommandDefs('model')).toEqual([
      { name: 'model', aliases: [], descriptionKey: 'command.model' },
    ]);
  });
});

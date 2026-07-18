import { describe, expect, test } from 'bun:test';
import {
  buildModeSuggestionItems,
  findSlashCommandDefs,
  SLASH_COMMANDS,
} from '../src/app/tui/hooks/useSlashSuggestions';

describe('slash command suggestions', () => {
  test('suggests /mcp with its management hint', () => {
    expect(findSlashCommandDefs('mc')).toEqual([
      {
        name: 'mcp',
        aliases: [],
        description: 'Manage MCP servers',
      },
    ]);
  });

  test('makes /mcp available to tab completion and exact-command matching', () => {
    expect(SLASH_COMMANDS).toContain('mcp');
  });
});

describe('slash mode suggestions', () => {
  test('explains the local-only boundary of accept_edits', () => {
    const items = buildModeSuggestionItems('', 'auto', 'none');
    const acceptEdits = items.find((item) => item.command === 'accept_edits');

    expect(acceptEdits?.description).toBe(
      '本地工作区操作自动执行；出网、外部写入和未知副作用需确认',
    );
  });

  test('marks full as disabled when sandbox is unavailable', () => {
    const items = buildModeSuggestionItems('', 'accept_edits', 'none');
    const full = items.find((item) => item.command === 'full');

    expect(full).toBeDefined();
    expect(full?.disabled).toBe(true);
    expect(full?.description).toContain('未启用沙箱');
  });

  test('keeps full selectable when sandbox backend is available', () => {
    const items = buildModeSuggestionItems('', 'accept_edits', 'seatbelt');
    const full = items.find((item) => item.command === 'full');

    expect(full).toBeDefined();
    expect(full?.disabled).toBe(false);
  });
});

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

  test('shows the actual permissions values instead of the obsolete ask label', () => {
    expect(findSlashCommandDefs('permissions')[0]?.args).toBe('accept_edits|auto|full');
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

describe('slash mode suggestions', () => {
  test('explains the local-only boundary of accept_edits', () => {
    const items = buildModeSuggestionItems('', 'auto', 'none');
    const acceptEdits = items.find((item) => item.command === 'accept_edits');

    expect(acceptEdits?.description).toBe(
      '本地工作区操作自动执行；出网、外部写入和未知副作用需确认',
    );
  });

  test('disables full and attaches a sandbox warning when unavailable', () => {
    const items = buildModeSuggestionItems('', 'accept_edits', 'none');
    const full = items.find((item) => item.command === 'full');

    expect(full).toBeDefined();
    expect(full?.disabled).toBe(true);
    expect(full?.description).toBe('完全自主，全部放行，不询问用户');
    expect(full?.warning).toBe('当前未在沙箱环境开启');
  });

  test('marks full as disabled for the restricted-token backend', () => {
    const items = buildModeSuggestionItems('', 'accept_edits', 'windows_restricted_token');
    const unavailableItems = buildModeSuggestionItems('', 'accept_edits', 'none');
    const full = items.find((item) => item.command === 'full');
    const unavailableFull = unavailableItems.find((item) => item.command === 'full');

    expect(full).toBeDefined();
    expect(full?.disabled).toBe(true);
    expect(full?.description).toBe(unavailableFull?.description);
    expect(full?.warning).toBe(unavailableFull?.warning);
  });

  test('keeps full selectable when sandbox backend is available', () => {
    const items = buildModeSuggestionItems('', 'accept_edits', 'seatbelt');
    const full = items.find((item) => item.command === 'full');

    expect(full).toBeDefined();
    expect(full?.disabled).toBe(false);
    expect(full?.warning).toBeUndefined();
  });
});

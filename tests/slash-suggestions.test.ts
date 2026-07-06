import { describe, expect, test } from 'bun:test';
import { buildModeSuggestionItems } from '../src/app/tui/hooks/useSlashSuggestions';

describe('slash mode suggestions', () => {
  test('marks full as disabled when sandbox is unavailable', () => {
    const items = buildModeSuggestionItems('', 'ask', 'none');
    const full = items.find((item) => item.command === 'full');

    expect(full).toBeDefined();
    expect(full?.disabled).toBe(true);
    expect(full?.description).toContain('未启用沙箱');
  });

  test('keeps full selectable when sandbox backend is available', () => {
    const items = buildModeSuggestionItems('', 'ask', 'seatbelt');
    const full = items.find((item) => item.command === 'full');

    expect(full).toBeDefined();
    expect(full?.disabled).toBe(false);
  });
});

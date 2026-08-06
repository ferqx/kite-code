import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSlashCommand, SLASH_COMMAND_DEFS } from '../src/app/tui/public-surface';

describe('TUI public surface', () => {
  test('keeps command parsing co-located with the command declarations', () => {
    for (const command of SLASH_COMMAND_DEFS) {
      expect(parseSlashCommand(`/${command.name}`)?.type).not.toBe('unknown');
      for (const alias of command.aliases) {
        expect(parseSlashCommand(`/${alias}`)?.type).not.toBe('unknown');
      }
    }
  });

  test('is a data-only boundary without runtime configuration or release dependencies', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '../src/app/tui/public-surface.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/core\/config(?:\/index)?/);
    expect(source).not.toMatch(/release[-_/](?:gate|qualification)|gate evaluator/i);
  });
});

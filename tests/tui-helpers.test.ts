import { describe, expect, test } from 'bun:test';
import { parseInline } from '../src/app/tui/components/MarkdownBlock';
import { writeFileActionName } from '../src/app/tui/components/render-utils';
import { changePrefix, toolColor } from '../src/app/tui/OutputArea';
import { formatDuration } from '../src/app/tui/StatusBar';
import type { Theme } from '../src/app/tui/theme';
import { darkTheme } from '../src/app/tui/theme';

describe('darkTheme', () => {
  test('has all required color keys', () => {
    const keys: (keyof Omit<Theme, 'risk'>)[] = [
      'primary',
      'success',
      'error',
      'warning',
      'muted',
      'dim',
      'bg',
      'userMsgBg',
      'diffAddedBg',
      'diffAddedFg',
      'diffRemovedBg',
      'diffRemovedFg',
    ];
    for (const k of keys) {
      expect(darkTheme[k]).toBeString();
      expect(darkTheme[k].length).toBeGreaterThan(0);
    }
  });

  test('risk colors cover all risk levels with non‑empty values', () => {
    const expectedRisks = [
      'read',
      'plan',
      'write_file',
      'execute_code',
      'destructive',
      'network',
      'vcs_mutation',
      'unknown',
    ];
    for (const r of expectedRisks) {
      expect(darkTheme.risk[r]).toBeString();
      expect(darkTheme.risk[r]!.length).toBeGreaterThan(0);
    }
  });
});

// ── OutputArea changePrefix ──

describe('changePrefix', () => {
  test('add returns + with success color', () => {
    expect(changePrefix('add', darkTheme)).toEqual({ prefix: '+', color: darkTheme.success });
  });

  test('edit returns ~ with warning color', () => {
    expect(changePrefix('edit', darkTheme)).toEqual({ prefix: '~', color: darkTheme.warning });
  });

  test('delete returns - with error color', () => {
    expect(changePrefix('delete', darkTheme)).toEqual({ prefix: '-', color: darkTheme.error });
  });
});

// ── MarkdownBlock parseInline ──

describe('parseInline', () => {
  test('plain text returns single segment', () => {
    const result = parseInline('hello world');
    expect(result).toEqual([{ text: 'hello world' }]);
  });

  test('parses bold text with **', () => {
    const result = parseInline('this is **bold** text');
    expect(result).toEqual([{ text: 'this is ' }, { text: 'bold', bold: true }, { text: ' text' }]);
  });

  test('parses italic text with *', () => {
    const result = parseInline('this is *italic* text');
    expect(result).toEqual([
      { text: 'this is ' },
      { text: 'italic', italic: true },
      { text: ' text' },
    ]);
  });

  test('parses inline code with backticks', () => {
    const result = parseInline('use `const x = 1` here');
    expect(result).toEqual([
      { text: 'use ' },
      { text: 'const x = 1', code: true },
      { text: ' here' },
    ]);
  });

  test('parses mixed bold, italic, and code', () => {
    const result = parseInline('**bold** *italic* `code`');
    expect(result).toEqual([
      { text: 'bold', bold: true },
      { text: ' ' },
      { text: 'italic', italic: true },
      { text: ' ' },
      { text: 'code', code: true },
    ]);
  });

  test('parses adjacent inline elements', () => {
    const result = parseInline('**a***b*');
    expect(result).toEqual([
      { text: 'a', bold: true },
      { text: 'b', italic: true },
    ]);
  });

  test('handles text with no formatting', () => {
    const result = parseInline('no formatting at all');
    expect(result).toEqual([{ text: 'no formatting at all' }]);
  });

  test('handles empty string', () => {
    const result = parseInline('');
    expect(result).toEqual([]);
  });

  test('bold spans content containing backticks (backtick is not special inside **...** match)', () => {
    const result = parseInline('**bold `code` here**');
    expect(result).toEqual([{ text: 'bold `code` here', bold: true }]);
  });

  test('unclosed bold treated as literal', () => {
    const result = parseInline('this **is not closed');
    expect(result).toEqual([{ text: 'this **is not closed' }]);
  });

  test('unclosed italic treated as literal', () => {
    const result = parseInline('this *is not closed');
    expect(result).toEqual([{ text: 'this *is not closed' }]);
  });
});

// ── formatDuration ──

describe('formatDuration', () => {
  test('0 seconds -> 00:00', () => {
    expect(formatDuration(0)).toBe('00:00');
  });

  test('59 seconds -> 00:59', () => {
    expect(formatDuration(59)).toBe('00:59');
  });

  test('60 seconds -> 01:00', () => {
    expect(formatDuration(60)).toBe('01:00');
  });

  test('3661 seconds -> 61:01', () => {
    expect(formatDuration(3661)).toBe('61:01');
  });
});

// ── OutputArea toolColor ──

describe('toolColor', () => {
  const t = {
    success: darkTheme.success,
    error: darkTheme.error,
    warning: darkTheme.warning,
    primary: darkTheme.primary,
    muted: darkTheme.muted,
  };
  test('returns theme colors for each status', () => {
    expect(toolColor('done', t)).toBe(darkTheme.success);
    expect(toolColor('error', t)).toBe(darkTheme.error);
    expect(toolColor('running', t)).toBe(darkTheme.primary);
    expect(toolColor('pending', t)).toBe(darkTheme.muted);
    expect(toolColor('unknown', t)).toBe(darkTheme.muted);
  });
});

describe('writeFileActionName', () => {
  test('overwrite (diff stats summary) → Write', () => {
    expect(writeFileActionName('Added 1 line, removed 1 line\n 1 -a\n 1 +b', {})).toBe('Write');
  });

  test('create (Wrote header) → Create', () => {
    expect(writeFileActionName('Wrote 3 lines to fresh.md\n 1  a', {})).toBe('Create');
  });

  test('content-unchanged overwrite → Write', () => {
    expect(writeFileActionName('Wrote 2 lines to notes.md (content unchanged)\n 1  a', {})).toBe(
      'Write',
    );
  });

  test('no summary (running/queued caller) → neutral Write', () => {
    expect(writeFileActionName(undefined, {})).toBe('Write');
    expect(writeFileActionName('', {})).toBe('Write');
  });
});

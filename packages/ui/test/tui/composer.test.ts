import { expect, test } from 'bun:test';
import { additionalTuiCommands, fixedTuiCommands, parseTuiCommand } from '../../src/tui/commands';
import { ComposerBuffer, composerDisplay } from '../../src/tui/composer';
import { translateTuiLabel } from '../../src/tui/presentation';

test('grapheme insertion and directional deletion preserve CJK, emoji and combining boundaries', () => {
  const b = new ComposerBuffer();
  b.insert('中文🙂e\u0301尾');
  b.horizontal(-1);
  b.remove(true);
  expect(b.text).toBe('中文🙂尾');
  b.horizontal(-1);
  b.insert('中');
  expect(b.text).toBe('中文中🙂尾');
  b.remove(false);
  expect(b.text).toBe('中文中尾');
});
test('visual rows use cells, explicit newlines and multiline history only at boundaries', () => {
  const b = new ComposerBuffer();
  b.insert('中文abc\n🙂xy');
  expect(b.lines(5)).toEqual([
    { start: 0, end: 3, cells: 5 },
    { start: 3, end: 5, cells: 2 },
    { start: 6, end: 9, cells: 4 },
  ]);
  b.boundary(false, 5);
  expect(b.cursor).toBe(6);
  b.vertical(-1, 5);
  expect(b.cursor).toBe(3);
  b.remember();
  b.sync('draft');
  b.vertical(-1, 80);
  expect(b.text).toBe('中文abc\n🙂xy');
  b.vertical(1, 80);
  expect(b.text).toBe('draft');
});
test('atomic paste keeps exact UTF8 and deletes one whole block without placeholder submission', () => {
  const b = new ComposerBuffer();
  const original = '首🙂e\u0301\r\n' + '完整尾'.repeat(60);
  b.insert('before');
  b.insert(original, true);
  b.insert('after');
  b.horizontal(-1);
  b.horizontal(-1);
  b.horizontal(-1);
  b.horizontal(-1);
  b.horizontal(-1);
  expect(b.text).toBe('before' + original + 'after');
  expect(composerDisplay(b.parts[6]!)).toContain('Pasted');
  b.remove(true);
  expect(b.text).toBe('beforeafter');
});
test('fixed candidates are completions only, dismissal survives navigation and editing reopens', () => {
  const b = new ComposerBuffer();
  b.sync('/');
  expect(b.candidates).toEqual([...fixedTuiCommands]);
  b.sync('/rec');
  // The ordinary TuiSession supplies additional formal readers only after
  // a nonempty prefix; the original root menu remains exactly 18 commands.
  b.commands = [...fixedTuiCommands, ...additionalTuiCommands];
  expect(b.candidates).toEqual(['/recovery']);
  expect(b.complete()).toBe(true);
  expect(b.text).toBe('/recovery');
  expect(b.candidates).toEqual([]);
  b.sync('/');
  b.dismissed = true;
  b.horizontal(-1);
  expect(b.candidates).toEqual([]);
  b.insert('m');
  expect(b.candidates).toEqual([]);
  b.sync('/mo');
  expect(b.candidates).toEqual(['/model']);
  b.sync('/plan');
  expect(b.candidates).toEqual(['/plan']);
  b.complete();
  expect(b.text).toBe('/plan');
  expect(b.candidates).toEqual([]);
});
test('external scope draft replacement does not preserve obsolete paste or cursor identity', () => {
  const a = new ComposerBuffer(),
    b = new ComposerBuffer();
  a.insert('A\noriginal', true);
  b.sync('B');
  b.insert('🙂');
  expect(a.text).toBe('A\noriginal');
  expect(b.text).toBe('B🙂');
  a.sync('new disk revision');
  expect(a.parts.every((p) => !p.pasted)).toBe(true);
  expect(a.cursor).toBe(a.parts.length);
});

test('End stays on the same full visual row and Home returns to that row start', () => {
  const b = new ComposerBuffer();
  b.sync('中文abc');
  b.boundary(false, 5);
  expect(b.cursor).toBe(3);
  b.vertical(-1, 5);
  b.boundary(true, 5);
  expect(b.cursor).toBe(3);
  expect(b.row(5).index).toBe(0);
  b.boundary(false, 5);
  expect(b.cursor).toBe(0);
});

test('separate keyboard events join combining marks and ZWJ emoji into one cursor boundary without changing raw bytes', () => {
  const b = new ComposerBuffer();
  b.insert('e');
  b.insert('\u0301');
  expect(b.text).toBe('e\u0301');
  expect(b.parts).toHaveLength(1);
  b.remove(true);
  expect(b.text).toBe('');
  b.insert('👩');
  b.insert('\u200d');
  b.insert('💻');
  expect(b.parts).toHaveLength(1);
  expect(b.text).toBe('👩\u200d💻');
  b.remove(true);
  expect(b.text).toBe('');
});

test('localized atomic paste uses its displayed cell width for wrapping, Home/End and vertical movement', () => {
  const b = new ComposerBuffer();
  b.sync('abcdefghij');
  b.insert('12\n🙂', true);
  b.insert('xy');
  const display = (part: ComposerBuffer['parts'][number]) =>
    composerDisplay(part, (label) => translateTuiLabel(label, 'zh-CN'));
  expect(display(b.parts[10]!)).toBe('[已粘贴 4 个字符]');
  expect(composerDisplay(b.parts[10]!)).toBe('[Pasted 4 characters]');
  expect(b.lines(28, display)).toEqual([
    { start: 0, end: 12, cells: 28 },
    { start: 12, end: 13, cells: 1 },
  ]);
  b.boundary(false, 28, display);
  expect(b.cursor).toBe(12);
  b.vertical(-1, 28, display);
  expect(b.cursor).toBe(0);
  b.boundary(true, 28, display);
  expect(b.cursor).toBe(12);
  expect(b.row(28, display).index).toBe(0);
  b.horizontal(1);
  expect(b.row(28, display).index).toBe(1);
  expect(b.text).toBe('abcdefghij12\n🙂xy');
});

test('original 500-entry history retains the oldest allowed task and restores unsubmitted scratch', () => {
  const buffer = new ComposerBuffer();
  for (let index = 0; index < 501; index++) {
    buffer.sync(`task ${index}`);
    buffer.remember();
  }
  buffer.sync('unfinished');
  for (let index = 0; index < 501; index++) buffer.vertical(-1, 80);
  expect(buffer.text).toBe('task 1');
  for (let index = 0; index < 500; index++) buffer.vertical(1, 80);
  expect(buffer.text).toBe('unfinished');
});

test('Tab completion first extends the actual shared prefix and then selects the highlighted candidate', () => {
  const buffer = new ComposerBuffer();
  buffer.sync('/r');
  expect(buffer.complete()).toBe(true);
  expect(buffer.text).toBe('/re');
  expect(buffer.candidates).toEqual(['/resume', '/rewind']);
  buffer.candidate = 1;
  expect(buffer.complete()).toBe(true);
  expect(buffer.text).toBe('/rewind');
  expect(buffer.candidates).toEqual([]);
});

test('original argument-ignoring menus preserve aliases while selectors and new management commands stay strict', () => {
  for (const command of [
    'resume',
    'clear',
    'help',
    'new',
    'rewind',
    'export',
    'context',
    'exit',
  ] as const)
    expect(parseTuiCommand(`/${command} unused`)).toEqual({ kind: command });
  expect(parseTuiCommand('/q ignored')).toEqual({ kind: 'exit' });
  expect(parseTuiCommand('/c ignored')).toEqual({ kind: 'clear' });
  for (const command of [
    'model',
    'theme',
    'language',
    'effort',
    'mcp',
    'permissions',
    'status',
    'recovery',
    'skills',
    'drafts',
  ])
    expect(() => parseTuiCommand(`/${command} unused`)).toThrow('unexpected_command_arguments');
  expect(parseTuiCommand('/context requests')).toEqual({ kind: 'management_requests' });
  expect(() => parseTuiCommand('/context requests extra')).toThrow('unexpected_command_arguments');
  expect(() => parseTuiCommand('/session delete ignored')).toThrow();
});

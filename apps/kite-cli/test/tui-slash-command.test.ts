import { describe, expect, test } from 'bun:test';
import { parseSlashCommand } from '../src/tui/hooks/useSlashCommand';

describe('parseSlashCommand', () => {
  test('returns null for non-slash input', () => {
    expect(parseSlashCommand('hello')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
    expect(parseSlashCommand('  /help')).toBeNull(); // leading space
  });

  // ── /effort ──
  test('parses /effort', () => {
    expect(parseSlashCommand('/effort')).toEqual({ type: 'effort' });
  });

  test('rejects /effort arguments', () => {
    for (const input of ['/effort low', '/effort medium', '/effort high', '/effort max']) {
      expect(parseSlashCommand(input)).toEqual({ type: 'effort_invalid_args' });
    }
  });

  test('parses /theme and rejects its preset arguments', () => {
    expect(parseSlashCommand('/theme')).toEqual({ type: 'theme' });
    for (const input of ['/theme teal', '/theme blue', '/theme purple']) {
      expect(parseSlashCommand(input)).toEqual({ type: 'theme_invalid_args' });
    }
  });

  test('parses /language and rejects its arguments', () => {
    expect(parseSlashCommand('/language')).toEqual({ type: 'language' });
    expect(parseSlashCommand('/language zh-CN')).toEqual({
      type: 'unknown',
      raw: '/language zh-CN',
    });
  });

  // ── /model ──
  test('parses /model without args', () => {
    expect(parseSlashCommand('/model')).toEqual({ type: 'model' });
  });

  test('accepts only argument-free /model', () => {
    for (const input of ['/model deepseek-v4', '/model claude sonnet 4']) {
      expect(parseSlashCommand(input)).toEqual({ type: 'unknown', raw: input });
    }
  });

  // ── /resume ──
  test('parses /resume', () => {
    expect(parseSlashCommand('/resume')).toEqual({ type: 'sessions' });
  });

  test('/resume ignores extra args and /sessions is no longer accepted', () => {
    expect(parseSlashCommand('/resume run-abc123')).toEqual({ type: 'sessions' });
    expect(parseSlashCommand('/sessions')).toEqual({ type: 'unknown', raw: '/sessions' });
  });

  // ── /plan ──
  test('parses /plan', () => {
    expect(parseSlashCommand('/plan')).toEqual({ type: 'plan' });
  });

  test('accepts only argument-free /mcp', () => {
    expect(parseSlashCommand('/mcp')).toEqual({ type: 'mcp' });
    for (const input of ['/mcp github', '/mcp add', '/mcp retry github', '/mcp reload']) {
      expect(parseSlashCommand(input)).toEqual({ type: 'unknown', raw: input });
    }
  });

  test('parses /compact with optional custom instructions', () => {
    expect(parseSlashCommand('/compact')).toEqual({ type: 'compact' });
    expect(parseSlashCommand('/compact focus on auth changes')).toEqual({
      type: 'compact',
      customInstructions: 'focus on auth changes',
    });
  });

  test('keeps /auto-compact presentation-only', () => {
    expect(parseSlashCommand('/auto-compact')).toEqual({
      type: 'unknown',
      raw: '/auto-compact',
    });
  });

  test('parses diagnostic and session utility commands exposed by completion', () => {
    expect(parseSlashCommand('/rewind')).toEqual({ type: 'rewind' });
    expect(parseSlashCommand('/export')).toEqual({ type: 'export' });
    expect(parseSlashCommand('/context')).toEqual({ type: 'context' });
    expect(parseSlashCommand('/status')).toEqual({ type: 'status' });
    expect(parseSlashCommand('/status extra')).toEqual({ type: 'unknown', raw: '/status extra' });
  });

  // ── /clear ──
  test('parses /clear', () => {
    expect(parseSlashCommand('/clear')).toEqual({ type: 'clear' });
  });

  test('parses shorthand /c', () => {
    expect(parseSlashCommand('/c')).toEqual({ type: 'clear' });
  });

  // ── /help ──
  test('parses /help', () => {
    expect(parseSlashCommand('/help')).toEqual({ type: 'help' });
  });

  test('does not retain /web after it is merged into /status', () => {
    expect(parseSlashCommand('/web')).toEqual({ type: 'unknown', raw: '/web' });
    expect(parseSlashCommand('/web start')).toEqual({ type: 'unknown', raw: '/web start' });
  });

  test('parses command names case-insensitively like the suggestion matcher', () => {
    expect(parseSlashCommand('/HELP')).toEqual({ type: 'help' });
  });

  test('parses shorthand /h', () => {
    expect(parseSlashCommand('/h')).toEqual({ type: 'help' });
  });

  // ── /exit ──
  test('parses /exit', () => {
    expect(parseSlashCommand('/exit')).toEqual({ type: 'exit' });
  });

  test('parses alias /quit', () => {
    expect(parseSlashCommand('/quit')).toEqual({ type: 'exit' });
  });

  test('parses alias /q', () => {
    expect(parseSlashCommand('/q')).toEqual({ type: 'exit' });
  });

  // ── unknown commands ──
  test('returns unknown for unrecognized commands', () => {
    expect(parseSlashCommand('/foobar')).toEqual({ type: 'unknown', raw: '/foobar' });
  });

  test('unknown preserves the full raw input', () => {
    expect(parseSlashCommand('/nonexistent arg1 arg2')).toEqual({
      type: 'unknown',
      raw: '/nonexistent arg1 arg2',
    });
  });

  // ── edge cases ──
  test('handles extra whitespace between / and command', () => {
    // parser trims after /, so /   effort is treated as /effort
    expect(parseSlashCommand('/   effort')).toEqual({ type: 'effort' });
  });

  test('handles trailing whitespace', () => {
    expect(parseSlashCommand('/effort max   ')).toEqual({ type: 'effort_invalid_args' });
  });

  test("handles no input after slash (just '/')", () => {
    expect(parseSlashCommand('/')).toEqual({ type: 'unknown', raw: '/' });
  });

  test('handles empty string', () => {
    expect(parseSlashCommand('')).toBeNull();
  });

  // ── /permissions ──

  test('rejects /permissions auto arguments', () => {
    expect(parseSlashCommand('/permissions auto')).toEqual({ type: 'permissions_invalid_args' });
  });

  test('rejects /permissions full arguments', () => {
    expect(parseSlashCommand('/permissions full')).toEqual({ type: 'permissions_invalid_args' });
  });

  test('rejects /permissions accept_edits arguments', () => {
    expect(parseSlashCommand('/permissions accept_edits')).toEqual({
      type: 'permissions_invalid_args',
    });
  });

  test('parses /permissions with no arg', () => {
    expect(parseSlashCommand('/permissions')).toEqual({ type: 'permissions' });
  });

  test('rejects /permissions short form a', () => {
    expect(parseSlashCommand('/permissions a')).toEqual({ type: 'permissions_invalid_args' });
  });

  test('rejects /permissions short form f', () => {
    expect(parseSlashCommand('/permissions f')).toEqual({ type: 'permissions_invalid_args' });
  });

  test('rejects /permissions short form au', () => {
    expect(parseSlashCommand('/permissions au')).toEqual({ type: 'permissions_invalid_args' });
  });
});

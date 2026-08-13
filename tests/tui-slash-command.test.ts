import { describe, expect, test } from 'bun:test';
import { parseSlashCommand } from '../src/app/tui/hooks/useSlashCommand';

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

  // ── /model ──
  test('parses /model without args', () => {
    expect(parseSlashCommand('/model')).toEqual({ type: 'model' });
  });

  test('accepts only argument-free /model', () => {
    for (const input of ['/model deepseek-v4', '/model claude sonnet 4']) {
      expect(parseSlashCommand(input)).toEqual({ type: 'unknown', raw: input });
    }
  });

  // ── /sessions ──
  test('parses /sessions', () => {
    expect(parseSlashCommand('/sessions')).toEqual({ type: 'sessions' });
  });

  test('/sessions ignores extra args', () => {
    expect(parseSlashCommand('/sessions run-abc123')).toEqual({ type: 'sessions' });
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

  test('accepts only argument-free /telemetry', () => {
    expect(parseSlashCommand('/telemetry')).toEqual({ type: 'telemetry' });
    expect(parseSlashCommand('/telemetry enable')).toEqual({
      type: 'unknown',
      raw: '/telemetry enable',
    });
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

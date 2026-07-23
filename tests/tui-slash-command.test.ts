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
    expect(parseSlashCommand('/effort')).toEqual({ type: 'effort', level: 'max' });
  });

  test('parses /effort with level', () => {
    expect(parseSlashCommand('/effort low')).toEqual({ type: 'effort', level: 'low' });
  });

  test('parses /effort with medium level', () => {
    expect(parseSlashCommand('/effort medium')).toEqual({ type: 'effort', level: 'medium' });
  });

  test('parses /effort with high level', () => {
    expect(parseSlashCommand('/effort high')).toEqual({ type: 'effort', level: 'high' });
  });

  test('parses /effort with max level', () => {
    expect(parseSlashCommand('/effort max')).toEqual({ type: 'effort', level: 'max' });
  });

  // ── /model ──
  test('parses /model without args', () => {
    expect(parseSlashCommand('/model')).toEqual({ type: 'model', name: undefined });
  });

  test('parses /model with name', () => {
    expect(parseSlashCommand('/model deepseek-v4')).toEqual({ type: 'model', name: 'deepseek-v4' });
  });

  test('parses /model with multi-word name', () => {
    expect(parseSlashCommand('/model claude sonnet 4')).toEqual({
      type: 'model',
      name: 'claude sonnet 4',
    });
  });

  test('parses /model name', () => {
    expect(parseSlashCommand('/model deepseek-v4')).toEqual({ type: 'model', name: 'deepseek-v4' });
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

  test('parses /compact with optional custom instructions', () => {
    expect(parseSlashCommand('/compact')).toEqual({ type: 'compact' });
    expect(parseSlashCommand('/compact focus on auth changes')).toEqual({
      type: 'compact',
      customInstructions: 'focus on auth changes',
    });
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
    expect(parseSlashCommand('/   effort')).toEqual({ type: 'effort', level: 'max' });
  });

  test('handles trailing whitespace', () => {
    expect(parseSlashCommand('/effort max   ')).toEqual({ type: 'effort', level: 'max' });
  });

  test("handles no input after slash (just '/')", () => {
    expect(parseSlashCommand('/')).toEqual({ type: 'unknown', raw: '/' });
  });

  test('handles empty string', () => {
    expect(parseSlashCommand('')).toBeNull();
  });

  // ── /permissions ──

  test('parses /permissions auto', () => {
    expect(parseSlashCommand('/permissions auto')).toEqual({ type: 'permissions', mode: 'auto' });
  });

  test('parses /permissions full', () => {
    expect(parseSlashCommand('/permissions full')).toEqual({ type: 'permissions', mode: 'full' });
  });

  test('parses /permissions accept_edits', () => {
    expect(parseSlashCommand('/permissions accept_edits')).toEqual({
      type: 'permissions',
      mode: 'accept_edits',
    });
  });

  test('parses /permissions with no arg', () => {
    expect(parseSlashCommand('/permissions')).toEqual({ type: 'permissions', mode: undefined });
  });

  test('parses /permissions with short form a', () => {
    expect(parseSlashCommand('/permissions a')).toEqual({ type: 'permissions', mode: 'a' });
  });

  test('parses /permissions with short form f', () => {
    expect(parseSlashCommand('/permissions f')).toEqual({ type: 'permissions', mode: 'f' });
  });

  test('parses /permissions with short form au', () => {
    expect(parseSlashCommand('/permissions au')).toEqual({ type: 'permissions', mode: 'au' });
  });
});

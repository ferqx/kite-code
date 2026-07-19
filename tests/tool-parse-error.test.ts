import { describe, expect, test } from 'bun:test';
import { formatToolParseError, getToolSchemaHint } from '@/core/tools/tool-parse-error';

describe('getToolSchemaHint', () => {
  test('returns ask_user schema', () => {
    const hint = getToolSchemaHint('ask_user');
    expect(hint).toContain('question');
    expect(hint).toContain('options');
    expect(hint).toContain('recommended');
  });

  test('returns update_plan schema', () => {
    const hint = getToolSchemaHint('update_plan');
    expect(hint).toContain('plan_id');
    expect(hint).toContain('step_id');
    expect(hint).toContain('steps');
  });

  test('returns shell_execute schema', () => {
    const hint = getToolSchemaHint('shell_execute');
    expect(hint).toContain('ok');
    expect(hint).toContain('exitCode');
  });

  test('returns MCP tool hint', () => {
    const hint = getToolSchemaHint('mcp__server__tool');
    expect(hint).toContain('MCP tool');
    expect(hint).toContain('JSON schema');
  });

  test('returns fallback for unknown tool', () => {
    const hint = getToolSchemaHint('nonexistent_tool');
    expect(hint).toContain('Unknown tool');
    expect(hint).toContain('JSON object');
  });
});

describe('formatToolParseError', () => {
  test('includes tool name, raw args, parse error, and schema hint', () => {
    const result = formatToolParseError(
      'ask_user',
      '{question: 123 invalid}',
      "Expected property name or '}' at line 1",
    );
    expect(result).toContain('ask_user');
    expect(result).toContain('{question: 123 invalid}');
    expect(result).toContain('Expected property name');
    expect(result).toContain('question');
    expect(result).toContain('options');
  });

  test('truncates long raw args', () => {
    const longArgs = 'x'.repeat(2000);
    const result = formatToolParseError('shell_execute', longArgs, 'parse error');
    expect(result.length).toBeLessThan(2000);
    expect(result).toContain('...');
  });

  test('formats error for unknown tool', () => {
    const result = formatToolParseError('unknown', 'bad args', 'parse error');
    expect(result).toContain('unknown');
    expect(result).toContain('bad args');
    expect(result).toContain('parse error');
    expect(result).toContain('Unknown tool');
  });
});

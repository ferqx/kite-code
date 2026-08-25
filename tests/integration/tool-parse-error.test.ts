import { describe, expect, test } from 'bun:test';
import type { BuiltinModelToolCatalogEntry } from '@kite-ai/builtin-runtime';
import {
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
  formatBuiltinToolParseError,
  formatBuiltinToolSchemaHint,
} from '@kite-ai/builtin-runtime';
import { createRuntimeModuleRegistry } from '@kite-ai/runtime-spi';

function modelEntry(name: string): BuiltinModelToolCatalogEntry {
  const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
  const projection = createBuiltinToolCatalogProjection(registry, {
    turnContext: {
      toolSearchEnabled: true,
      hasTaskAdapter: true,
      hasGitBroker: true,
      brokeredGitFeatureRevision: 'brokered-git-r1',
      activeSkillFrameIds: ['skill-frame'],
      availableSkillIds: ['skill'],
      featureFlags: { brokeredGit: true, skillWorkflow: true, skillActivation: true },
    },
  });
  const entry = projection.entries.find(
    (candidate): candidate is BuiltinModelToolCatalogEntry =>
      candidate.visibility === 'model' && candidate.name === name,
  );
  if (!entry) throw new Error(`Builtin model catalog entry is missing: ${name}`);
  return entry;
}

describe('Builtin catalog schema hint', () => {
  test('returns ask_user schema', () => {
    const hint = formatBuiltinToolSchemaHint(modelEntry('ask_user'));
    expect(hint).toContain('question');
    expect(hint).toContain('options');
    expect(hint).toContain('recommended');
  });

  test('returns update_plan schema', () => {
    const hint = formatBuiltinToolSchemaHint(modelEntry('update_plan'));
    expect(hint).toContain('plan_id');
    expect(hint).toContain('updates');
    expect(hint).toContain('complete_plan');
  });

  test('returns shell_execute schema', () => {
    const hint = formatBuiltinToolSchemaHint(modelEntry('shell_execute'));
    expect(hint).toContain('command');
    expect(hint).toContain('timeout_ms');
    expect(hint).not.toContain('exitCode');
  });

  test('returns MCP tool hint', () => {
    const hint = formatBuiltinToolParseError({
      toolName: 'mcp__server__tool',
      rawArgs: '{}',
      parseError: 'invalid arguments',
    });
    expect(hint).toContain('MCP tool');
    expect(hint).toContain('JSON schema');
  });

  test('returns fallback for unknown tool', () => {
    const hint = formatBuiltinToolParseError({
      toolName: 'nonexistent_tool',
      rawArgs: '{}',
      parseError: 'invalid arguments',
    });
    expect(hint).toContain('Unknown tool');
    expect(hint).toContain('JSON object');
  });
});

describe('Builtin catalog parse error formatter', () => {
  test('includes tool name, raw args, parse error, and schema hint', () => {
    const result = formatBuiltinToolParseError({
      toolName: 'ask_user',
      rawArgs: '{question: 123 invalid}',
      parseError: "Expected property name or '}' at line 1",
      entry: modelEntry('ask_user'),
    });
    expect(result).toContain('ask_user');
    expect(result).toContain('{question: 123 invalid}');
    expect(result).toContain('Expected property name');
    expect(result).toContain('question');
    expect(result).toContain('options');
  });

  test('truncates long raw args', () => {
    const longArgs = 'x'.repeat(2000);
    const result = formatBuiltinToolParseError({
      toolName: 'shell_execute',
      rawArgs: longArgs,
      parseError: 'parse error',
      entry: modelEntry('shell_execute'),
    });
    expect(result.length).toBeLessThan(2000);
    expect(result).toContain('...');
  });

  test('formats error for unknown tool', () => {
    const result = formatBuiltinToolParseError({
      toolName: 'unknown',
      rawArgs: 'bad args',
      parseError: 'parse error',
    });
    expect(result).toContain('unknown');
    expect(result).toContain('bad args');
    expect(result).toContain('parse error');
    expect(result).toContain('Unknown tool');
  });
});

import { describe, expect, test } from 'bun:test';
import type { BuiltinModelToolCatalogEntry } from '@kite/builtin-runtime';
import {
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
  formatBuiltinToolParseError,
  formatBuiltinToolSchemaHint,
} from '@kite/builtin-runtime';
import { createRuntimeModuleRegistry } from '@kite/runtime-spi';

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

describe('Builtin catalog schema-hint formatter', () => {
  test('uses the immutable catalog schema and Builtin contract for hints', () => {
    expect(formatBuiltinToolSchemaHint(modelEntry('ask_user'))).toContain('questions');
    expect(formatBuiltinToolSchemaHint(modelEntry('ask_user'))).toContain('recommended');
    expect(formatBuiltinToolSchemaHint(modelEntry('update_plan'))).toContain('plan_id');
    expect(formatBuiltinToolSchemaHint(modelEntry('update_plan'))).toContain('complete_plan');
    expect(formatBuiltinToolSchemaHint(modelEntry('shell_execute'))).toContain('timeout_ms');
    expect(formatBuiltinToolSchemaHint(modelEntry('shell_execute'))).not.toContain('exitCode');
  });

  test('formats Builtin, dynamic MCP, and unknown diagnostics without a second schema owner', () => {
    const builtin = formatBuiltinToolParseError({
      toolName: 'ask_user',
      rawArgs: '{question: 123 invalid}',
      parseError: "Expected property name or '}' at line 1",
      entry: modelEntry('ask_user'),
    });
    expect(builtin).toContain('ask_user');
    expect(builtin).toContain('questions');

    const mcp = formatBuiltinToolParseError({
      toolName: 'mcp__server__tool',
      rawArgs: '{}',
      parseError: 'invalid arguments',
    });
    expect(mcp).toContain('MCP tool');
    expect(mcp).toContain('JSON schema');

    const unknown = formatBuiltinToolParseError({
      toolName: 'nonexistent_tool',
      rawArgs: 'bad args',
      parseError: 'parse error',
    });
    expect(unknown).toContain('Unknown tool');
    expect(unknown).toContain('JSON object');
  });

  test('bounds raw provider arguments in the generic formatter', () => {
    const result = formatBuiltinToolParseError({
      toolName: 'shell_execute',
      rawArgs: 'x'.repeat(2000),
      parseError: 'parse error',
      entry: modelEntry('shell_execute'),
    });
    expect(result.length).toBeLessThan(2000);
    expect(result).toContain('...');
  });
});

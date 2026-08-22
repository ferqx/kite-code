import { describe, expect, test } from 'bun:test';
import type { BuiltinModelToolCatalogEntryV1 } from '@kite/builtin-runtime';
import {
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjectionV1,
  formatBuiltinToolParseErrorV1,
  formatBuiltinToolSchemaHintV1,
} from '@kite/builtin-runtime';
import { createRuntimeModuleRegistryV1 } from '@kite/runtime-spi';

function modelEntry(name: string): BuiltinModelToolCatalogEntryV1 {
  const registry = createRuntimeModuleRegistryV1(createBuiltinRuntimeModules());
  const projection = createBuiltinToolCatalogProjectionV1(registry, {
    turnContext: {
      toolSearchEnabled: true,
      hasTaskAdapter: true,
      hasGitBroker: true,
      brokeredGitFeatureRevision: 'brokered-git-r1',
      activeSkillFrameIds: ['skill-frame'],
      availableSkillIds: ['skill'],
      featureFlags: { brokeredGitV1: true, skillWorkflowV1: true, skillActivationV2: true },
    },
  });
  const entry = projection.entries.find(
    (candidate): candidate is BuiltinModelToolCatalogEntryV1 =>
      candidate.visibility === 'model' && candidate.name === name,
  );
  if (!entry) throw new Error(`Builtin model catalog entry is missing: ${name}`);
  return entry;
}

describe('Builtin catalog schema-hint formatter', () => {
  test('uses the immutable catalog schema and Builtin contract for hints', () => {
    expect(formatBuiltinToolSchemaHintV1(modelEntry('ask_user'))).toContain('questions');
    expect(formatBuiltinToolSchemaHintV1(modelEntry('ask_user'))).toContain('recommended');
    expect(formatBuiltinToolSchemaHintV1(modelEntry('update_plan'))).toContain('plan_id');
    expect(formatBuiltinToolSchemaHintV1(modelEntry('update_plan'))).toContain('complete_plan');
    expect(formatBuiltinToolSchemaHintV1(modelEntry('shell_execute'))).toContain('timeout_ms');
    expect(formatBuiltinToolSchemaHintV1(modelEntry('shell_execute'))).not.toContain('exitCode');
  });

  test('formats Builtin, dynamic MCP, and unknown diagnostics without a second schema owner', () => {
    const builtin = formatBuiltinToolParseErrorV1({
      toolName: 'ask_user',
      rawArgs: '{question: 123 invalid}',
      parseError: "Expected property name or '}' at line 1",
      entry: modelEntry('ask_user'),
    });
    expect(builtin).toContain('ask_user');
    expect(builtin).toContain('questions');

    const mcp = formatBuiltinToolParseErrorV1({
      toolName: 'mcp__server__tool',
      rawArgs: '{}',
      parseError: 'invalid arguments',
    });
    expect(mcp).toContain('MCP tool');
    expect(mcp).toContain('JSON schema');

    const unknown = formatBuiltinToolParseErrorV1({
      toolName: 'nonexistent_tool',
      rawArgs: 'bad args',
      parseError: 'parse error',
    });
    expect(unknown).toContain('Unknown tool');
    expect(unknown).toContain('JSON object');
  });

  test('bounds raw provider arguments in the generic formatter', () => {
    const result = formatBuiltinToolParseErrorV1({
      toolName: 'shell_execute',
      rawArgs: 'x'.repeat(2000),
      parseError: 'parse error',
      entry: modelEntry('shell_execute'),
    });
    expect(result.length).toBeLessThan(2000);
    expect(result).toContain('...');
  });
});

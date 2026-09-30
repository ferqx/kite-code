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
      activeSkillFrameIds: ['skill-frame'],
      availableSkillIds: ['skill'],
      featureFlags: { skillWorkflow: true, skillActivation: true },
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
  test('accepts tool_search queries and candidate counts beyond former fixed ceilings', () => {
    const toolSearch = modelEntry('tool_search');
    expect(toolSearch.parse({ query: 'q'.repeat(513), limit: 13 })).toMatchObject({
      success: true,
    });
  });

  test('accepts plans beyond former text and step count ceilings', () => {
    const steps = Array.from({ length: 14 }, (_, index) => ({
      id: `step_${index}`,
      title: `Step ${index} ${'x'.repeat(170)}`,
    }));
    expect(
      modelEntry('write_plan').parse({
        title: 'x'.repeat(130),
        body_markdown: 'x'.repeat(30_001),
        steps,
      }),
    ).toMatchObject({ success: true });
    expect(
      modelEntry('update_plan').parse({
        plan_id: 'plan_1',
        updates: steps.map((step) => ({ step_id: step.id, status: 'completed' })),
      }),
    ).toMatchObject({ success: true });
  });

  test('uses the immutable catalog schema and Builtin contract for hints', () => {
    expect(formatBuiltinToolSchemaHint(modelEntry('ask_user'))).toContain('questions');
    expect(formatBuiltinToolSchemaHint(modelEntry('ask_user'))).toContain('recommended');
    expect(formatBuiltinToolSchemaHint(modelEntry('update_plan'))).toContain('plan_id');
    expect(formatBuiltinToolSchemaHint(modelEntry('update_plan'))).toContain('complete_plan');
    expect(formatBuiltinToolSchemaHint(modelEntry('shell_execute'))).toContain('timeout_ms');
    expect(formatBuiltinToolSchemaHint(modelEntry('shell_execute'))).toContain('yield_ms');
    expect(formatBuiltinToolSchemaHint(modelEntry('shell_execute'))).toContain(
      'result_disposition',
    );
    const taskHint = formatBuiltinToolSchemaHint(modelEntry('task'));
    expect(taskHint).toContain('background');
    expect(taskHint).toContain('stable task identity');
    expect(taskHint).toContain('result_disposition');
    expect(taskHint).toContain('defaults to required');
    const taskReadHint = formatBuiltinToolSchemaHint(modelEntry('task_read'));
    expect(taskReadHint).toContain('on-demand snapshot');
    expect(taskReadHint).toContain('not a waiting primitive');
    const taskWaitHint = formatBuiltinToolSchemaHint(modelEntry('task_wait'));
    expect(taskWaitHint).toContain('task_ids');
    expect(taskWaitHint).toContain('defaults to 30000');
    const taskWait = modelEntry('task_wait');
    expect(taskWait.parse({ task_ids: ['child-1'], timeout_ms: 0 })).toMatchObject({
      success: true,
    });
    expect(taskWait.parse({ task_ids: ['child-1', 'child-1'] })).toMatchObject({
      success: false,
    });
    expect(
      taskWait.parse({ task_ids: Array.from({ length: 9 }, (_, index) => `child-${index}`) }),
    ).toMatchObject({ success: true });
    expect(taskWait.parse({ task_ids: ['child-1'], timeout_ms: 60_001 })).toMatchObject({
      success: true,
    });
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

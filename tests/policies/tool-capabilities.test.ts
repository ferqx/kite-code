import { describe, expect, test } from 'bun:test';
import { failClosedBuiltinToolCapability as failClosedToolCapability } from '@kite-ai/builtin-runtime';
import { testBuiltinToolCatalog } from '../helpers/runtime-model';

function entry(name: string) {
  const found = testBuiltinToolCatalog().entries.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing Builtin catalog entry for ${name}.`);
  return found;
}

describe('Builtin-owned tool capability classification', () => {
  test.each([
    'read_file',
    'search_files',
    'search_content',
    'web_fetch',
    'ask_user',
  ])('%s is classified by the frozen catalog', (toolName) => {
    expect(entry(toolName).classifyEffects({})).toMatchObject({
      effectClass: 'read_only',
      sideEffect: false,
    });
  });

  test.each(['explore', 'plan', 'review'])('%s sub-agent is read-only', (subagentType) => {
    expect(
      entry('task').classifyEffects({ subagent_type: subagentType, task: 'inspect' }),
    ).toMatchObject({ effectClass: 'read_only', sideEffect: false });
  });

  test('code sub-agent is workspace-write', () => {
    expect(
      entry('task').classifyEffects({ subagent_type: 'code', task: 'implement' }),
    ).toMatchObject({ effectClass: 'workspace_write', sideEffect: true });
  });

  test('unknown sub-agent role fails closed', () => {
    expect(
      entry('task').classifyEffects({ subagent_type: 'unknown', task: 'implement' }),
    ).toMatchObject({ effectClass: 'unknown', sideEffect: true });
  });

  test('compound shell mutation fails closed', () => {
    expect(
      entry('shell_execute').classifyEffects({ command: 'ls -la && touch generated.txt' }),
    ).toMatchObject({
      sideEffect: true,
    });
  });

  test('missing captured effects remain generic and fail closed', () => {
    expect(failClosedToolCapability('unknown_tool')).toEqual({
      effectClass: 'unknown',
      sideEffect: true,
      classificationReason: 'No captured capability classification exists for unknown_tool.',
    });
  });
});

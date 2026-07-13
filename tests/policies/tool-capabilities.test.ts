import { describe, expect, test } from 'bun:test';
import { classifyToolCapability } from '@/core/policies/tool-capabilities';

describe('shared tool capability classification', () => {
  test.each([
    'read_file',
    'search_files',
    'search_content',
    'web_fetch',
    'ask_user',
  ])('%s is read-only', (toolName) => {
    expect(classifyToolCapability(toolName, {}).sideEffect).toBe(false);
    expect(classifyToolCapability(toolName, {}).effectClass).toBe('read_only');
  });

  test.each(['explore', 'plan', 'review'])('%s sub-agent is read-only', (subagentType) => {
    expect(
      classifyToolCapability('task', { subagent_type: subagentType, task: 'inspect' }),
    ).toMatchObject({ effectClass: 'read_only', sideEffect: false });
  });

  test.each(['code', 'unknown'])('%s sub-agent is side-effectful', (subagentType) => {
    expect(
      classifyToolCapability('task', { subagent_type: subagentType, task: 'implement' }),
    ).toMatchObject({ effectClass: 'workspace_write', sideEffect: true });
  });

  test('compound shell mutation fails closed', () => {
    expect(
      classifyToolCapability('shell_execute', { command: 'ls -la && touch generated.txt' }),
    ).toMatchObject({ sideEffect: true });
  });
});

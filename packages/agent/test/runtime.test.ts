import { expect, test } from 'bun:test';
import { createRuntime } from '../src';
import { defineExtension, type Permissions, type ToolDefinition } from '../src/extensions';
import type { Store } from '../src/storage';

const permissions: Permissions = {
  async authorize() {
    return { allowed: true, revision: '1' };
  },
};
// Registry assembly is pure; a Store is intentionally never called by these tests.
const store = {} as Store;
const tool: ToolDefinition = {
  id: 'fixture.duplicate',
  version: '1',
  description: 'conflict fixture',
  inputSchema: { type: 'object' },
  async execute() {
    return { outcome: 'succeeded', content: 'unused' };
  },
};

test('duplicate extension IDs are rejected explicitly without resource initialization', () => {
  const extension = defineExtension({ id: 'fixture.same', version: '1', apiMajor: 1 });
  expect(() => createRuntime({ store, permissions, extensions: [extension, extension] })).toThrow(
    expect.objectContaining({ code: 'extension_definition_conflict' }),
  );
});

test('duplicate tool IDs cannot silently replace an implementation', () => {
  expect(() =>
    createRuntime({
      store,
      permissions,
      extensions: [
        defineExtension({ id: 'fixture.a', version: '1', apiMajor: 1, tools: [tool] }),
        defineExtension({ id: 'fixture.b', version: '1', apiMajor: 1, tools: [tool] }),
      ],
    }),
  ).toThrow(expect.objectContaining({ code: 'tool_definition_conflict' }));
});

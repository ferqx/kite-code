import { expect, test } from 'bun:test';
import type { TuiMcpReadDirectory, TuiMcpSnapshot } from '../../src/tui/mcp';
import { buildTuiMcpPromptRegistry } from '../../src/tui/mcp-prompts';

function source() {
  const facts = {
    storeId: 'store',
    sessionId: 's',
    workspaceId: 'w',
    labels: { server: 'ActualName' },
    items: [
      {
        id: 'server',
        configDigest: 'a'.repeat(64),
        admitted: true,
        selected: true,
        available: true,
      },
    ],
  } as unknown as TuiMcpSnapshot;
  const page: TuiMcpReadDirectory = {
    family: 'prompts',
    sessionId: 's',
    workspaceId: 'w',
    nextAfterKey: null,
    items: [
      {
        key: 'prompts/001',
        serverId: 'server',
        configDigest: 'a'.repeat(64),
        generation: 1,
        live: true,
        descriptors: [{ name: 'original', arguments: [{ name: 'topic', required: true }] }],
        descriptorDigests: ['b'.repeat(64)],
      },
    ],
  };
  return { facts, page };
}
test('original prompt registry derives only live exact current names and original descriptor identities', () => {
  const { facts, page } = source();
  const command = buildTuiMcpPromptRegistry(facts, page).get('mcp__ActualName__original')!;
  expect(command.command).toBe('mcp__ActualName__original');
  expect(command.serverId).toBe('server');
  expect(command.recordKey).toBe('prompts/001');
  expect(command.descriptorDigest).toBe('b'.repeat(64));
  expect(command.descriptor).toEqual(page.items[0]!.descriptors[0]!);
  expect(buildTuiMcpPromptRegistry(facts, { ...page, sessionId: 'other' }).size).toBe(0);
  expect(buildTuiMcpPromptRegistry(facts, { ...page, workspaceId: 'other' }).size).toBe(0);
  expect(buildTuiMcpPromptRegistry({ ...facts, labels: {} }, page).size).toBe(0);
  expect(
    buildTuiMcpPromptRegistry(facts, { ...page, items: [{ ...page.items[0]!, live: false }] }).size,
  ).toBe(0);
  expect(
    buildTuiMcpPromptRegistry(facts, {
      ...page,
      items: [{ ...page.items[0]!, configDigest: 'c'.repeat(64) }],
    }).size,
  ).toBe(0);
});
test('only complete unique directory candidates register; repeated commands and unclosed pages fail closed', () => {
  const { facts, page } = source();
  const first = { ...page, nextAfterKey: 'prompts/002' };
  const second = { ...page, items: [{ ...page.items[0]!, key: 'prompts/003' }] };
  expect(buildTuiMcpPromptRegistry(facts, first).size).toBe(0);
  expect(buildTuiMcpPromptRegistry(facts, [first, second]).size).toBe(0);
  expect(
    buildTuiMcpPromptRegistry(facts, [
      first,
      { ...second, items: [{ ...second.items[0]!, descriptors: [{ name: 'other' }] }] },
    ]).size,
  ).toBe(2);
  expect(
    buildTuiMcpPromptRegistry(facts, {
      ...page,
      items: [{ ...page.items[0]!, descriptors: [{ name: 'two words' }] }],
    }).size,
  ).toBe(0);
  expect(buildTuiMcpPromptRegistry(facts, [page, page]).size).toBe(0);
});

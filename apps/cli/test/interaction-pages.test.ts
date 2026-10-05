import { expect, test } from 'bun:test';
import type { AgentClient, Interaction } from '@kite-ai/client';
import { observeCommand } from '../src';

const card = (id: string, runId = 'other'): Interaction => ({
  id,
  runId,
  originStoreId: 'store',
  sessionId: 's',
  presentationSessionId: 's',
  executionId: 'execution',
  ancestry: ['s'],
  attempt: 1,
  kind: 'approval',
  definitionId: 'test',
  definitionVersion: '1',
  inputDigest: 'digest',
  policyRevision: 'policy',
  requiredRefs: [],
  request: {},
  answer: null,
  revision: '0',
  acceptedDecisionRevision: null,
  state: 'pending',
});
const intent = {
  kind: 'run.start' as const,
  commandId: 'work',
  expectedStoreId: 'store',
  content: 'original',
};
function fixture(second: { interactions: Interaction[]; nextAfterId: string | null }) {
  let pages = 0,
    posts = 0,
    handlers = 0;
  const client = {
    serverInfo: { capabilities: ['interactions'] },
    async getCommand() {
      return {
        id: 'work',
        kind: 'run.start',
        originStoreId: 'store',
        sessionId: 's',
        status: 'applied',
        cancelRequestedAt: null,
        receipt: { runId: 'run' },
      };
    },
    async getRun() {
      return {
        id: 'run',
        originCommandId: 'work',
        originStoreId: 'store',
        sessionId: 's',
        isActive: true,
        status: 'waiting_interaction',
      };
    },
    async listInteractions(_id: string, input: { afterId?: string }) {
      pages++;
      return input.afterId
        ? second
        : {
            interactions: Array.from({ length: 20 }, (_, i) =>
              card(`a${String(i).padStart(3, '0')}`),
            ),
            nextAfterId: 'a019',
          };
    },
    async answerInteraction() {
      posts++;
      throw Error('unexpected_post');
    },
  } as unknown as AgentClient;
  return {
    read: (answer = false) =>
      observeCommand('s', intent, {
        client,
        write() {},
        timeoutMs: 1000,
        ...(answer
          ? {
              answerInteraction: async () => {
                handlers++;
                return undefined;
              },
            }
          : {}),
      }),
    pages: () => pages,
    posts: () => posts,
    handlers: () => handlers,
  };
}
test('CLI examines the later page after excluding 20 cards from other original Work', async () => {
  const f = fixture({ interactions: [card('z', 'run')], nextAfterId: null });
  const outcome = await f.read();
  expect(outcome.status).toBe('waiting_interaction');
  expect(outcome.interactions?.map((c) => c.id)).toEqual(['z']);
  expect(f.pages()).toBe(2);
  expect(f.posts()).toBe(0);
});
test('malformed continuation cannot reach answer handler or issue a POST', async () => {
  for (const page of [
    { interactions: [], nextAfterId: 'z' },
    { interactions: [card('a019', 'run')], nextAfterId: 'a019' },
    { interactions: [card('z', 'run'), card('z', 'run')], nextAfterId: null },
    { interactions: [{ ...card('z', 'run'), originStoreId: 'foreign' }], nextAfterId: null },
    { interactions: [{ ...card('z', 'run'), presentationSessionId: 'other' }], nextAfterId: null },
  ]) {
    const f = fixture(page);
    expect((await f.read(true)).status).toBe('outcome_unknown');
    expect(f.posts()).toBe(0);
    expect(f.handlers()).toBe(0);
  }
});

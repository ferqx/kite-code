import { expect, test } from 'bun:test';
import type { Interaction } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { InteractionCard } from '../src';
import { mcpSourceDecisions } from '../src/mcp-source-review';

const sha = 'a'.repeat(64),
  identity = { kind: 'workspace', pathDigest: sha, rootIdentity: sha };
const server = {
  id: `mcp-${sha}`,
  name: 'exact-server',
  source: identity,
  rawEntryDigest: sha,
  transportDigest: sha,
  transport: 'http',
  enabled: true,
  admitted: false,
  reason: null,
};
const readSet = {
  scopeDigest: sha,
  user: { identity: { ...identity, kind: 'user' }, etag: sha, error: null },
  workspace: { identity, etag: sha, error: null },
  approvalEtag: sha,
  bindingEtag: sha,
  variablesDigest: sha,
};
function card(binding = false): Interaction {
  return {
    id: 'source-question',
    originStoreId: 'store',
    sessionId: 'source-session',
    presentationSessionId: 'root',
    ancestry: ['root', 'source-session'],
    runId: null,
    executionId: 'execution',
    attempt: 1,
    kind: 'question',
    definitionId: `builtin.mcp.sources/${binding ? 'mcp.credential.bind' : 'mcp.source.approve'}`,
    definitionVersion: '1',
    inputDigest: sha,
    policyRevision: 'policy',
    requiredRefs: [],
    answer: null,
    revision: '7',
    acceptedDecisionRevision: null,
    state: 'pending',
    request: {
      kind: binding ? 'mcp_credential_binding' : 'mcp_source_approval',
      executionId: 'execution',
      originalStoreId: 'store',
      sessionId: 'source-session',
      server,
      readSet,
      choices: binding ? ['bind', 'revoke', 'cancel'] : ['approved', 'rejected', 'cancel'],
      instruction: 'Exact source',
      ...(binding
        ? { authProfileDigest: sha, credentialReferenceDigest: sha, expiresAt: 2000000000000 }
        : {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['decision'],
              properties: {
                decision: { type: 'string', enum: ['approved', 'rejected', 'cancel'] },
              },
            },
          }),
    },
  };
}
test('Source Review exact definitions, request identity, read-set, schema and choices fail closed', () => {
  const original = card();
  expect(mcpSourceDecisions(original)).toEqual(['approved', 'rejected', 'cancel']);
  for (const changed of [
    { ...original, definitionVersion: '2' },
    { ...original, definitionId: 'foreign' },
    { ...original, request: { ...(original.request as object), extra: true } },
    { ...original, request: { ...(original.request as object), originalStoreId: 'foreign' } },
    {
      ...original,
      request: {
        ...(original.request as object),
        choices: ['approved', 'rejected', 'cancel', 'extra'],
      },
    },
    {
      ...original,
      request: { ...(original.request as object), readSet: { ...readSet, extra: true } },
    },
    { ...original, request: { ...(original.request as object), schema: { type: 'object' } } },
  ] as Interaction[])
    expect(mcpSourceDecisions(changed)).toBeUndefined();
  expect(mcpSourceDecisions(card(true))).toEqual(['bind', 'revoke', 'cancel']);
});
test('actual DOM submits exact Source Review decisions through original card and blocks malformed fallback', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host),
    answers: unknown[] = [];
  const onAnswer = (interaction: Interaction, answer: unknown) => {
    answers.push({ interaction, answer });
  };
  try {
    for (const binding of [false, true]) {
      const original = card(binding);
      await act(async () =>
        root.render(<InteractionCard interaction={original} onAnswer={onAnswer} />),
      );
      for (const decision of mcpSourceDecisions(original)!) {
        await act(async () =>
          [...host.querySelectorAll('button')]
            .find((button) => button.textContent === decision)!
            .click(),
        );
        expect(answers.at(-1)).toEqual({
          interaction: original,
          answer: { kind: 'question', answers: { decision } },
        });
      }
      expect(host.querySelector('textarea')).toBeNull();
    }
    const original = card();
    await act(async () =>
      root.render(
        <InteractionCard
          interaction={{ ...original, request: { ...(original.request as object), extra: true } }}
          onAnswer={onAnswer}
        />,
      ),
    );
    expect(host.textContent).toContain('Source Review unavailable');
    expect(host.querySelector('button')).toBeNull();
    expect(host.querySelector('textarea')).toBeNull();
    const count = answers.length;
    for (const malformedServer of [
      { ...server, transport: ['http'] },
      { ...server, id: 'foreign-server' },
      { ...server, source: { ...identity, kind: ['workspace'] } },
    ]) {
      await act(async () =>
        root.render(
          <InteractionCard
            interaction={{
              ...original,
              request: { ...(original.request as object), server: malformedServer },
            }}
            onAnswer={onAnswer}
          />,
        ),
      );
      expect(host.textContent).toContain('Source Review unavailable');
      expect(host.querySelector('button')).toBeNull();
      expect(host.querySelector('textarea')).toBeNull();
    }
    expect(answers).toHaveLength(count);
    for (const binding of [false, true]) {
      const ordinary = {
        ...card(binding),
        kind: 'approval' as const,
        request: { definitionId: card(binding).definitionId, input: {}, grants: [] },
      };
      await act(async () =>
        root.render(<InteractionCard interaction={ordinary} onAnswer={onAnswer} />),
      );
      expect(host.textContent).not.toContain('Source Review unavailable');
      const approve = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Approve once',
      );
      expect(approve).toBeDefined();
      await act(async () => approve!.click());
      expect(answers.at(-1)).toEqual({
        interaction: ordinary,
        answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
      });
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});

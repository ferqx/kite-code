import { expect, test } from 'bun:test';
import type { Interaction } from '@kite-ai/client';
import { InteractionCard } from '../src';

export const card: Interaction = {
  id: 'i',
  originStoreId: 'store',
  sessionId: 'child',
  presentationSessionId: 'root',
  ancestry: ['root', 'child'],
  runId: 'r',
  executionId: 'e',
  attempt: 1,
  kind: 'approval',
  definitionId: 'file.write',
  definitionVersion: '1',
  inputDigest: 'digest',
  policyRevision: 'policy',
  requiredRefs: [],
  request: { path: 'actual.txt' },
  answer: null,
  revision: '7',
  acceptedDecisionRevision: null,
  state: 'pending',
};
function nodes(element: unknown): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (!element || typeof element !== 'object') return [];
  const node = element as { type: unknown; props: Record<string, unknown> };
  const children = node.props?.children;
  return [node, ...(Array.isArray(children) ? children : [children]).flatMap(nodes)];
}
test('pure React element projection preserves true child and exact request; readonly approval cannot answer', () => {
  const element = InteractionCard({ interaction: card });
  expect(JSON.stringify(element)).toContain('child');
  expect(JSON.stringify(element)).toContain('actual.txt');
  const buttons = nodes(element).filter((node) => node.type === 'button');
  expect(buttons.map((button) => button.props.children)).toEqual(['Approve once', 'Deny']);
  expect(buttons.every((button) => button.props.disabled)).toBe(true);
});
test('submitting panel persists and disables offered approvals; saved plan is display only', () => {
  const element = InteractionCard({
    interaction: card,
    submission: { phase: 'submitting', commandId: 'answer' },
    onAnswer() {},
  });
  expect(
    nodes(element)
      .filter((node) => node.type === 'button')
      .every((button) => button.props.disabled),
  ).toBe(true);
  expect(JSON.stringify(element)).toContain('Acceptance does not prove execution');
  const plan = InteractionCard({ interaction: { ...card, kind: 'plan_review' }, onAnswer() {} });
  expect(nodes(plan).filter((node) => node.type === 'button')).toHaveLength(0);
});

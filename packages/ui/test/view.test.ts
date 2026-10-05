import { expect, test } from 'bun:test';
import type { PublicView } from '@kite-ai/client';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { PublicViewCard, projectPublicView } from '../src';

test('unknown content versions retain the exact public object, future fields and actions', () => {
  const view = {
    extensionId: 'unknown.extension',
    contentType: 'new.content',
    contentVersion: 99,
    summary: 'Saved result',
    payload: { future: ['one', { two: true }] },
    artifactRefs: [{ id: 'opaque-id', mediaType: 'text/plain', size: '9007199254740993' }],
    actions: [
      {
        actionId: 'unknown.action',
        definitionVersion: 'future',
        label: 'Continue',
        input: { extra: 'preserved' },
      },
    ],
    futureEnvelope: { active: true },
  } satisfies PublicView & { futureEnvelope: unknown };
  const projected = projectPublicView(view);
  expect(projected.raw).toBe(view);
  expect(projected.version).toBe(99);
  expect(projected.actions).toBe(view.actions);
  expect(projected.artifacts[0]?.id).toBe('opaque-id');
  expect(JSON.parse(projected.payloadText)).toEqual(view.payload);
  expect((projected.raw as typeof view).futureEnvelope).toEqual({ active: true });
});

test('generic card callback receives the original action envelope and is disabled without host authority', () => {
  const view: PublicView = {
    extensionId: 'external',
    contentType: 'unknown',
    contentVersion: 99,
    summary: 'Result',
    payload: null,
    artifactRefs: [],
    actions: [
      {
        actionId: 'external.action',
        definitionVersion: 'next',
        label: 'Act',
        input: { arbitrary: 'preserved' },
      },
    ],
  };
  let received: unknown;
  const card = PublicViewCard({
    view,
    onAction(action) {
      received = action;
    },
  });
  const buttons = findButtons(card);
  expect(buttons).toHaveLength(1);
  buttons[0]!.props.onClick!();
  expect(received).toBe(view.actions[0]);
  expect(findButtons(PublicViewCard({ view }))[0]!.props.disabled).toBe(true);
});

function findButtons(
  node: ReactNode,
): ReactElement<{ onClick?: () => void; disabled?: boolean }>[] {
  return Children.toArray(node).flatMap((item) => {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void; disabled?: boolean }>(item))
      return [];
    return item.type === 'button' ? [item] : findButtons(item.props.children);
  });
}

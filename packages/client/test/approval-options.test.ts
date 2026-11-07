import { expect, test } from 'bun:test';
import { readApprovalOptions } from '../src';

test('approval presentation preserves opaque frozen IDs and full details, rejecting malformed or ambiguous options', () => {
  const once = {
    optionId: 'only-this-id',
    kind: 'once',
    presentation: { label: '仅此次', details: [] },
  };
  const scope = {
    optionId: 'original-scope-id',
    kind: 'scope',
    presentation: {
      label: 'edit/write 同位置',
      details: ['/workspace/full/path.txt', '仅来源会话 · 非递归'],
    },
    scope: { path: '/workspace/full/path.txt' },
  };
  const request = { options: [scope, once] };
  const view = readApprovalOptions(request);
  expect(view.map((option) => option.optionId)).toEqual(['original-scope-id', 'only-this-id']);
  expect(view[0]?.presentation).toEqual(scope.presentation);
  expect(view[0]).not.toHaveProperty('scope');
  scope.presentation.details[0] = 'changed-after-read';
  expect(view[0]?.presentation.details[0]).toBe('/workspace/full/path.txt');
  for (const value of [
    {},
    { grants: ['approve_once', 'same_command'] },
    { options: [scope] },
    { options: [once, once] },
    { options: [once, { ...scope, optionId: once.optionId }] },
    { options: [once, { ...scope, presentation: { label: 'invalid', details: [1] } }] },
  ])
    expect(readApprovalOptions(value)).toEqual([]);
});

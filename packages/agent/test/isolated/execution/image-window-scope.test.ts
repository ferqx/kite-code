import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { ModelRequest } from '@kite-ai/ai';
import { type ImageWindowScope, imageWindowScope } from '../../../src/execution/image-window';

const bytes = Buffer.from('unchanged-original');
const hash = createHash('sha256').update(bytes).digest('hex');
const scope: ImageWindowScope = {
  version: 1,
  kind: 'observation',
  route: 'bound-model-route',
  members: [{ executionId: 'source', ordinal: 1, size: bytes.length, hash }],
};
const req: ModelRequest = {
  requestId: 'r',
  modelId: 'm',
  tools: [],
  messages: [
    {
      role: 'user',
      content: 'untrusted archived source',
      images: [{ mediaType: 'image/png', data: bytes.toString('base64') }],
    },
  ],
};
test('manifest binds exact current image bytes and isolates caller mutations', () => {
  const v = imageWindowScope(scope, req)!;
  expect(v).toEqual(scope);
  expect(v).not.toBe(scope);
  expect(() =>
    imageWindowScope({ ...scope, members: [{ ...scope.members[0]!, ordinal: 0 }] }, req),
  ).toThrow('image_window_scope_invalid');
  expect(() =>
    imageWindowScope({ ...scope, members: [{ ...scope.members[0]!, hash: 'a'.repeat(64) }] }, req),
  ).toThrow('image_window_scope_invalid');
  expect(() => imageWindowScope(scope, { ...req, messages: [] })).toThrow(
    'image_window_scope_invalid',
  );
});
test('observations cannot request tools or collapse duplicate content ordinals', () => {
  expect(() =>
    imageWindowScope(scope, {
      ...req,
      tools: [{ id: 'exec', definitionVersion: '1', inputSchema: { type: 'object' } }],
    }),
  ).toThrow('image_window_scope_invalid');
  const members = [scope.members[0]!, { ...scope.members[0]!, ordinal: 2 }];
  const request = {
    ...req,
    messages: [
      { ...req.messages[0]!, images: [req.messages[0]!.images![0]!, req.messages[0]!.images![0]!] },
    ],
  };
  expect(imageWindowScope({ ...scope, members }, request)?.members.length).toBe(2);
  expect(() =>
    imageWindowScope({ ...scope, members: [members[0]!, members[0]!] }, request),
  ).toThrow('image_window_scope_invalid');
});
test('business preserves unrelated user/PDF images without claiming their delivery', () => {
  const tool = {
    ...req.messages[0]!,
    role: 'tool' as const,
    sourceIds: ['source'],
    toolCallId: 'call',
  };
  const mixed = { ...req, messages: [req.messages[0]!, tool] };
  expect(imageWindowScope({ ...scope, kind: 'business' }, mixed)?.members.length).toBe(1);
  expect(() => imageWindowScope({ ...scope, kind: 'business' }, req)).toThrow();
});

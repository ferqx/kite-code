import { expect, test } from 'vitest';
import { createPageBoundFetch } from '../src/transport/page-identity';

test('old pages reject a replacement instance response before its body is consumed', async () => {
  let changed = 0;
  const replacement = new Response('{"items":[]}', { headers: { 'x-kite-web-identity': 'new' } });
  const fetch = createPageBoundFetch(
    'old',
    () => changed++,
    async () => replacement,
  );
  await expect(fetch('/v1')).rejects.toMatchObject({ reason: 'protocol_error' });
  expect(replacement.bodyUsed).toBe(false);
  expect(changed).toBe(1);
  const matching = new Response('{}', { headers: { 'x-kite-web-identity': 'old' } });
  await expect(
    createPageBoundFetch(
      'old',
      () => changed++,
      async () => matching,
    )('/v1'),
  ).resolves.toBe(matching);
  expect(changed).toBe(1);
});

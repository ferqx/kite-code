import { expect, test } from 'bun:test';
import { createWebFetchConfiguration } from '../../src/web-fetch-configuration';

test('trusted web configuration is pure, effects remain network/unknown and immutable host policy cannot be selected into broader access', () => {
  let dns = 0,
    admission = 0,
    parser = 0;
  const policy = { mode: 'allowlist' as const, hosts: ['docs.example.test'] };
  const configuration = createWebFetchConfiguration({
    network: {
      policy,
      resolveAddresses: async () => {
        dns++;
        return [];
      },
      admitHop: async () => {
        admission++;
        return { allowed: true, revision: '1' };
      },
    },
    extractor: {
      prepare: async () => {
        parser++;
        return { hash: 'a'.repeat(64) };
      },
      extract: async () => ({ title: '', content: 'body' }),
    },
  });
  policy.hosts.push('untrusted.example.test');
  expect([dns, admission, parser]).toEqual([0, 0, 0]);
  expect(configuration.toolIds).toEqual(['web_fetch']);
  expect(configuration.snapshot.policy).toEqual({
    mode: 'allowlist',
    hosts: ['docs.example.test'],
  });
  expect(configuration.capabilities).toEqual([
    {
      kind: 'tool',
      definitionId: 'web_fetch',
      definitionVersion: '1',
      revision: 'builtin.web:1',
      hardAllowed: true,
      effects: ['network', 'unknown'],
      safeRead: false,
    },
  ]);
  const off = createWebFetchConfiguration({
    network: { policy: { mode: 'off' }, admitHop: async () => ({ allowed: true, revision: '1' }) },
  });
  expect(off.capabilities[0]?.hardAllowed).toBe(false);
  expect(off.extension.tools?.[0]?.version).toBe('1');
});

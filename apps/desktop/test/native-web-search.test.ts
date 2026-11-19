import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { type AgentClient, ClientError } from '@kite-ai/client';
import { readVisitedIcon, VisitedSiteIcons } from '../electron/visited-site-icons';
import { NativeWebSearch, projectSearchEvidence } from '../electron/web-search';
import { validateSearchOperation } from '../electron/web-search-ipc';

const scope = { generation: 2, selection: 4, storeId: 's', sessionId: 'a', readOnly: false };
const base = { expectedStoreId: 's', generation: 2 };
function make() {
  let current = { ...scope },
    probes = 0,
    saves = 0,
    lookups = 0,
    gets = 0,
    observed = false,
    lost = false;
  let savedInput: Record<string, unknown> = {},
    commandId = '';
  const api = {
    serverInfo: {
      storeId: 's',
      capabilities: ['web_search_settings', 'web_search_test', 'web_search_evidence'],
    },
    getWebSearchSettings: async () => ({
      storeId: 's',
      eligibleConnections: [
        { providerAlias: 'official-account', name: '生产账号', adapter: 'deepseek-search' },
      ],
      webSearch: { mode: 'auto' },
      searchProviders: [
        {
          id: 'd',
          name: 'P',
          adapter: 'perplexity-search',
          connection: {
            kind: 'dedicated',
            baseURL: 'https://api.perplexity.ai',
            credentialRef: 'private-vault-handle',
          },
          maxResults: 5,
        },
      ],
      readSet: { userEtag: 'old' },
      errors: [],
    }),
    getProviderSettings: async () => ({ storeId: 's', providers: [] }),
    testWebSearch: async (input: { commandId: string }) => {
      commandId = input.commandId;
      probes++;
      if (lost) throw new ClientError('network_outcome_unknown');
      return command();
    },
    getCommand: async (id: string) => {
      expect(id).toBe(commandId);
      lookups++;
      return command();
    },
    getExecution: async (id: string) => {
      gets++;
      return {
        id,
        sessionId: 'a',
        originStoreId: 's',
        status: 'succeeded',
        result: { details: { route: 'provider', provider: 'P', observed, sources: [] } },
      };
    },
    saveWebSearchSettings: async (input: typeof savedInput) => {
      saves++;
      savedInput = input;
      return {
        originStoreId: 's',
        kind: 'config.patch',
        state: 'applied',
        commandId: input.commandId,
      };
    },
    getWebSearchEvidence: async () => ({
      schema: 'kite.web-search',
      schemaVersion: 1,
      storeId: 's',
      sessionId: 'a',
      executionId: 'ex',
      revision: 1,
      blocks: [{ status: 'completed', sources: [{ url: 'https://example.test' }] }],
    }),
  };
  function command() {
    return {
      id: commandId,
      sessionId: 'a',
      originStoreId: 's',
      kind: 'extension.invoke',
      status: 'applied',
      receipt: { executionId: 'ex' },
    };
  }
  const host = new NativeWebSearch(api as unknown as AgentClient, () => current);
  async function read() {
    const r = await host.invoke({ ...base, method: 'webSearch.settings.read' });
    if (r.kind !== 'webSearch.settings') throw Error();
    return r.view;
  }
  return {
    host,
    api,
    read,
    setObserved: (v: boolean) => {
      observed = v;
    },
    lose: () => {
      lost = true;
    },
    state: () => ({ probes, saves, lookups, gets, savedInput }),
    select: (id: string) => {
      current = { ...current, selection: current.selection + 1, sessionId: id };
    },
  };
}
test('host projects only derived status and public label; no lookup, account inference or active test', async () => {
  const f = make();
  expect((await f.read()).derivedDeepSeek).toBeUndefined();
  const saved = await f.api.getWebSearchSettings();
  const flags = { status: 'configured', label: 'Official DeepSeek', secret: 'PRIVATE_SENTINEL' };
  f.api.getWebSearchSettings = async () => ({
    ...saved,
    eligibleConnections: [],
    searchProviders: [],
    derivedDeepSeek: flags,
  });
  const view = await f.read();
  expect(view.derivedDeepSeek).toEqual({ status: 'configured', label: 'Official DeepSeek' });
  expect(JSON.stringify(view)).not.toContain('PRIVATE_SENTINEL');
  flags.status = 'ambiguous';
  expect((await f.read()).derivedDeepSeek).toEqual({ status: 'ambiguous' });
  flags.status = 'unavailable';
  expect((await f.read()).derivedDeepSeek).toEqual({ status: 'unavailable' });
  expect(f.state()).toMatchObject({ probes: 0, saves: 0, lookups: 0 });
});
test('read and save never probe; host masks vault refs, reuses only the exact service binding and discards raw secrets', async () => {
  const f = make(),
    view = await f.read();
  expect(JSON.stringify(view)).not.toContain('private-vault-handle');
  expect(f.state().probes).toBe(0);
  const result = await f.host.invoke({
    ...base,
    method: 'webSearch.settings.save',
    revision: view.revision,
    draft: view.draft,
    credential: { providerId: 'd', secret: 'example-only' },
  });
  expect(f.state().saves).toBe(1);
  expect(f.state().probes).toBe(0);
  expect(JSON.stringify(result)).not.toContain('example-only');
  expect(f.state().savedInput.searchProviders).toEqual([
    {
      id: 'd',
      name: 'P',
      adapter: 'perplexity-search',
      maxResults: 5,
      connection: {
        kind: 'dedicated',
        baseURL: 'https://api.perplexity.ai',
        credentialRef: 'private-vault-handle',
      },
    },
  ]);
});
test('one test post even on lost response; follow only the same command/execution, no source is not failure', async () => {
  const f = make(),
    v = await f.read();
  f.lose();
  f.setObserved(true);
  expect(
    await f.host.invoke({
      ...base,
      method: 'webSearch.settings.test',
      revision: v.revision,
      sessionId: 'a',
    }),
  ).toMatchObject({ kind: 'webSearch.test', probe: { observed: true, sources: [] } });
  expect(f.state()).toMatchObject({ probes: 1, lookups: 1, gets: 1 });
  f.setObserved(false);
  expect(
    await f.host.invoke({
      ...base,
      method: 'webSearch.settings.test',
      revision: v.revision,
      sessionId: 'a',
    }),
  ).toMatchObject({ probe: { observed: false } });
  f.select('b');
  await expect(
    f.host.invoke({
      ...base,
      method: 'webSearch.settings.test',
      revision: v.revision,
      sessionId: 'a',
    }),
  ).rejects.toThrow();
  expect(f.state().probes).toBe(2);
});
test('unsupported capability or mismatched execution/session/revision cannot expose a different evidence body', async () => {
  const f = make();
  const req = {
    ...base,
    method: 'webSearch.evidence' as const,
    executionId: 'ex',
    sessionId: 'a',
    viewSelection: 4,
  };
  expect(await f.host.invoke(req)).toMatchObject({
    kind: 'webSearch.evidence',
    evidence: { executionId: 'ex' },
  });
  expect(await f.host.invoke({ ...req, executionId: 'different' })).toMatchObject({
    evidence: null,
  });
  await expect(f.host.invoke({ ...req, sessionId: 'b' })).rejects.toThrow();
  f.api.serverInfo.capabilities.length = 0;
  await expect(f.host.invoke(req)).rejects.toThrow();
  expect(
    projectSearchEvidence(
      { schemaVersion: 2 },
      { storeId: 's', sessionId: 'a', executionId: 'ex' },
    ),
  ).toBeUndefined();
});
test('ordinary result projection permits bounded plain snippets only on sources, never provider body or citation offsets', () => {
  const ids = { storeId: 's', sessionId: 'a', executionId: 'ex' },
    link = {
      url: 'https://example.test',
      title: 'T',
      snippet: `${'x'.repeat(319)}\u{1F642}`,
      fullPage: 'RAW_PRIVATE',
    };
  const result = projectSearchEvidence(
    {
      schema: 'kite.web-search',
      schemaVersion: 1,
      ...ids,
      revision: 1,
      blocks: [
        {
          status: 'completed',
          route: 'provider',
          sources: [link],
          citations: [{ ...link, startUtf16: 0, endUtf16: 1 }],
        },
      ],
    },
    ids,
  );
  expect(result?.sources).toEqual([{ url: link.url, title: 'T', snippet: 'x'.repeat(319) }]);
  expect(result?.citations).toEqual([{ url: link.url, title: 'T' }]);
  expect(JSON.stringify(result)).not.toContain('RAW_PRIVATE');
});
test('IPC rejects arbitrary vault references, arbitrary endpoints, cross-provider secrets and duplicate ids', () => {
  const draft = {
    mode: 'provider',
    providerId: 'd',
    providers: [
      {
        id: 'd',
        name: 'D',
        adapter: 'deepseek-search',
        account: { kind: 'provider', alias: 'known' },
        maxResults: 5,
      },
    ],
  };
  const req = { revision: 'valid', draft };
  expect(() => validateSearchOperation('webSearch.settings.save', req)).not.toThrow();
  for (const bad of [
    { ...req, credential: { providerId: 'd', secret: 'secret' } },
    {
      ...req,
      draft: { ...draft, providers: [{ ...draft.providers[0], credentialRef: 'stolen' }] },
    },
    {
      ...req,
      draft: {
        ...draft,
        providers: [
          { ...draft.providers[0], account: { kind: 'dedicated', baseURL: 'http://evil' } },
        ],
      },
    },
    { ...req, draft: { ...draft, providers: [...draft.providers, ...draft.providers] } },
  ])
    expect(() => validateSearchOperation('webSearch.settings.save', bad)).toThrow();
});

test('one-time dedicated key omits ref for Service allocation; approved account uses resolver alias, not display text or opaque connection id', async () => {
  const f = make(),
    v = await f.read();
  expect(v.accounts).toEqual([
    { alias: 'official-account', name: '生产账号', adapter: 'deepseek-search' },
  ]);
  const draft = {
    ...v.draft,
    providers: [
      ...v.draft.providers,
      {
        id: 'new',
        name: 'Dedicated',
        adapter: 'deepseek-search' as const,
        account: { kind: 'dedicated' as const, hasCredential: false },
        maxResults: 5,
      },
      {
        id: 'account',
        name: 'Existing',
        adapter: 'deepseek-search' as const,
        account: { kind: 'provider' as const, alias: 'official-account' },
        maxResults: 3,
      },
    ],
  };
  await f.host.invoke({
    ...base,
    method: 'webSearch.settings.save',
    revision: v.revision,
    draft,
    credential: { providerId: 'new', secret: 'fixture-key' },
  });
  expect(f.state().savedInput.searchProviders).toMatchObject([
    {},
    { connection: { kind: 'dedicated', baseURL: 'https://api.deepseek.com' } },
    { connection: { kind: 'provider', providerAlias: 'official-account' } },
  ]);
  expect(
    (f.state().savedInput.searchProviders as Array<{ connection: object }>)[1]!.connection,
  ).not.toHaveProperty('credentialRef');
});
test('actual evidence schema: searching and unknown are not success; native anchors survive but provider offsets never decorate the main model', () => {
  const ids = { storeId: 's', sessionId: 'a', executionId: 'ex' },
    url = 'https://example.test/';
  const anchor = {
    executionId: 'ex',
    blockIndex: 0,
    blockLengthUtf16: 8,
    blockStartUtf16: 0,
    textSha256: '0'.repeat(64),
    startUtf16: 1,
    endUtf16: 5,
  };
  const block = {
    callId: 'c',
    status: 'searching' as const,
    route: 'native' as const,
    provider: 'fixture',
    citations: [{ url, anchor }],
    sources: [{ url }],
    truncated: false,
  };
  const packet = {
    schema: 'kite.web-search' as const,
    schemaVersion: 1 as const,
    ...ids,
    revision: 2,
    blocks: [block],
  };
  expect(projectSearchEvidence(packet, ids)).toMatchObject({
    status: 'running',
    blocks: [{ index: 0, offset: 0, length: 8, sha256: anchor.textSha256 }],
    citations: [{ url, blockIndex: 0, start: 1, end: 5 }],
  });
  expect(
    projectSearchEvidence(
      { ...packet, blocks: [{ ...block, route: 'provider', status: 'outcome_unknown' }] },
      ids,
    ),
  ).toMatchObject({ status: 'unknown', citations: [{ url }], blocks: [] });
});

test('favicon projection only accepts bounded visited pixels for this store, session and HTTPS origin', () => {
  const icons = new VisitedSiteIcons(),
    px = Buffer.alloc(1024, 142).toString('base64');
  const s = { storeId: 's', sessionId: 'a', executionId: 'exec' };
  const url = 'https://source.example/guide',
    off = 'https://other.example';
  const packet = {
    schema: 'kite.web-search',
    schemaVersion: 1,
    ...s,
    revision: 1,
    blocks: [
      {
        status: 'completed',
        route: 'provider',
        sources: [
          { url, siteIconPixels: 'https://evil.example/icon.svg' },
          { url: off, siteIconPixels: px },
        ],
      },
    ],
  };
  icons.record(s, url, 'https://evil.example/pixel');
  icons.record(s, url, 'data:image/svg+xml,<svg/>');
  expect(icons.get(s, url)).toBeUndefined();
  expect(projectSearchEvidence(packet, s, icons)?.sources[1]?.siteIconPixels).toBeUndefined();
  icons.record(s, url, px);
  expect(projectSearchEvidence(packet, s, icons)?.sources[0]?.siteIconPixels).toBe(px);
  expect(icons.get({ ...s, storeId: 'other' }, url)).toBeUndefined();
  expect(icons.get({ ...s, sessionId: 'other' }, url)).toBeUndefined();
  expect(icons.get(s, 'https://source.example:8443')).toBeUndefined();
  expect(icons.get(s, 'http://source.example')).toBeUndefined();
  expect(icons.get(s, 'https://user@source.example')).toBeUndefined();
});

test('the browser sampler accepts document-owned PNG bytes and does no lookup for linked icons', async () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XDbkAAAAASUVORK5CYII=';
  const pixels = Buffer.alloc(1024, 255);
  let closed = 0,
    reads = 0;
  const decoded: string[] = [];
  const lookup = () => {
    reads++;
    throw Error('external image access');
  };
  const sample = (protocol: string, hrefs: string[]) =>
    runInNewContext(readVisitedIcon, {
      location: { protocol },
      document: { querySelectorAll: () => hrefs.map((href) => ({ href })) },
      caches: { match: lookup },
      fetch: lookup,
      Image: lookup,
      atob,
      btoa,
      Blob,
      createImageBitmap: async (blob: Blob) => {
        decoded.push(Buffer.from(await blob.arrayBuffer()).toString('base64'));
        return { width: 1, height: 1, close: () => closed++ };
      },
      OffscreenCanvas: class {
        getContext() {
          return { drawImage() {}, getImageData: () => ({ data: pixels }) };
        }
      },
    });
  const inline = 'data:image/png;base64,' + png;
  expect(await sample('http:', [inline])).toBeUndefined();
  expect(
    await sample('https:', ['https://a.example/favicon.png', 'https://b.example/favicon.png']),
  ).toBeUndefined();
  expect(await sample('https:', ['data:image/png;base64,AAAA', inline])).toBe(
    pixels.toString('base64'),
  );
  expect(decoded).toEqual([png]);
  expect(closed).toBe(1);
  expect(reads).toBe(0);
});

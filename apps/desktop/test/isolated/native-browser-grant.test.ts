import { expect, setSystemTime, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  type BrowserPagePort,
  NativeBrowserPageHost,
  serializeBrowserPageFailure,
} from '../../electron/browser-page-host';

type Grant = {
  requestId: string;
  state: 'question' | 'ready' | 'committed' | 'cancelled' | 'expired';
  page: { kind: 'existing' | 'new'; id?: string; title: string; url: string };
  expiresAt: number;
  consumed?: boolean;
  requireExisting?: true;
};
const scope = { storeId: 'store', sessionId: 'session' };
const retainedIdentity = (host: NativeBrowserPageHost, pageId: string) => ({
  pageId,
  incarnation: host.state(pageId)!.incarnation,
});
function fixture() {
  const host = new NativeBrowserPageHost();
  let selected = { ...scope, generation: 1, viewSelection: 1 };
  const pages = new Map<string, { title: string; url: string; attached: number; remove(): void }>();
  const created: string[] = [],
    closed: string[] = [];
  const sent: { id: string; method: string }[] = [];
  const add = (id: string, owner = scope, url = 'https://example.test/destination') => {
    const row = {
      title: `Page ${id}`,
      url,
      attached: 0,
      onAttach: undefined as (() => void) | undefined,
      remove() {},
    };
    const port: BrowserPagePort = {
      id,
      scope: owner,
      alive: () => pages.has(id),
      attach() {
        row.attached++;
        row.onAttach?.();
      },
      detach: () => true,
      send: async (method) => {
        sent.push({ id, method });
        return {};
      },
      typingCursor: async () => null,
      onEvent: () => () => {},
      decorate() {},
      changed() {},
      capture: async () => ({}),
      captureMeta: () => ({}),
    };
    row.remove = host.add(port);
    pages.set(id, row);
    return row;
  };
  const dispose = host.configureGrantContext({
    selectedScope: () => selected,
    describe: (id) => pages.get(id),
    create(id) {
      created.push(id);
      add(id, selected, '');
    },
    close(id) {
      const page = pages.get(id);
      page?.remove();
      pages.delete(id);
      closed.push(id);
    },
  });
  const prepare = (
    requestId: string = randomUUID(),
    browserId = 'open',
    fields: Record<string, unknown> = {},
  ) =>
    host.request({
      op: 'prepareGrant',
      requestId,
      ...scope,
      executionId: 'original-tool',
      browserId,
      url: 'https://example.test/destination',
      ...fields,
    }) as Promise<Grant>;
  const inspect = (requestId: string) =>
    host.request({ op: 'inspectGrant', requestId }) as Promise<Grant>;
  const commit = (requestId: string, interactionId = 'question', decisionRevision = '1') =>
    host.request({
      op: 'commitGrant',
      requestId,
      interactionId,
      decisionRevision,
    }) as Promise<Grant>;
  const commitAuthorized = (
    requestId: string,
    authorizationDigest = 'a'.repeat(64),
    executionId = 'original-tool',
  ) =>
    host.request({
      op: 'commitGrant',
      requestId,
      executionId,
      authorizationDigest,
    }) as Promise<Grant>;
  const cancel = (requestId: string) =>
    host.request({ op: 'cancelGrant', requestId }) as Promise<Grant>;
  const acquire = (grantId?: string, browserId = 'open') =>
    host.request({
      op: 'acquire',
      ...scope,
      executionId: 'browser-job',
      browserId,
      ...(grantId ? { grantId, grantExecutionId: 'original-tool' } : {}),
    });
  return {
    host,
    pages,
    created,
    closed,
    sent,
    add,
    prepare,
    inspect,
    commit,
    commitAuthorized,
    cancel,
    acquire,
    dispose,
    get selected() {
      return selected;
    },
    set selected(value) {
      selected = value;
    },
  };
}

const existingFields = (f: ReturnType<typeof fixture>) => ({
  requireExisting: true,
  existingPage: {
    pageId: 'retained',
    incarnation: f.host.state('retained')?.incarnation ?? '00000000-0000-4000-8000-000000000000',
  },
});

test('a trusted retained identity selects the original hidden page among duplicate URLs', async () => {
  const f = fixture();
  try {
    const original = f.add('original', scope, 'https://example.test/destination');
    const existingPage = retainedIdentity(f.host, 'original');
    const other = f.add('other', scope, 'https://example.test/destination');
    f.host.present('other', true);
    f.selected = { ...f.selected, sessionId: 'background-b', viewSelection: 2 };
    const grant = await f.prepare(randomUUID(), 'new-run', { requireExisting: true, existingPage });
    expect(grant.page.id).toBe('original');
    await f.commitAuthorized(grant.requestId);
    const acquired = await f.acquire(grant.requestId, 'new-run');
    expect(acquired).toMatchObject(existingPage);
    expect(original.attached).toBe(1);
    expect(other.attached).toBe(0);
    expect(f.created).toEqual([]);
    expect(f.sent).toEqual([]);
  } finally {
    f.dispose();
  }
});

test('retained identity fails before prepare after closure or same-id replacement without URL fallback', async () => {
  for (const replaced of [false, true]) {
    const f = fixture();
    try {
      const original = f.add('original', scope, 'https://example.test/destination');
      const existingPage = retainedIdentity(f.host, 'original');
      original.remove();
      f.pages.delete('original');
      if (replaced) f.add('original', scope, 'https://example.test/destination');
      const substitute = f.add('other', scope, 'https://example.test/destination');
      f.host.present('other', true);
      await expect(
        f.prepare(randomUUID(), 'new-run', { requireExisting: true, existingPage }),
      ).rejects.toThrow(replaced ? 'existing_mismatch' : 'existing_missing');
      expect(substitute.attached).toBe(0);
      expect([...f.pages.values()].every((row) => row.attached === 0)).toBe(true);
      expect(f.created).toEqual([]);
      expect(f.sent).toEqual([]);
    } finally {
      f.dispose();
    }
  }
});

test('existing-only attachment rechecks address and navigation before admitting the daemon', async () => {
  const f = fixture();
  try {
    const page = f.add('retained');
    const grant = await f.prepare(randomUUID(), 'open', existingFields(f));
    await f.commitAuthorized(grant.requestId);
    page.onAttach = () => {
      page.url = 'https://example.test/changed-during-attach';
      f.host.navigate('retained');
    };
    const error = await f.acquire(grant.requestId).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : undefined).toBe(
      'browser_page_existing_mismatch',
    );
    expect(serializeBrowserPageFailure(error, { op: 'acquire' })).toEqual({
      kind: 'effect_unknown',
      op: 'acquire',
    });
    expect(f.host.state('retained')?.phase).toBe('unknown');
    expect(f.sent).toEqual([]);
    expect(f.created).toEqual([]);
    expect(page.url).toBe('https://example.test/changed-during-attach');
  } finally {
    f.dispose();
  }
});

test('fresh open uses URL only to find a unique existing match and never selects a different visible page', async () => {
  for (const duplicate of [false, true]) {
    const f = fixture();
    try {
      const original = f.add('visible', scope, 'https://example.test/keep');
      f.host.present('visible', true);
      if (duplicate) {
        f.add('a', scope, 'https://example.test/destination');
        f.add('b', scope, 'https://example.test/destination');
        await expect(f.prepare()).rejects.toThrow('browser_page_existing_ambiguous');
        expect(f.created).toEqual([]);
      } else {
        const grant = await f.prepare();
        expect(grant.page.kind).toBe('new');
        await f.commitAuthorized(grant.requestId);
        expect((await f.acquire(grant.requestId)) as object).not.toMatchObject({
          pageId: 'visible',
        });
        expect(f.created).toHaveLength(1);
      }
      expect(original.url).toBe('https://example.test/keep');
      expect(original.attached).toBe(0);
      expect(f.sent).toEqual([]);
    } finally {
      f.dispose();
    }
  }
});

test('only a unique never-used initial blank can be initialized; historical or multiple blanks are left untouched', async () => {
  for (const mode of ['pristine', 'navigated', 'multiple'] as const) {
    const f = fixture();
    try {
      const blank = f.add('blank', scope, 'about:blank');
      if (mode === 'navigated') f.host.navigate('blank');
      if (mode === 'multiple') f.add('other-blank', scope, '');
      const grant = await f.prepare();
      expect(grant.page.kind).toBe(mode === 'pristine' ? 'existing' : 'new');
      if (mode === 'pristine') expect(grant.page.id).toBe('blank');
      await f.commitAuthorized(grant.requestId);
      expect(f.created).toHaveLength(mode === 'pristine' ? 0 : 1);
      expect(blank.url).toBe('about:blank');
      expect(blank.attached).toBe(0);
      expect(f.sent).toEqual([]);
    } finally {
      f.dispose();
    }
  }
});

test('fresh different-URL open at capacity fails without binding or navigating an existing page', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 8; i++) f.add(`old-${i}`, scope, `https://example.test/keep-${i}`);
    f.host.present('old-0', true);
    await expect(f.prepare()).rejects.toThrow('browser_page_capacity');
    expect(f.created).toEqual([]);
    expect(f.sent).toEqual([]);
    expect([...f.pages.values()].every((row) => row.attached === 0)).toBe(true);
    expect([...f.pages.values()].map((row) => row.url)).toEqual(
      Array.from({ length: 8 }, (_, i) => `https://example.test/keep-${i}`),
    );
  } finally {
    f.dispose();
  }
});

test('existing-only requests cannot omit or forge the private identity shape', async () => {
  const f = fixture();
  try {
    f.add('retained');
    for (const existingPage of [
      undefined,
      null,
      {},
      { pageId: 'retained' },
      { pageId: 'retained', incarnation: randomUUID(), extra: true },
    ])
      await expect(
        f.prepare(randomUUID(), 'open', { requireExisting: true, existingPage }),
      ).rejects.toThrow('page_request_invalid');
    expect(f.created).toEqual([]);
    expect(f.sent).toEqual([]);
  } finally {
    f.dispose();
  }
});

test('original Tool dispatch receipt pins one exact page and cannot be replaced or borrowed', async () => {
  const f = fixture();
  try {
    const page = f.add('a');
    f.host.present('a', true);
    const grant = await f.prepare();
    expect(page.attached).toBe(0);
    expect(f.host.state('a')?.phase).toBe('human');
    expect((await f.commitAuthorized(grant.requestId)).state).toBe('committed');
    expect(await f.commitAuthorized(grant.requestId)).toEqual(await f.inspect(grant.requestId));
    expect(f.host.state('a')?.phase).toBe('armed');
    await expect(f.commitAuthorized(grant.requestId, 'b'.repeat(64))).rejects.toThrow(
      'receipt_conflict',
    );
    await expect(f.commit(grant.requestId)).rejects.toThrow('receipt_conflict');
    await expect(f.acquire()).rejects.toThrow('explicit_grant_required');
    await expect(f.acquire(grant.requestId, 'foreign-browser')).rejects.toThrow('grant');
    const lease = await f.acquire(grant.requestId);
    expect(lease).toMatchObject({ pageId: 'a' });
    expect(page.attached).toBe(1);
    expect((await f.inspect(grant.requestId)).consumed).toBe(true);
  } finally {
    f.dispose();
  }
});

test('dispatch receipt rejects foreign execution, malformed digest and mixed proof before arm or attach', async () => {
  const f = fixture();
  try {
    const page = f.add('a');
    f.host.present('a', true);
    const grant = await f.prepare();
    for (const fields of [
      { executionId: 'foreign-tool', authorizationDigest: 'a'.repeat(64) },
      { executionId: 'original-tool', authorizationDigest: 'not-a-digest' },
      { executionId: 'original-tool', authorizationDigest: 'A'.repeat(64) },
      { executionId: 'original-tool' },
      {
        executionId: 'original-tool',
        authorizationDigest: 'a'.repeat(64),
        interactionId: 'question',
        decisionRevision: '1',
      },
    ])
      await expect(
        f.host.request({ op: 'commitGrant', requestId: grant.requestId, ...fields }),
      ).rejects.toThrow('page_request_invalid');
    expect((await f.inspect(grant.requestId)).state).toBe('question');
    expect(f.host.state('a')?.phase).toBe('human');
    expect(page.attached).toBe(0);
    expect(f.created).toEqual([]);
    expect((await f.commitAuthorized(grant.requestId)).state).toBe('committed');
  } finally {
    f.dispose();
  }
});

test('original dispatch cannot revive changed navigation, selection, cancellation or a foreign request', async () => {
  for (const change of ['navigation', 'selection', 'cancel'] as const) {
    const f = fixture();
    try {
      const page = f.add('a');
      f.host.present('a', true);
      const grant = await f.prepare();
      if (change === 'navigation') f.host.navigate('a');
      if (change === 'selection') f.selected = { ...f.selected, viewSelection: 2 };
      if (change === 'cancel') await f.cancel(grant.requestId);
      const result = await f.commitAuthorized(grant.requestId);
      expect(result.state).toBe(change === 'cancel' ? 'cancelled' : 'expired');
      await expect(f.acquire(grant.requestId)).rejects.toThrow('grant');
      await expect(f.commitAuthorized(randomUUID())).rejects.toThrow('grant_unavailable');
      expect(page.attached).toBe(0);
      expect(f.host.state('a')?.phase).toBe('human');
    } finally {
      f.dispose();
    }
  }
});

test('Question grant pins one exact page, commits one receipt once, and cannot be borrowed by a legacy or foreign intent', async () => {
  const f = fixture();
  try {
    const page = f.add('a');
    f.host.present('a', true);
    const grant = await f.prepare();
    expect(grant.state).toBe('question');
    expect(grant.page).toEqual({
      kind: 'existing',
      id: 'a',
      title: 'Page a',
      url: 'https://example.test/destination',
    });
    expect(page.attached).toBe(0);
    expect(f.host.state('a')?.phase).toBe('human');
    expect((await f.commit(grant.requestId)).state).toBe('committed');
    expect(await f.commit(grant.requestId)).toEqual(await f.inspect(grant.requestId));
    expect(f.host.state('a')?.phase).toBe('armed');
    await expect(f.commit(grant.requestId, 'another-question')).rejects.toThrow('receipt_conflict');
    await expect(f.acquire()).rejects.toThrow('explicit_grant_required');
    await expect(
      f.host.request({
        op: 'acquire',
        ...scope,
        executionId: 'browser-job',
        browserId: 'open',
        grantId: grant.requestId,
        grantExecutionId: 'foreign-tool',
      }),
    ).rejects.toThrow('grant_changed');
    await expect(f.acquire(grant.requestId, 'another-open')).rejects.toThrow('grant');
    const lease = await f.acquire(grant.requestId);
    expect(lease).toMatchObject({ pageId: 'a' });
    expect(page.attached).toBe(1);
    expect((await f.inspect(grant.requestId)).consumed).toBe(true);
    expect((await f.cancel(grant.requestId)).state).toBe('committed');
    expect(f.host.state('a')?.phase).toBe('acquiring');
    await expect(f.acquire(grant.requestId)).rejects.toThrow('grant_consumed');
  } finally {
    f.dispose();
  }
});

test('new-page approval allocates nothing before consent, survives lost commit acknowledgement, and cancels only its unused blank page', async () => {
  const f = fixture();
  try {
    const grant = await f.prepare();
    expect(grant.state).toBe('question');
    expect(grant.page.kind).toBe('new');
    expect(f.pages.size).toBe(0);
    await f.commit(grant.requestId); // Deliberately discard this original response.
    const recovered = await f.inspect(grant.requestId);
    expect(recovered.state).toBe('committed');
    expect(f.created).toHaveLength(1);
    expect(recovered.page.id).toBe(f.created[0]);
    expect(f.pages.get(recovered.page.id!)?.url).toBe('');
    await f.commit(grant.requestId);
    expect(f.created).toHaveLength(1);
    expect((await f.cancel(grant.requestId)).state).toBe('cancelled');
    expect(f.pages.size).toBe(0);
    expect(f.closed).toEqual(f.created);
    await f.cancel(grant.requestId);
    expect(f.closed).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

test('existing manual grant is a zero-Question pinned fast path even in the background', async () => {
  const f = fixture();
  try {
    f.add('a');
    f.host.arm('a', scope);
    f.selected = { ...f.selected, sessionId: 'background-b', viewSelection: 2 };
    const grant = await f.prepare();
    expect(grant.state).toBe('ready');
    expect(grant.page.id).toBe('a');
    await expect(f.acquire()).rejects.toThrow('explicit_grant_required');
    expect(await f.acquire(grant.requestId)).toMatchObject({ pageId: 'a' });
    expect(f.pages.get('a')?.attached).toBe(1);
  } finally {
    f.dispose();
  }
});

test('rejection/cancellation creates no page and repeated preparation cannot change an original intent', async () => {
  const f = fixture();
  try {
    const grant = await f.prepare();
    expect(await f.prepare(grant.requestId)).toEqual(grant);
    await expect(f.prepare(grant.requestId, 'different')).rejects.toThrow('intent_conflict');
    await expect(f.prepare()).rejects.toThrow('grant_pending');
    expect((await f.cancel(grant.requestId)).state).toBe('cancelled');
    expect((await f.commit(grant.requestId)).state).toBe('cancelled');
    expect(f.created).toHaveLength(0);
    await expect(f.acquire(grant.requestId)).rejects.toThrow('grant');
  } finally {
    f.dispose();
  }
});

for (const change of ['selection', 'navigation'] as const)
  test(`a ${change} change expires the original Question without granting its replacement`, async () => {
    const f = fixture();
    try {
      f.add('a');
      const grant = await f.prepare();
      if (change === 'selection')
        f.selected = { ...f.selected, viewSelection: 3 }; // A-B-A
      else f.host.navigate('a');
      expect((await f.commit(grant.requestId)).state).toBe('expired');
      expect(f.host.state('a')?.phase).toBe('human');
      await expect(f.acquire(grant.requestId)).rejects.toThrow('grant');
    } finally {
      f.dispose();
    }
  });

test('withdrawal and a later manual grant cannot be adopted or undone by an older proposal', async () => {
  const f = fixture();
  try {
    f.add('a');
    f.add('b', scope, 'https://example.test/other');
    f.host.present('a', true);
    const grant = await f.prepare();
    await f.commit(grant.requestId);
    f.host.arm('a', scope); // Withdraw the proposal's armed grant.
    expect(f.host.state('a')?.phase).toBe('human');
    f.host.arm('b', scope);
    await expect(f.acquire(grant.requestId)).rejects.toThrow('grant');
    await f.cancel(grant.requestId);
    expect(f.host.state('b')?.phase).toBe('armed');
    expect(await f.acquire()).toMatchObject({ pageId: 'b' });
  } finally {
    f.dispose();
  }
});

test('expiry reclaims only the untouched unconsumed page; navigation and a newer manual grant preserve human work', async () => {
  const f = fixture();
  try {
    const first = await f.prepare();
    const committed = await f.commit(first.requestId);
    setSystemTime(new Date(committed.expiresAt + 1));
    expect((await f.inspect(first.requestId)).state).toBe('expired');
    expect(f.pages.size).toBe(0);
    const next = await f.prepare();
    const second = await f.commit(next.requestId);
    const id = second.page.id!;
    f.host.arm(id, scope);
    f.host.arm(id, scope); // A new explicit manual authorization.
    await f.cancel(next.requestId);
    expect(f.pages.has(id)).toBe(true);
    expect(f.host.state(id)?.phase).toBe('armed');
  } finally {
    setSystemTime();
    f.dispose();
  }
});

test('ambiguous matching pages fail while new proposals still reserve the last page slot', async () => {
  const f = fixture();
  try {
    f.add('a');
    f.add('b');
    await expect(f.prepare()).rejects.toThrow('browser_page_existing_ambiguous');
    expect(f.created).toHaveLength(0);
  } finally {
    f.dispose();
  }
  const full = fixture();
  try {
    for (let i = 0; i < 7; i++) full.add(`other-${i}`, { ...scope, sessionId: 'other' });
    const grant = await full.prepare();
    expect(() => full.add('manual-last')).toThrow('capacity');
    await full.commit(grant.requestId);
    expect(full.pages.size).toBe(8);
  } finally {
    full.dispose();
  }
});

test('a new manual grant during a Question expires it rather than creating two armed pages', async () => {
  const f = fixture();
  try {
    f.add('a');
    f.add('b', scope, 'https://example.test/other');
    f.host.present('a', true);
    const grant = await f.prepare();
    f.host.arm('b', scope);
    expect((await f.commit(grant.requestId)).state).toBe('expired');
    expect(f.host.state('a')?.phase).toBe('human');
    expect(f.host.state('b')?.phase).toBe('armed');
  } finally {
    f.dispose();
  }
});

test('prepared manual fast path and committed Question both reject later selection or navigation changes', async () => {
  for (const mode of ['ready-selection', 'committed-selection', 'committed-navigation'] as const) {
    const f = fixture();
    try {
      f.add('a');
      if (mode === 'ready-selection') f.host.arm('a', scope);
      const grant = await f.prepare();
      if (mode !== 'ready-selection') await f.commit(grant.requestId);
      if (mode === 'committed-navigation') f.host.navigate('a');
      else f.selected = { ...f.selected, viewSelection: 3 };
      await expect(f.acquire(grant.requestId)).rejects.toThrow('grant_changed');
      expect(f.pages.get('a')?.attached).toBe(0);
      expect(f.host.state('a')?.phase).toBe(mode === 'ready-selection' ? 'armed' : 'human');
    } finally {
      f.dispose();
    }
  }
});

test('cancellation disarms an unused proposal but does not close a newly created page that the human navigated', async () => {
  const f = fixture();
  try {
    const grant = await f.prepare();
    const committed = await f.commit(grant.requestId);
    const id = committed.page.id!;
    f.host.navigate(id);
    f.pages.get(id)!.url = 'https://example.test/human-work';
    await f.cancel(grant.requestId);
    expect(f.pages.has(id)).toBe(true);
    expect(f.host.state(id)?.phase).toBe('human');
    expect(f.closed).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

test('cancelled or new proposals never wash an actual lease unknown into manual authority', async () => {
  const f = fixture();
  try {
    f.add('a');
    const grant = await f.prepare();
    await f.commit(grant.requestId);
    await f.acquire(grant.requestId);
    f.host.fail('a');
    await f.cancel(grant.requestId);
    expect(f.host.state('a')?.phase).toBe('unknown');
    await expect(f.prepare(randomUUID(), 'next')).rejects.toThrow('already_bound');
    expect(() => f.host.arm('a', scope)).toThrow('grant_denied');
    expect(f.host.state('a')?.phase).toBe('unknown');
  } finally {
    f.dispose();
  }
});

test('requireExisting pins a matching live page, echoes the intent and recovers the original commit without allocation or navigation', async () => {
  for (const mode of ['question', 'manual'] as const) {
    const f = fixture();
    try {
      const page = f.add('retained', scope, 'https://EXAMPLE.test:443/destination');
      if (mode === 'manual') f.host.arm('retained', scope);
      let capacityChecks = 0;
      f.host.assertCanCreate = () => {
        capacityChecks++;
        throw Error('existing_must_not_check_creation');
      };
      const requestId = randomUUID(),
        first = await f.prepare(requestId, 'open', existingFields(f));
      expect(first).toMatchObject({
        requireExisting: true,
        state: mode === 'manual' ? 'ready' : 'question',
        page: { kind: 'existing', id: 'retained', url: page.url },
      });
      expect(await f.prepare(requestId, 'open', existingFields(f))).toEqual(first);
      // The first reply can be lost; inspect and exact receipt reentry keep the same page.
      const committed = await f.commitAuthorized(requestId);
      expect(committed).toMatchObject({ requireExisting: true, page: { id: 'retained' } });
      expect(await f.inspect(requestId)).toEqual(committed);
      expect(await f.commitAuthorized(requestId)).toEqual(committed);
      expect(capacityChecks).toBe(0);
      expect(f.created).toEqual([]);
      expect(f.closed).toEqual([]);
      expect(page.attached).toBe(0);
      expect(f.sent).toEqual([]);
      expect(await f.acquire(requestId)).toMatchObject({ pageId: 'retained' });
      expect(page.attached).toBe(1);
      expect(f.sent).toEqual([]);
    } finally {
      f.dispose();
    }
  }
});

test('requireExisting missing, foreign and ambiguous pages reject before capacity checks, allocation or CDP', async () => {
  for (const mode of ['missing', 'foreign-store', 'foreign-session', 'ambiguous'] as const) {
    const f = fixture();
    try {
      if (mode === 'foreign-store')
        f.add('foreign', { ...scope, storeId: 'other-store' }, 'https://example.test/destination');
      if (mode === 'foreign-session')
        f.add(
          'foreign',
          { ...scope, sessionId: 'other-session' },
          'https://example.test/destination',
        );
      if (mode === 'ambiguous') {
        f.add('a', scope, 'https://example.test/destination');
        f.add('b', scope, 'https://example.test/destination');
      }
      let capacityChecks = 0;
      f.host.assertCanCreate = () => {
        capacityChecks++;
      };
      const requestId = randomUUID();
      const error = await f.prepare(requestId, 'open', existingFields(f)).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('browser_page_existing_missing');
      expect(serializeBrowserPageFailure(error, { op: 'prepareGrant' })).toEqual({
        kind: 'not_dispatched',
        op: 'prepareGrant',
      });
      await expect(f.inspect(requestId)).rejects.toThrow('grant_unavailable');
      expect(capacityChecks).toBe(0);
      expect(f.created).toEqual([]);
      expect(f.closed).toEqual([]);
      expect(f.sent).toEqual([]);
      expect([...f.pages.values()].every((page) => page.attached === 0)).toBe(true);
    } finally {
      f.dispose();
    }
  }
});

test('requireExisting mismatched or blank URLs never navigate an existing page to satisfy the request', async () => {
  for (const url of [
    '',
    'https://example.test/changed',
    'https://example.test/destination#other',
    'file:///private/tmp/page',
  ]) {
    const f = fixture();
    try {
      const page = f.add('retained', scope, url);
      f.host.assertCanCreate = () => {
        throw Error('must_not_create');
      };
      await expect(f.prepare(randomUUID(), 'open', existingFields(f))).rejects.toThrow(
        'browser_page_existing_mismatch',
      );
      expect(page.url).toBe(url);
      expect(f.host.state('retained')?.phase).toBe('human');
      expect(page.attached).toBe(0);
      expect(f.created).toEqual([]);
      expect(f.sent).toEqual([]);
    } finally {
      f.dispose();
    }
  }
});

test('requireExisting is strict and bound to the first request; prepare, inspect and commit cannot flip or inject it', async () => {
  for (const required of [false, true]) {
    const f = fixture();
    try {
      f.add('retained', scope, 'https://example.test/destination');
      const requestId = randomUUID(),
        fields = required ? existingFields(f) : {},
        first = await f.prepare(requestId, 'open', fields);
      await expect(f.prepare(requestId, 'open', required ? {} : existingFields(f))).rejects.toThrow(
        'intent_conflict',
      );
      for (const requireExisting of [false, null, 0, 'true'])
        await expect(f.prepare(randomUUID(), 'open', { requireExisting })).rejects.toThrow(
          'page_request_invalid',
        );
      for (const op of ['inspectGrant', 'commitGrant'])
        await expect(f.host.request({ op, requestId, requireExisting: true })).rejects.toThrow(
          'page_request_invalid',
        );
      expect(await f.inspect(requestId)).toEqual(first);
      expect((await f.commitAuthorized(requestId)).requireExisting).toBe(
        required ? true : undefined,
      );
      await expect(f.commitAuthorized(requestId, 'b'.repeat(64))).rejects.toThrow(
        'receipt_conflict',
      );
      expect(f.created).toEqual([]);
      expect(f.sent).toEqual([]);
    } finally {
      f.dispose();
    }
  }
});

test('requireExisting rechecks the original live incarnation, navigation and URL before commit and acquire', async () => {
  for (const stage of ['prepared', 'committed'] as const)
    for (const change of ['url', 'navigation', 'closed', 'replaced'] as const) {
      const f = fixture();
      try {
        const page = f.add('retained', scope, 'https://example.test/destination'),
          requestId = randomUUID(),
          fields = existingFields(f);
        await f.prepare(requestId, 'open', fields);
        if (stage === 'committed') await f.commitAuthorized(requestId);
        if (change === 'url') page.url = 'https://example.test/human-change';
        if (change === 'navigation') f.host.navigate('retained');
        if (change === 'closed' || change === 'replaced') {
          page.remove();
          f.pages.delete('retained');
          if (change === 'replaced') f.add('retained', scope, 'https://example.test/destination');
        }
        const op = stage === 'prepared' ? 'commitGrant' : 'acquire',
          error = await (stage === 'prepared'
            ? f.commitAuthorized(requestId)
            : f.acquire(requestId)
          ).catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error instanceof Error ? error.message : undefined).toBe(
          change === 'closed' ? 'browser_page_existing_missing' : 'browser_page_existing_mismatch',
        );
        expect(serializeBrowserPageFailure(error, { op })).toEqual({ kind: 'not_dispatched', op });
        expect(await f.inspect(requestId)).toMatchObject({
          state: 'expired',
          requireExisting: true,
          consumed: false,
        });
        expect(f.created).toEqual([]);
        expect(f.closed).toEqual([]);
        expect(f.sent).toEqual([]);
        expect([...f.pages.values()].every((row) => row.attached === 0)).toBe(true);
        // Reentry cannot retarget even a replacement with the same id and URL.
        await expect(f.prepare(requestId, 'open', fields)).rejects.toThrow(
          change === 'closed' ? 'existing_missing' : 'existing_mismatch',
        );
      } finally {
        f.dispose();
      }
    }
});

test('exact retained identity survives foreground selection changes while cancellation still denies acquisition', async () => {
  for (const change of ['selection', 'cancel'] as const) {
    const f = fixture();
    try {
      const page = f.add('retained', scope, 'https://example.test/destination'),
        grant = await f.prepare(randomUUID(), 'open', existingFields(f));
      if (change === 'selection') f.selected = { ...f.selected, viewSelection: 2 };
      else await f.cancel(grant.requestId);
      expect(await f.commitAuthorized(grant.requestId)).toMatchObject({
        state: change === 'cancel' ? 'cancelled' : 'committed',
        requireExisting: true,
      });
      if (change === 'cancel') {
        await expect(f.acquire(grant.requestId)).rejects.toThrow('grant_changed');
        expect(page.attached).toBe(0);
        expect(f.host.state('retained')?.phase).toBe('human');
      } else {
        expect(await f.acquire(grant.requestId)).toMatchObject({ pageId: 'retained' });
        expect(page.attached).toBe(1);
      }
      expect(f.created).toEqual([]);
      expect(f.sent).toEqual([]);
    } finally {
      f.dispose();
    }
  }
});

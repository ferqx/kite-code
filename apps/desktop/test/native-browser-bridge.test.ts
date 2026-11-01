import { expect, test } from 'bun:test';
import {
  browserAddress,
  isNativeBrowserClosePreparation,
  isNativeBrowserDraftRestoreResult,
  isNativeBrowserFrozenFrame,
  isNativeBrowserLayoutFrameAck,
  isNativeBrowserPresentationFrame,
  isNativeBrowserPresentationRequest,
  isNativeBrowserRestoreResult,
  isNativeBrowserState,
  type NativeBrowserLayout,
  parseNativeBrowserMenuRequest,
  parseNativeBrowserRequest,
  projectNativeBrowserBounds,
  projectNativeBrowserLayout,
} from '../src/native-browser-bridge';

test('native layout projection returns independent constrained allocations for the next resize', () => {
  const panel = (size: number, min: number) => ({
    size,
    min,
    minUnit: 'px' as const,
    max: 100,
    maxUnit: '%' as const,
    preserve: 'relative' as const,
    collapsible: false,
  });
  const layout: NativeBrowserLayout = {
    windowWidth: 1601,
    windowHeight: 1200,
    insetLeft: 0,
    insetRight: 0,
    groups: [{ left: 0, right: 0, gap: 1, panels: [panel(1300, 360), panel(300, 300)] }],
  };
  const bounds = { x: 1301, y: 100, width: 300, height: 600, radius: 8 };
  const source = structuredClone({ bounds, layout });
  const narrow = projectNativeBrowserLayout(bounds, layout, 1001, 1100)!;
  expect(narrow.bounds).toEqual({ ...bounds, x: 701, width: 300, height: 500 });
  expect(narrow.layout.windowWidth).toBe(1001);
  expect(narrow.layout.windowHeight).toBe(1100);
  expect(narrow.layout.groups[0]!.panels.map((p) => p.size)).toEqual([700, 300]);
  expect(projectNativeBrowserBounds(bounds, layout, 1001, 1100)).toEqual(narrow.bounds);
  const expanded = projectNativeBrowserLayout(narrow.bounds, narrow.layout, 1601, 1200)!;
  expect(expanded.bounds).toEqual({ ...bounds, x: 1121, width: 480 });
  expect(expanded.layout.groups[0]!.panels.map((p) => p.size)).toEqual([1120, 480]);
  expect({ bounds, layout }).toEqual(source);
  expect(narrow.layout).not.toBe(layout);
  expect(narrow.layout.groups[0]).not.toBe(layout.groups[0]);
  expect(narrow.layout.groups[0]!.panels[0]).not.toBe(layout.groups[0]!.panels[0]);
  expect(projectNativeBrowserLayout(bounds, layout, Number.NaN, 1200)).toBeUndefined();
  expect(projectNativeBrowserLayout(bounds, layout, 1, 1200)).toBeUndefined();
});

test('a draft owner is confined to manual browser requests and cannot mix session or Agent presentation authority', () => {
  const draft = 'a'.repeat(32),
    id = 'draft-page';
  const scope = { storeId: 's', sessionId: 'e', generation: 1, viewSelection: 2 };
  const navigate = { action: 'navigate' as const, id, draft, input: 'https://www.baidu.com/' };
  expect(parseNativeBrowserRequest(navigate)).toEqual(navigate);
  for (const action of ['state', 'back', 'forward', 'reload', 'stop', 'close'] as const)
    expect(parseNativeBrowserRequest({ action, id, draft })).toEqual({ action, id, draft });
  expect(parseNativeBrowserRequest({ action: 'restoreDraft', draft })).toEqual({
    action: 'restoreDraft',
    draft,
  });
  for (const value of [
    { ...navigate, draft: '' },
    { ...navigate, draft: 'A'.repeat(32) },
    { ...navigate, draft: 'a'.repeat(31) },
    { ...navigate, scope },
    { action: 'grant', id, draft },
    { action: 'capturePresentation', id, draft },
    { action: 'restore', scope, draft },
    { action: 'restoreDraft', draft, scope },
    { action: 'restoreDraft', draft, id },
    { action: 'restoreDraft', draft, grant: true },
    { action: 'present', id, draft, scope, bounds: null, presentationRevision: 1 },
    {
      action: 'present',
      id,
      draft,
      bounds: null,
      presentationKey: 'proof',
      presentationRevision: 1,
    },
  ])
    expect(() => parseNativeBrowserRequest(value)).toThrow('invalid_browser_request');
});

test('fresh presentation requests carry one exact Session or draft owner and no control or execution fields', () => {
  const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 0 };
  const request = { id: 'page_1-restore', key: 'a'.repeat(32), scope };
  const draft = { id: request.id, key: 'b'.repeat(32), draft: 'c'.repeat(32) };
  expect(isNativeBrowserPresentationRequest(request)).toBe(true);
  expect(isNativeBrowserPresentationRequest(draft)).toBe(true);
  for (const invalid of [
    null,
    [],
    {},
    { id: request.id, key: request.key },
    { ...request, scope: undefined },
    { ...request, draft: draft.draft },
    { ...request, scope: { storeId: scope.storeId, sessionId: scope.sessionId } },
    { ...request, scope: { ...scope, generation: 0 } },
    { ...request, scope: { ...scope, viewSelection: -1 } },
    { ...request, scope: { ...scope, viewSelection: 1.5 } },
    { ...request, scope: { ...scope, extra: true } },
    { ...draft, draft: '' },
    { ...draft, draft: 'C'.repeat(32) },
    { ...draft, draft: 'c'.repeat(31) },
    { ...request, id: '' },
    { ...request, id: 'page with spaces' },
    { ...request, id: 'p'.repeat(65) },
    { ...request, key: '' },
    { ...request, key: 'A'.repeat(32) },
    { ...request, key: 'a'.repeat(31) },
    { ...request, key: 'a'.repeat(33) },
    { ...request, key: 1 },
    { ...request, url: 'https://example.com/' },
    { ...request, bounds: { x: 0, y: 0, width: 100, height: 100 } },
    { ...request, lease: 'private-control' },
    { ...request, code: 'replay()' },
    { ...request, action: 'navigate' },
  ])
    expect(isNativeBrowserPresentationRequest(invalid)).toBe(false);
});

test('Root close preparation and confirmation transport only one bounded marker receipt and an exact private key', () => {
  const draft = 'a'.repeat(32),
    id = 'page',
    key = 'b'.repeat(32);
  for (const request of [
    { action: 'prepareClose', id },
    { action: 'prepareClose', id, draft },
    ...(['confirmClose', 'finishClose', 'cancelClose'] as const).map((action) => ({ action, key })),
  ] as const)
    expect(parseNativeBrowserRequest(request)).toEqual(request);
  for (const request of [
    { action: 'prepareClose', id, scope: {} },
    { action: 'prepareClose', id, draft: 'invalid' },
    { action: 'prepareClose', id, lease: 'secret' },
    { action: 'confirmClose', key: 'bad' },
    { action: 'finishClose', key, id },
    { action: 'cancelClose', key, draft },
  ])
    expect(() => parseNativeBrowserRequest(request)).toThrow('invalid_browser_request');
  const receipt = {
    key,
    witness: 'c'.repeat(24),
    bounds: { x: 600, y: 0, width: 400, height: 96, radius: 0 },
    width: 1000,
    height: 700,
  };
  expect(isNativeBrowserClosePreparation(receipt)).toBe(true);
  expect(
    isNativeBrowserClosePreparation({
      ...receipt,
      bounds: { ...receipt.bounds, x: 600 / 1.2, width: 400 / 1.2, height: 96 / 1.2 },
      width: 1000 / 1.2,
      height: 700 / 1.2,
    }),
  ).toBe(true);
  for (const bad of [
    null,
    [],
    { ...receipt, key: 'wrong' },
    { ...receipt, witness: 'd'.repeat(32) },
    { ...receipt, scope: {} },
    { ...receipt, frame: { data: 'private' } },
    { ...receipt, width: NaN },
    { ...receipt, bounds: { ...receipt.bounds, width: 401 } },
    { ...receipt, bounds: { ...receipt.bounds, height: 0 } },
    { ...receipt, bounds: { ...receipt.bounds, secret: true } },
  ])
    expect(isNativeBrowserClosePreparation(bad)).toBe(false);
});

test('Root draw witnesses and asynchronous frozen pixels stay finite and bound to a presentation', () => {
  const scope = { storeId: 's', sessionId: 'e', generation: 1, viewSelection: 2 };
  const witness = { key: '00112233445566778899aabb', step: 1 as const };
  const panel = (size: number) => ({
    size,
    min: 0,
    minUnit: 'px' as const,
    max: 100,
    maxUnit: '%' as const,
    preserve: 'relative' as const,
    collapsible: false,
  });
  const request = {
    action: 'present' as const,
    id: 'page',
    scope,
    presentationRevision: 1,
    witness,
    bounds: { x: 201, y: 100, width: 599, height: 500, radius: 0 },
    layout: {
      windowWidth: 800,
      windowHeight: 600,
      insetLeft: 0,
      insetRight: 0,
      groups: [
        {
          left: 0,
          right: 0,
          gap: 1,
          panels: [panel(200), panel(599)] as const,
        },
      ],
    },
  };
  expect(parseNativeBrowserRequest(request)).toEqual(request);
  const draft = 'a'.repeat(32),
    draftRequest = { ...request, scope: undefined, draft };
  expect(parseNativeBrowserRequest(draftRequest)).toEqual(draftRequest);
  expect(() =>
    parseNativeBrowserRequest({ ...draftRequest, presentationRevision: undefined }),
  ).toThrow();
  expect(() => parseNativeBrowserRequest({ ...draftRequest, scope })).toThrow();
  for (const value of [
    { ...request, witness: { ...witness, step: 0 } },
    { ...request, witness: { ...witness, key: 'not-a-paint' } },
    { ...request, witness: { ...witness, target: 'other' } },
    { ...request, layout: undefined },
    { ...request, bounds: null },
    { ...request, scope: undefined },
    { ...request, frozen: '/private/page.png' },
  ])
    expect(() => parseNativeBrowserRequest(value)).toThrow();
  const frozen = {
    key: '00112233445566778899aabbccddeeff',
    mimeType: 'image/png',
    data: 'iVBORw0KGgo=',
    width: 1,
    height: 1,
    cssWidth: 320,
    cssHeight: 500,
    rootZoom: 1.25,
  };
  const ack = { id: 'page', scope, presentationRevision: 1, key: witness.key, step: 0, frozen };
  expect(isNativeBrowserLayoutFrameAck(ack)).toBe(true);
  expect(isNativeBrowserLayoutFrameAck({ ...ack, scope: undefined, draft })).toBe(true);
  for (const value of [
    { ...ack, draft },
    { ...ack, scope: undefined },
    { ...ack, scope: undefined, draft: 'A'.repeat(32) },
  ])
    expect(isNativeBrowserLayoutFrameAck(value)).toBe(false);
  const presented = { ...ack, step: 2, frozen: undefined };
  for (const value of [
    { ...presented, presented: false },
    { ...presented, presented: true },
    { ...presented, presented: false, error: 'browser_presentation_unavailable' },
  ])
    expect(isNativeBrowserLayoutFrameAck(value)).toBe(true);
  for (const value of [
    { ...ack, presented: true },
    { ...presented, presented: 'yes' },
    { ...presented, error: 'browser_presentation_unavailable' },
    { ...presented, presented: true, error: 'browser_presentation_unavailable' },
    { ...presented, presented: false, error: 'arbitrary_error' },
  ])
    expect(isNativeBrowserLayoutFrameAck(value)).toBe(false);
  for (const value of [
    { ...ack, step: 3 },
    { ...ack, scope: { ...scope, generation: 0 } },
    { ...ack, witness: true },
    { ...ack, key: 'old' },
    { ...ack, frozen: { ...frozen, data: 'file:///secret' } },
  ])
    expect(isNativeBrowserLayoutFrameAck(value)).toBe(false);
  expect(isNativeBrowserFrozenFrame({ ...frozen, width: 20000 })).toBe(false);
  expect(isNativeBrowserFrozenFrame({ ...frozen, data: 'x'.repeat(5600001) })).toBe(false);
});

test('browser addresses accept normal websites and local development URLs; plain text becomes an explicit search', () => {
  expect(browserAddress(' example.com/docs ')).toBe('https://example.com/docs');
  expect(browserAddress('example.com:8443/a')).toBe('https://example.com:8443/a');
  expect(browserAddress('localhost:3000/a')).toBe('http://localhost:3000/a');
  expect(browserAddress('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
  expect(browserAddress('[::1]:3000')).toBe('http://[::1]:3000/');
  expect(browserAddress('https://example.com/?q=中文')).toBe(
    'https://example.com/?q=%E4%B8%AD%E6%96%87',
  );
  expect(browserAddress('Electron tabs')).toBe('https://www.bing.com/search?q=Electron%20tabs');
});
test('local files, external handlers, credentials and malformed addresses cannot become browser navigation', () => {
  for (const value of [
    'file:///C:/private.txt',
    'javascript:alert(1)',
    'data:text/html,hello',
    'devtools://devtools',
    'kite://open',
    'C:\\private.txt',
    'https://user:secret@example.com',
    'http://',
    '',
    'a'.repeat(2049),
    'https://exam\u0000ple.com',
  ])
    expect(() => browserAddress(value)).toThrow();
});
test('browser requests are closed and finite before allocating any native view', () => {
  const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 2 };
  expect(parseNativeBrowserRequest({ action: 'restore', scope })).toEqual({
    action: 'restore',
    scope,
  });
  expect(
    parseNativeBrowserRequest({
      action: 'navigate',
      id: 'browser-1',
      input: 'https://example.com',
    }),
  ).toEqual({ action: 'navigate', id: 'browser-1', input: 'https://example.com' });
  expect(parseNativeBrowserRequest({ action: 'present', id: 'browser-1', bounds: null })).toEqual({
    action: 'present',
    id: 'browser-1',
    bounds: null,
  });
  const bounds = { x: 20, y: 100, width: 400, height: 500, radius: 16 };
  expect(parseNativeBrowserRequest({ action: 'present', id: 'browser-1', bounds })).toEqual({
    action: 'present',
    id: 'browser-1',
    bounds,
  });
  for (const value of [
    null,
    [],
    { action: 'navigate', id: '../app', input: 'https://example.com' },
    { action: 'navigate', id: 'b', input: 'https://example.com', preload: 'evil' },
    { action: 'present', id: 'b', bounds: { ...bounds, x: Number.NaN } },
    { action: 'present', id: 'b', bounds: { ...bounds, radius: 100 } },
    { action: 'present', id: 'b', bounds: { ...bounds, width: -1 } },
    { action: 'present', id: 'b', bounds: { ...bounds, secret: true } },
    { action: 'executeJavaScript', id: 'b' },
    { action: 'restore', id: 'b' },
    { action: 'restore' },
    { action: 'restore', scope: { ...scope, sessionId: '' } },
    { action: 'restore', scope: { ...scope, generation: 0 } },
    { action: 'restore', sessionId: 'foreign' },
  ])
    expect(() => parseNativeBrowserRequest(value)).toThrow();
});
test('only bounded display metadata crosses the browser event channel', () => {
  const state = {
    id: 'b',
    url: 'https://example.com',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  expect(isNativeBrowserState(state)).toBe(true);
  expect(isNativeBrowserState({ ...state, error: 'load_failed' })).toBe(true);
  for (const value of [
    { ...state, title: 'x'.repeat(129) },
    { ...state, cookie: 'secret' },
    { ...state, error: 'raw server data' },
    { ...state, loading: 'yes' },
    { ...state, id: '' },
  ])
    expect(isNativeBrowserState(value)).toBe(false);
});

test('scoped multi-page restore remains compatible with the original single-page result and rejects invalid inventories', () => {
  const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 2 };
  const page = {
    id: 'original',
    url: 'https://example.test/',
    title: 'Original',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  const other = { ...page, id: 'other', title: 'Other' };
  expect(isNativeBrowserRestoreResult({ scope, page })).toBe(true);
  expect(isNativeBrowserRestoreResult({ scope, page: null })).toBe(true);
  expect(
    isNativeBrowserRestoreResult({ scope, page, pages: [page, other], activeId: page.id }),
  ).toBe(true);
  expect(
    isNativeBrowserRestoreResult({ scope, page, pages: [page, other], activeId: other.id }),
  ).toBe(true);
  expect(
    isNativeBrowserRestoreResult({
      scope,
      page,
      pages: [page, other],
      activeId: other.id,
      reveal: true,
    }),
  ).toBe(true);
  expect(isNativeBrowserRestoreResult({ scope, page: null, pages: [] })).toBe(true);
  for (const value of [
    { scope, page, pages: [other] },
    { scope, page, pages: [page, page] },
    {
      scope,
      page,
      pages: Array.from({ length: 9 }, (_, index) => ({ ...page, id: `page-${index}` })),
    },
    { scope, page, activeId: other.id },
    { scope, page: null, pages: [page] },
    { scope, page, pages: [page], permission: true },
    { scope, page, reveal: true },
    { scope, page: null, activeId: page.id, reveal: true },
    { scope, page, activeId: page.id, reveal: false },
  ])
    expect(isNativeBrowserRestoreResult(value)).toBe(false);
});

test('draft restore returns only its bounded manual page inventory without a Core session or control grant', () => {
  const page = {
    id: 'draft-page',
    url: 'https://www.baidu.com/',
    title: 'Baidu',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  for (const value of [{ pages: [] }, { pages: [page] }, { pages: [page], activeId: page.id }])
    expect(isNativeBrowserDraftRestoreResult(value)).toBe(true);
  const control = {
    phase: 'human',
    incarnation: 'incarnation',
    navigation: 0,
    sessionId: 'session',
  };
  expect(isNativeBrowserState({ ...page, control })).toBe(true);
  for (const value of [
    null,
    [],
    {},
    { pages: null },
    { pages: [page, page] },
    { pages: Array.from({ length: 9 }, (_, i) => ({ ...page, id: `p${i}` })) },
    { pages: [], activeId: page.id },
    { pages: [page], activeId: 'other' },
    { pages: [page], scope: { storeId: 's', sessionId: 'e', generation: 1, viewSelection: 1 } },
    { pages: [page], draft: 'a'.repeat(32) },
    { pages: [page], lease: 'not-authority' },
    { pages: [page], page },
    { pages: [{ ...page, control }] },
    { pages: [{ ...page, script: 'unsafe' }] },
  ])
    expect(isNativeBrowserDraftRestoreResult(value)).toBe(false);
});

test('presentation layout accepts only the current bounded two-panel contract', () => {
  const panel = {
    size: 400,
    min: 240,
    minUnit: 'px' as const,
    max: 85,
    maxUnit: '%' as const,
    preserve: 'relative' as const,
    collapsible: true,
  };
  const layout: NativeBrowserLayout = {
    windowWidth: 1000,
    windowHeight: 800,
    insetLeft: 1,
    insetRight: 1,
    groups: [
      {
        left: 0,
        right: 0,
        gap: 1,
        panels: [{ ...panel, size: 599, min: 360, max: 100, collapsible: false }, panel],
      },
    ],
  };
  const bounds = { x: 601, y: 92, width: 398, height: 650, radius: 8 };
  const request = { action: 'present' as const, id: 'browser', bounds, layout };
  expect(parseNativeBrowserRequest(request)).toEqual(request);
  for (const bad of [
    { ...layout, secret: true },
    { ...layout, windowWidth: Number.NaN },
    { ...layout, windowHeight: 0 },
    { ...layout, insetLeft: -1 },
    { ...layout, insetRight: 32769 },
    { ...layout, groups: [] },
    { ...layout, groups: Array(1) },
    { ...layout, groups: [{ ...layout.groups[0], panels: Object.assign(Array(2), { 1: panel }) }] },
    { ...layout, groups: Array(3).fill(layout.groups[0]) },
    { ...layout, groups: [{ ...layout.groups[0], orientation: 'vertical' }] },
    { ...layout, groups: [{ ...layout.groups[0], gap: Number.POSITIVE_INFINITY }] },
    ...[
      { ...panel, size: -1 },
      { ...panel, minUnit: 'rem' },
      { ...panel, max: 101 },
      { ...panel, preserve: 'guessed' },
      { ...panel, collapsible: 1 },
      { ...panel, extra: true },
    ].map((badPanel) => ({
      ...layout,
      groups: [{ ...layout.groups[0], panels: [panel, badPanel] }],
    })),
    { ...layout, groups: [{ ...layout.groups[0], panels: [panel] }] },
  ])
    expect(() => parseNativeBrowserRequest({ ...request, layout: bad })).toThrow();
  expect(() => parseNativeBrowserRequest({ ...request, bounds: null })).toThrow();
  expect(projectNativeBrowserBounds(bounds, layout, Number.NaN, 800)).toBeUndefined();
  expect(projectNativeBrowserBounds(bounds, layout, 1, 800)).toBeUndefined();
});

test('private presentation capture accepts no scope/script input and only bounded PNG display replies', () => {
  expect(parseNativeBrowserRequest({ action: 'capturePresentation', id: 'page' })).toEqual({
    action: 'capturePresentation',
    id: 'page',
  });
  for (const extra of [{ scope: {} }, { script: '1' }, { proof: 'model-image' }])
    expect(() =>
      parseNativeBrowserRequest({ action: 'capturePresentation', id: 'page', ...extra }),
    ).toThrow();
  const request = {
    action: 'present' as const,
    id: 'page',
    bounds: null,
    presentationKey: 'opaque-key',
  };
  expect(parseNativeBrowserRequest(request)).toEqual(request);
  expect(() =>
    parseNativeBrowserRequest({
      ...request,
      bounds: { x: 0, y: 0, width: 2, height: 2, radius: 0 },
    }),
  ).toThrow();
  const value = {
    id: 'page',
    key: 'opaque-key',
    scope: { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 },
    cssX: 0,
    cssY: 0,
    cssWidth: 800,
    cssHeight: 600,
    frame: { mimeType: 'image/png', data: 'AA==', width: 1600, height: 1200 },
  };
  expect(isNativeBrowserPresentationFrame(value)).toBe(true);
  for (const bad of [
    { ...value, proof: 'imageRef' },
    { ...value, scope: { ...value.scope, generation: 0 } },
    { ...value, cssWidth: 0 },
    { ...value, frame: { ...value.frame, mimeType: 'image/svg+xml' } },
    { ...value, frame: { ...value.frame, data: 'https://remote/image' } },
    { ...value, frame: { ...value.frame, width: 99999 } },
  ])
    expect(isNativeBrowserPresentationFrame(bad)).toBe(false);
});

test('native popup accepts only a bounded finite menu on one exact selection', () => {
  const value = {
    requestId: 'menu-1',
    id: 'page',
    scope: { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 },
    incarnation: 'inc',
    navigation: 0,
    x: 20,
    y: 80,
    items: [
      { action: 'handoff', enabled: true },
      { action: 'close', enabled: false },
    ],
    details: ['Original reason'],
  } as const;
  expect(parseNativeBrowserMenuRequest(value)).toEqual(value);
  const draft = 'a'.repeat(32);
  expect(parseNativeBrowserMenuRequest({ ...value, scope: undefined, draft })).toEqual({
    ...value,
    scope: undefined,
    draft,
  });
  for (const invalid of [
    { ...value, draft },
    { ...value, scope: undefined },
    { ...value, scope: undefined, draft: 'invalid' },
    { ...value, scope: undefined, draft, items: [{ action: 'execute', enabled: true }] },
  ])
    expect(() => parseNativeBrowserMenuRequest(invalid)).toThrow('invalid_browser_request');
  for (const invalid of [
    { ...value, script: 'run()' },
    { ...value, scope: { ...value.scope, viewSelection: -1 } },
    { ...value, items: [{ action: 'resume', enabled: true }] },
    { ...value, items: [{ action: 'close', enabled: 'yes' }] },
    {
      ...value,
      items: [
        { action: 'close', enabled: true },
        { action: 'close', enabled: true },
      ],
    },
    { ...value, details: ['x'.repeat(16385)] },
    { ...value, x: Number.NaN },
  ])
    expect(() => parseNativeBrowserMenuRequest(invalid)).toThrow('invalid_browser_request');
});

test('internal layout revisions are positive finite integers and cannot bypass strict request fields', () => {
  const value = { action: 'present', id: 'page', bounds: null, presentationRevision: 2 } as const;
  expect(parseNativeBrowserRequest(value)).toEqual(value);
  for (const presentationRevision of [0, -1, 1.5, Infinity, '2'])
    expect(() => parseNativeBrowserRequest({ ...value, presentationRevision })).toThrow(
      'invalid_browser_request',
    );
  expect(() =>
    parseNativeBrowserRequest({
      ...value,
      scope: { storeId: 'store', sessionId: 'session', generation: 0, viewSelection: 1 },
    }),
  ).toThrow('invalid_browser_request');
});

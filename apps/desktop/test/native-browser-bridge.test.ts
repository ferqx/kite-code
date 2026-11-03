import { expect, test } from 'bun:test';
import {
  browserAddress,
  isNativeBrowserDraftRestoreResult,
  isNativeBrowserRestoreResult,
  isNativeBrowserState,
  type NativeBrowserLayout,
  parseNativeBrowserMenuRequest,
  parseNativeBrowserRequest,
  projectNativeBrowserBounds,
  projectNativeBrowserLayout,
} from '../src/native-browser-bridge';

test('native frame metadata is bounded paint-only geometry and survives native window projection', () => {
  const panel = {
    size: 0,
    min: 0,
    minUnit: 'px',
    max: 100,
    maxUnit: '%',
    preserve: 'relative',
    collapsible: false,
  } as const;
  const frame = {
    top: 38,
    bottom: 6,
    width: 1,
    color: [255, 255, 255, 0.08],
    grip: {
      left: -1,
      width: 3,
      height: 28,
      color: [181, 181, 181, 0.55],
      visible: true,
    },
  } as const;
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
        panels: [
          { ...panel, size: 599 },
          { ...panel, size: 400 },
        ],
      },
    ],
    frame,
  };
  const bounds = { x: 601, y: 100, width: 398, height: 694, radius: 0 };
  const request = {
    action: 'present' as const,
    id: 'page',
    bounds,
    layout,
    scope: { storeId: 's', sessionId: 'e', generation: 1, viewSelection: 1 },
    pageToken: 'current',
    presentationRevision: 1,
  };
  expect(parseNativeBrowserRequest(request)).toEqual(request);
  const projected = projectNativeBrowserLayout(bounds, layout, 1200, 900)!;
  expect(projected.layout.frame).toEqual(frame);
  expect(projected.bounds.x).toBeGreaterThan(bounds.x);
  for (const invalid of [
    { ...frame, top: -1 },
    { ...frame, bottom: 800 },
    { ...frame, width: 5 },
    { ...frame, color: [255, 255, 255, 2] },
    { ...frame, color: [255, 255, Number.NaN, 1] },
    { ...frame, color: [255, 255, 255] },
    { ...frame, color: Array(4) },
    { ...frame, input: true },
    ...[
      { ...frame.grip, left: 17 },
      { ...frame.grip, width: 9 },
      { ...frame.grip, height: 65 },
      { ...frame.grip, visible: 'true' },
      { ...frame.grip, control: 'human' },
    ].map((grip) => ({ ...frame, grip })),
  ])
    expect(() =>
      parseNativeBrowserRequest({ ...request, layout: { ...layout, frame: invalid } }),
    ).toThrow('invalid_browser_request');
});

test('sidebar animation keeps measured widths until a real window resize applies the target constraints', () => {
  for (const [size, min, max] of [
    [200, 0, 0],
    [100, 200, 320],
  ] as const) {
    const layout: NativeBrowserLayout = {
      windowWidth: 1000,
      windowHeight: 800,
      insetLeft: 0,
      insetRight: 0,
      groups: [
        {
          left: 0,
          right: 0,
          gap: 1,
          panels: [
            {
              size,
              min,
              max,
              minUnit: 'px',
              maxUnit: 'px',
              preserve: 'pixel',
              collapsible: false,
            },
            {
              size: 999 - size,
              min: 200,
              max: 100,
              minUnit: 'px',
              maxUnit: '%',
              preserve: 'relative',
              collapsible: false,
            },
          ],
        },
      ],
    };
    const bounds = { x: size + 1, y: 80, width: 999 - size, height: 720, radius: 0 };
    expect(projectNativeBrowserBounds(bounds, layout, 1000, 800)).toEqual(bounds);
    expect(projectNativeBrowserBounds(bounds, layout, 1000, 900)).toEqual({
      ...bounds,
      height: 820,
    });
    const resized = projectNativeBrowserLayout(bounds, layout, 1200, 800)!;
    expect(resized.layout.groups[0]!.panels[0].size).toBeCloseTo(min, 1);
    expect(resized.bounds.x).toBeCloseTo(min + 1, 1);
    expect(resized.bounds.width).toBeCloseTo(1199 - min, 1);
    // The measured panel boundary must still validate a caller's viewport.
    expect(projectNativeBrowserBounds({ ...bounds, x: 1 }, layout, 1000, 800)?.x).toBe(bounds.x);
  }
});

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
  for (const action of ['state', 'back', 'forward', 'reload', 'stop'] as const)
    expect(parseNativeBrowserRequest({ action, id, draft })).toEqual({ action, id, draft });
  expect(
    parseNativeBrowserRequest({ action: 'close', id, draft, pageToken: 'exact-token' }),
  ).toEqual({ action: 'close', id, draft, pageToken: 'exact-token' });
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
  expect(
    parseNativeBrowserRequest({
      action: 'present',
      id: 'browser-1',
      bounds: null,
      scope,
      pageToken: 'exact-token',
      presentationRevision: 1,
    }),
  ).toEqual({
    action: 'present',
    id: 'browser-1',
    bounds: null,
    scope,
    pageToken: 'exact-token',
    presentationRevision: 1,
  });
  const bounds = { x: 20, y: 100, width: 400, height: 500, radius: 16 };
  expect(
    parseNativeBrowserRequest({
      action: 'present',
      id: 'browser-1',
      bounds,
      scope,
      pageToken: 'exact-token',
      presentationRevision: 2,
    }),
  ).toEqual({
    action: 'present',
    id: 'browser-1',
    bounds,
    scope,
    pageToken: 'exact-token',
    presentationRevision: 2,
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
test('load failure metadata permits a finite reason and one error name, never logs or authority', () => {
  const state = {
    id: 'page',
    url: 'https://example.test/',
    title: '',
    loading: false,
    canGoBack: true,
    canGoForward: false,
    error: 'load_failed',
    failure: { kind: 'dns', code: 'ERR_NAME_NOT_RESOLVED' },
  };
  expect(isNativeBrowserState(state)).toBe(true);
  for (const failure of [
    { kind: 'unknown' },
    { kind: ['dns'] },
    { kind: 'dns', code: 'ERR_BAD\nstack trace' },
    { kind: 'dns', code: `ERR_${'A'.repeat(61)}` },
    { kind: 'dns', code: 105 },
    { kind: 'dns', details: 'private log' },
    { kind: 'dns', control: 'agent' },
  ])
    expect(isNativeBrowserState({ ...state, failure })).toBe(false);
  expect(isNativeBrowserState({ ...state, error: undefined })).toBe(false);
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
  const request = {
    action: 'present' as const,
    id: 'browser',
    bounds,
    layout,
    scope: { storeId: 's', sessionId: 'e', generation: 1, viewSelection: 2 },
    pageToken: 'exact-token',
    presentationRevision: 1,
  };
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
  const value = {
    action: 'present',
    id: 'page',
    bounds: null,
    scope: { storeId: 's', sessionId: 'e', generation: 1, viewSelection: 2 },
    pageToken: 'exact-token',
    presentationRevision: 2,
  } as const;
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

test('positive layouts and withdrawals require an exact finite page token, monotonic-sequence field and exactly one display owner', () => {
  const scope = { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 2 };
  const bounds = { x: 20, y: 100, width: 400, height: 500, radius: 8 };
  for (const rectangle of [bounds, null]) {
    const request = {
      action: 'present' as const,
      id: 'page',
      scope,
      pageToken: 'opaque-Main-object-document',
      presentationRevision: 2,
      bounds: rectangle,
    };
    expect(parseNativeBrowserRequest(request)).toEqual(request);
    const draft = { ...request, scope: undefined, draft: 'a'.repeat(32) };
    expect(parseNativeBrowserRequest(draft)).toEqual(draft);
    for (const invalid of [
      { ...request, pageToken: undefined },
      { ...request, pageToken: '' },
      { ...request, pageToken: 1 },
      { ...request, pageToken: 'x'.repeat(1025) },
      { ...request, presentationRevision: undefined },
      { ...request, presentationRevision: 0 },
      { ...request, presentationRevision: 1.5 },
      { ...request, presentationRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...request, scope: undefined },
      { ...request, draft: 'a'.repeat(32) },
      { ...request, scope: { ...scope, viewSelection: -1 } },
      { ...request, witness: { key: 'a'.repeat(24), step: 1 } },
      { ...request, frozen: { data: 'private-pixels' } },
      { ...request, lease: 'control-is-not-display' },
    ])
      expect(() => parseNativeBrowserRequest(invalid)).toThrow('invalid_browser_request');
  }
});

test('true close needs the exact current Main page token rather than a tab ID or URL alone', () => {
  const request = {
    action: 'close' as const,
    id: 'page',
    pageToken: 'opaque-Main-object-document',
  };
  expect(parseNativeBrowserRequest(request)).toEqual(request);
  for (const invalid of [
    { action: 'close', id: 'page' },
    { ...request, pageToken: undefined },
    { ...request, pageToken: '' },
    { ...request, pageToken: 1 },
    { ...request, pageToken: 'x'.repeat(1025) },
    { ...request, url: 'https://example.test/' },
  ])
    expect(() => parseNativeBrowserRequest(invalid)).toThrow('invalid_browser_request');
  for (const action of ['prepareClose', 'confirmClose', 'finishClose', 'cancelClose'])
    expect(() => parseNativeBrowserRequest({ action, id: 'page', key: 'a'.repeat(32) })).toThrow(
      'invalid_browser_request',
    );
});

test('bounded display state does not turn ready or visible UI into observation or control authority', () => {
  const base = {
    id: 'page',
    url: 'https://example.test/',
    title: 'Page',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  for (const display of ['loading', 'ready', 'failed'])
    expect(isNativeBrowserState({ ...base, display, pageToken: 'exact-Main-token' })).toBe(true);
  for (const invalid of [
    { ...base, display: 'first-paint-authorized-input' },
    { ...base, pageToken: '' },
    { ...base, pageToken: 'x'.repeat(1025) },
    { ...base, display: 'ready', screenshot: 'private-pixels' },
    { ...base, display: 'ready', leaseId: 'grant' },
    { ...base, display: 'ready', coordinates: { x: 1, y: 2 } },
  ])
    expect(isNativeBrowserState(invalid)).toBe(false);
});

test('retired presentation snapshots and one-shot display commits are rejected rather than retained as an observation API', () => {
  const current = {
    action: 'present',
    id: 'page',
    scope: { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 2 },
    pageToken: 'exact-token',
    presentationRevision: 2,
    bounds: null,
  };
  for (const invalid of [
    { action: 'capturePresentation', id: 'page' },
    { action: 'capturePresentation', id: 'page', scope: current.scope },
    { action: 'capturePresentation', id: 'page', draft: 'a'.repeat(32) },
    { action: 'present', id: 'page', bounds: null, presentationKey: 'old-snapshot' },
    { ...current, presentationKey: 'old-snapshot' },
    { ...current, snapshot: { mimeType: 'image/png', data: 'AA==' } },
  ])
    expect(() => parseNativeBrowserRequest(invalid)).toThrow('invalid_browser_request');
});

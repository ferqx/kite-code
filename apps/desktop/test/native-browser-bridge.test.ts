import { expect, test } from 'bun:test';
import {
  browserAddress,
  isNativeBrowserState,
  parseNativeBrowserRequest,
} from '../src/native-browser-bridge';

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

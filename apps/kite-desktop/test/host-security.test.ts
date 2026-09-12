import { expect, test } from 'bun:test';
import { pathToFileURL } from 'node:url';
import {
  confirmPayload,
  connectionPayload,
  runtimeSendPayload,
  sameRendererDocument,
  switchPayload,
} from '../electron/security';

test('renderer document validation accepts only the configured main document', () => {
  expect(
    sameRendererDocument('http://127.0.0.1:1420/?refresh=1#session', 'http://127.0.0.1:1420/'),
  ).toBe(true);
  expect(sameRendererDocument('http://localhost:1420/', 'http://127.0.0.1:1420/')).toBe(false);
  expect(sameRendererDocument('http://127.0.0.1:1420/other', 'http://127.0.0.1:1420/')).toBe(false);
  const entry = pathToFileURL('/Applications/kite.app/Contents/Resources/app/dist/index.html').href;
  expect(sameRendererDocument(`${entry}#session`, entry)).toBe(true);
  expect(sameRendererDocument(pathToFileURL('/tmp/replacement/index.html').href, entry)).toBe(
    false,
  );
});

test('IPC payload decoders reject unknown fields and malformed capabilities', () => {
  expect(connectionPayload({ connectionId: 4 })).toEqual({ connectionId: 4 });
  expect(() => connectionPayload({ connectionId: 4, extra2: true })).toThrow('参数无效');
  expect(() => connectionPayload({ connectionId: 0 })).toThrow('参数无效');
  expect(runtimeSendPayload({ connectionId: 1, frame: '{"ok":true}' })).toEqual({
    connectionId: 1,
    frame: '{"ok":true}',
  });
  expect(() => runtimeSendPayload({ connectionId: 1, frame: 42 })).toThrow('参数无效');
  expect(
    confirmPayload({
      title: '切换项目？',
      message: '确认',
      kind: 'warning',
      okLabel: '继续',
      cancelLabel: '返回',
    }),
  ).toMatchObject({ kind: 'warning', okLabel: '继续' });
  expect(() => confirmPayload({ title: 'x', message: 'y', kind: 'error' })).toThrow('参数无效');

  const expected = {
    workspace: '/tmp/project',
    repository: true,
    root: '/tmp/project',
    current: 'main',
    head: 'abc',
    branches: ['main'],
    dirty: false,
    canSwitch: true,
  };
  expect(switchPayload({ expected, branch: 'main' })).toEqual({ expected, branch: 'main' });
  expect(() =>
    switchPayload({ expected: { ...expected, authority: true }, branch: 'main' }),
  ).toThrow('参数无效');
});

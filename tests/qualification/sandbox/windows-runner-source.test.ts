import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '#kite-test';

test('keeps the cancel HANDLE under one Option/take close owner after join', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../../native/windows-sandbox-runner/src/main.rs'),
    'utf8',
  );
  const watcher = source.slice(
    source.indexOf('struct CancelWatcher'),
    source.indexOf('fn close_pipe_pair'),
  );
  expect(watcher).toContain('cancel_event: Option<HANDLE>');
  expect(watcher.match(/self\.cancel_event\.take\(\)/g)).toHaveLength(1);
  expect(watcher).not.toContain('CloseHandle(self.cancel_event)');
  expect(watcher.indexOf('.join()')).toBeLessThan(watcher.indexOf('self.cancel_event.take()'));
});

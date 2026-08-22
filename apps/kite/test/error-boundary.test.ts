import { expect, test } from 'bun:test';
import { unrecoverableErrorExitHintV1 } from '../src/tui/components/ErrorBoundary';

test('unrecoverable Runtime authority key failures do not suggest model setup', () => {
  const error = Object.assign(new Error('Runtime authority evidence exists'), {
    name: 'RuntimeInstallationAuthorityKeyErrorV1',
    code: 'key_unavailable',
  });

  const hint = unrecoverableErrorExitHintV1(error);
  expect(hint).toContain('Restore the Runtime authority key');
  expect(hint).not.toContain('kite-code setup');
  expect(hint).not.toContain('model provider');
});

test('generic unrecoverable failures do not guess at a recovery command', () => {
  expect(unrecoverableErrorExitHintV1(new Error('unexpected'))).toBe('Press Enter or Esc to exit');
});

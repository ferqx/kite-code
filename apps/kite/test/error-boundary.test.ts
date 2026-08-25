import { expect, test } from 'bun:test';
import { unrecoverableErrorExitHint } from '../src/tui/components/ErrorBoundary';

test('generic unrecoverable failures do not guess at a recovery command', () => {
  expect(unrecoverableErrorExitHint()).toBe('Press Enter or Esc to exit');
});

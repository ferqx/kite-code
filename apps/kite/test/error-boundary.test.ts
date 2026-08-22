import { expect, test } from 'bun:test';
import { unrecoverableErrorExitHintV1 } from '../src/tui/components/ErrorBoundary';

test('generic unrecoverable failures do not guess at a recovery command', () => {
  expect(unrecoverableErrorExitHintV1()).toBe('Press Enter or Esc to exit');
});

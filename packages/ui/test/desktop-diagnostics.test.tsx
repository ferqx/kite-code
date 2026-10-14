import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesktopDiagnosticsProvider } from '../src/desktop/diagnostics';
import { TurnFailure } from '../src/desktop/TurnFailure';
import type { Message } from '../src/desktop/types';

test('explicit client diagnostics controls failure detail independently of the development environment', () => {
  const message = {
    id: 'original',
    role: 'system',
    text: 'Actual failure\nFull detail',
    failure: {
      summary: 'Actual failure',
      reasonCode: 'original_reason',
      outcome: { status: 'unknown', safeRetry: false, recoveryEntry: 'reconcile' },
    },
  } as Message;
  const original = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'development';
    const draw = (mode: boolean | undefined) =>
      renderToStaticMarkup(
        <DesktopDiagnosticsProvider value={mode}>
          <TurnFailure message={message} expanded onToggle={() => {}} />
        </DesktopDiagnosticsProvider>,
      );
    expect(draw(false)).toContain('Actual failure');
    expect(draw(false)).not.toContain('original_reason');
    expect(draw(true)).toContain('original_reason');
    expect(draw(undefined)).toContain('original_reason');
    process.env.NODE_ENV = 'production';
    expect(draw(true)).toContain('original_reason');
    expect(draw(undefined)).not.toContain('original_reason');
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});

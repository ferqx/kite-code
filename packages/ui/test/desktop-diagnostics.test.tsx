import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesktopDiagnosticsProvider } from '../src/desktop/diagnostics';
import { TurnFailure } from '../src/desktop/TurnFailure';
import type { Message } from '../src/desktop/types';

test('dev and prod never imply diagnostics; only an explicit test provider exposes technical detail', () => {
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
    const draw = (mode?: boolean) => {
      const notice = <TurnFailure message={message} expanded onToggle={() => {}} />;
      return renderToStaticMarkup(
        mode === undefined ? (
          notice
        ) : (
          <DesktopDiagnosticsProvider value={mode}>{notice}</DesktopDiagnosticsProvider>
        ),
      );
    };
    for (const environment of ['development', 'production', 'test']) {
      process.env.NODE_ENV = environment;
      for (const mode of [undefined, false]) {
        const rendered = draw(mode);
        expect(rendered).toContain('Actual failure');
        expect(rendered).toContain('Full detail');
        expect(rendered).not.toContain('original_reason');
        expect(rendered).not.toContain('原因代码');
      }
      expect(draw(true)).toContain('original_reason');
    }
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});

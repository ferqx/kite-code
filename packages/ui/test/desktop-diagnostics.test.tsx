import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
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
        expect(rendered).not.toContain('<button');
        expect(rendered).not.toContain('展开回复失败');
        const document = new JSDOM(rendered).window.document;
        expect(document.querySelector('[data-slot="alert"]')?.getAttribute('role')).toBe('alert');
        expect(document.querySelector('[data-slot="alert-title"]')).toBeNull();
        expect(document.querySelector('.message')).toBeNull();
      }
      expect(draw(true)).toContain('original_reason');
    }
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});

test('an unclassified exception gives an honest cause boundary and actionable advice in an Alert', () => {
  const html = renderToStaticMarkup(
    <TurnFailure
      message={{ id: 'unknown', role: 'system', text: '', settled: true }}
      onToggle={() => {}}
    />,
  );
  const document = new JSDOM(html).window.document;
  expect(document.querySelector('[data-slot="alert-title"]')).toBeNull();
  expect(document.querySelector('[data-slot="alert"]')?.getAttribute('aria-label')).toBe(
    '本轮异常结束',
  );
  expect(document.querySelector('[data-slot="alert-description"]')?.textContent).toContain(
    '未提供可核实的错误原因',
  );
  expect(document.body.textContent).toContain('核对本轮工具执行结果');
  expect(document.body.textContent).not.toContain('回复未完成，已保留本轮消息');
});

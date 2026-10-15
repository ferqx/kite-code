import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import { TuiErrorBoundary } from '../../src/tui/error-boundary';

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
function Broken(): never {
  throw new Error('original failure\x1b[31m unsafe');
}
test('ordinary error page preserves safe original message, hides stack and waits for explicit Enter or Escape', async () => {
  for (const exitKey of ['\r', '\x1b']) {
    let exited = 0,
      caught = 0;
    const ui = render(
      <TuiErrorBoundary onExit={() => exited++} onError={() => caught++}>
        <Broken />
      </TuiErrorBoundary>,
    );
    try {
      await tick();
      expect(ui.lastFrame()).toContain('An unrecoverable error occurred');
      expect(ui.lastFrame()).toContain('original failure\\u001b[31m unsafe');
      expect(ui.lastFrame()).not.toContain('at Broken');
      expect(caught).toBe(1);
      expect(exited).toBe(0);
      ui.stdin.write('x');
      await tick();
      expect(exited).toBe(0);
      ui.stdin.write(exitKey);
      await tick();
      expect(exited).toBe(1);
    } finally {
      ui.unmount();
    }
  }
});
test('explicit diagnostics shows the same safe error stack', async () => {
  const ui = render(
    <TuiErrorBoundary testDiagnostics onExit={() => {}}>
      <Broken />
    </TuiErrorBoundary>,
  );
  try {
    await tick();
    expect(ui.lastFrame()).toContain('at Broken');
  } finally {
    ui.unmount();
  }
});

import { expect, test } from 'bun:test';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { TuiPanelViewport } from '../../src/tui/panel-viewport';

const tick = () => Bun.sleep(30);
test('bounded panel pages through complete content and resets for a different original scope', async () => {
  const content = Array.from(
    { length: 15 },
    (_, index) => `Row ${String(index + 1).padStart(2, '0')}`,
  ).join('\n');
  const element = (identity: string) => (
    <TuiPanelViewport rows={5} identity={identity}>
      <Text>{content}</Text>
    </TuiPanelViewport>
  );
  const ui = render(element('a'));
  try {
    await tick();
    expect(ui.lastFrame()).toContain('Row 01');
    expect(ui.lastFrame()).not.toContain('Row 15');
    for (let i = 0; i < 4; i++) {
      ui.stdin.write('\x1b[6~');
      await tick();
    }
    expect(ui.lastFrame()).toContain('Row 15');
    expect(ui.lastFrame()).not.toContain('Row 01');
    ui.stdin.write('\x1b[5~');
    await tick();
    expect(ui.lastFrame()).toContain('Row 08');
    ui.rerender(element('b'));
    await tick();
    expect(ui.lastFrame()).toContain('Row 01');
  } finally {
    ui.unmount();
  }
});

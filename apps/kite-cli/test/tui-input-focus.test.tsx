import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import InputLine from '../src/tui/components/InputLine';

describe('InputLine startup focus', () => {
  test('accepts input after the first effect flush without waiting for a timer', async () => {
    let value = '';
    const view = render(
      <InputLine
        mode="prompt"
        onSubmit={() => {}}
        onValueChange={(next) => {
          value = next;
        }}
        workspace={process.cwd()}
      />,
    );

    await Bun.sleep(10);
    view.stdin.write('x');
    await Promise.resolve();

    expect(value).toBe('x');
    expect(view.lastFrame()).toContain('x');
    view.unmount();
  });
});

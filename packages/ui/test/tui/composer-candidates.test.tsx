import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import { useState } from 'react';
import { ComposerBuffer } from '../../src/tui/composer';
import { candidateViewport, TuiComposer } from '../../src/tui/composer-input';

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test('adaptive candidate window follows both ends and budgets multiline/narrow viewports', () => {
  const large = candidateViewport(605, 604, 40, 1);
  expect(large.end).toBe(605);
  expect(large.index).toBe(604);
  expect(large.end - large.start).toBeGreaterThan(5);
  const small = candidateViewport(605, 300, 12, 7);
  expect(small.start).toBeLessThanOrEqual(300);
  expect(small.end).toBeGreaterThan(300);
  expect(small.end - small.start).toBe(1);
  expect(candidateViewport(20, 0, 24, 1).start).toBe(0);
});

test('framed original file candidates navigate, complete whole references and dismiss without submitting', async () => {
  const buffer = new ComposerBuffer();
  buffer.sync('@');
  const key = buffer.fileToken!.key;
  const paths = Array.from({ length: 30 }, (_, n) => `目录/file ${n}🙂.ts`);
  let submitted = 0;
  function Harness() {
    const [value, setValue] = useState('@');
    return (
      <TuiComposer
        buffer={buffer}
        value={value}
        active
        label="New Run"
        onChange={setValue}
        onSubmit={() => {
          submitted++;
        }}
        files={{
          key,
          scope: { storeId: 'original', workspaceId: 'w', sessionId: 's' },
          phase: 'ready',
          paths,
          unavailable: [],
        }}
      />
    );
  }
  const app = render(<Harness />);
  try {
    await tick();
    expect(app.lastFrame()).toContain('1/30');
    expect(app.lastFrame()).toContain('file 8🙂.ts');
    app.stdin.write('\u001b[A');
    await tick();
    expect(app.lastFrame()).toContain('30/30');
    expect(app.lastFrame()).toContain('› 目录/file 29🙂.ts');
    app.stdin.write('\u001b');
    await tick();
    expect(buffer.text).toBe('@');
    expect(app.lastFrame()).not.toContain('30/30');
    expect(submitted).toBe(0);
    app.stdin.write('\u007f');
    await tick();
    app.stdin.write('@');
    await tick();
    app.stdin.write('\u001b[A');
    await tick();
    app.stdin.write('\r');
    await tick();
    expect(submitted).toBe(0);
    expect(buffer.text).toBe('@"目录/file 29🙂.ts"');
    expect(app.lastFrame()).not.toContain('30/30');
    app.stdin.write('\r');
    await tick();
    expect(submitted).toBe(1);
  } finally {
    app.unmount();
  }
});

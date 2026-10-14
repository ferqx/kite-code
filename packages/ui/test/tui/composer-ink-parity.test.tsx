import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import { useState } from 'react';
import { describeTuiCommand, slashGhostSuffix } from '../../src/tui/command-catalog';
import { fixedTuiCommands } from '../../src/tui/commands';
import { ComposerBuffer } from '../../src/tui/composer';
import { TuiComposer } from '../../src/tui/composer-input';
import { useInkI18n } from '../../src/tui/presentation';

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
test('original composer owns exactly two full-width rules and a named planning heading', () => {
  const buffer = new ComposerBuffer();
  buffer.sync('original');
  const view = render(
    <TuiComposer
      buffer={buffer}
      value="original"
      active
      label="New Run"
      planning
      planName="Review"
      onChange={() => {}}
      onSubmit={() => {}}
    />,
  );
  try {
    const frame = view.lastFrame()!;
    expect(frame).toContain(' review ────');
    expect(frame).toContain('❯ original');
    expect(frame.split('\n').filter((line) => line.startsWith('────'))).toHaveLength(2);
    expect(frame).not.toContain('New Run >');
  } finally {
    view.unmount();
  }
});
test('command ghost, original description and aliases never enter submitted source; first Enter completes only', async () => {
  const buffer = new ComposerBuffer();
  let submitted = '';
  function Harness() {
    const [value, setValue] = useState('/he');
    return (
      <TuiComposer
        buffer={buffer}
        value={value}
        active
        label="New Run"
        onChange={setValue}
        onSubmit={() => {
          submitted = buffer.text;
        }}
      />
    );
  }
  const app = render(<Harness />);
  try {
    await tick();
    expect(app.lastFrame()).toContain('❯ /help');
    expect(buffer.text).toBe('/he');
    expect(app.lastFrame()).toContain('· /h');
    expect(app.lastFrame()).toContain('Open help panel');
    app.stdin.write('\r');
    await tick();
    expect(buffer.text).toBe('/help');
    expect(submitted).toBe('');
    expect(app.lastFrame()).not.toContain('Command matches');
    app.stdin.write('\r');
    await tick();
    expect(submitted).toBe('/help');
  } finally {
    app.unmount();
  }
});
test('original Right-arrow ghost completion preserves Unicode edits and Ctrl shortcuts stay owned by root', async () => {
  const buffer = new ComposerBuffer();
  let submits = 0,
    escapes = 0;
  function Harness() {
    const [value, setValue] = useState('/he');
    return (
      <TuiComposer
        buffer={buffer}
        value={value}
        active
        label="New Run"
        onChange={setValue}
        onSubmit={() => submits++}
        onEscape={() => escapes++}
      />
    );
  }
  const app = render(<Harness />);
  try {
    await tick();
    app.stdin.write('\u001b[C');
    await tick();
    expect(buffer.text).toBe('/help');
    app.stdin.write('\u0003');
    await tick();
    expect(buffer.text).toBe('/help');
    expect(submits).toBe(0);
    app.stdin.write('\u001b');
    await tick();
    expect(escapes).toBe(1);
    app.stdin.write('\u001b');
    await tick();
    expect(escapes).toBe(2);
    app.stdin.write('中文🙂');
    await tick();
    expect(buffer.text).toBe('/help中文🙂');
    app.stdin.write('\u001b[D');
    await tick();
    app.stdin.write('x');
    await tick();
    expect(buffer.text).toBe('/help中文x🙂');
  } finally {
    app.unmount();
  }
});
test('UI command descriptions cover every implemented fixed candidate, with parser-supported aliases', () => {
  let checked = false;
  function Read() {
    const i18n = useInkI18n();
    for (const command of fixedTuiCommands) {
      expect(describeTuiCommand(command, i18n).description.length).toBeGreaterThan(0);
    }
    expect(describeTuiCommand('/exit', i18n).aliases).toEqual(['quit', 'q']);
    checked = true;
    return null;
  }
  const app = render(<Read />);
  try {
    expect(checked).toBe(true);
  } finally {
    app.unmount();
  }
  expect(slashGhostSuffix('/he', ['/help'], 0)).toBe('lp');
  expect(slashGhostSuffix('original /he', ['/help'], 0)).toBe('');
  expect(slashGhostSuffix('/help', ['/help'], 0)).toBe('');
});

test('original multiline editor displays complete short input and a centered forty-line window for long input', () => {
  const buffer = new ComposerBuffer();
  const short = Array.from({ length: 8 }, (_, i) => `short-${i}`).join('\n');
  buffer.sync(short);
  const ui = render(
    <TuiComposer
      buffer={buffer}
      value={short}
      active
      label="New Run"
      onChange={() => {}}
      onSubmit={() => {}}
    />,
  );
  try {
    expect(ui.lastFrame()).toContain('short-0');
    expect(ui.lastFrame()).toContain('short-7');
    const long = Array.from({ length: 60 }, (_, i) => `long-${i}`).join('\n');
    buffer.sync(long);
    ui.rerender(
      <TuiComposer
        buffer={buffer}
        value={long}
        active
        label="New Run"
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(ui.lastFrame()).toContain('20 more lines above');
    expect(ui.lastFrame()).toContain('long-20');
    expect(ui.lastFrame()).toContain('long-59');
    expect(ui.lastFrame()).not.toContain('long-0');
  } finally {
    ui.unmount();
  }
});

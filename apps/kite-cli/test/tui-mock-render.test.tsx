import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import CompactionProgress from '../src/tui/components/CompactionProgress';
import Header from '../src/tui/Header';
import { I18nProvider } from '../src/tui/i18n';
import type { RunStatusSnapshot } from '../src/tui/run-status';
import StatusBar from '../src/tui/StatusBar';

function fakeRunStatus(overrides: Partial<RunStatusSnapshot> = {}): RunStatusSnapshot {
  return {
    phase: 'working',
    verb: 'Running',
    tone: 'success',
    elapsedMs: 28_000,
    runTokenDelta: 189,
    retry: null,
    waiting: null,
    ...overrides,
  };
}

describe('Header', () => {
  test('shows the model snapshot in the startup card', () => {
    const { lastFrame } = render(
      React.createElement(Header, {
        modelName: 'gpt-5.6',
        thinkingMode: 'low',
        workspace: '/tmp/kite-code',
        columns: 60,
      }),
    );
    expect(lastFrame()).toContain('gpt-5.6 low');
  });

  test('uses the kite wordmark instead of the former cat mascot', () => {
    const { lastFrame } = render(
      React.createElement(Header, {
        modelName: 'gpt-5.6',
        workspace: '/tmp/kite-code',
        columns: 60,
      }),
    );
    expect(lastFrame()).toContain('──◆ Kite Code');
    expect(lastFrame()).toContain('╭');
    expect(lastFrame()).toContain('╰');
    expect(lastFrame()).not.toContain('/\\_/\\');
  });
});

describe('StatusBar', () => {
  test('shows Working with an animated activity marker', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, {
        runStatus: fakeRunStatus(),
        running: true,
      }),
    );
    const output = lastFrame();
    expect(output).toContain('Working');
    expect(output).toMatch(/[·⋄⋆✧] Working/);
  });

  test('does not show cumulative metrics in StatusBar', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, {
        runStatus: fakeRunStatus(),
        running: true,
      }),
    );
    const output = lastFrame();
    // Metrics are in StatsLine, not StatusBar
    expect(output).not.toContain('42%');
    expect(output).not.toContain('123,456');
  });

  test('animates Working without displaying elapsed time', async () => {
    const view = render(
      React.createElement(StatusBar, {
        runStatus: fakeRunStatus({ elapsedMs: 0, runTokenDelta: 0 }),
        running: true,
      }),
    );

    const initialWriteCount = view.frames.length;
    await Bun.sleep(1_250);

    expect(view.lastFrame()).toContain('Working');
    expect(view.lastFrame()).toMatch(/^[·⋄⋆✧] Working$/);
    expect(view.lastFrame()).not.toMatch(/\d+:\d+/);
    expect(view.frames.length).toBeGreaterThan(initialWriteCount);
    view.unmount();
  });

  test('stops status animation writes once the Run is inactive', async () => {
    const view = render(React.createElement(StatusBar, { running: true }));
    await Bun.sleep(300);
    view.rerender(React.createElement(StatusBar, { running: false }));
    await Bun.sleep(30);
    const idleFrames = view.frames.length;
    await Bun.sleep(750);
    expect(view.lastFrame()).toBe('');
    expect(view.frames).toHaveLength(idleFrames);
    view.unmount();
  });

  test('working phase shows Working prefix in status line', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, {
        runStatus: fakeRunStatus({ phase: 'working', verb: 'Running' }),
        running: true,
      }),
    );
    expect(lastFrame()).toContain('Working');
  });

  test('thinking phase still renders only the fixed English Working text', () => {
    const { lastFrame } = render(
      React.createElement(
        I18nProvider,
        { language: 'zh-CN' },
        React.createElement(StatusBar, {
          runStatus: fakeRunStatus({ phase: 'thinking', verb: 'Thinking' }),
          running: true,
        }),
      ),
    );
    const output = lastFrame();
    expect(output).toContain('Working');
    expect(output).not.toContain('Thinking');
    expect(output).not.toContain('思考');
    expect(output).not.toContain('工作');
  });

  test('keeps showing Working after the final answer while awaiting the Run terminal', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, {
        runStatus: fakeRunStatus({ phase: 'finishing', verb: 'Finishing' }),
        running: true,
      }),
    );

    expect(lastFrame()).toContain('Working');
    expect(lastFrame()).not.toContain('Finishing');
  });
});

describe('CompactionProgress', () => {
  test('renders a compaction phase as inline command output', () => {
    const { lastFrame } = render(
      React.createElement(CompactionProgress, {
        phase: 'summarizing',
      }),
    );
    const output = lastFrame();
    expect(output).toContain('⎿');
    expect(output).toContain('Summarizing context');
    expect(output).toMatch(/(?:● | {2}) Summarizing context/);
  });
});

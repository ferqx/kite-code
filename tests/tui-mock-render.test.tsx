import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import CompactionProgress from '../src/app/tui/components/CompactionProgress';
import Header from '../src/app/tui/Header';
import type { RunStatusSnapshot } from '../src/app/tui/run-status';
import StatusBar, { runStatusColor } from '../src/app/tui/StatusBar';
import { darkTheme } from '../src/app/tui/theme';

function fakeStatus() {
  return {
    phase: 'building' as const,
    plan: null,
    pendingPlan: null,
    authorization: 'default' as const,
    workspaceAccess: 'write' as const,
    cacheHitTokens: 420,
    cacheMissTokens: 580,
    cacheHitRate: 0.42,
    totalTokens: 123456,
    currentNode: null,
    modelProvider: 'deepseek' as const,
    modelName: 'deepseek-v4',
    thinkingMode: 'max',
    retryState: null,
  };
}

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
  test('maps run status tones to the active theme colors', () => {
    expect(runStatusColor(darkTheme, 'primary')).toBe(darkTheme.primary);
    expect(runStatusColor(darkTheme, 'success')).toBe(darkTheme.success);
    expect(runStatusColor(darkTheme, 'warning')).toBe(darkTheme.warning);
    expect(runStatusColor(darkTheme, 'muted')).toBe(darkTheme.muted);
    expect(runStatusColor(darkTheme, 'error')).toBe(darkTheme.error);
  });

  test('keeps Working on the theme primary color', () => {
    expect(runStatusColor(darkTheme, 'success', 'working')).toBe(darkTheme.primary);
    expect(runStatusColor(darkTheme, 'warning', 'working')).toBe(darkTheme.primary);
  });

  test('shows fixed Working text and spinner when running', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, {
        status: fakeStatus(),
        runStatus: fakeRunStatus(),
        timerKey: 0,
        running: true,
      }),
    );
    const output = lastFrame();
    expect(output).toContain('Working');
    // Cosmic dot spinner appears when running
    expect(output).toMatch(/[·⋆✦✧★]/);
  });

  test('does not show cumulative metrics in StatusBar', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, {
        status: fakeStatus(),
        runStatus: fakeRunStatus(),
        timerKey: 0,
        running: true,
      }),
    );
    const output = lastFrame();
    // Metrics are in StatsLine, not StatusBar
    expect(output).not.toContain('42%');
    expect(output).not.toContain('123,456');
  });

  test('keeps Working free of elapsed time between parent updates', async () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, {
        status: fakeStatus(),
        runStatus: fakeRunStatus({ elapsedMs: 0, runTokenDelta: 0 }),
        timerKey: 0,
        running: true,
      }),
    );

    await Bun.sleep(1_250);

    expect(lastFrame()).toContain('Working');
    expect(lastFrame()).not.toContain('(1s)');
  });

  test('working phase shows Working prefix in status line', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, {
        status: fakeStatus(),
        runStatus: fakeRunStatus({ phase: 'working', verb: 'Running' }),
        timerKey: 0,
        running: true,
      }),
    );
    expect(lastFrame()).toContain('Working');
  });

  test('thinking phase uses verb-only format without Working prefix', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, {
        status: fakeStatus(),
        runStatus: fakeRunStatus({ phase: 'thinking', verb: 'Thinking' }),
        timerKey: 0,
        running: true,
      }),
    );
    const output = lastFrame();
    expect(output).toContain('Thinking');
    // Thinking phase shouldn't have the "Working ·" prefix
    expect(output).not.toMatch(/Working/);
  });
});

describe('CompactionProgress', () => {
  test('renders an animated compaction phase as inline command output', () => {
    const { lastFrame } = render(
      React.createElement(CompactionProgress, {
        phase: 'summarizing',
      }),
    );
    const output = lastFrame();
    expect(output).toContain('⎿');
    expect(output).toContain('Summarizing context');
    expect(output).toMatch(/●/);
  });
});

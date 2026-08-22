import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import SlashSuggestionOverlay from '../apps/kite/src/tui/components/SlashSuggestionOverlay';
import type { SlashSuggestionData } from '../apps/kite/src/tui/hooks/useSlashSuggestions';
import { detectTuiDeviceLocale, I18nProvider, resolveTuiLanguage } from '../apps/kite/src/tui/i18n';

describe('TUI language resolution', () => {
  test('honors an explicit personal language setting', () => {
    expect(resolveTuiLanguage('zh-CN', 'en-US')).toBe('zh-CN');
    expect(resolveTuiLanguage('en-US', 'zh-CN')).toBe('en-US');
  });

  test('uses Chinese whenever the device language is Chinese in system mode', () => {
    expect(resolveTuiLanguage('system', 'zh-CN')).toBe('zh-CN');
    expect(resolveTuiLanguage('system', 'zh-Hans-CN')).toBe('zh-CN');
    expect(resolveTuiLanguage('system', 'zh-TW')).toBe('zh-CN');
    expect(resolveTuiLanguage('system', 'zh-Hans')).toBe('zh-CN');
    expect(resolveTuiLanguage('system', 'en-US')).toBe('en-US');
  });

  test('falls back to English when the device locale cannot be interpreted', () => {
    expect(resolveTuiLanguage('system', 'not-a-locale')).toBe('en-US');
  });

  test('uses the macOS primary language when the host process locale is overridden', () => {
    expect(detectTuiDeviceLocale('en-US', 'darwin', 'zh-Hans-CN')).toBe('zh-Hans-CN');
    expect(
      resolveTuiLanguage('system', detectTuiDeviceLocale('en-US', 'darwin', 'zh-Hans-CN')),
    ).toBe('zh-CN');
  });
});

describe('localized slash suggestions', () => {
  const suggestion: SlashSuggestionData = {
    kind: 'command',
    partial: 'pl',
    selectedIndex: 0,
    items: [
      {
        command: 'plan',
        aliases: [],
        args: '[task]',
        description: 'Enter plan mode',
      },
    ],
  };

  test('keeps command tokens stable while translating surrounding UI', () => {
    const { lastFrame } = render(
      React.createElement(
        I18nProvider,
        { language: 'zh-CN' },
        React.createElement(SlashSuggestionOverlay, {
          suggestion,
          maxVisibleItems: 5,
          width: 88,
        }),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('命令匹配');
    expect(frame).toContain('/plan');
    expect(frame).toContain('Tab / → 补全');
  });
});

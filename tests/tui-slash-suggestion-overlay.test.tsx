import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import SlashSuggestionOverlay from '../src/app/tui/components/SlashSuggestionOverlay';
import type { SlashSuggestionData } from '../src/app/tui/hooks/useSlashSuggestions';

const commandSuggestion: SlashSuggestionData = {
  kind: 'command',
  partial: '',
  selectedIndex: 0,
  items: [
    {
      command: 'effort',
      aliases: [],
      args: 'low|medium|high|max',
      description: 'Set reasoning effort',
    },
    {
      command: 'clear',
      aliases: ['c'],
      description: 'Clear output',
    },
  ],
};

describe('SlashSuggestionOverlay', () => {
  test('renders the command palette hierarchy without repeating the product brand', () => {
    const { lastFrame, stdout } = render(
      <SlashSuggestionOverlay suggestion={commandSuggestion} maxVisibleItems={5} width={88} />,
    );
    const frame = lastFrame() ?? '';
    const titleDivider = frame.split('\n').find((line) => line.includes('命令匹配')) ?? '';

    expect(frame).not.toContain('◆ Kite Code');
    expect(frame).toContain('── 命令匹配');
    expect(frame).not.toContain('命令匹配 /effort');
    expect(frame).toContain('1 / 2');
    expect(frame).toContain('❯ /effort');
    expect(frame).toContain('low|medium|high|max');
    expect(frame).toContain('Set reasoning effort');
    expect(frame).toContain('/clear');
    expect(frame).toContain('· /c');
    expect(frame).toContain('Tab / → 补全');
    expect(frame).toContain('Enter 确认');
    expect(frame).not.toContain('╭');
    expect(frame).not.toContain('╰');
    expect(stringWidth(titleDivider)).toBe(stdout.columns);
  });

  test('aligns commands, arguments, and descriptions to stable columns', () => {
    const suggestion: SlashSuggestionData = {
      kind: 'command',
      partial: '',
      selectedIndex: 0,
      items: [
        {
          command: 'effort',
          aliases: [],
          args: 'low|medium|high|max',
          description: 'Set reasoning effort',
        },
        {
          command: 'model',
          aliases: [],
          args: '[name]',
          description: 'Switch model',
        },
        {
          command: 'theme',
          aliases: [],
          args: 'teal|blue|purple|cyan|mono',
          description: 'Switch color theme',
        },
      ],
    };
    const { lastFrame } = render(
      <SlashSuggestionOverlay suggestion={suggestion} maxVisibleItems={5} width={88} />,
    );
    const lines = (lastFrame() ?? '').split('\n');
    const effort = lines.find((line) => line.includes('/effort')) ?? '';
    const model = lines.find((line) => line.includes('/model')) ?? '';
    const theme = lines.find((line) => line.includes('/theme')) ?? '';

    expect(effort.indexOf('/effort')).toBe(model.indexOf('/model'));
    expect(model.indexOf('/model')).toBe(theme.indexOf('/theme'));
    expect(effort.indexOf('low|')).toBe(model.indexOf('[name]'));
    expect(model.indexOf('[name]')).toBe(theme.indexOf('teal|'));
    expect(effort.indexOf('Set reasoning effort')).toBe(model.indexOf('Switch model'));
    expect(model.indexOf('Switch model')).toBe(theme.indexOf('Switch color theme'));
  });

  test('renders mode values without a misleading slash and marks active state', () => {
    const suggestion: SlashSuggestionData = {
      kind: 'theme',
      partial: '',
      selectedIndex: 1,
      items: [
        { command: 'blue', aliases: [], description: '', isActive: true },
        { command: 'purple', aliases: [], description: '' },
      ],
    };
    const { lastFrame } = render(
      <SlashSuggestionOverlay suggestion={suggestion} maxVisibleItems={5} width={72} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('主题选项');
    expect(frame).toContain('2 / 2');
    expect(frame).toContain('blue');
    expect(frame).toContain('当前');
    expect(frame).toContain('❯ purple');
    expect(frame).not.toContain('/purple');
  });

  test('shows the selected unavailable permission warning beside the normal description', () => {
    const suggestion: SlashSuggestionData = {
      kind: 'permissions',
      partial: 'f',
      selectedIndex: 0,
      items: [
        {
          command: 'full',
          aliases: [],
          description: '完全自主，全部放行，不询问用户',
          warning: '当前未在沙箱环境开启',
        },
      ],
    };
    const { lastFrame } = render(
      <SlashSuggestionOverlay suggestion={suggestion} maxVisibleItems={5} width={100} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('❯ full');
    expect(frame).toContain('完全自主，全部放行，不询问用户');
    expect(frame).toContain('当前未在沙箱环境开启');
  });
});

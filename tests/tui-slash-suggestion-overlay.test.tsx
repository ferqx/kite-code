import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import SlashSuggestionOverlay from '../apps/kite/src/tui/components/SlashSuggestionOverlay';
import type { SlashSuggestionData } from '../apps/kite/src/tui/hooks/useSlashSuggestions';

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
    const titleDivider = frame.split('\n').find((line) => line.includes('Command matches')) ?? '';

    expect(frame).not.toContain('◆ Kite Code');
    expect(frame).toContain('── Command matches');
    expect(frame).not.toContain('Command matches /effort');
    expect(frame).toContain('1 / 2');
    expect(frame).toContain('❯ /effort');
    expect(frame).toContain('low|medium|high|max');
    expect(frame).toContain('Set reasoning effort');
    expect(frame).toContain('/clear');
    expect(frame).toContain('· /c');
    expect(frame).toContain('Tab / → Complete');
    expect(frame).toContain('Enter Confirm');
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
          description: 'Open model selector',
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
    expect(model).not.toContain('[name]');
    expect(effort.indexOf('low|')).toBe(theme.indexOf('teal|'));
    expect(effort.indexOf('Set reasoning effort')).toBe(model.indexOf('Open model selector'));
    expect(model.indexOf('Open model selector')).toBe(theme.indexOf('Switch color theme'));
  });

  test('renders command values with their slash prefix', () => {
    const suggestion: SlashSuggestionData = {
      kind: 'command',
      partial: '',
      selectedIndex: 1,
      items: [
        { command: 'help', aliases: [], description: '打开帮助面板' },
        { command: 'model', aliases: [], description: '打开模型选择器' },
      ],
    };
    const { lastFrame } = render(
      <SlashSuggestionOverlay suggestion={suggestion} maxVisibleItems={5} width={72} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Command matches');
    expect(frame).toContain('2 / 2');
    expect(frame).toContain('/help');
    expect(frame).toContain('❯ /model');
    expect(frame).not.toContain('/purple');
  });

  test('scrolls a long command list to keep the selected command visible', () => {
    const suggestion: SlashSuggestionData = {
      kind: 'command',
      partial: '',
      selectedIndex: 7,
      items: Array.from({ length: 8 }, (_, index) => ({
        command: `command-${index}`,
        aliases: [],
        description: `Command ${index}`,
      })),
    };
    const { lastFrame, rerender } = render(
      <SlashSuggestionOverlay suggestion={suggestion} maxVisibleItems={3} width={88} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('8 / 8');
    expect(frame).toContain('❯ /command-7');
    expect(frame).not.toContain('/command-0');

    rerender(
      <SlashSuggestionOverlay
        suggestion={{ ...suggestion, selectedIndex: 0 }}
        maxVisibleItems={3}
        width={88}
      />,
    );
    const returnedFrame = lastFrame() ?? '';
    expect(returnedFrame).toContain('❯ /command-0');
    expect(returnedFrame).not.toContain('/command-7');
  });
});

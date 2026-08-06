import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import OverlayChoiceList from '../src/app/tui/components/OverlayChoiceList';

describe('OverlayChoiceList', () => {
  test('renders a safe default separately from the destructive option', () => {
    const { lastFrame } = render(
      <OverlayChoiceList
        selectedId="keep"
        options={[
          {
            id: 'keep',
            label: '保留会话',
            description: '返回会话列表，不做任何更改',
          },
          {
            id: 'delete',
            label: '永久删除',
            description: '此操作不可撤销',
            destructive: true,
            separatorBefore: true,
          },
        ]}
      />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('❯ 保留会话');
    expect(frame).toContain('返回会话列表，不做任何更改');
    expect(frame).toContain('永久删除');
    expect(frame).toContain('此操作不可撤销');
  });

  test('keeps headings non-selectable and renders metadata on a secondary line', () => {
    const { lastFrame } = render(
      <OverlayChoiceList
        selectedId="server"
        options={[
          { id: 'heading', label: '用户', heading: true, disabled: true },
          {
            id: 'server',
            label: '示例服务器 · 已连接',
            description: '/非常/长的/配置/路径.json · 3 个工具',
          },
        ]}
      />,
    );
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const heading = lines.findIndex((line) => line.includes('用户'));
    const server = lines.findIndex((line) => line.includes('❯ 示例服务器'));
    expect(frame).toContain('用户');
    expect(frame).toContain('❯ 示例服务器 · 已连接');
    expect(frame).toContain('/非常/长的/配置/路径.json · 3 个工具');
    expect(frame).not.toContain('❯ 用户');
    expect(server).toBeGreaterThan(heading + 1);
    expect(lines[server - 1]?.trim()).toBe('');
  });
});

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
});

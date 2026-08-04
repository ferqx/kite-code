import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import OverlayFrame, { OverlayShortcutBar } from '../src/app/tui/components/OverlayFrame';
import { OverlayEmptyState, OverlayMessage } from '../src/app/tui/components/OverlayPrimitives';

describe('OverlayFrame contract', () => {
  test('owns title, content, optional message, and footer spacing', () => {
    const { lastFrame } = render(
      <OverlayFrame
        title="示例"
        message={<OverlayMessage tone="warning">处理中</OverlayMessage>}
        footer={<OverlayShortcutBar shortcuts={[{ keys: 'Esc', label: '关闭' }]} />}
      >
        <OverlayEmptyState>暂无内容</OverlayEmptyState>
      </OverlayFrame>,
    );
    const lines = (lastFrame() ?? '').split('\n');
    const content = lines.findIndex((line) => line.includes('暂无内容'));
    const message = lines.findIndex((line) => line.includes('处理中'));
    const footer = lines.findIndex((line) => line.includes('Esc 关闭'));
    expect(lines.some((line) => line.includes('── 示例'))).toBe(true);
    expect(message).toBeGreaterThan(content);
    expect(footer).toBeGreaterThan(message);
  });

  test('does not reserve a blank message row when no message exists', () => {
    const { lastFrame } = render(
      <OverlayFrame
        title="空态"
        footer={<OverlayShortcutBar shortcuts={[{ keys: 'Esc', label: '关闭' }]} />}
      >
        <OverlayEmptyState>暂无内容</OverlayEmptyState>
      </OverlayFrame>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('暂无内容');
    expect(frame).not.toContain('\n \n');
  });
});

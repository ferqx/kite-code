import { describe, expect, test } from 'bun:test';
import { RuntimeClientError } from '@kite-ai/runtime-client';
import { formatTuiStartupError } from '../src/tui/startup-diagnostic';

describe('TUI startup diagnostics', () => {
  test('treats a same-build mismatch as an incomplete installation', () => {
    expect(
      formatTuiStartupError(
        new RuntimeClientError('server_mismatch', 'Runtime Server version does not match.'),
        'same_build',
      ),
    ).toBe(
      'TUI 与配套 App Server 不兼容，当前 Kite Code 安装可能不完整。请更新或重新安装 Kite Code。',
    );
  });

  test('tells an explicit daemon user to update or use a matching client', () => {
    expect(
      formatTuiStartupError(
        new RuntimeClientError('server_mismatch', 'Runtime Server capability set is incomplete.'),
        'exact_protocol',
      ),
    ).toContain('请更新 Kite Code，或改用与该 App Server 匹配的客户端');
  });

  test('preserves unrelated startup errors', () => {
    expect(formatTuiStartupError(new Error('connection unavailable'), 'same_build')).toBe(
      'connection unavailable',
    );
  });
});

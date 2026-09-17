import { describe, expect, test } from 'bun:test';
import { RuntimeClientError, RuntimeClientStartupError } from '@kite-ai/runtime-client';
import { formatTuiStartupError, formatTuiStartupProgress } from '../src/tui/startup-diagnostic';

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

  test('directs explicit daemon clients to stable lifecycle management', () => {
    expect(
      formatTuiStartupError(
        new RuntimeClientError('server_mismatch', 'Runtime Server capability set is incomplete.'),
        'exact_protocol',
      ),
    ).toContain('server status 和 server restart');
  });

  test('recognizes a server-rejected wire version without treating it as an installation failure', () => {
    const error = new RuntimeClientError('protocol_error', 'Protocol version mismatch', {
      code: -32004,
      message: 'Protocol version mismatch',
      data: { code: 'protocol_version_mismatch' },
    });
    expect(formatTuiStartupError(error, 'exact_protocol')).toContain('server restart');
    expect(formatTuiStartupError(error, 'same_build')).toContain('安装可能不完整');
  });

  test('preserves unrelated startup errors', () => {
    expect(formatTuiStartupError(new Error('connection unavailable'), 'same_build')).toBe(
      'connection unavailable',
    );
  });

  test('shows a fixed preparation phase and a saveable redacted terminal report', () => {
    expect(formatTuiStartupProgress({ phase: 'preparing' })).toContain('安全取消或提交结算');
    const waiting = formatTuiStartupProgress({ phase: 'waiting_for_store' });
    expect(waiting).toContain('正在自动重试');
    expect(waiting).toContain('超时后请按提示重试');
    expect(waiting).not.toContain('PID');
    const report = formatTuiStartupError(
      new RuntimeClientStartupError({
        code: 'store_corrupt',
        actualSchema: 10,
        expectedSchema: 10,
        stage: 'preparing',
      }),
    );
    expect(report).toContain('可将以下脱敏诊断保存');
    expect(report).toContain('"stage": "preparing"');
    expect(report).not.toContain('sqlite');
  });
});

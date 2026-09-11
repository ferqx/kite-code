import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionPage, type SessionPageProps } from '../src';

const base: SessionPageProps = {
  workspaces: [
    {
      id: 'w',
      label: 'Workspace',
      state: 'loaded',
      sessionCount: 1,
      sessions: [{ sessionId: 's', displayName: 'Session', status: 'idle' }],
    },
  ],
  selected: 's',
  workspaceLabel: 'Workspace',
  sessionLabel: 'Session',
  readingKey: 'w/s',
  messages: [
    {
      id: 'm',
      role: 'assistant',
      settled: true,
      text: '[文件](src/main.ts) [网页](https://example.com)',
    },
  ],
  loading: false,
  connected: true,
  connectionLabel: 'connected',
  actions: {},
  onOpen: () => {},
};

test('read-only page permits reading and web links without exposing local or mutation operations', () => {
  const html = renderToStaticMarkup(<SessionPage {...base} readOnlyReason="只读访问" />);
  expect(html).toContain('只读访问');
  expect(html).toContain('https://example.com');
  expect(html).not.toContain('class="file-link"');
  expect(html).not.toContain('任务输入');
  expect(html).not.toContain('新对话');
  expect(html).not.toContain('模型与 Provider 设置');
  expect(html).toContain('aria-label="收起侧栏"');
  expect(html).not.toContain('data-tauri-drag-region');
  expect(html).toContain('<strong>Session</strong>');
  expect(html.match(/<header/g)).toHaveLength(1);
});

test('the same page renders granted operations while an unavailable send stays disabled', () => {
  const html = renderToStaticMarkup(
    <SessionPage
      {...base}
      actions={{ newSession: () => {}, openFile: () => {}, settings: () => {} }}
      composer={{
        draft: '保留的草稿',
        onChange: () => {},
        active: false,
        stopping: false,
        disabled: false,
      }}
    />,
  );
  expect(html).toContain('class="file-link"');
  expect(html).toContain('新对话');
  expect(html).toContain('任务输入');
  expect(html).toMatch(/<button[^>]*aria-label="发送消息"[^>]*disabled=""/);
});

test('workbench reuses the shared shell and groups only facts present in session summaries', () => {
  const html = renderToStaticMarkup(
    <SessionPage
      {...base}
      selected={undefined}
      actions={{ workbench: () => {} }}
      workbench
      workspaces={[
        {
          id: 'w',
          label: 'Workspace',
          state: 'loaded',
          sessionCount: 5,
          sessions: [
            {
              sessionId: 'waiting',
              displayName: '需要确认',
              status: 'waiting',
              pendingInteractions: 1,
            },
            { sessionId: 'running', displayName: '正在测试', status: 'running' },
            { sessionId: 'recover', displayName: '需要恢复', status: 'recovery_required' },
            { sessionId: 'idle', displayName: '尚未开始', status: 'idle' },
            { sessionId: 'done', displayName: '已经结束', status: 'completed' },
          ],
        },
      ]}
    />,
  );
  expect(html).toContain('aria-label="工作台"');
  expect(html).toContain('需要确认');
  expect(html).toContain('正在测试');
  expect(html).toContain('需要恢复');
  expect(html).toContain('尚未开始');
  expect(html).toContain('已经结束');
  expect(html).not.toContain('等待下一步');
  expect(html).not.toContain('已完成');
  expect(html).not.toContain('需要我处理');
  expect(html).toContain('最近会话');
  expect(html).toContain('aria-label="主要导航"');
  expect(html).not.toContain('任务输入');
});

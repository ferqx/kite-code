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
  expect(html).not.toContain('加载更早的会话');
  expect(html).toContain('data-radix-scroll-area-viewport');
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

test('new and running conversations share one composer prompt', () => {
  for (const active of [false, true]) {
    const html = renderToStaticMarkup(
      <SessionPage
        {...base}
        newConversation={
          active
            ? undefined
            : {
                projects: [],
                workspace: '/workspace',
                busy: false,
                onProject: () => {},
                onAddProject: () => {},
                onBranch: () => {},
                onRefreshBranch: () => {},
              }
        }
        composer={{
          draft: '',
          onChange: () => {},
          active,
          stopping: false,
          disabled: false,
        }}
      />,
    );
    expect(html).toContain('placeholder="描述你想完成的工作…"');
    expect(html).not.toContain('可以先写下下一步要求');
  }
});

test('the primary new-conversation navigation exposes its stable style hook while disabled', () => {
  const html = renderToStaticMarkup(
    <SessionPage {...base} busy actions={{ newSession: () => {} }} />,
  );
  expect(html).toMatch(/class="[^"]*new-session[^"]*"[^>]*disabled=""/);
});

test('an optimistic first message replaces loading and welcome content', () => {
  const html = renderToStaticMarkup(
    <SessionPage
      {...base}
      messages={[
        {
          id: 'optimistic',
          role: 'user',
          text: '正在提交的首条消息',
          settled: false,
          delivery: 'sending',
        },
      ]}
      loading={false}
      composer={{
        draft: '',
        onChange: () => {},
        active: false,
        stopping: false,
        disabled: false,
      }}
    />,
  );
  expect(html).toContain('正在提交的首条消息');
  expect(html).toContain('正在发送');
  expect(html).not.toContain('从一个想法开始');
  expect(html).not.toContain('描述你的目标');
  expect(html).not.toContain('正在加载会话历史');
  expect(html).not.toContain('class="welcome"');
});

test('an unsettled assistant message exposes reply activity outside its content', () => {
  const streaming = renderToStaticMarkup(
    <SessionPage
      {...base}
      messages={[
        {
          id: 'streaming',
          role: 'assistant',
          text: '已经生成的部分',
          settled: false,
        },
      ]}
    />,
  );
  expect(streaming).toContain('aria-busy="true"');
  expect(streaming).toContain('class="message assistant responding"');
  expect(streaming).toContain('class="response-status" role="status">正在回复…');
  expect(streaming).toContain('已经生成的部分');

  const settled = renderToStaticMarkup(<SessionPage {...base} />);
  expect(settled).not.toContain('正在回复');
  expect(settled).not.toContain('response-status');
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
  expect(html).toContain('data-radix-scroll-area-viewport');
  expect(html).not.toContain('>全部<');
  expect(html).not.toContain('最近更新');
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

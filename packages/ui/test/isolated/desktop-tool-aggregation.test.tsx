import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Conversation } from '../../src/desktop/Conversation';
import { DesktopDiagnosticsProvider } from '../../src/desktop/diagnostics';
import { ToolActivity, ToolRow } from '../../src/desktop/ToolActivity';
import type { Message } from '../../src/desktop/types';

const tool = (id: string, status: NonNullable<Message['status']> = 'queued'): Message => ({
  id: `tool:${id}`,
  turnId: 'run',
  role: 'tool',
  toolName: 'read_file',
  target: `${id}.ts`,
  presentation: 'exploration',
  presentationGroupId: `batch:${id}`,
  text: '',
  status,
  settled: ['completed', 'failed'].includes(status),
});

async function withConversation(
  inspect: (fixture: {
    host: HTMLElement;
    render: (messages: Message[]) => Promise<void>;
    click: (element: Element) => Promise<void>;
  }) => Promise<void>,
  extra: Partial<ComponentProps<typeof Conversation>> = {},
) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const keys = [
    'window',
    'document',
    'navigator',
    'IS_REACT_ACT_ENVIRONMENT',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ] as const;
  const previous = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  }))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  try {
    await inspect({
      host,
      render: (messages) =>
        act(async () => {
          root.render(
            <Conversation
              messages={messages}
              loading={false}
              selected
              connected
              turnActivity={{ turnId: 'run', status: 'running' }}
              saveReading={() => {}}
              renderToolActivity={(group, state) => (
                <ToolActivity
                  messages={group}
                  {...state}
                  renderChildren={(_, open) =>
                    group.length === 1 && !group[0]!.toolName && open ? (
                      <pre key={group[0]!.id}>ORIGINAL_TOOL_RECORD</pre>
                    ) : null
                  }
                />
              )}
              {...extra}
            />,
          );
        }),
      click: (element) =>
        act(async () => {
          element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        }),
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function summary(host: HTMLElement) {
  const button = host.querySelector<HTMLButtonElement>('.tool-activity-summary[aria-expanded]');
  expect(button).not.toBeNull();
  return button!;
}

test('the shared task adapter retains exact child navigation inside a mixed aggregate', async () => {
  const opened: string[] = [];
  await withConversation(
    async ({ host, render, click }) => {
      await render([
        { ...tool('task', 'completed'), toolName: 'task' },
        tool('read', 'running'),
        {
          id: 'subagent:child-task',
          role: 'subagent',
          turnId: 'run',
          parentToolCallId: 'task',
          title: 'Child',
          text: 'Child result',
          settled: true,
        },
      ]);
      await click(summary(host));
      const detail = host.querySelector('[aria-label="查看子 Agent 详情：Child"]');
      expect(detail).not.toBeNull();
      await click(detail!);
      expect(opened).toEqual(['child-session']);
    },
    {
      renderToolActivity: undefined,
      childSessionIdsByTaskId: new Map([['child-task', 'child-session']]),
      onOpenChildSession: (id) => opened.push(id),
    },
  );
});

test('the first tool owns one stable aggregate through mixed calls and delayed metadata', async () => {
  await withConversation(async ({ host, render, click }) => {
    const first: Message = {
      id: 'tool:a',
      turnId: 'run',
      role: 'tool',
      text: 'PRIVATE_RECEIPT',
      presentationGroupId: 'continuous-tools',
      settled: true,
    };
    await render([first]);
    const activity = host.querySelector('.tool-activity-aggregate');
    const button = summary(host);
    expect(host.querySelector('.conversation-viewport')?.classList.contains('scroll-fade-y')).toBe(
      false,
    );
    expect(button.textContent).toBe('使用工具');
    expect(host.textContent).not.toContain('PRIVATE_RECEIPT');
    await click(button);
    const names = [
      'read_file',
      'write_file',
      'edit_file',
      'shell_execute',
      'mcp_tool',
      'spawn_agent',
      undefined,
    ];
    const mixed = names.map(
      (toolName, index): Message => ({
        ...tool(index === 0 ? 'a' : String(index), index === 0 ? 'completed' : 'running'),
        toolName,
        presentation: 'standalone',
        presentationGroupId: 'continuous-tools',
        target: index === 3 ? 'bun test' : `target-${index}`,
        text: index === 6 ? 'UNKNOWN_TOOL_RECORD' : '',
      }),
    );
    await render(mixed);
    expect(host.querySelector('.tool-activity-aggregate')).toBe(activity);
    expect(summary(host)).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.textContent).toContain(
      '读取文件编辑文件运行命令调用 MCP 工具创建子 Agent使用工具',
    );
    expect(button.textContent).not.toContain('执行中');
    expect(button.textContent).not.toContain('target-');
    expect(host.querySelectorAll('.tool-activity-aggregate')).toHaveLength(1);
    expect(
      host.querySelectorAll(
        '.tool-activity-steps > .tool-activity, .tool-activity-steps > .tool-activity-step',
      ),
    ).toHaveLength(7);
    expect(host.textContent).not.toContain('UNKNOWN_TOOL_RECORD');
    await click(button);
    await render(mixed.map((message) => ({ ...message, status: 'completed', settled: true })));
    expect(summary(host)).toBe(button);
    expect(host.querySelector('.tool-activity-aggregate')).toBe(activity);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.textContent).toBe('读取文件编辑文件运行命令调用 MCP 工具创建子 Agent使用工具');
    expect(host.querySelector('.tool-activity-steps')).toBeNull();
  });
});

test('readable narration and a new Turn delimit mixed tool activities', async () => {
  await withConversation(async ({ host, render }) => {
    await render([
      tool('a', 'completed'),
      { ...tool('b', 'completed'), toolName: 'write_file', presentation: 'standalone' },
      { id: 'narration', role: 'assistant', turnId: 'run', settled: true, text: '下一步检查' },
      { ...tool('c', 'running'), toolName: 'shell_execute', presentation: 'standalone' },
      { ...tool('d', 'running'), turnId: 'next-run', toolName: 'mcp_tool' },
    ]);
    expect(host.querySelectorAll('.tool-activity-aggregate')).toHaveLength(3);
    expect(host.querySelectorAll('.tool-activity-aggregate')[0]?.textContent).toContain(
      '读取文件编辑文件',
    );
    expect(host.textContent).toContain('下一步检查');
  });
});

test('a host-proven empty tool declaration never splits or remounts a collapsed activity', async () => {
  await withConversation(async ({ host, render }) => {
    const declaration: Message = {
      id: 'model-tools',
      role: 'assistant',
      turnId: 'run',
      text: '',
      settled: false,
      presentation: 'hidden',
    };
    const messages = (settled: boolean) => [
      tool('a', 'completed'),
      { ...declaration, settled },
      { ...tool('b', 'running'), presentationGroupId: 'same-continuous-block' },
    ];
    await render(messages(false));
    const activity = host.querySelector('.tool-activity-aggregate');
    const button = summary(host);
    expect(host.querySelectorAll('.tool-activity-aggregate')).toHaveLength(1);
    expect(host.querySelector('[data-message-id="model-tools"]')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await render(messages(true));
    expect(host.querySelectorAll('.tool-activity-aggregate')).toHaveLength(1);
    expect(host.querySelector('.tool-activity-aggregate')).toBe(activity);
    expect(summary(host)).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.tool-activity-steps')).toBeNull();
  });
});

test('mixed aggregate headings contain only the action label for every approval and execution state', () => {
  const messages: Message[] = [
    { ...tool('done', 'completed'), toolName: 'write_file' },
    { ...tool('run', 'running'), toolName: 'shell_execute' },
    tool('queue'),
    { ...tool('auto', 'running'), approval: { state: 'checking', source: 'auto' } },
    { ...tool('human', 'waiting'), approval: { state: 'awaiting_user', source: 'user' } },
    tool('failed', 'failed'),
    tool('unknown', 'unknown'),
    tool('stopped', 'cancelled'),
    { ...tool('refresh', 'not_executed'), decisionRefresh: 'context_refresh_required' },
    { ...tool('unverified'), status: undefined },
  ];
  const dom = new JSDOM(
    renderToStaticMarkup(
      <ToolActivity messages={messages} onToggle={() => {}} renderChildren={() => null} />,
    ),
  );
  try {
    const text = dom.window.document.body.textContent;
    expect(text).toBe('编辑文件运行命令读取文件');
    for (const label of [
      '正在自动审批',
      '等待人工审批',
      '执行中',
      '等待执行',
      '失败',
      '结果未知',
      '已停止',
      '重新评估',
    ])
      expect(text).not.toContain(label);
    expect(dom.window.document.querySelector('.tool-activity-title')?.textContent).not.toMatch(
      /[了、]/,
    );
    expect(text).not.toContain('已完成 10 项');
    expect(dom.window.document.querySelector('.tool-activity-count')).toBeNull();
    expect(dom.window.document.querySelector('.tool-activity-state')).toBeNull();
    expect(dom.window.document.querySelector('.tool-activity')?.getAttribute('aria-label')).toBe(
      text,
    );
    expect(
      dom.window.document.querySelector('.tool-activity-marker-content')?.getAttribute('title'),
    ).toBe(text);
    expect(dom.window.document.querySelector('button')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
  } finally {
    dom.window.close();
  }
});

test('approval rows omit redundant pre-dispatch results while preserving independent execution outcomes', () => {
  const cases: {
    message: Partial<Message>;
    approval?: string;
    result?: string;
  }[] = [
    {
      message: { status: 'failed', approval: { source: 'auto', state: 'rejected' } },
      approval: '自动审批未通过',
    },
    {
      message: { status: 'failed', approval: { source: 'user', state: 'rejected' } },
      approval: '人工审批已拒绝',
    },
    {
      message: { status: 'cancelled', approval: { source: 'auto', state: 'cancelled' } },
      approval: '自动审批已停止',
    },
    {
      message: { status: 'cancelled', approval: { source: 'user', state: 'cancelled' } },
      approval: '审批已取消',
    },
    {
      message: { status: 'cancelled', approval: { source: 'auto', state: 'checking' } },
      approval: '自动审批已停止',
    },
    {
      message: {
        status: 'queued',
        settled: false,
        approval: { source: 'user', state: 'awaiting_user' },
      },
      approval: '等待人工审批',
    },
    ...(['running', 'failed', 'unknown', 'cancelled'] as const).map((status, index) => ({
      message: {
        status,
        settled: status !== 'running',
        dispatchCommitted: true,
        approval: { source: 'auto' as const, state: 'approved' as const },
      },
      approval: '已自动批准',
      result: ['执行中', '失败', '结果未知', '已停止'][index],
    })),
    ...(['approve_once', 'same_command'] as const).map((grant) => ({
      message: {
        status: 'running' as const,
        settled: false,
        dispatchCommitted: true,
        approval: { source: 'user' as const, state: 'approved' as const, grant },
      },
      approval: grant === 'same_command' ? '已人工批准 · 本会话相同命令' : '已人工批准',
      result: '执行中',
    })),
    {
      message: { status: 'unknown', approval: { source: 'auto', state: 'rejected' } },
      approval: '自动审批未通过',
      result: '结果未知',
    },
    {
      message: {
        status: 'failed',
        approval: { source: 'auto', state: 'rejected' },
        toolResult: { ok: false, status: 'error', terminationReason: 'timed_out' },
      },
      approval: '自动审批未通过',
      result: '执行超时',
    },
    {
      message: { status: 'unknown', approval: { source: 'auto', state: 'unavailable' } },
      approval: '自动审批结果未知',
      result: '结果未知',
    },
    {
      message: { status: 'not_executed', decisionRefresh: 'context_refresh_required' },
      result: '上下文已更新，此次未执行',
    },
  ];
  for (const toolName of ['read_file', 'edit_file', 'custom.remote', 'shell_execute']) {
    for (const item of cases) {
      const message: Message = {
        ...tool('approval-row', 'failed'),
        toolName,
        dispatchCommitted: false,
        ...item.message,
      };
      for (const render of [
        <ToolRow key="row" message={message} />,
        <ToolActivity
          key="activity"
          messages={[message]}
          onToggle={() => {}}
          renderChildren={() => null}
        />,
      ]) {
        const dom = new JSDOM(renderToStaticMarkup(render));
        try {
          const root = dom.window.document;
          const approval = root.querySelector('.tool-approval');
          expect(approval?.getAttribute('aria-label') ?? approval?.textContent).toBe(item.approval);
          if (message.approval?.state === 'approved') {
            expect(approval?.textContent).toBe('');
            expect(approval?.querySelector('svg')).not.toBeNull();
            expect(root.querySelector('button .tool-approval[tabindex]')).toBeNull();
          }
          if (root.querySelector('.shell-activity')) {
            expect(root.querySelector('.tool-step-status,.tool-activity-state')).toBeNull();
            if (item.result) {
              const expected =
                (
                  { 执行中: '运行中', 失败: '运行失败', 执行超时: '运行超时' } as Record<
                    string,
                    string
                  >
                )[item.result] ?? item.result;
              expect(root.querySelector('.tool-activity-title')?.textContent).toBe(expected);
            }
          } else
            expect(root.querySelector('.tool-step-status,.tool-activity-state')?.textContent).toBe(
              item.result,
            );
          if (!item.result) expect(root.body.textContent).not.toContain('未执行');
        } finally {
          dom.window.close();
        }
      }
      if (toolName === 'shell_execute' && message.approval) {
        const dom = new JSDOM(
          renderToStaticMarkup(
            <ToolActivity
              messages={[message]}
              expanded
              onToggle={() => {}}
              renderChildren={() => null}
            />,
          ),
        );
        try {
          expect(dom.window.document.querySelector('.shell-result')?.textContent).toBe(item.result);
          expect(
            [...dom.window.document.querySelectorAll('.tool-approval')].map(
              (element) => element.getAttribute('aria-label') ?? element.textContent,
            ),
          ).toEqual(item.approval ? [item.approval] : []);
        } finally {
          dom.window.close();
        }
      }
    }
  }
});

test('Shell cards retain the original command and output while the header stays a compact status summary', async () => {
  const command = `python3 - <<'PY'\nprint('旅程🙂')\n# ${'长命令'.repeat(250)}\nPY`;
  const original: Message = {
    ...tool('shell-card', 'running'),
    toolName: 'shell_execute',
    shell: {
      operation: 'execute',
      command,
      jobStatus: 'running',
      stdout: '第一行\n',
      outputComplete: false,
    },
  };
  await withConversation(async ({ host, render, click }) => {
    await render([original]);
    await click(summary(host));
    const button = host.querySelector('.shell-activity .tool-activity-summary')!;
    expect(button.querySelector('.tool-activity-title')?.textContent).toBe('运行中');
    expect(button.querySelector('.tool-command')?.textContent).not.toContain('\n');
    expect(button.querySelector('.tool-command')?.textContent?.length).toBeLessThanOrEqual(513);
    await click(button);
    const viewport = host.querySelector('.shell-output-viewport')!;
    expect(host.querySelector('.shell-output-header .shell-command-text')?.textContent).toBe(
      command,
    );
    expect(viewport.querySelector('.shell-command-text')).toBeNull();
    expect(
      host.querySelector('.shell-output-header [data-slot="code-block-copy-button"]'),
    ).not.toBeNull();
    expect(host.querySelector('.shell-command-text')?.textContent).toBe(command);
    expect(host.querySelector('.shell-console-output')?.textContent).toBe('第一行\n');
    expect(host.querySelector('.shell-result-icon')).toBeNull();
    await render([
      {
        ...original,
        status: 'completed',
        settled: true,
        shell: {
          ...original.shell!,
          jobStatus: 'succeeded',
          stdout: '第一行\n第二行🙂\n',
          exitCode: 0,
          outputComplete: true,
        },
      },
    ]);
    expect(host.querySelector('.shell-output-viewport')).toBe(viewport);
    expect(host.querySelector('.shell-activity .tool-activity-summary')).toBe(button);
    expect(button.querySelector('.tool-activity-title')?.textContent).toBe('已运行');
    expect(host.querySelector('.shell-command-text')?.textContent).toBe(command);
    expect(host.querySelector('.shell-console-output')?.textContent).toBe('第一行\n第二行🙂\n');
    expect(host.querySelector('.shell-result')?.textContent).toBe('成功');
    expect(host.querySelector('.shell-result-icon')).not.toBeNull();
    expect(host.querySelector('button button')).toBeNull();
  });
});

test('Shell result cards distinguish process outcomes from acceptance, reads, waiting and cancellation requests', () => {
  const cases: {
    shell: NonNullable<Message['shell']>;
    status?: Message['status'];
    text?: string;
    label: string;
    success?: boolean;
    body?: string;
  }[] = [
    { shell: { operation: 'launch', accepted: true }, label: '已受理' },
    {
      shell: {
        operation: 'read',
        jobStatus: 'running',
        output: 'first\nerror\ndone\n',
        outputComplete: false,
      },
      label: '执行中 · 部分输出',
      body: 'first\nerror\ndone\n',
    },
    {
      shell: { operation: 'wait', jobStatus: 'running', timedOut: true },
      label: '等待超时 · 命令仍在运行',
    },
    {
      shell: { operation: 'stop', jobStatus: 'running', cancelRequested: true },
      label: '已请求停止，等待结束',
    },
    {
      shell: { operation: 'read', jobStatus: 'failed', outputComplete: false },
      text: 'ORIGINAL_JOB_FAILURE_DETAIL',
      label: '失败',
      body: 'ORIGINAL_JOB_FAILURE_DETAIL',
    },
    {
      shell: { operation: 'read', jobStatus: 'outcome_unknown' },
      text: 'ORIGINAL_UNKNOWN_DETAIL',
      label: '结果未知',
      body: 'ORIGINAL_UNKNOWN_DETAIL',
    },
    {
      shell: { operation: 'execute', jobStatus: 'cancelled', timedOut: true, exitCode: 143 },
      status: 'failed',
      label: '执行超时 · 退出码 143',
    },
    {
      shell: { operation: 'execute', jobStatus: 'cancelled', outputComplete: false },
      status: 'cancelled',
      label: '已停止',
      body: '本次记录未包含完整输出。',
    },
    {
      shell: { operation: 'launch' },
      text: 'ORIGINAL_UNVERIFIED_LAUNCH',
      label: '启动结果未提供',
      body: 'ORIGINAL_UNVERIFIED_LAUNCH',
    },
    ...(['read', 'wait', 'stop'] as const).map((operation) => ({
      shell: { operation },
      text: `ORIGINAL_UNVERIFIED_${operation}`,
      label: { read: '读取结果未提供', wait: '等待结果未提供', stop: '停止结果未提供' }[operation],
      body: `ORIGINAL_UNVERIFIED_${operation}`,
    })),
    {
      shell: { operation: 'execute', jobStatus: 'outcome_unknown', stdout: 'partial\n' },
      status: 'unknown',
      text: 'shell_owned_cleanup_unconfirmed: cleanupConfirmed=false',
      label: '结果未知',
      body: 'partial\n\n\nshell_owned_cleanup_unconfirmed: cleanupConfirmed=false',
    },
    {
      shell: { operation: 'execute', jobStatus: 'failed', stderr: 'process output', exitCode: 7 },
      status: 'failed',
      text: 'supervisorFailure: supervisorErrno=5',
      label: '失败 · 退出码 7',
      body: 'process output\n\nsupervisorFailure: supervisorErrno=5',
    },
    {
      shell: { operation: 'execute' },
      text: 'ORIGINAL_UNVERIFIED_EXECUTION',
      label: '命令结果未提供',
      body: 'ORIGINAL_UNVERIFIED_EXECUTION',
    },
    {
      shell: { operation: 'execute', jobStatus: 'succeeded', outputComplete: false },
      label: '成功',
      success: true,
      body: '本次记录未包含完整输出。',
    },
    {
      shell: { operation: 'execute', jobStatus: 'succeeded', outputComplete: true },
      label: '成功',
      success: true,
      body: '命令执行成功，无输出。',
    },
  ];
  for (const [index, item] of cases.entries()) {
    const dom = new JSDOM(
      renderToStaticMarkup(
        <ToolActivity
          messages={[
            {
              ...tool(`shell-result-${index}`, item.status ?? 'completed'),
              toolName: 'shell_execute',
              text: item.text ?? '',
              settled: true,
              shell: item.shell,
            },
          ]}
          expanded
          onToggle={() => {}}
          renderChildren={() => null}
        />,
      ),
    );
    try {
      const root = dom.window.document;
      expect(root.querySelector('.shell-result')?.textContent).toBe(item.label);
      expect(Boolean(root.querySelector('.shell-result-icon'))).toBe(!!item.success);
      if (item.body)
        expect(root.querySelector('.shell-console-output')?.textContent).toBe(item.body);
      if (!item.success)
        expect(root.querySelector('.shell-console-output')?.textContent).not.toContain(
          '成功，无输出',
        );
    } finally {
      dom.window.close();
    }
  }
});

test('a completed command read replaces its preview without replacing the Shell viewport or the manual reading position', async () => {
  const command = "python3 - <<'PY'\nprint('完整命令🙂')\nPY";
  const message: Message = {
    ...tool('shell-command-read', 'completed'),
    toolName: 'shell_execute',
    shell: {
      operation: 'execute',
      commandPreview: 'python3 -',
      jobStatus: 'succeeded',
      stdout: '原输出\n',
      outputComplete: true,
    },
  };
  await withConversation(async ({ host, render, click }) => {
    await render([message]);
    await click(summary(host));
    const button = host.querySelector('.shell-activity .tool-activity-summary')!;
    await click(button);
    const viewport = host.querySelector<HTMLElement>('.shell-output-viewport')!;
    expect(host.querySelector('.shell-command-preview-label')?.textContent).toContain('命令摘要');
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
    });
    viewport.scrollTop = 50;
    await act(async () =>
      viewport.dispatchEvent(
        new viewport.ownerDocument.defaultView!.Event('scroll', { bubbles: true }),
      ),
    );
    await render([
      { ...message, shell: { ...message.shell!, command, commandPreview: undefined } },
    ]);
    expect(host.querySelector('.shell-output-viewport')).toBe(viewport);
    expect(host.querySelector('.shell-activity .tool-activity-summary')).toBe(button);
    expect(viewport.scrollTop).toBe(50);
    expect(host.querySelector('.shell-command-text')?.textContent).toBe(command);
    expect(host.querySelector('.shell-command-preview-label')).toBeNull();
    expect(host.querySelector('.shell-console-output')?.textContent).toBe('原输出\n');
    expect(host.querySelector('.shell-latest')).toBeNull();
    expect(host.textContent).not.toContain('回到最新输出');
  });
});

test('finished activity describes the combined actions once without a tool counter', () => {
  const messages = [
    { ...tool('edit', 'completed'), toolName: 'edit_file' },
    { ...tool('write', 'completed'), toolName: 'write_file' },
    tool('read-a', 'completed'),
    tool('read-b', 'completed'),
    { ...tool('shell', 'completed'), toolName: 'shell_execute' },
  ];
  const dom = new JSDOM(
    renderToStaticMarkup(
      <ToolActivity messages={messages} onToggle={() => {}} renderChildren={() => null} />,
    ),
  );
  try {
    expect(dom.window.document.querySelector('.tool-activity-summary')?.textContent).toBe(
      '编辑文件读取文件运行命令',
    );
  } finally {
    dom.window.close();
  }
});

test('each failed or refused tool exposes its complete error only through its own retained disclosure', async () => {
  const longError = `READ_ERROR_BEGIN\n${'完整错误正文🙂'.repeat(80)}\nREAD_ERROR_END`;
  const messages: Message[] = [
    {
      ...tool('read-error', 'failed'),
      text: longError,
      toolResult: { ok: false, status: 'error', stderr: longError, stdout: 'READ_STDOUT' },
    },
    {
      ...tool('write-denied', 'failed'),
      toolName: 'write_file',
      text: 'Automatic approval did not authorize this tool. AUTO_DENIAL_REASON',
      approval: { source: 'auto', state: 'rejected', reason: 'AUTO_DENIAL_REASON' },
    },
    {
      ...tool('shell-error', 'failed'),
      toolName: 'shell_execute',
      toolResult: { ok: false, status: 'error', stdout: 'SHELL_STDOUT', stderr: 'SHELL_STDERR' },
      text: 'SHELL_FAILURE_TEXT',
      approval: { source: 'auto', state: 'rejected', reason: 'SHELL_DENIAL_REASON' },
    },
    {
      ...tool('custom-error', 'failed'),
      toolName: 'custom.remote',
      text: 'CUSTOM_FAILURE_TEXT',
      toolResult: { ok: false, status: 'error', stdout: 'CUSTOM_STDOUT', stderr: 'CUSTOM_STDERR' },
    },
    {
      ...tool('read-wait', 'queued'),
      approval: { source: 'user', state: 'awaiting_user', reason: 'HUMAN_PENDING_REASON' },
    },
    { ...tool('read-unknown', 'unknown'), settled: true, text: 'UNKNOWN_ORIGINAL_FACT' },
  ];
  const privateText = [
    longError,
    'READ_STDOUT',
    'AUTO_DENIAL_REASON',
    'SHELL_STDOUT',
    'SHELL_STDERR',
    'SHELL_FAILURE_TEXT',
    'SHELL_DENIAL_REASON',
    'CUSTOM_FAILURE_TEXT',
    'CUSTOM_STDOUT',
    'CUSTOM_STDERR',
    'HUMAN_PENDING_REASON',
    'UNKNOWN_ORIGINAL_FACT',
  ];
  await withConversation(async ({ host, render, click }) => {
    await render(messages);
    const aggregate = summary(host);
    const label = '读取文件编辑文件运行命令使用工具';
    expect(aggregate.textContent).toBe(label);
    expect(host.querySelector('.tool-activity-aggregate')?.getAttribute('aria-label')).toBe(label);
    expect(aggregate.querySelector('[title]')?.getAttribute('title')).toBe(label);
    await click(aggregate);
    const region = host.querySelector('.tool-activity-steps')!;
    const viewport = region.closest('[data-slot="scroll-area-viewport"]')!;
    expect(viewport.getAttribute('role')).toBe('region');
    expect(viewport.getAttribute('aria-label')).toBe('工具执行明细');
    expect(viewport.getAttribute('tabindex')).toBe('0');
    expect(viewport.classList.contains('scroll-fade-y')).toBe(true);
    expect(region.children).toHaveLength(messages.length);
    expect(host.querySelector('.tool-step-preview')).toBeNull();
    for (const text of privateText) expect(region.textContent).not.toContain(text);
    const item = (index: number) => host.querySelector('.tool-activity-steps')!.children[index]!;
    const itemButton = (index: number) => item(index).querySelector('.tool-activity-summary')!;
    for (const [index, expected] of [
      [0, [longError, 'READ_STDOUT']],
      [1, ['AUTO_DENIAL_REASON', 'Automatic approval did not authorize this tool']],
      [2, ['SHELL_STDOUT', 'SHELL_STDERR', 'SHELL_FAILURE_TEXT', 'SHELL_DENIAL_REASON']],
      [3, ['CUSTOM_FAILURE_TEXT', 'CUSTOM_STDOUT', 'CUSTOM_STDERR']],
      [4, ['HUMAN_PENDING_REASON']],
      [5, ['UNKNOWN_ORIGINAL_FACT']],
    ] as const) {
      await click(itemButton(index));
      const detail = item(index).querySelector('pre');
      expect(detail).not.toBeNull();
      expect(detail?.closest('[data-slot="scroll-area-viewport"]')).not.toBeNull();
      expect(
        detail?.closest('[data-slot="scroll-area-viewport"]')?.classList.contains('scroll-fade-y'),
      ).toBe(true);
      for (const text of expected) expect(detail?.textContent).toContain(text);
      if (index === 0) expect(detail?.textContent?.match(/READ_ERROR_BEGIN/g)).toHaveLength(1);
      if (index === 1) expect(detail?.textContent?.match(/AUTO_DENIAL_REASON/g)).toHaveLength(1);
      await click(itemButton(index));
      expect(item(index).querySelector('pre')).toBeNull();
      for (const text of expected) expect(item(index).textContent).not.toContain(text);
    }
    expect(item(4).textContent).toContain('等待人工审批');
    expect(item(5).textContent).toContain('结果未知');
    await click(itemButton(0));
    await click(itemButton(3));
    await click(aggregate);
    for (const text of privateText) expect(host.textContent).not.toContain(text);
    await render([...messages, { ...tool('new-read', 'completed') }]);
    expect(summary(host)).toBe(aggregate);
    expect(aggregate.textContent).toBe(label);
    await click(aggregate);
    expect(item(0).querySelector('pre')?.textContent).toContain(longError);
    expect(item(3).querySelector('pre')?.textContent).toContain('CUSTOM_FAILURE_TEXT');
    expect(item(1).querySelector('pre')).toBeNull();
  });
});

test('failed Shell details retain each progress stream omitted by the final result', async () => {
  const messages: Message[] = [
    {
      ...tool('partial-stderr', 'failed'),
      toolName: 'shell_execute',
      toolProgress: { stdout: 'SAVED_PROGRESS_STDOUT', stderr: 'OLD_STDERR' },
      toolResult: { ok: false, status: 'error', stderr: 'FINAL_STDERR' },
      text: 'FAILED_SHELL_REASON',
    },
    {
      ...tool('partial-stdout', 'failed'),
      toolName: 'shell_execute',
      toolProgress: { stdout: 'OLD_STDOUT', stderr: 'SAVED_PROGRESS_STDERR' },
      toolResult: { ok: false, status: 'error', stdout: 'FINAL_STDOUT' },
      text: 'SECOND_FAILED_SHELL_REASON',
    },
  ];
  await withConversation(async ({ host, render, click }) => {
    await render(messages);
    await click(summary(host));
    const items = host.querySelectorAll('.tool-activity-steps > .tool-activity');
    for (const [index, streams] of [
      [0, ['SAVED_PROGRESS_STDOUT', 'FINAL_STDERR', 'FAILED_SHELL_REASON']],
      [1, ['FINAL_STDOUT', 'SAVED_PROGRESS_STDERR', 'SECOND_FAILED_SHELL_REASON']],
    ] as const) {
      expect(items[index]?.querySelector('pre')).toBeNull();
      await click(items[index]!.querySelector('.tool-activity-summary')!);
      const output = items[index]!.querySelector('pre')?.textContent;
      for (const stream of streams) expect(output).toContain(stream);
      expect(output).not.toContain('OLD_STDOUT');
      expect(output).not.toContain('OLD_STDERR');
    }
  });
});

test('successful file readers and confirmed file diffs retain their existing file actions', async () => {
  const opened: string[] = [];
  await withConversation(
    async ({ host, render, click }) => {
      await render([
        tool('success-read', 'completed'),
        {
          ...tool('success-write', 'completed'),
          toolName: 'write_file',
          changeConfirmed: true,
          toolResult: { ok: true, status: 'success', stdout: '1 -old\n1 +new' },
        },
      ]);
      await click(summary(host));
      const region = host.querySelector('.tool-activity-steps')!;
      const paths = [...region.querySelectorAll('.file-link')];
      expect(paths.map((node) => node.textContent)).toEqual([
        'success-read.ts',
        'success-write.ts',
      ]);
      await click(paths[0]!);
      await click(paths[1]!);
      expect(opened).toEqual(['success-read.ts', 'success-write.ts']);
      const diff = region.querySelector('.tool-diff-toggle')!;
      expect(region.querySelector('.diff-output')).toBeNull();
      await click(diff);
      expect(region.querySelector('.diff-output')?.textContent).toContain('1 +new');
      expect(region.querySelector('.tool-detail')).toBeNull();
    },
    { renderToolActivity: undefined, openFile: (path) => opened.push(path) },
  );
});

test('public lightweight ToolRow never publishes exception or approval reason previews', () => {
  for (const toolName of ['read_file', 'write_file', 'custom.remote']) {
    const markup = renderToStaticMarkup(
      <ToolRow
        message={{
          ...tool('private', 'failed'),
          toolName,
          text: 'PRIVATE_FAILURE',
          approval: { state: 'rejected', source: 'auto', reason: 'PRIVATE_APPROVAL_REASON' },
        }}
        showReadFailure
      />,
    );
    expect(markup).not.toContain('PRIVATE_FAILURE');
    expect(markup).not.toContain('PRIVATE_APPROVAL_REASON');
    expect(markup).toContain('自动审批未通过');
    expect(markup).not.toContain('tool-step-preview');
  }
});

test('question receipts keep their answers while failed question tools retain their separate error detail', async () => {
  await withConversation(async ({ host, render, click }) => {
    await render([
      {
        ...tool('answered', 'completed'),
        toolName: 'ask_user',
        ask: { questions: [{ id: 'q', question: '原问题' }], answers: { q: '原答复' } },
      },
      {
        ...tool('question-failed', 'failed'),
        toolName: 'ask_user',
        ask: { questions: [{ id: 'q2', question: '失败前的问题' }] },
        text: 'QUESTION_TOOL_FAILURE',
      },
    ]);
    await click(summary(host));
    const rows = host.querySelector('.tool-activity-steps')!.children;
    expect(host.textContent).not.toContain('QUESTION_TOOL_FAILURE');
    await click(rows[0]!.querySelector('.tool-activity-summary')!);
    expect(rows[0]!.querySelector('.tool-ask-answers')?.textContent).toContain('原答复');
    await click(rows[1]!.querySelector('.tool-activity-summary')!);
    expect(rows[1]!.querySelector('.tool-detail')?.textContent).toBe('QUESTION_TOOL_FAILURE');
    expect(rows[0]!.querySelector('.tool-ask-answers')?.textContent).toContain('原答复');
  });
});

for (const initial of ['queued', 'running'] as const)
  test(`a ${initial} exploration group remains closed as tools progress, arrive and finish`, async () => {
    await withConversation(async ({ host, render }) => {
      const states = [
        [tool('a', initial), tool('b', initial)],
        [tool('a', 'running'), tool('b', 'queued')],
        [tool('a', 'running'), tool('b', 'running'), tool('c')],
        [tool('a', 'completed'), tool('b', 'running'), tool('c', 'running')],
        [tool('a', 'completed'), tool('b', 'completed'), tool('c', 'completed')],
      ];
      for (const messages of states) {
        await render(messages);
        expect(summary(host).getAttribute('aria-expanded')).toBe('false');
        expect(host.querySelector('.tool-activity-steps')).toBeNull();
      }
    });
  });

test('an exploration group keeps the reader choice when tools arrive or finish', async () => {
  await withConversation(async ({ host, render, click }) => {
    await render([tool('a', 'running'), tool('b')]);
    await click(summary(host));
    expect(summary(host).getAttribute('aria-expanded')).toBe('true');
    await render([tool('a', 'completed'), tool('b', 'running'), tool('c')]);
    expect(summary(host).getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('.tool-activity-step')).toHaveLength(3);
    await click(summary(host));
    expect(summary(host).getAttribute('aria-expanded')).toBe('false');
    await render([tool('a', 'completed'), tool('b', 'completed'), tool('c', 'running'), tool('d')]);
    expect(summary(host).getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.tool-activity-steps')).toBeNull();
  });
});

test('opening an unverified single record does not open the exploration group it later joins', async () => {
  await withConversation(async ({ host, render, click }) => {
    const unverified: Message = {
      id: 'tool:a',
      turnId: 'run',
      role: 'tool',
      text: '',
      settled: true,
    };
    await render([unverified]);
    expect(summary(host).getAttribute('aria-expanded')).toBe('false');
    await click(summary(host));
    expect(summary(host).getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('ORIGINAL_TOOL_RECORD');

    // Verified metadata changes the same first receipt into a lightweight
    // exploration item while another adjacent result joins its aggregation.
    await render([tool('a', 'completed'), tool('b', 'running')]);
    expect(summary(host).getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.tool-activity-steps')).toBeNull();
    expect(host.textContent).not.toContain('ORIGINAL_TOOL_RECORD');

    await click(summary(host));
    await render([tool('a', 'completed'), tool('b', 'completed'), tool('c', 'running')]);
    expect(summary(host).getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('.tool-activity-step')).toHaveLength(3);
  });
});

test('Trace aggregation preserves Shell disclosure, output following and real stopped status', async () => {
  await withConversation(async ({ host, render, click }) => {
    const shell = (stdout: string, status: Message['status'] = 'running'): Message => ({
      ...tool('shell', status),
      toolName: 'shell_execute',
      target: 'bun test',
      toolProgress: { stdout, stderr: '' },
      settled: status === 'cancelled',
    });
    const messages = (stdout: string, status: Message['status'] = 'running') => [
      tool('read', 'completed'),
      shell(stdout, status),
    ];
    await render(messages('first line'));
    await click(summary(host));
    expect(host.querySelector('.tool-activity-steps')?.getAttribute('data-slot')).toBe('trace');
    const shellSummary = () => host.querySelector('.shell-activity .tool-activity-summary')!;
    expect(shellSummary().getAttribute('data-slot')).toBe('trace-collapsible-trigger');
    expect(shellSummary().querySelector('[data-slot="trace-title"]')).not.toBeNull();
    await click(shellSummary());
    const output = () => host.querySelector<HTMLElement>('[aria-label="Shell 执行输出"]')!;
    expect(output().tagName).toBe('DIV');
    expect(output().getAttribute('role')).toBe('region');
    expect(output().getAttribute('tabindex')).toBe('0');
    expect(output().getAttribute('data-slot')).toBe('scroll-area-viewport');
    expect(output().classList.contains('scroll-fade-y')).toBe(true);
    expect(output().querySelector('pre')?.getAttribute('data-slot')).toBe('code-block-content');
    expect(output().querySelector('pre')?.getAttribute('tabindex')).toBe('-1');
    expect(host.querySelector('.shell-output-header .shell-command-text')?.textContent).toBe(
      'bun test',
    );
    expect(output().querySelector('.shell-command-text')).toBeNull();
    expect(output().querySelector('.shell-console-output')?.textContent).toBe('first line');
    Object.defineProperties(output(), {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
    });
    output().scrollTop = 500;
    await act(async () => {
      const scroll = output().ownerDocument.createEvent('Event');
      scroll.initEvent('scroll', true, false);
      output().dispatchEvent(scroll);
    });
    await render(messages('first line\nsecond line'));
    expect(output().scrollTop).toBe(500);
    expect(host.querySelector('.shell-latest')).toBeNull();
    output().scrollTop = 900;
    await act(async () => output().dispatchEvent(new window.Event('scroll', { bubbles: true })));
    await render(messages('first line\nsecond line\nthird line'));
    expect(output().scrollTop).toBe(1000);
    expect(host.querySelector('.shell-latest')).toBeNull();

    // Less than 24 px from the end resumes following; exactly 24 px pauses it.
    for (const [top, paused] of [
      [876, true],
      [877, false],
    ] as const) {
      output().scrollTop = top;
      await act(async () => {
        const scroll = output().ownerDocument.createEvent('Event');
        scroll.initEvent('scroll', true, false);
        output().dispatchEvent(scroll);
      });
      await render(messages(`first line\nsecond line\noutput ${top}`));
      expect(output().scrollTop).toBe(paused ? top : 1000);
      expect(host.querySelector('.shell-latest')).toBeNull();
    }
    await click(summary(host));
    await click(summary(host));
    expect(shellSummary().getAttribute('aria-expanded')).toBe('true');
    expect(output().textContent).toContain('second line');
    await render(messages('first line\nsecond line', 'cancelled'));
    expect(output().textContent).toContain('second line');
    expect(host.querySelector('.shell-result')?.textContent).toContain('已停止');
    expect(host.querySelector('.shell-activity [data-status="error"]')).toBeNull();
    expect(host.querySelector('button button')).toBeNull();
  });
});

test('unconfirmed unfinished tools preserve facts and stop queued, running and review activity until held', () => {
  for (const toolName of ['read_file', 'write_file', 'shell_execute', 'task'])
    for (const status of ['queued', 'running', 'auto_checking', 'auto_reviewing'] as const) {
      const original: Message = {
        ...tool('pending', status),
        toolName,
        ...(status === 'auto_checking' || status === 'auto_reviewing'
          ? {
              approval: {
                state: status === 'auto_checking' ? 'checking' : 'reviewing',
                source: 'auto',
              } as const,
            }
          : {}),
      };
      const render = (messages: Message[]) =>
        new JSDOM(
          renderToStaticMarkup(
            <ToolActivity messages={messages} onToggle={() => {}} renderChildren={() => null} />,
          ),
        );
      const unknown = render([{ ...original, executionUnconfirmed: true }]);
      try {
        expect(unknown.window.document.body.textContent).not.toContain('执行状态待核实');
        expect(unknown.window.document.body.textContent).not.toMatch(/等待执行|正在自动审批/);
        expect(
          unknown.window.document.querySelectorAll(
            '.is-running, [data-status="running"], [data-status="pending"]',
          ),
        ).toHaveLength(0);
      } finally {
        unknown.window.close();
      }
      const held = render([original]);
      try {
        expect(held.window.document.body.textContent).not.toContain('执行状态待核实');
        if (status === 'queued')
          expect(held.window.document.body.textContent).toContain('等待执行');
        if (status === 'auto_checking' || status === 'auto_reviewing')
          expect(held.window.document.body.textContent).toContain('正在自动审批');
      } finally {
        held.window.close();
      }
      const completed = render([
        {
          ...original,
          status: 'completed',
          settled: true,
          approval: undefined,
          executionUnconfirmed: true,
        },
      ]);
      try {
        expect(completed.window.document.body.textContent).not.toContain('执行状态待核实');
      } finally {
        completed.window.close();
      }
      expect(original.status).toBe(status);
      expect(original.settled).toBe(false);
    }
});

test('an unconfirmed exploration group retains successful items without advertising pending work', () => {
  const messages = [
    { ...tool('done', 'completed'), executionUnconfirmed: true },
    { ...tool('waiting', 'queued'), executionUnconfirmed: true },
    { ...tool('active', 'running'), executionUnconfirmed: true },
  ];
  const dom = new JSDOM(
    renderToStaticMarkup(
      <ToolActivity messages={messages} onToggle={() => {}} renderChildren={() => null} />,
    ),
  );
  try {
    expect(dom.window.document.body.textContent).not.toContain('执行状态待核实');
    expect(dom.window.document.body.textContent).not.toMatch(/等待执行|正在执行|正在读取/);
    expect(dom.window.document.querySelectorAll('.is-running')).toHaveLength(0);
    expect(messages.map((message) => [message.status, message.settled])).toEqual([
      ['completed', true],
      ['queued', false],
      ['running', false],
    ]);
  } finally {
    dom.window.close();
  }
});

test('an expanded unconfirmed Shell retains output and only resumes waiting after ownership is confirmed', async () => {
  await withConversation(async ({ host, render, click }) => {
    const shell = (executionUnconfirmed: boolean, text = ''): Message => ({
      ...tool('shell', 'running'),
      toolName: 'shell_execute',
      presentation: 'standalone',
      presentationGroupId: undefined,
      text,
      executionUnconfirmed,
    });
    await render([shell(true)]);
    await click(summary(host));
    const output = () => host.querySelector('[aria-label="Shell 执行输出"]');
    expect(output()?.querySelector('.shell-console-output')?.textContent).toBe('');
    expect(host.textContent).not.toContain('等待输出…');
    await render([shell(true, 'original output')]);
    expect(output()?.querySelector('.shell-console-output')?.textContent).toBe('original output');
    await render([shell(false)]);
    expect(output()?.querySelector('.shell-console-output')?.textContent).toBe('');
    expect(host.querySelectorAll('.shell-activity.is-running')).toHaveLength(1);
  });
});

test('only explicit diagnostics show missing observation labels while actual tool failures and stops remain readable', () => {
  for (const diagnostics of [false, true])
    for (const [message, unverified, warning] of [
      [{ ...tool('unknown'), status: undefined, presentation: 'standalone' }, true, '状态待核对'],
      [{ ...tool('owner'), executionUnconfirmed: true }, false, '执行状态待核实'],
      [
        {
          ...tool('shell', 'running'),
          toolName: 'shell_execute',
          presentation: 'standalone',
          executionUnconfirmed: true,
        },
        false,
        '执行状态待核实',
      ],
    ] as [Message, boolean, string][]) {
      const content = renderToStaticMarkup(
        <DesktopDiagnosticsProvider value={diagnostics}>
          <ToolActivity
            messages={[message]}
            expanded
            unverified={unverified}
            onToggle={() => {}}
            renderChildren={() => null}
          />
        </DesktopDiagnosticsProvider>,
      );
      if (diagnostics) expect(content).toContain(warning);
      else expect(content).not.toContain(warning);
    }
  for (const status of ['failed', 'cancelled', 'unknown'] as const) {
    const content = renderToStaticMarkup(
      <ToolActivity
        messages={[
          {
            ...tool('actual', status),
            toolName: 'shell_execute',
            presentation: 'standalone',
            settled: true,
            text: 'ORIGINAL TOOL RESULT',
            toolResult: { ok: status !== 'failed', stdout: 'ORIGINAL TOOL RESULT' },
            executionUnconfirmed: true,
          },
        ]}
        expanded
        onToggle={() => {}}
        renderChildren={() => null}
      />,
    );
    expect(content).toContain('ORIGINAL TOOL RESULT');
    expect(content).not.toContain('执行状态待核实');
  }
});

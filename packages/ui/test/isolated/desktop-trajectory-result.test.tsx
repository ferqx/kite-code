import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TrajectoryJobOutput,
  TrajectoryResult,
} from '../../src/desktop/trajectory/TrajectoryResult';

function result(data: unknown, fallback?: string) {
  const dom = new JSDOM(renderToStaticMarkup(<TrajectoryResult data={data} fallback={fallback} />));
  const body = dom.window.document.body;
  const primary = body.cloneNode(true) as HTMLElement;
  for (const details of primary.querySelectorAll('details')) details.remove();
  return { dom, body, primary };
}

test('Shell separates observation receipts from command status and preserves zero and false in secondary information', () => {
  const { dom, body, primary } = result({
    outcome: 'succeeded',
    content: 'Original wait receipt',
    presentation: {
      kind: 'shell',
      operation: 'wait',
      status: 'running',
      accepted: true,
      terminal: false,
      timedOut: true,
      cancelRequested: false,
      caughtUp: false,
      exitCode: 0,
      output: [],
      droppedBytes: '0',
    },
  });
  expect(primary.textContent).toContain('目标命令状态运行中');
  expect(primary.textContent).toContain('退出码0');
  expect(primary.textContent).toContain('本次等待超时，命令不会因此停止');
  expect(primary.textContent).not.toContain('已完成');
  expect(primary.textContent).not.toContain('Original wait receipt');
  expect(body.textContent).toContain('确定终态否');
  expect(body.textContent).toContain('取消已请求否');
  expect(body.textContent).toContain('丢弃字节：0');
  expect(body.textContent).toContain('本次回执保存的命令输出为空');
  expect([...body.querySelectorAll('details')].every((item) => !item.open)).toBe(true);
  dom.window.close();
});

test('Shell retains errors, gaps, whitespace and repeated text at different original sequences', () => {
  const { dom, body } = result({
    outcome: 'failed',
    presentation: {
      kind: 'shell',
      operation: 'execute',
      status: 'failed',
      exitCode: 7,
      stderr: 'Original error',
      truncated: true,
      output: [
        { sequence: '1', throughSequence: '1', stream: 'stdout', content: 'same' },
        { sequence: '1', throughSequence: '1', stream: 'stdout', content: 'same' },
        { sequence: '2', throughSequence: '2', stream: 'stdout', content: 'same' },
        { sequence: '3', throughSequence: '3', stream: 'stdout', content: ' ' },
        { sequence: '4', throughSequence: '6', stream: 'gap', content: '', droppedBytes: '31' },
      ],
    },
  });
  expect(body.textContent).toContain('失败');
  expect(body.textContent).toContain('Original error');
  expect(body.textContent).toContain('退出码7');
  expect(
    [...body.querySelectorAll('pre')].filter((item) => item.textContent === 'same'),
  ).toHaveLength(2);
  expect([...body.querySelectorAll('pre')].some((item) => item.textContent === ' ')).toBe(true);
  expect(body.textContent).toContain('丢弃 31 字节');
  expect(body.textContent).toContain('原输出已截断');
  dom.window.close();
});

test('Task expresses acceptance, work state and result delivery separately from the tool receipt', () => {
  const { dom, body, primary } = result({
    outcome: 'succeeded',
    content: 'Unique task receipt',
    presentation: {
      kind: 'task',
      operation: 'spawn',
      accepted: true,
      status: 'succeeded',
      delivery: 'pending',
    },
  });
  expect(primary.textContent).toContain('本次投递受理是');
  expect(primary.textContent).toContain('子任务工作状态已完成');
  expect(primary.textContent).toContain('结果交付等待交付');
  expect(primary.textContent).toContain('不是子任务最终结果');
  expect(primary.textContent).not.toContain('Unique task receipt');
  expect(body.textContent).toContain('Unique task receipt');
  expect(primary.textContent).not.toContain('结果类型');
  expect(primary.textContent).not.toContain('spawn');
  dom.window.close();
});

test('a queued child task is readable without promoting acceptance or pending delivery to completion', () => {
  const { dom, primary } = result({
    outcome: 'succeeded',
    presentation: {
      kind: 'task',
      operation: 'spawn',
      accepted: true,
      status: 'queued',
      delivery: 'pending',
    },
  });
  expect(primary.textContent).toContain('子任务工作状态排队中');
  expect(primary.textContent).toContain('结果交付等待交付');
  expect(primary.textContent).toContain('不是子任务最终结果');
  expect(primary.textContent).not.toContain('queued');
  expect(primary.textContent).not.toContain('已完成');
  dom.window.close();
});

test('Web keeps the fetched text primary and moves transport metadata without dropping zero or false', () => {
  const { dom, body, primary } = result({
    outcome: 'succeeded',
    content: 'Original fetched text',
    presentation: {
      kind: 'web',
      title: 'Original page',
      url: 'https://example.test/page',
      contentType: 'text/plain',
      characters: 0,
      truncated: false,
    },
  });
  expect(primary.textContent).toContain('Original fetched text');
  expect(primary.textContent).toContain('Original page');
  expect(primary.textContent).toContain('https://example.test/page');
  expect(primary.textContent).not.toContain('结果类型');
  expect(body.textContent).toContain('已保存字符0');
  expect(body.textContent).toContain('已截断否');
  dom.window.close();
});

test('Browser elements do not erase additional public receipt text, while exact empty typed text stays empty', () => {
  const partial = result({
    content: 'Unique original browser diagnostic',
    presentation: {
      kind: 'browser',
      operation: 'snapshot',
      title: 'Page title',
      sequence: '0',
      elements: [{ role: 'button', name: 'Submit' }],
    },
  });
  expect(partial.primary.textContent).toContain('button · Submit');
  expect(partial.primary.textContent).not.toContain('Unique original browser diagnostic');
  expect(partial.body.textContent).toContain('Unique original browser diagnostic');
  expect(partial.body.textContent).toContain('快照序号0');
  partial.dom.window.close();
  const empty = result({
    content: 'Must not replace empty text',
    presentation: {
      kind: 'browser',
      operation: 'snapshot',
      text: '',
      elements: [],
    },
  });
  expect(empty.body.textContent).toContain('已保存的正文为空');
  expect(empty.body.textContent).not.toContain('Must not replace empty text');
  empty.dom.window.close();
});

test('Files distinguish saved empty content from absent typed content and preserve the original read window', () => {
  const empty = result({
    content: 'Must not replace empty file',
    presentation: {
      kind: 'file',
      operation: 'read',
      path: 'empty.txt',
      text: '',
      startLine: 0,
      endLine: 0,
      bytes: 0,
      truncated: true,
    },
  });
  expect(empty.body.textContent).toContain('原路径empty.txt');
  expect(empty.body.textContent).toContain('已保存的正文为空');
  expect(empty.body.textContent).toContain('起始行0');
  expect(empty.body.textContent).toContain('字节数0');
  expect(empty.body.textContent).toContain('截断片段');
  expect(empty.body.textContent).not.toContain('Must not replace empty file');
  empty.dom.window.close();
  const absent = result({
    content: 'Original write result',
    presentation: { kind: 'file', operation: 'write', path: 'written.txt' },
  });
  expect(absent.body.textContent).toContain('Original write result');
  expect(absent.body.textContent).not.toContain('已保存的正文为空');
  absent.dom.window.close();
});

test('MCP keeps structured null, false and zero as actual results and retains tool errors', () => {
  for (const structuredContent of [null, false, 0]) {
    const { dom, body } = result({
      outcome: 'succeeded',
      content: 'Duplicate MCP fallback',
      presentation: {
        kind: 'mcp',
        isError: true,
        text: [],
        structuredContent,
      },
    });
    expect(body.textContent).toContain('工具返回错误');
    expect(body.querySelector('[aria-label="结构化结果"] pre')?.textContent).toBe(
      JSON.stringify(structuredContent),
    );
    expect(body.textContent).not.toContain('Duplicate MCP fallback');
    dom.window.close();
  }
});

test('Worktree keeps unique error codes primary, and unsupported presentations preserve public fallback', () => {
  const worktree = result({
    outcome: 'failed',
    content: 'Original worktree diagnostic',
    presentation: {
      kind: 'worktree',
      operation: 'create',
      path: 'original-worktree',
      mutation: 'none',
      cwdChanged: false,
      replayed: false,
      code: 'original_unknown_code',
    },
  });
  expect(worktree.primary.textContent).toContain('工作树路径original-worktree');
  expect(worktree.primary.textContent).toContain('original_unknown_code');
  expect(worktree.primary.textContent).toContain('工作目录变化否');
  expect(worktree.body.textContent).toContain('Original worktree diagnostic');
  expect(worktree.body.textContent).toContain('原操作回执否');
  worktree.dom.window.close();
  const old = result({
    outcome: 'outcome_unknown',
    content: 'Original legacy public output',
    presentation: { kind: 'future_result', text: 'Not trusted' },
  });
  expect(old.body.textContent).toContain('结果未知');
  expect(old.body.textContent).toContain('Original legacy public output');
  expect(old.body.textContent).not.toContain('Not trusted');
  old.dom.window.close();
});

test('Explicit empty tool text and answers are visible states, not substituted fallback content', () => {
  const mcp = result({
    content: 'Must not replace saved empty MCP text',
    presentation: { kind: 'mcp', isError: false, text: [''] },
  });
  expect(mcp.body.textContent).toContain('已保存的正文为空');
  expect(mcp.body.textContent).not.toContain('Must not replace');
  mcp.dom.window.close();
  const question = result({
    content: 'Must not replace saved answer',
    presentation: { kind: 'question', answers: [{ question: 'Original question', answer: '' }] },
  });
  expect(question.body.textContent).toContain('Original question');
  expect(question.body.textContent).toContain('已保存的答复为空');
  expect(question.body.textContent).not.toContain('Must not replace');
  question.dom.window.close();
});

test('Abnormal typed results keep unique public failure text primary even when typed output exists', () => {
  for (const outcome of ['failed', 'cancelled', 'outcome_unknown']) {
    for (const presentation of [
      { kind: 'task', operation: 'spawn', accepted: false },
      { kind: 'file', operation: 'read', text: 'Typed saved prefix' },
      { kind: 'mcp', isError: true, text: [], structuredContent: null },
    ]) {
      const { dom, primary } = result({
        outcome,
        content: 'Unique original failure reason',
        presentation,
      });
      expect(primary.textContent).toContain('Unique original failure reason');
      dom.window.close();
    }
  }
});

test('Only exactly repeated typed error text is deduplicated; distinct public diagnostics stay visible', () => {
  const same = result({
    outcome: 'failed',
    content: 'Exact error',
    presentation: {
      kind: 'shell',
      operation: 'execute',
      status: 'failed',
      stderr: 'Exact error',
    },
  });
  expect(same.primary.textContent?.split('Exact error')).toHaveLength(2);
  same.dom.window.close();
  const different = result({
    outcome: 'failed',
    content: 'Exact error with additional cause',
    presentation: {
      kind: 'shell',
      operation: 'execute',
      status: 'failed',
      stderr: 'Exact error',
    },
  });
  expect(different.primary.textContent).toContain('Exact error with additional cause');
  different.dom.window.close();
});

test('non-gap shell output reports dropped bytes even when the retained text is empty', () => {
  const { dom, body } = result({
    outcome: 'succeeded',
    presentation: {
      kind: 'shell',
      operation: 'read',
      status: 'running',
      output: [
        { sequence: '1', throughSequence: '3', stream: 'stdout', content: '', droppedBytes: '31' },
        {
          sequence: '4',
          throughSequence: '4',
          stream: 'stderr',
          content: 'retained error',
          droppedBytes: '2',
        },
        {
          sequence: '5',
          throughSequence: '5',
          stream: 'gap',
          content: 'original gap note',
          droppedBytes: '7',
        },
      ],
    },
  });
  expect(body.textContent).toContain('此段输出不完整 · 丢弃 31 字节');
  expect(body.textContent).toContain('此段输出不完整 · 丢弃 2 字节');
  expect(body.textContent).toContain('retained error');
  expect(body.textContent).toContain('original gap note');
  expect(body.textContent).not.toContain('命令输出为空');
  expect(body.textContent).not.toContain('目标命令状态已完成');
  dom.window.close();
});

test('retained Job checkpoints group original text and exact gaps without joining distinct sequences', () => {
  const dom = new JSDOM(
    renderToStaticMarkup(
      <TrajectoryJobOutput
        data={{
          contentMode: 'retained_preview',
          upperOutputSeq: '8',
          truncated: true,
          items: [
            { seq: '1', stream: 'stdout', content: 'same' },
            { seq: '1', stream: 'stdout', content: 'same' },
            { seq: '2', stream: 'stdout', content: 'same' },
            { seq: '3', stream: 'stderr', content: ' ' },
            { seq: '4', throughSeq: '5', stream: 'progress', content: '', droppedBytes: '11' },
          ],
          gaps: [{ stream: 'stdout', fromSeq: '6', throughSeq: '8', droppedBytes: '19' }],
        }}
      />,
    ),
  );
  const body = dom.window.document.body;
  expect(body.querySelector('[aria-label="已保存命令文本"]')).not.toBeNull();
  expect(body.querySelector('[aria-label="已记录输出缺口"]')).not.toBeNull();
  expect(
    [...body.querySelectorAll('pre')].filter((item) => item.textContent === 'same'),
  ).toHaveLength(2);
  expect([...body.querySelectorAll('pre')].some((item) => item.textContent === ' ')).toBe(true);
  expect(body.textContent).toContain('此段输出不完整 · 丢弃 11 字节');
  expect(body.textContent).toContain('标准输出 · #6–8 · 丢弃 19 字节');
  expect(body.querySelector('[aria-label="已记录输出缺口"] pre')).toBeNull();
  expect(body.textContent).not.toContain('完整输出');
  dom.window.close();
});

test('empty retained Job lists differ from explicitly saved empty text and malformed legacy values keep their fallback', () => {
  for (const [items, expected] of [
    [[], '该封存检查点没有输出文本记录。'],
    [[{ seq: '1', stream: 'stdout', content: '' }], '该封存检查点保存的输出文本为空。'],
    [[null], '此版本的输出记录格式无法识别。'],
  ] as const) {
    const dom = new JSDOM(
      renderToStaticMarkup(
        <TrajectoryJobOutput data={{ contentMode: 'retained_preview', items, gaps: [] }} />,
      ),
    );
    expect(dom.window.document.body.textContent).toContain(expected);
    expect(dom.window.document.body.textContent).not.toContain('已完成');
    dom.window.close();
  }
  const dom = new JSDOM(
    renderToStaticMarkup(
      <TrajectoryJobOutput data={{ future: true }} fallback="Exact legacy public result" />,
    ),
  );
  expect(dom.window.document.body.textContent).toBe('Exact legacy public result');
  dom.window.close();
});

test('plan and step states use their own meanings while task delivery retains its original meaning', () => {
  const plan = result({
    outcome: 'succeeded',
    presentation: {
      kind: 'plan',
      operation: 'read',
      status: 'pending',
      steps: [
        { id: '1', title: 'Inspect', status: 'pending' },
        { id: '2', title: 'Run', status: 'running' },
        { id: '3', title: 'Finish', status: 'completed' },
        { id: '4', title: 'Blocked', status: 'blocked' },
        { id: '5', title: 'Compensated', status: 'compensated' },
        { id: '6', title: 'Future', status: 'future_status' },
      ],
    },
  });
  expect(plan.body.textContent).toContain('计划状态待处理');
  expect(plan.body.textContent).not.toContain('等待交付');
  expect(
    [...plan.body.querySelectorAll('.trajectory-plan-steps small')].map((item) => item.textContent),
  ).toEqual(['待处理', '进行中', '已完成', '受阻', '已补偿', 'future_status']);
  plan.dom.window.close();
  const task = result({ presentation: { kind: 'task', operation: 'events', delivery: 'pending' } });
  expect(task.body.textContent).toContain('结果交付等待交付');
  task.dom.window.close();
});

test('browser, plan and question lists distinguish saved emptiness from absent lists without replacing explicit empty text', () => {
  for (const [presentation, emptyText, absentText, field] of [
    [
      { kind: 'browser', operation: 'snapshot', text: '' },
      '该次快照未列出页面元素。',
      '此版本未保存页面元素列表。',
      'elements',
    ],
    [
      { kind: 'plan', operation: 'read', text: '' },
      '已保存的计划步骤列表为空。',
      '此版本未保存计划步骤列表。',
      'steps',
    ],
    [{ kind: 'question' }, '已保存的答复列表为空。', '此版本未保存答复项。', 'answers'],
  ] as const) {
    const empty = result({ presentation: { ...presentation, [field]: [] } });
    expect(empty.body.textContent).toContain(emptyText);
    expect(empty.body.textContent).not.toContain(absentText);
    empty.dom.window.close();
    const absent = result({ presentation });
    expect(absent.body.textContent).toContain(absentText);
    expect(absent.body.textContent).not.toContain(emptyText);
    absent.dom.window.close();
  }
  const execute = result({
    presentation: { kind: 'browser', operation: 'execute', text: 'Exact interpreter output' },
  });
  expect(execute.body.textContent).toContain('Exact interpreter output');
  expect(execute.body.textContent).not.toContain('页面元素');
  execute.dom.window.close();
});

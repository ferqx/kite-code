import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { TrajectoryInteraction } from '../src/desktop/trajectory/TrajectoryInteraction';

function render(data: unknown, cancelled = false) {
  return new JSDOM(
    renderToStaticMarkup(<TrajectoryInteraction data={data} cancelled={cancelled} />),
  );
}
function section(page: JSDOM, label: string) {
  return [...page.window.document.querySelectorAll('[data-slot="accordion-trigger"]')]
    .find((item) => item.textContent === label)!
    .closest('[data-slot="accordion-item"]')!;
}

test('original question IDs map object answers independently of order and distinguish free text from choice IDs', () => {
  const data = {
    request: {
      questions: [
        {
          id: 'q1',
          header: '部署方式',
          question: '选择部署环境？',
          options: [
            { id: 'q1-o1', label: '环境甲', description: '甲说明' },
            { id: 'q1-o2', label: '环境乙', description: '乙说明' },
          ],
        },
        { id: 'q2', question: '补充要求？', options: [{ id: 'q1-o1', label: '这是选项文案' }] },
      ],
    },
    answer: { kind: 'question', answers: { q2: { text: 'q1-o1' }, q1: 'q1-o2' } },
  };
  const before = structuredClone(data),
    page = render(data);
  const first = section(page, '部署方式'),
    second = section(page, '补充要求？');
  expect(first.textContent).toContain('选择部署环境？');
  expect(first.querySelector('details')?.hasAttribute('open')).toBe(false);
  expect(first.querySelector('h4')?.nextElementSibling?.textContent).toBe('环境乙');
  expect(second.querySelector('h4')?.nextElementSibling?.textContent).toBe('q1-o1');
  expect(second.querySelector('h4')?.nextElementSibling?.textContent).not.toBe('这是选项文案');
  expect(page.window.document.querySelector('.trajectory-content-accordion')).not.toBeNull();
  expect(
    [...page.window.document.querySelectorAll('[data-slot="accordion-item"]')].every((item) =>
      item.classList.contains('border-0'),
    ),
  ).toBe(true);
  expect(data).toEqual(before);
  page.window.close();
});

test('answers without original questions use exact saved keys once and preserve false, zero and empty selections', () => {
  const page = render({
    request: {},
    answer: { kind: 'question', answers: { flag: false, count: 0, selections: [] } },
  });
  expect(section(page, 'flag').textContent).toContain('false');
  expect(section(page, 'count').textContent).toContain('0');
  expect(section(page, 'selections').textContent).toContain('未选择选项（空数组）');
  expect(page.window.document.body.textContent?.split('false')).toHaveLength(2);
  expect(page.window.document.querySelectorAll('pre')).toHaveLength(0);
  expect(page.window.document.body.textContent).not.toContain('尚未保存答复');
  page.window.close();
});

test('an empty saved answer object without original questions remains distinct from a missing answer', () => {
  const data = { request: {}, answer: { kind: 'question', answers: {} } };
  const page = render(data);
  const answer = section(page, '已保存的答复');
  expect(JSON.parse(answer.querySelector('pre')!.textContent!)).toEqual({});
  expect(page.window.document.body.textContent).not.toContain('尚未保存答复');
  expect(data.answer.answers).toEqual({});
  page.window.close();
  const missing = render({ request: {}, answer: null });
  expect(section(missing, '答复').textContent).toContain('此版本尚未保存答复');
  expect(missing.window.document.querySelectorAll('pre')).toHaveLength(0);
  missing.window.close();
  const withQuestion = render({
    request: { questions: [{ id: 'q', question: '原问题' }] },
    answer: { kind: 'question', answers: {} },
  });
  expect(section(withQuestion, '原问题').textContent).toContain('此问题尚未保存答复');
  expect(withQuestion.window.document.querySelectorAll('pre')).toHaveLength(0);
  withQuestion.window.close();
});

test('approval decisions, exact option labels and feedback remain readable without duplicated keyed answers or private fields', () => {
  const page = render({
    request: {
      title: '原批准请求',
      description: '原批准请求',
      source: 'PRIVATE_SOURCE',
      options: [{ id: 'once', label: '仅此次' }],
    },
    answer: {
      kind: 'approval',
      decision: 'approve',
      optionId: 'once',
      feedback: '原反馈\n第二行',
      answers: { saved: '公开原回答' },
      transport: 'PRIVATE_TRANSPORT',
    },
  });
  const text = page.window.document.body.textContent!;
  expect(text.split('原批准请求')).toHaveLength(2);
  expect(text).toContain('已批准');
  expect(text).toContain('所选选项：仅此次');
  expect(text).toContain('反馈');
  expect(text).toContain('原反馈');
  expect(text).toContain('第二行');
  expect(text.split('公开原回答')).toHaveLength(2);
  expect(text).not.toContain('PRIVATE_');
  expect(page.window.document.querySelectorAll('[role="tab"]')).toHaveLength(0);
  expect(
    [...page.window.document.querySelectorAll('h3')].map((heading) => heading.textContent),
  ).not.toContain('原批准请求');
  page.window.close();
});

test('saved legacy answer arrays stay readable, including scalar false and zero', () => {
  const page = render({
    request: { question: '原请求' },
    answer: {
      kind: 'question',
      answers: [
        { question: '旧题甲', answer: '旧答案' },
        { question: '旧题乙', answer: false },
        { question: '旧题丙', answer: 0 },
      ],
    },
  });
  const text = page.window.document.body.textContent!;
  for (const value of ['旧题甲', '旧答案', '旧题乙', 'false', '旧题丙', '0'])
    expect(text).toContain(value);
  expect(page.window.document.querySelectorAll('pre')).toHaveLength(0);
  page.window.close();
});

test('missing, explicitly cancelled and saved null answers keep distinct meanings', () => {
  const missing = render({
    request: { questions: [{ id: 'q', question: '未答问题' }] },
    answer: null,
  });
  expect(missing.window.document.body.textContent).toContain('此问题尚未保存答复');
  expect(missing.window.document.body.textContent).not.toContain('已取消');
  missing.window.close();
  const cancelled = render(
    { request: { questions: [{ id: 'q', question: '取消前问题' }] }, answer: null },
    true,
  );
  expect(cancelled.window.document.body.textContent).toContain('此交互已取消');
  expect(cancelled.window.document.body.textContent).toContain('此版本没有答复');
  expect(cancelled.window.document.body.textContent).not.toContain('尚未');
  cancelled.window.close();
  const nullAnswer = render({ request: {}, answer: { kind: 'question', answers: null } });
  expect(nullAnswer.window.document.body.textContent).toContain('null');
  expect(nullAnswer.window.document.body.textContent).not.toContain('已取消');
  nullAnswer.window.close();
});

test('unknown original public answer structures are complete, escaped and folded without exposing envelope metadata', () => {
  const value = {
    original: { flag: false, count: 0, list: [], html: '<script>PUBLIC_TEXT</script>' },
  };
  const page = render({
    request: {},
    answer: { kind: 'question', answers: { unknownKey: value }, source: 'PRIVATE_PROOF' },
  });
  const item = section(page, 'unknownKey'),
    details = item.querySelector('details')!;
  expect(details.hasAttribute('open')).toBe(false);
  expect(JSON.parse(details.querySelector('pre')!.textContent!)).toEqual(value);
  expect(page.window.document.querySelectorAll('script')).toHaveLength(0);
  expect(page.window.document.body.textContent).not.toContain('PRIVATE_PROOF');
  page.window.close();
});

test('pending original Shell approval shows the saved command and requested scopes with folded options, without an execution control', () => {
  const page = render({
    request: {
      action: {
        kind: 'shell',
        command: "printf '<saved-command>\\n'",
        workdir: 'workspace/subdir',
        filesystem: 'workspace_write',
        network: 'none',
        env: 'PRIVATE_ENV',
      },
      options: [{ id: 'once', label: '仅此次', description: '仅适用于原操作' }],
      policy: 'PRIVATE_POLICY',
    },
    answer: null,
  });
  const request = section(page, '请求内容');
  expect(request.querySelector('pre')?.textContent).toBe("printf '<saved-command>\\n'");
  expect(request.textContent).toContain('workspace/subdir');
  expect(request.textContent).toContain('工作区及允许的临时目录');
  expect(request.textContent).toContain('不请求网络访问');
  expect(request.querySelector('details')?.hasAttribute('open')).toBe(false);
  expect(request.querySelector('details')?.textContent).toContain('仅此次');
  expect(request.querySelector('details')?.textContent).toContain('仅适用于原操作');
  const text = page.window.document.body.textContent!;
  expect(text).not.toContain('未保存可展示的请求说明');
  expect(text.split('此版本尚未保存答复')).toHaveLength(2);
  expect(text).not.toContain('PRIVATE_');
  expect(
    page.window.document.querySelectorAll('button:not([data-slot="accordion-trigger"])'),
  ).toHaveLength(0);
  expect(page.window.document.querySelectorAll('saved-command')).toHaveLength(0);
  page.window.close();
});

test('answered Shell approval renders its selected answer once while retaining the closed original option list', () => {
  const page = render({
    request: {
      action: { kind: 'shell', command: 'printf ok' },
      options: [{ id: 'once', label: '仅此次', description: '原说明' }],
    },
    answer: { kind: 'approval', decision: 'approve', optionId: 'once', feedback: '已确认原命令' },
  });
  const answer = section(page, '已保存的答复');
  expect(answer.textContent?.split('已批准')).toHaveLength(2);
  expect(answer.textContent?.split('所选选项：仅此次')).toHaveLength(2);
  expect(answer.textContent?.split('已确认原命令')).toHaveLength(2);
  expect(page.window.document.body.textContent).not.toContain('尚未保存答复');
  expect(section(page, '请求内容').querySelector('details')?.hasAttribute('open')).toBe(false);
  page.window.close();
});

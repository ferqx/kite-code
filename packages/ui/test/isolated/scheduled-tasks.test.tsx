import { afterAll, afterEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type {
  ScheduledTaskDraft,
  ScheduledTaskSummary,
  ScheduledTasksProps,
} from '../../src/desktop/ScheduledTasks';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(dom.window, 'ResizeObserver', {
  configurable: true,
  value: TestResizeObserver,
});
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => null,
});
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => {},
});
dom.window.requestAnimationFrame = (callback) => dom.window.setTimeout(() => callback(0), 0);
dom.window.cancelAnimationFrame = (handle) => dom.window.clearTimeout(handle);
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLFormElement: dom.window.HTMLFormElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLCanvasElement: dom.window.HTMLCanvasElement,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  Element: dom.window.Element,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  MutationObserver: dom.window.MutationObserver,
  DOMRect: dom.window.DOMRect,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: TestResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries(globals)) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
let root: import('react-dom/client').Root | undefined;
afterEach(async () => {
  if (root) await act(() => root?.unmount());
  // Radix releases modal focus and body pointer state on its next timer turn.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  root = undefined;
  document.body.innerHTML = '';
});
afterAll(() => {
  dom.window.close();
  for (const [key, original] of originals) {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const { SessionPage } = await import('../../src/desktop/SessionPage');
const { createRoot } = await import('react-dom/client');
const { ScheduledTaskEditor, ScheduledTasks, validScheduledTaskDraft } = await import(
  '../../src/desktop/ScheduledTasks'
);

const draft: ScheduledTaskDraft = {
  name: 'Daily review',
  prompt: 'Review local changes',
  workspaceId: 'w',
  modelId: 'm',
  environment: 'local',
  schedule: { frequency: 'weekly', weekday: 2, time: '14:35' },
};
const task: ScheduledTaskSummary = {
  id: 't',
  name: draft.name,
  prompt: draft.prompt,
  workspaceLabel: 'Project',
  scheduleLabel: 'Tuesday',
  environment: 'local',
  status: 'active',
  draft,
  runs: [{ id: 'r', status: 'completed', sessionId: 's', startedAt: '2026-10-15T01:00:00Z' }],
};
const base: ScheduledTasksProps = {
  tasks: [task],
  workspaces: [{ id: 'w', label: 'Project', state: 'loaded', sessions: [], sessionCount: 0 }],
  models: [
    { id: 'm', provider: 'Provider', name: 'Model', reasoningEffortChoices: ['low', 'high'] },
  ],
};
async function render(element: React.ReactNode) {
  root = createRoot(document.body);
  await act(() => root!.render(element));
}
async function click(label: string) {
  const button = [
    ...document.querySelectorAll<HTMLElement>('button, [role="menuitem"], [role="menuitemradio"]'),
  ].find((item) => item.textContent === label || item.getAttribute('aria-label') === label);
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
}
async function openTaskMenu() {
  await act(async () => {
    document
      .querySelector('button[aria-label="Daily review的更多操作"]')!
      .dispatchEvent(
        new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false }),
      );
  });
}
async function submit() {
  await act(async () => {
    document
      .querySelector('form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
}

test('schedule draft validates HH:mm, weekly weekday without a renderer time zone', () => {
  expect(validScheduledTaskDraft(draft)).toBe(true);
  for (const change of [
    { time: '24:00' },
    { time: '9:00' },
    { weekday: 7 },
    { weekday: undefined },
  ]) {
    expect(validScheduledTaskDraft({ ...draft, schedule: { ...draft.schedule, ...change } })).toBe(
      false,
    );
  }
  expect(validScheduledTaskDraft({ ...draft, modelId: '' })).toBe(false);
});
test('async edit preserves complete fields on failure, blocks duplicate save, and closes only on success', async () => {
  let reject!: (error: Error) => void;
  let resolve!: () => void;
  let calls = 0;
  let closed = 0;
  const saved: ScheduledTaskDraft[] = [];
  await render(
    <ScheduledTaskEditor
      task={task}
      props={{
        ...base,
        onUpdate: (id, value) => {
          expect(id).toBe('t');
          saved.push(value);
          calls++;
          return new Promise<void>((yes, no) => {
            resolve = yes;
            reject = no;
          });
        },
      }}
      onClose={() => {
        closed++;
      }}
    />,
  );
  expect((document.querySelector('input[aria-label="名称"]') as HTMLInputElement).value).toBe(
    'Daily review',
  );
  await submit();
  await submit();
  expect(calls).toBe(1);
  expect(closed).toBe(0);
  expect(document.querySelector('form')!.getAttribute('aria-busy')).toBe('true');
  expect((document.querySelector('input[type="time"]') as HTMLInputElement).disabled).toBe(true);
  await act(async () => reject(new Error('offline')));
  expect(document.querySelector('[role="alert"]')!.textContent).toContain('offline');
  expect((document.querySelector('input[type="time"]') as HTMLInputElement).disabled).toBe(false);
  expect((document.querySelector('input[type="time"]') as HTMLInputElement).value).toBe('14:35');
  expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe(draft.prompt);
  await submit();
  expect(calls).toBe(2);
  expect(saved[1]).toEqual(draft);
  await act(async () => resolve());
  expect(closed).toBe(1);
});
test('task card edit, pause, run now, exact history session and explicit delete use host callbacks', async () => {
  const actions: string[] = [];
  await render(
    <ScheduledTasks
      {...base}
      onNewTask={() => {}}
      onEditTask={(value) => {
        actions.push(`edit:${value.id}`);
      }}
      onUpdate={() => {}}
      onToggle={(id, active) => {
        actions.push(`toggle:${id}:${active}`);
      }}
      onRunNow={(id) => {
        actions.push(`run:${id}`);
      }}
      onOpenRun={(id, run) => {
        actions.push(`open:${id}:${run}`);
      }}
      onDelete={(id) => {
        actions.push(`delete:${id}`);
      }}
    />,
  );
  await click('编辑');
  await openTaskMenu();
  await click('暂停');
  await click('立即运行');
  await click('打开会话');
  await openTaskMenu();
  await click('删除');
  expect(actions).not.toContain('delete:t');
  await click('删除');
  expect(actions).toEqual(['edit:t', 'toggle:t:false', 'run:t', 'open:t:r', 'delete:t']);
});
test('run history labels every scheduler state and preserves failed and unknown outcomes', async () => {
  const states = [
    ['queued', '排队中'],
    ['creating', '创建会话中'],
    ['starting', '启动中'],
    ['running', '运行中'],
    ['waiting', '等待中'],
    ['completed', '已完成'],
    ['failed', '运行失败'],
    ['unknown', '结果未知'],
    ['cancelled', '已停止'],
    ['future-status', '状态未知'],
  ] as const;
  await render(
    <ScheduledTasks
      {...base}
      tasks={[
        {
          ...task,
          runs: states.map(([status]) => ({
            id: status,
            status,
            startedAt: '10:00',
            ...(status === 'failed' ? { error: '模型服务不可用' } : {}),
            ...(status === 'unknown' ? { error: '运行结果尚未确认' } : {}),
          })),
        },
      ]}
      onNewTask={() => {}}
    />,
  );
  const rows = document.querySelectorAll('.scheduled-history-row');
  expect(rows).toHaveLength(states.length);
  for (const [index, [status, label]] of states.entries()) {
    expect(rows[index]!.textContent).toContain('10:00');
    expect(rows[index]!.textContent).toContain(label);
    expect(rows[index]!.textContent).not.toContain(status);
  }
  expect(rows[6]!.textContent).toContain('模型服务不可用');
  expect(rows[7]!.textContent).toContain('运行结果尚未确认');
  expect(rows[7]!.textContent).not.toContain('运行失败');
});
test('a removed project cannot save', async () => {
  await render(
    <ScheduledTaskEditor
      task={task}
      props={{
        ...base,
        workspaces: [],
        onUpdate: () => {
          throw new Error('must not save');
        },
      }}
      onClose={() => {}}
    />,
  );
  expect(document.querySelector('button[aria-label="项目空间"]')!.hasAttribute('disabled')).toBe(
    true,
  );
  expect(
    [...document.querySelectorAll('button')].find((item) => item.textContent === '保存')!.disabled,
  ).toBe(true);
  await submit();
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

test('card pending prevents repeat run and a failed action is visible without losing history', async () => {
  let reject!: (error: Error) => void;
  let calls = 0;
  await render(
    <ScheduledTasks
      {...base}
      onNewTask={() => {}}
      onRunNow={() => {
        calls++;
        return new Promise<void>((_resolve, no) => {
          reject = no;
        });
      }}
    />,
  );
  await click('立即运行');
  await click('立即运行');
  expect(calls).toBe(1);
  await act(async () => reject(new Error('service unavailable')));
  expect(document.querySelector('[role="alert"]')!.textContent).toContain('service unavailable');
  expect(document.querySelector('.scheduled-history')!.textContent).toContain('已完成');
  expect(
    [...document.querySelectorAll('button')].find((item) => item.textContent === '立即运行')!
      .disabled,
  ).toBe(false);
});

test('a run-now request that creates no occurrence explains the result and retains history', async () => {
  await render(
    <ScheduledTasks
      {...base}
      onNewTask={() => {}}
      onRunNow={() => {
        throw Error('scheduled_task_not_started');
      }}
    />,
  );
  await click('立即运行');
  const message = document.querySelector('[role="alert"]')!.textContent;
  expect(message).toContain('本次未新建运行');
  expect(message).not.toContain('scheduled_task_not_started');
  expect(document.querySelector('.scheduled-history')!.textContent).toContain('已完成');
});

async function changeField(selector: string, value: string) {
  await act(async () => {
    const field = document.querySelector(selector)!;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value);
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

test('status and text filters compose, recover from no matches, and do not change task facts', async () => {
  const paused = {
    ...task,
    id: 'paused',
    name: 'Weekly digest',
    workspaceLabel: 'Backend',
    status: 'paused' as const,
  };
  await render(
    <ScheduledTasks {...base} tasks={[task, paused]} onCreate={() => {}} onNewTask={() => {}} />,
  );
  const cards = () =>
    [...document.querySelectorAll('.scheduled-card')].map((card) =>
      card.getAttribute('aria-label'),
    );
  expect(cards()).toEqual(['Daily review', 'Weekly digest']);
  await click('已暂停任务');
  expect(cards()).toEqual(['Weekly digest']);
  await changeField('input[type="search"]', 'BACKEND');
  expect(cards()).toEqual(['Weekly digest']);
  await changeField('input[type="search"]', 'not here');
  expect(cards()).toEqual([]);
  expect(document.querySelector('.scheduled-filter-empty')!.textContent).toContain('无匹配任务');
  await click('清除筛选');
  expect(cards()).toEqual(['Daily review', 'Weekly digest']);
  expect(document.querySelector('input[type="search"]')!.getAttribute('value')).toBe('');
  expect(paused.status).toBe('paused');
});

test('shared project and model-effort selectors save selected IDs and effort with weekly Sunday', async () => {
  const saved: ScheduledTaskDraft[] = [];
  await render(
    <ScheduledTaskEditor
      props={{
        ...base,
        workspaces: [...base.workspaces, { ...base.workspaces[0]!, id: 'w2', label: 'Backend' }],
        models: [
          ...base.models!,
          {
            id: 'm2',
            provider: 'Provider',
            name: 'Second model',
            reasoningEffort: 'low',
            reasoningEffortChoices: ['low', 'high'],
          },
        ],
        onCreate: (value) => {
          saved.push(value);
        },
      }}
      onClose={() => {}}
    />,
  );
  await changeField('[aria-label="名称"]', 'Nightly checks');
  await changeField('textarea', 'Inspect changes');
  await click('高级');
  expect(document.querySelector('button[aria-label="项目空间"]')).toBeNull();
  await click('高级');
  expect(document.querySelector('.scheduled-setting-row')!.textContent).toContain('名称');
  expect(document.querySelector('[aria-label="运行设置"]')!.textContent).toContain('项目');
  expect(document.querySelector('[aria-label="运行设置"]')!.textContent).toContain('模型');
  expect(document.querySelector('[aria-label="运行设置"]')!.textContent).toContain('思考程度');
  await act(async () =>
    document
      .querySelector('button[aria-label="项目空间"]')!
      .dispatchEvent(
        new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false }),
      ),
  );
  await click('Backend');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => document.querySelector<HTMLElement>('[data-model-trigger]')!.click());
  expect(document.querySelector('.model-effort-switch')).toBeNull();
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[cmdk-item]')]
      .find((item) => item.textContent === 'Second model')!
      .click(),
  );
  expect(document.querySelector('[data-model-trigger]')!.textContent).toBe('Second model');
  // Let the closed model popover release its focus scope before the next user action.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => document.querySelector<HTMLElement>('[data-effort-trigger]')!.click());
  await act(async () =>
    document
      .querySelector('[role="slider"]')!
      .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true })),
  );
  expect(document.querySelector('[data-model-trigger]')!.textContent).toBe('Second model');
  expect(document.querySelector('[data-effort-trigger]')!.textContent).toBe('高');
  await act(async () =>
    document
      .querySelector('button[aria-label="重复频率"]')!
      .dispatchEvent(
        new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false }),
      ),
  );
  await click('每周');
  await act(async () => document.querySelector<HTMLInputElement>('[aria-label="星期日"]')!.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect((document.querySelector('input[type="time"]') as HTMLInputElement).form).toBe(
    document.querySelector('form'),
  );
  expect(
    document.querySelector(`label[for="${document.querySelector('input[type="time"]')!.id}"]`)!
      .textContent,
  ).toBe('时间');
  expect(document.querySelector('button[aria-label="时间"]')).toBeNull();
  await changeField('input[type="time"]', '23:45');
  expect((document.querySelector('input[type="time"]') as HTMLInputElement).value).toBe('23:45');
  expect(document.querySelector('[role="dialog"][aria-label="选择时间"]')).toBeNull();
  await submit();
  expect(saved).toEqual([
    {
      name: 'Nightly checks',
      prompt: 'Inspect changes',
      workspaceId: 'w2',
      modelId: 'm2',
      reasoningEffort: 'high',
      environment: 'local',
      schedule: { frequency: 'weekly', weekday: 0, time: '23:45' },
    },
  ]);
});

test('cancel history remains concise and an empty time blocks save without losing other fields', async () => {
  await render(
    <ScheduledTasks
      {...base}
      onNewTask={() => {}}
      tasks={[
        { ...task, runs: [{ id: 'cancel', status: 'cancelled', error: 'cancel_requested' }] },
      ]}
    />,
  );
  expect(document.querySelector('.scheduled-history-row')!.textContent).toContain('已停止');
  expect(document.querySelector('.scheduled-history-row')!.textContent).not.toContain(
    '已按请求停止',
  );
  expect(document.querySelector('.scheduled-history-row')!.textContent).not.toContain(
    'cancel_requested',
  );
  await act(async () =>
    root!.render(
      <ScheduledTaskEditor
        task={task}
        props={{
          ...base,
          onUpdate: () => {
            throw Error('must not save');
          },
        }}
        onClose={() => {}}
      />,
    ),
  );
  expect(document.querySelector('input[placeholder="Asia/Shanghai"]')).toBeNull();
  expect(document.querySelector('input[type="time"]')!.getAttribute('data-slot')).toBe('input');
  await changeField('input[type="time"]', '');
  await submit();
  expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(document.querySelector('[aria-label="名称"]')!.getAttribute('value')).toBe(task.name);
  expect(document.querySelector('textarea')!.textContent).toBe(task.prompt);
  expect((document.querySelector('input[type="time"]') as HTMLInputElement).value).toBe('');
  await changeField('input[type="time"]', '07:20');
  expect((document.querySelector('input[type="time"]') as HTMLInputElement).value).toBe('07:20');
  expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
    false,
  );
});

test('one create editor keeps its intent key after a failed edited retry and a new editor gets another key', async () => {
  const keys: (string | undefined)[] = [];
  const props: ScheduledTasksProps = {
    ...base,
    onCreate: (_draft, key) => {
      keys.push(key);
      throw Error('reply_lost');
    },
  };
  await render(<ScheduledTaskEditor key="first" props={props} onClose={() => {}} />);
  async function fill() {
    await act(async () => {
      for (const [selector, value] of [
        ['input[aria-label="名称"]', 'Review'],
        ['textarea', `Changed prompt ${keys.length}`],
      ]) {
        const input = document.querySelector(selector!)!;
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      }
    });
  }
  await fill();
  await submit();
  await fill();
  await submit();
  expect(typeof keys[0]).toBe('string');
  expect(keys[1]).toBe(keys[0]);
  await act(async () =>
    root!.render(<ScheduledTaskEditor key="next" props={props} onClose={() => {}} />),
  );
  await fill();
  await submit();
  expect(keys[2]).not.toBe(keys[0]);
});

function schedulePage(tasks: ScheduledTasksProps = base) {
  return (
    <SessionPage
      workspaces={base.workspaces}
      sessionLabel="Review"
      readingKey="review"
      messages={[]}
      loading={false}
      connected={true}
      connectionLabel="local"
      actions={{}}
      scheduledTasks={tasks}
    />
  );
}
const editorVisible = () =>
  document
    .querySelector('.right-sidebar')
    ?.closest('.collapsible-sidebar-content')
    ?.getAttribute('aria-hidden');
const nameInput = () =>
  document.querySelector<HTMLInputElement>('.scheduled-editor [aria-label="名称"]')!;
const editButtons = () =>
  [...document.querySelectorAll<HTMLButtonElement>('.scheduled-card button')].filter(
    (button) => button.textContent === '编辑',
  );

for (const next of ['different task', 'same task', 'new task'] as const) {
  for (const outcome of ['success', 'failure'] as const) {
    test(`An earlier save ${outcome} cannot close or overwrite a reopened ${next} editor`, async () => {
      let resolve!: () => void, reject!: (error: Error) => void;
      const saved: string[] = [];
      const later = {
        ...task,
        id: 'later',
        name: 'Later task',
        draft: { ...draft, name: 'Later task' },
      };
      await render(
        schedulePage({
          ...base,
          tasks: [task, later],
          onCreate: () => {},
          onUpdate: (id) => {
            saved.push(id);
            return new Promise<void>((yes, no) => {
              resolve = yes;
              reject = no;
            });
          },
        }),
      );
      await act(async () => editButtons()[0]!.click());
      await submit();
      expect(saved).toEqual(['t']);
      await act(async () =>
        document.querySelector<HTMLButtonElement>('.right-sidebar-close')!.click(),
      );
      if (next === 'new task') await click('新建');
      else await act(async () => editButtons()[next === 'same task' ? 0 : 1]!.click());
      expect(nameInput().value).toBe(
        next === 'same task' ? 'Daily review' : next === 'different task' ? 'Later task' : '',
      );
      expect(document.querySelector('form')!.getAttribute('aria-busy')).toBe('false');
      nameInput().focus();
      const focus = document.activeElement;
      await act(async () => (outcome === 'success' ? resolve() : reject(Error('old save failed'))));
      expect(editorVisible()).toBe('false');
      expect(focus).toBe(nameInput());
      expect(nameInput().value).toBe(
        next === 'same task' ? 'Daily review' : next === 'different task' ? 'Later task' : '',
      );
      expect(document.activeElement).toBe(focus);
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(saved).toEqual(['t']);
    });
  }
}

test('The current editor successful save closes exactly its own rail and restores its trigger focus', async () => {
  let resolve!: () => void;
  await render(
    schedulePage({
      ...base,
      onCreate: () => {},
      onUpdate: () =>
        new Promise<void>((yes) => {
          resolve = yes;
        }),
    }),
  );
  const trigger = editButtons()[0]!;
  await act(async () => trigger.click());
  await submit();
  expect(editorVisible()).toBe('false');
  await act(async () => resolve());
  expect(editorVisible()).toBe('true');
  expect(document.activeElement).toBe(trigger);
});

test('Escape invalidates a pending editor close so an old result cannot move focus after dismissal', async () => {
  let resolve!: () => void;
  await render(
    schedulePage({
      ...base,
      onCreate: () => {},
      onUpdate: () =>
        new Promise<void>((yes) => {
          resolve = yes;
        }),
    }),
  );
  await act(async () => editButtons()[0]!.click());
  await submit();
  await act(async () =>
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  const nextControl = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === '新建',
  )!;
  nextControl.focus();
  await act(async () => resolve());
  expect(editorVisible()).toBe('true');
  expect(document.activeElement).toBe(nextControl);
});

test('Leaving the scheduled page invalidates the old save before another editor opens', async () => {
  let resolve!: () => void;
  const props = {
    ...base,
    onUpdate: () =>
      new Promise<void>((yes) => {
        resolve = yes;
      }),
  };
  await render(schedulePage(props));
  await act(async () => editButtons()[0]!.click());
  await submit();
  await act(async () =>
    root!.render(
      <SessionPage
        workspaces={base.workspaces}
        sessionLabel="Conversation"
        readingKey="conversation"
        messages={[]}
        loading={false}
        connected={true}
        connectionLabel="local"
        actions={{}}
      />,
    ),
  );
  await act(async () => root!.render(schedulePage(props)));
  await act(async () => editButtons()[0]!.click());
  nameInput().focus();
  const focus = document.activeElement;
  await act(async () => resolve());
  expect(editorVisible()).toBe('false');
  expect(document.activeElement).toBe(focus);
  expect(document.querySelector('form')!.getAttribute('aria-busy')).toBe('false');
});

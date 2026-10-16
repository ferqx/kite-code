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
  schedule: { frequency: 'weekly', weekday: 2, time: '14:35', timeZone: 'Asia/Shanghai' },
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
  models: [{ id: 'm', label: 'Model' }],
};
async function render(element: React.ReactNode) {
  root = createRoot(document.body);
  await act(() => root!.render(element));
}
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(
    (item) => item.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
}
async function submit() {
  await act(async () => {
    document
      .querySelector('form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
}

test('schedule draft validates HH:mm, weekly weekday and IANA time zone', () => {
  expect(validScheduledTaskDraft(draft)).toBe(true);
  for (const change of [
    { time: '24:00' },
    { time: '9:00' },
    { timeZone: 'Mars/Base' },
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
  await act(async () => reject(new Error('offline')));
  expect(document.querySelector('[role="alert"]')!.textContent).toContain('offline');
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
  await click('暂停');
  await click('立即运行');
  await click('打开会话');
  await click('删除');
  expect(actions).not.toContain('delete:t');
  await click('确认删除');
  expect(actions).toEqual(['edit:t', 'toggle:t:false', 'run:t', 'open:t:r', 'delete:t']);
});
test('local environment only; a removed project or missing model cannot save', async () => {
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
  expect((document.querySelector('option[value="worktree"]') as HTMLOptionElement).disabled).toBe(
    true,
  );
  expect(
    [...document.querySelectorAll('button')].find((item) => item.textContent === '保存任务')!
      .disabled,
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
  expect(document.querySelector('.scheduled-history')!.textContent).toContain('completed');
  expect(
    [...document.querySelectorAll('button')].find((item) => item.textContent === '立即运行')!
      .disabled,
  ).toBe(false);
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
      if (next === 'new task') await click('新建任务');
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
    (button) => button.textContent === '新建任务',
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

import { afterEach, expect, test } from 'bun:test';
import Ajv from 'ajv';
import type { Json } from '../../../src/extensions';
import { createBrowserController } from '../../../src/tools/browser/controller';
import {
  BrowserTransportError,
  type NativeBrowserTransport,
} from '../../../src/tools/browser/native';
import { createBrowserControlTool } from '../../../src/tools/browser/page-api';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(mode: 'preview' | 'on-demand' = 'on-demand', existing = false) {
  const requests: Record<string, Json>[] = [];
  let captures = 0,
    closes = 0,
    formValue = 'original draft';
  let refs: Json = { e1: { role: 'combobox', name: 'Color' } };
  let fail: string | undefined;
  let complete!: (value: { confirmed: boolean }) => void;
  const native: NativeBrowserTransport = {
    sharedPage: true,
    ready: Promise.resolve(),
    completion: new Promise((resolve) => {
      complete = resolve;
    }),
    async request(command, signal): Promise<Json> {
      signal.throwIfAborted();
      requests.push(command);
      if (command.action === 'navigate') formValue = '';
      if (command.action === fail) throw new BrowserTransportError('lost_ack', true);
      return {
        success: true,
        data:
          command.action === 'url' && existing
            ? { url: 'https://example.test/' }
            : command.action === 'title'
              ? { title: 'Original page' }
              : command.action === 'snapshot'
                ? { snapshot: '- combobox "Color" [ref=e1]', origin: 'https://example.test/', refs }
                : {},
      };
    },
    async capture() {
      captures++;
      return {
        frame: { mimeType: 'image/jpeg', data: 'jpeg', width: 800, height: 600 },
        annotations: [],
      };
    },
    async close() {
      closes++;
      complete({ confirmed: true });
      return { confirmed: true };
    },
    async dispose() {},
  };
  const controller = createBrowserController({
    sharedPage: true,
    createTransport: () => native,
    observationMode: async () => mode,
  });
  const signal = new AbortController().signal;
  const handle = await controller.job.start(
    { browserId: 'browser', url: 'https://example.test/' },
    { sessionId: 'session', executionId: 'job', signal },
  );
  cleanups.push(() => controller.job.cancel(handle));
  const target = controller.view('session')!;
  await controller.command('session', target, { action: 'snapshot' }, signal);
  return {
    controller,
    native,
    target,
    requests,
    signal,
    get captures() {
      return captures;
    },
    get closes() {
      return closes;
    },
    get formValue() {
      return formValue;
    },
    setRefs(value: Json) {
      refs = value;
    },
    fail(action: string) {
      fail = action;
    },
  };
}

test('an already matching shared page preserves its draft and skips startup navigation', async () => {
  const f = await fixture('on-demand', true);
  expect(f.requests.filter((value) => value.action === 'navigate')).toHaveLength(0);
  expect(f.formValue).toBe('original draft');
  expect(f.controller.view('session')).toMatchObject({
    url: 'https://example.test/',
    title: 'Original page',
    state: 'agent',
  });
});

test('on-demand Jobs observe semantic refs with no startup, post-action or periodic capture', async () => {
  const f = await fixture();
  const result = await f.controller.observe!('session', f.target, f.signal);
  expect(result.details).toMatchObject({
    elements: [{ ref: '@e1', role: 'combobox', name: 'Color' }],
    annotations: [],
  });
  expect(f.controller.view('session')?.frame).toBeNull();
  expect(f.captures).toBe(0);
  const view = f.controller.view('session')!;
  expect(
    (
      await f.controller.control!(
        'session',
        f.target,
        { action: 'select', ref: '@e1', seq: view.seq, values: ['blue'] },
        f.signal,
      )
    ).outcome,
  ).toBe('succeeded');
  expect(f.requests.at(-1)).toEqual({ action: 'select', selector: '@e1', values: ['blue'] });
  await Bun.sleep(350);
  expect(f.captures).toBe(0);
  expect((await f.controller.captureNote!('session', f.target, f.signal)).outcome).toBe(
    'succeeded',
  );
  expect(f.captures).toBe(1);
});

test('semantic refs are refreshed before dispatch and never remap a replaced element', async () => {
  const f = await fixture(),
    view = f.controller.view('session')!;
  f.setRefs({ e2: { role: 'combobox', name: 'Color' } });
  const result = await f.controller.command(
    'session',
    f.target,
    { action: 'fill', ref: '@e1', seq: view.seq, value: 'ordinary' },
    f.signal,
  );
  expect(result).toMatchObject({ outcome: 'failed', content: 'browser_stale_element' });
  expect(f.requests.some((value) => value.action === 'fill')).toBe(false);
  expect(f.captures).toBe(0);
  expect(
    (
      await f.controller.control!(
        'session',
        f.target,
        { action: 'hover', ref: '@e1', seq: view.seq },
        f.signal,
      )
    ).outcome,
  ).toBe('failed');
});

for (const mode of ['on-demand', 'preview'] as const)
  test(`${mode} semantic observation reads page counts and revalidates refs using the same full snapshot mode`, async () => {
    const f = await fixture(mode),
      request = f.native.request;
    let count = 0;
    const snapshots: Record<string, Json>[] = [];
    f.native.request = async (command, signal): Promise<Json> => {
      if (command.action === 'snapshot') {
        snapshots.push(command);
        const full = command.interactive === false;
        return {
          success: true,
          data: {
            snapshot: full
              ? `- main\n  - text "Count: ${count}"\n  - button "Increment" [ref=e2]`
              : '- button "Increment" [ref=e1]',
            origin: 'https://example.test/',
            refs: full
              ? { e2: { role: 'button', name: 'Increment' } }
              : { e1: { role: 'button', name: 'Increment' } },
          },
        };
      }
      if (command.action === 'click') {
        expect(command.selector).toBe('@e2');
        count++;
      }
      return request(command, signal);
    };
    const before = await f.controller.observe!('session', f.target, f.signal);
    expect(before.details).toMatchObject({
      snapshot: '- main\n  - text "Count: 0"\n  - button "Increment" [ref=e2]',
      elements: [{ ref: '@e2', role: 'button', name: 'Increment' }],
    });
    const view = f.controller.view('session')!;
    expect(
      (
        await f.controller.command(
          'session',
          f.target,
          { action: 'click', ref: '@e2', seq: view.seq },
          f.signal,
        )
      ).outcome,
    ).toBe('succeeded');
    expect((await f.controller.observe!('session', f.target, f.signal)).details).toMatchObject({
      snapshot: '- main\n  - text "Count: 1"\n  - button "Increment" [ref=e2]',
    });
    expect(count).toBe(1);
    expect(snapshots).toEqual(
      Array.from({ length: 3 }, () => ({ action: 'snapshot', interactive: false })),
    );
  });

test('limited native operations use the fixed backend fields, and unknown effects stop the lease', async () => {
  const f = await fixture();
  for (const operation of [
    { action: 'press', key: 'Control+a' },
    { action: 'wait', text: 'Ready', timeoutMs: 500 },
    { action: 'back' },
    { action: 'forward' },
    { action: 'reload' },
  ] as const)
    expect((await f.controller.control!('session', f.target, operation, f.signal)).outcome).toBe(
      'succeeded',
    );
  expect(f.requests).toContainEqual({ action: 'press', key: 'Control+a' });
  expect(f.requests).toContainEqual({ action: 'wait', text: 'Ready', timeout: 500 });
  f.fail('press');
  expect(
    (await f.controller.control!('session', f.target, { action: 'press', key: 'Enter' }, f.signal))
      .outcome,
  ).toBe('outcome_unknown');
  expect(
    (await f.controller.control!('session', f.target, { action: 'reload' }, f.signal)).outcome,
  ).toBe('failed');
  expect(
    f.requests.filter((value) => value.action === 'press' && value.key === 'Enter'),
  ).toHaveLength(1);
  expect(f.closes).toBe(1);
});

test('failed reference re-observation never becomes an unknown business input', async () => {
  const f = await fixture(),
    view = f.controller.view('session')!;
  f.fail('snapshot');
  expect(
    await f.controller.command(
      'session',
      f.target,
      { action: 'fill', ref: '@e1', seq: view.seq, value: 'ordinary' },
      f.signal,
    ),
  ).toMatchObject({ outcome: 'failed', content: 'browser_reference_observation_failed' });
  expect(f.requests.some((value) => value.action === 'fill')).toBe(false);
  expect(f.controller.view('session')?.state).toBe('agent');
  expect(f.closes).toBe(0);
});

test('semantic clicks preserve the backend dialog-opened signal without exposing dialog text', async () => {
  const f = await fixture(),
    request = f.native.request;
  f.native.request = (command, signal) =>
    command.action === 'click'
      ? Promise.resolve({ success: true, data: { dialogOpened: true } })
      : request(command, signal);
  const view = f.controller.view('session')!;
  expect(
    (
      await f.controller.command(
        'session',
        f.target,
        { action: 'click', ref: '@e1', seq: view.seq },
        f.signal,
      )
    ).details,
  ).toMatchObject({ dialogOpened: true });
  expect(f.captures).toBe(0);
});

test('human note capture is allowed once while model DOM observation and stale targets are refused', async () => {
  const f = await fixture();
  expect((await f.controller.handoff('session', f.target, f.signal)).outcome).toBe('succeeded');
  const human = f.controller.view('session')!;
  expect(f.captures).toBe(0);
  expect((await f.controller.observe!('session', human, f.signal)).outcome).toBe('failed');
  expect((await f.controller.captureNote!('session', human, f.signal)).outcome).toBe('succeeded');
  expect(f.captures).toBe(1);
  expect((await f.controller.captureNote!('session', f.target, f.signal)).outcome).toBe('failed');
  const cancelled = new AbortController();
  cancelled.abort();
  expect((await f.controller.captureNote!('session', human, cancelled.signal)).outcome).toBe(
    'cancelled',
  );
  expect(f.captures).toBe(1);
});

test('host revocation wakes code owners before awaiting transport teardown', async () => {
  const f = await fixture(),
    states: string[] = [];
  f.controller.watchControl('session', f.target, (value) => states.push(value));
  await f.controller.handoff('session', f.target, f.signal);
  expect(states).toEqual(['agent', 'pausing', 'human']);
  let finish!: () => void;
  f.native.close = async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { confirmed: true };
  };
  const stopping = f.controller.close('session', f.controller.view('session')!);
  expect(states.at(-1)).toBe('closing');
  finish();
  await stopping;
});

test('pointer and dialog control route only through proof-aware optional host ports', async () => {
  const f = await fixture(),
    calls: unknown[] = [];
  f.native.pointer = async (input) => {
    calls.push(input);
  };
  f.native.dialogs = async () => [{ dialogRef: 'host-dialog', type: 'confirm' }];
  f.native.dialog = async (input) => {
    calls.push(input);
  };
  expect(
    (await f.controller.control!('session', f.target, { action: 'dialogs' }, f.signal)).details,
  ).toEqual({ dialogs: [{ dialogRef: 'host-dialog', type: 'confirm' }] });
  expect(
    (
      await f.controller.control!(
        'session',
        f.target,
        { action: 'pointer', imageRef: 'formal-image', kind: 'click', from: { x: 4, y: 8 } },
        f.signal,
      )
    ).outcome,
  ).toBe('succeeded');
  expect(
    (
      await f.controller.control!(
        'session',
        f.target,
        { action: 'dialog', dialogRef: 'host-dialog', response: 'dismiss' },
        f.signal,
      )
    ).outcome,
  ).toBe('succeeded');
  expect(calls).toEqual([
    { imageRef: 'formal-image', kind: 'click', from: { x: 4, y: 8 } },
    { dialogRef: 'host-dialog', response: 'dismiss' },
  ]);
  expect(
    f.requests.some((value) =>
      ['pointer', 'dialog', 'dialogs', 'mouse'].includes(String(value.action)),
    ),
  ).toBe(false);
  f.native.pointer = async () => {
    throw new BrowserTransportError('browser_page_pointer_stale', false);
  };
  expect(
    (
      await f.controller.control!(
        'session',
        f.target,
        { action: 'pointer', imageRef: 'stale', kind: 'click', from: { x: 4, y: 8 } },
        f.signal,
      )
    ).outcome,
  ).toBe('failed');
  expect(f.controller.view('session')?.state).toBe('agent');
});

test('legacy preview remains periodic, and hidden control schema excludes scripts and unproved coordinates', async () => {
  const f = await fixture('preview');
  expect(f.captures).toBeGreaterThan(0);
  expect(
    f.requests
      .filter((value) => value.action === 'snapshot')
      .every((value) => value.interactive === true),
  ).toBe(true);
  const tool = createBrowserControlTool(f.controller);
  expect(tool.model?.hidden).toBe(true);
  const validate = new Ajv({ strict: false }).compile(tool.inputSchema);
  for (const operation of [
    { action: 'evaluate', script: 'alert(1)' },
    { action: 'pointer', kind: 'click', from: { x: 2, y: 3 } },
    { action: 'press', key: 'credential text' },
    { action: 'wait', text: 'ready', timeoutMs: 10001 },
  ])
    expect(validate({ browserId: 'browser', generation: f.target.generation, operation })).toBe(
      false,
    );
  expect(
    (
      await f.controller.control!(
        'session',
        f.target,
        { action: 'dialog', dialogRef: 'invented', response: 'accept' },
        f.signal,
      )
    ).content,
  ).toBe('browser_dialog_unavailable');
  expect(
    (
      await f.controller.control!(
        'session',
        f.target,
        { action: 'pointer', imageRef: 'invented', kind: 'click', from: { x: 2, y: 3 } },
        f.signal,
      )
    ).content,
  ).toBe('browser_pointer_unavailable');
});

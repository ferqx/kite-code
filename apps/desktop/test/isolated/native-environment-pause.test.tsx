import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  NativeBridge,
  NativeRequest,
  NativeResult,
  NativeSelection,
} from '../../src/native-bridge';
import { useNativeEnvironment } from '../../src/native-environment';
import { backgroundItem, backgroundShellItem } from '../background-item.fixture';

type Environment = ReturnType<typeof useNativeEnvironment>;
async function fixture() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const keys = ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const original = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  const items = [backgroundShellItem(1), backgroundItem(2, true)];
  let selection: NativeSelection = {
    storeId: 'store',
    viewGeneration: 1,
    viewSelection: 1,
    session: items[0]!.rootSession,
    runs: [],
    executions: [],
    interactions: [],
    interactionsAfterId: null,
    canReadModelOutput: false,
  };
  let generation = 1;
  let revision = 0;
  let paused = false;
  let unavailable = false;
  let nextRead: 'ready' | 'hold' | 'error' = 'ready';
  const requests: NativeRequest[] = [];
  const pending: { readId: string; resolve: (value: NativeResult) => void; page: NativeResult }[] =
    [];
  const children: { resolve: (value: NativeResult) => void }[] = [];
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(request) {
      requests.push(request);
      if (request.method === 'background.open') {
        const page: NativeResult = {
          kind: 'background.page',
          viewGeneration: generation,
          storeId: 'store',
          readId: request.readId,
          rootSessionId: selection.session.id,
          viewSelection: selection.viewSelection!,
          observationId: requests.length,
          startIndex: 0,
          nextIndex: items.length,
          total: items.length,
          complete: true,
          entries: items,
        };
        const mode = nextRead;
        nextRead = 'ready';
        if (mode === 'error') throw Error('environment_test_failure');
        if (mode === 'hold')
          return await new Promise<NativeResult>((resolve) => {
            pending.push({ readId: request.readId, resolve, page });
          });
        return page;
      }
      if (request.method === 'background.child.open')
        return await new Promise<NativeResult>((resolve) => {
          children.push({ resolve });
        });
      if (request.method === 'background.stop')
        return { id: request.commandId, status: 'accepted' } as NativeResult;
      return null;
    },
  };
  const commits: {
    paused: boolean;
    busy: boolean;
    childRead: boolean;
    approvalOwners: number;
    text: string;
  }[] = [];
  let latest: Environment;
  let onCommit: ((environment: Environment) => void) | undefined;
  const onChanged = async () => {};
  function Surface() {
    const environment = useNativeEnvironment({
      bridge,
      generation,
      selection,
      revision,
      paused,
      unavailable,
      onChanged,
    });
    useLayoutEffect(() => {
      latest = environment;
      commits.push({
        paused,
        busy: host.querySelector('[aria-label="环境信息"]')?.getAttribute('aria-busy') === 'true',
        childRead: environment.childReadAvailable,
        approvalOwners: environment.approvalOwners.length,
        text: host.textContent ?? '',
      });
      onCommit?.(environment);
    });
    return (
      <>
        {environment.card}
        <output data-child-state="">{environment.child?.loading ? 'loading' : ''}</output>
      </>
    );
  }
  return {
    host,
    requests,
    commits,
    pending,
    children,
    get environment() {
      return latest!;
    },
    async render(
      update: {
        paused?: boolean;
        unavailable?: boolean;
        revision?: number;
        view?: number;
        generation?: number;
        nextRead?: typeof nextRead;
        onCommit?: (environment: Environment) => void;
      } = {},
    ) {
      if (update.paused !== undefined) paused = update.paused;
      if (update.unavailable !== undefined) unavailable = update.unavailable;
      if (update.revision !== undefined) revision = update.revision;
      if (update.generation !== undefined) generation = update.generation;
      if (update.view !== undefined) selection = { ...selection, viewSelection: update.view };
      if (update.nextRead !== undefined) nextRead = update.nextRead;
      onCommit = update.onCommit;
      await act(async () => root.render(<Surface />));
      onCommit = undefined;
    },
    async resolve(index = 0) {
      const entry = pending.splice(index, 1)[0]!;
      await act(async () => entry.resolve(entry.page));
    },
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
const stops = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLButtonElement>('.background-execution-stop'),
];

test('pause retains its display with one parent commit and resume cannot use the paused facts before a fresh read takes ownership', async () => {
  const f = await fixture();
  try {
    await f.render();
    expect(stops(f.host)).toHaveLength(2);
    expect(stops(f.host).every((button) => !button.disabled)).toBe(true);
    const previous = f.commits.length;
    const oldText = f.host.textContent;
    await f.render({ paused: true });
    expect(f.commits.length - previous).toBe(1);
    expect(f.commits.at(-1)?.busy).toBe(true);
    expect(f.environment.childReadAvailable).toBe(false);
    expect(f.environment.approvalOwners).toEqual([]);
    expect(f.host.textContent).toBe(oldText);
    expect(stops(f.host).every((button) => button.disabled)).toBe(true);
    const beforeResume = f.requests.length;
    const resumeCommits = f.commits.length;
    let attempted = false;
    await f.render({
      paused: false,
      nextRead: 'hold',
      onCommit(environment) {
        if (attempted) return;
        attempted = true;
        expect(environment.childReadAvailable).toBe(false);
        expect(environment.approvalOwners).toEqual([]);
        for (const button of stops(f.host)) button.click();
        environment.openChild('child', 'job-2');
      },
    });
    expect(f.commits[resumeCommits]?.busy).toBe(true);
    expect(f.pending).toHaveLength(1);
    expect(stops(f.host).every((button) => button.disabled)).toBe(true);
    expect(
      f.requests
        .slice(beforeResume)
        .filter(
          (request) =>
            request.method === 'background.stop' || request.method === 'background.child.open',
        ),
    ).toEqual([]);
    await f.resolve();
    expect(stops(f.host).every((button) => !button.disabled)).toBe(true);
    expect(f.environment.childReadAvailable).toBe(true);
    expect(f.environment.approvalOwners).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a paused in-flight directory is cancelled and its late page cannot replace the resumed observation', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.render({ revision: 1, nextRead: 'hold' });
    expect(f.pending).toHaveLength(1);
    const retiredId = f.pending[0]!.readId;
    await f.render({ paused: true });
    expect(
      f.requests.some(
        (request) => request.method === 'background.close' && request.readId === retiredId,
      ),
    ).toBe(true);
    await f.render({ paused: false, nextRead: 'hold' });
    expect(f.pending).toHaveLength(2);
    await f.resolve(0);
    expect(stops(f.host).every((button) => button.disabled)).toBe(true);
    expect(f.environment.approvalOwners).toEqual([]);
    await f.resolve(0);
    expect(stops(f.host).every((button) => !button.disabled)).toBe(true);
  } finally {
    await f.close();
  }
});

test('pause and scope replacement keep child readers retired and old directory results cannot enable the new scope', async () => {
  const f = await fixture();
  try {
    await f.render();
    await act(async () => f.environment.openChild('child', 'job-2'));
    expect(f.children).toHaveLength(1);
    expect(f.host.querySelector('[data-child-state]')?.textContent).toBe('loading');
    const readId = f.requests.find((request) => request.method === 'background.child.open')!.readId;
    await f.render({ paused: true });
    expect(
      f.requests.some(
        (request) => request.method === 'background.child.close' && request.readId === readId,
      ),
    ).toBe(true);
    await act(async () => f.children[0]!.resolve(null));
    expect(f.environment.child?.facts).toBeUndefined();
    await f.render({ paused: false, nextRead: 'hold' });
    await f.render({ generation: 2, view: 2, nextRead: 'hold' });
    expect(f.pending).toHaveLength(2);
    await f.resolve(0);
    expect(f.environment.approvalOwners).toEqual([]);
    expect(stops(f.host).every((button) => button.disabled)).toBe(true);
    await f.resolve(0);
    expect(f.environment.child).toBeUndefined();
    expect(stops(f.host).every((button) => !button.disabled)).toBe(true);
  } finally {
    await f.close();
  }
});

test('errors and unavailable observations remain non-authoritative through pause and immediate fresh recovery', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.render({ revision: 1, nextRead: 'error' });
    expect(stops(f.host)).toHaveLength(0);
    expect(f.environment.approvalOwners).toEqual([]);
    const display = f.host.textContent;
    const before = f.commits.length;
    await f.render({ paused: true });
    expect(f.commits.length - before).toBe(1);
    expect(f.host.textContent).toBe(display);
    await f.render({ paused: false });
    expect(stops(f.host).every((button) => !button.disabled)).toBe(true);
    await f.render({ unavailable: true });
    expect(f.environment.childReadAvailable).toBe(false);
    expect(stops(f.host)).toHaveLength(0);
    await f.render({ paused: true });
    await f.render({ paused: false });
    expect(f.environment.approvalOwners).toEqual([]);
    expect(stops(f.host)).toHaveLength(0);
    await f.render({ unavailable: false });
    expect(stops(f.host).every((button) => !button.disabled)).toBe(true);
  } finally {
    await f.close();
  }
});

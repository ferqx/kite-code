import { afterAll, expect, mock, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { Activity, act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ConversationActivityContext,
  type RetainedConversationResource,
} from '../../src/conversation-activity';
import type { DiagramColors } from '../../src/desktop/markdown-diagram';

const jobs: { colors: DiagramColors; signal: AbortSignal; resolve: (value: string) => void }[] = [];
mock.module('../../src/desktop/markdown-diagram', () => ({
  diagramRestriction: () => undefined,
  renderMarkdownDiagram: (_code: string, colors: DiagramColors, signal: AbortSignal) =>
    new Promise<string>((resolve) => jobs.push({ colors, signal, resolve })),
}));
const { MarkdownDiagram } = await import('../../src/desktop/MarkdownDiagram');
afterAll(() => mock.restore());

test('diagrams discard late work, retain paused display, account cached resources and recover from window hiding', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  let accent = '#4b68b1';
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: () => ({
      color: 'rgb(20, 20, 20)',
      getPropertyValue: (name: string) => (name === '--diagram-accent' ? accent : '#478079'),
    }),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  let paused = false;
  const resources = new Set<RetainedConversationResource>();
  const retention = {
    isPaused: () => paused,
    retain: (resource: RetainedConversationResource) => {
      resources.add(resource);
      return () => {
        resources.delete(resource);
      };
    },
  };
  const render = (code: string, complete: boolean, active = true) =>
    act(async () => {
      paused = !active;
      root.render(
        <ConversationActivityContext value={{ readActive: active, resume: 0, retention }}>
          <Activity mode={active ? 'visible' : 'hidden'}>
            <MarkdownDiagram code={code} complete={complete} sourceVisible={false} />
          </Activity>
        </ConversationActivityContext>,
      );
    });
  try {
    await render('first', false);
    expect(jobs).toHaveLength(0);
    await render('first', true);
    expect(jobs).toHaveLength(1);
    await render('second', true);
    expect(jobs[0]!.signal.aborted).toBe(true);
    await act(async () => jobs[0]!.resolve('data:image/svg+xml,old'));
    expect(host.querySelector('img')).toBeNull();
    await act(async () => jobs[1]!.resolve('data:image/svg+xml,current'));
    const image = host.querySelector('img');
    expect(image?.getAttribute('src')).toBe('data:image/svg+xml,current');
    expect([...resources][0]!.bytes).toBe('data:image/svg+xml,current'.length * 2);
    await render('second', true, false);
    expect(resources.size).toBe(1);
    expect(jobs[1]!.signal.aborted).toBe(true);
    expect(host.querySelector('img')).toBe(image);
    await render('second', true);
    expect(host.querySelector('img')).toBe(image);
    await act(async () => jobs.at(-1)!.resolve('data:image/svg+xml,resumed'));
    await act(async () => {
      Object.defineProperty(dom.window.document, 'hidden', { value: true, configurable: true });
      dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    });
    expect(host.querySelector('img')).toBeNull();
    expect(resources.size).toBe(0);
    expect(jobs.at(-1)!.signal.aborted).toBe(true);
    await act(async () => {
      Object.defineProperty(dom.window.document, 'hidden', { value: false, configurable: true });
      dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    });
    await act(async () => jobs.at(-1)!.resolve('data:image/svg+xml,visible-again'));
    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/svg+xml,visible-again');
    expect(resources.size).toBe(1);
    const previousJob = jobs.at(-1)!;
    const previousImage = host.querySelector('img');
    await act(async () => {
      accent = '#9aafe6';
      host.setAttribute('data-theme', 'dark');
    });
    expect(previousJob.signal.aborted).toBe(true);
    expect(jobs.at(-1)!.colors.accent).toBe('#9aafe6');
    expect(jobs.at(-1)!.colors.foreground).toBe(previousJob.colors.foreground);
    expect(host.querySelector('img')).toBe(previousImage);
    await act(async () => jobs.at(-1)!.resolve('data:image/svg+xml,new-theme'));
    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/svg+xml,new-theme');
    const jobCount = jobs.length;
    await act(async () => host.setAttribute('class', 'unrelated-layout-change'));
    expect(jobs).toHaveLength(jobCount);
  } finally {
    paused = false;
    await act(async () => root.unmount());
    expect(resources.size).toBe(0);
    dom.window.close();
    for (const [key, value] of originals) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

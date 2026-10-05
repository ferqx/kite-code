import { expect, test } from 'bun:test';
import type { Interaction } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { type AttachmentReader, InteractionCard } from '../src';
import { card } from './interactions.test';

function fixtureCard(id = 'one'): Interaction {
  return {
    ...card,
    id,
    request: {
      policy: {
        review: {
          kind: 'artifact',
          complete: true,
          reference: {
            id: `ref-${id}`,
            mediaType: 'application/json',
            size: '2',
            scope: { kind: 'session', id: 'child' },
          },
        },
      },
    },
  };
}
async function read(bytes = Uint8Array.from([123, 125])) {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return { hash, bytes };
}
test('actual DOM keyboard cannot approve unseen/failed attachments; complete load enables one exact answer and late replacement cannot expose old body', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  const calls: string[] = [];
  const data = await read();
  let mode: 'valid' | 'corrupt' | 'encoding' | 'late' = 'valid';
  const invalidBytes = Uint8Array.from([192, 175]);
  const invalidHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', invalidBytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  let readSignal: AbortSignal | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const entry = new Promise<void>((resolve) => (entered = resolve));
  const reader: AttachmentReader = async (intent, { signal }) => {
    readSignal = signal;
    if (mode === 'late') {
      entered();
      await gate;
    }
    return {
      reference: { ...intent.reference, hash: mode === 'encoding' ? invalidHash : data.hash },
      content:
        mode === 'encoding'
          ? invalidBytes
          : mode === 'corrupt'
            ? Uint8Array.from([120, 125])
            : data.bytes,
    };
  };
  const onAnswer = (value: Interaction) => {
    calls.push(value.id);
  };
  const render = (value: Interaction, port: AttachmentReader | undefined = reader) =>
    act(async () =>
      root.render(
        <InteractionCard interaction={value} onAnswer={onAnswer} onReadAttachment={port} />,
      ),
    );
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((value) => value.textContent === label)!;
  const keyboard = async (label: string) =>
    act(async () => {
      const target = button(label);
      target.focus();
      target.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
  const click = async (label: string) => act(async () => button(label).click());
  try {
    await render(fixtureCard(), undefined);
    await keyboard('Approve once');
    expect(calls).toHaveLength(0);
    await render(fixtureCard());
    mode = 'corrupt';
    await click('Load complete attachment');
    await act(async () => await Bun.sleep(5));
    expect(button('Approve once').disabled).toBe(true);
    expect(host.textContent).toContain('could not be verified');
    expect(calls).toHaveLength(0);
    mode = 'encoding';
    await click('Load complete attachment');
    await act(async () => await Bun.sleep(5));
    expect(button('Approve once').disabled).toBe(true);
    expect(host.querySelector('[data-complete-attachment]')).toBeNull();
    mode = 'late';
    await click('Load complete attachment');
    await entry;
    await click('Cancel attachment loading');
    expect(readSignal?.aborted).toBe(true);
    expect(calls).toHaveLength(0);
    await render(fixtureCard('two'));
    release();
    await act(async () => await Bun.sleep(5));
    expect(host.querySelector('[data-complete-attachment]')).toBeNull();
    expect(button('Approve once').disabled).toBe(true);
    mode = 'valid';
    await click('Load complete attachment');
    await act(async () => await Bun.sleep(5));
    expect(host.querySelector('[data-complete-attachment]')?.textContent).toBe('{}');
    expect(button('Approve once').disabled).toBe(false);
    await act(async () => {
      const target = button('Approve once');
      target.focus();
      target.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      target.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true }),
      );
      target.click();
    });
    expect(calls).toEqual(['two']);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
}, 10000);

test('actual >=17MiB public Auto attachment renders complete DOM text before a keyboard answer can dispatch', async () => {
  const { largeInteractionFixture } = await import('./fixtures/large-interaction');
  const f = await largeInteractionFixture();
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  let saved: Promise<unknown> | undefined;
  try {
    const interaction = await f.start();
    const reader: AttachmentReader = (intent, options) =>
      f.client.readArtifact(
        intent.sessionId,
        {
          expectedStoreId: intent.originStoreId,
          refId: intent.reference.id,
          scope: intent.reference.scope,
        },
        { signal: options.signal, expectedReference: intent.reference },
      );
    await act(async () =>
      root.render(
        <InteractionCard
          interaction={interaction}
          onReadAttachment={reader}
          onAnswer={(original, answer) => {
            saved = f.client.answerInteraction(original.presentationSessionId, original.id, {
              expectedStoreId: original.originStoreId,
              expectedRevision: original.revision,
              commandId: 'complete-answer',
              answer,
            });
            return saved.then(() => {});
          }}
        />,
      ),
    );
    const button = (label: string) =>
      [...host.querySelectorAll('button')].find((value) => value.textContent === label)!;
    expect(button('Approve once').disabled).toBe(true);
    await act(async () => button('Load complete attachment').click());
    const end = Date.now() + 7000;
    while (!host.querySelector('[data-complete-attachment]')) {
      if (Date.now() > end) throw new Error('attachment_dom_deadline');
      await act(async () => await Bun.sleep(5));
    }
    const text = host.querySelector('[data-complete-attachment]')!.textContent!;
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(17 * 1024 * 1024);
    expect(JSON.parse(text).task).toBe(f.body);
    expect(button('Approve once').disabled).toBe(false);
    expect(f.effects()).toBe(0);
    await act(async () => {
      button('Approve once').focus();
      button('Approve once').dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await saved;
    await f.runtime.waitForCommand('work', { timeoutMs: 8000 });
    expect(f.effects()).toBe(1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
    await f.close();
  }
}, 30000);

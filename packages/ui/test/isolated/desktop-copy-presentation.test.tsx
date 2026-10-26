import { expect, spyOn, test } from 'bun:test';
import { HugeiconsIcon } from '@hugeicons/react';
import { JSDOM } from 'jsdom';
import { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationActivityContext } from '../../src/conversation-activity';
import { useTextCopy } from '../../src/desktop/clipboard';
import { MessageCopyButton } from '../../src/desktop/MessageCopyButton';

type Copy = ReturnType<typeof useTextCopy>;
async function fixture(count = 40, hook = false) {
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
  const writes: string[] = [];
  const props = {
    prefix: 'saved',
    writer: async (text: string) => {
      writes.push(text);
    },
    readActive: false,
    disabled: false,
    copyRole: 'assistant' as 'user' | 'assistant',
    resume: 0,
  };
  let latest: Copy | undefined;
  function HookProbe() {
    const copy = useTextCopy(props.prefix, props.writer, props.disabled);
    useLayoutEffect(() => {
      latest = copy;
    });
    return <output data-hook-copy="">{copy.copyState}</output>;
  }
  return {
    host,
    writes,
    get hook() {
      return latest!;
    },
    async render(update: Partial<typeof props> = {}) {
      Object.assign(props, update);
      await act(async () =>
        root.render(
          <ConversationActivityContext
            value={{ readActive: props.readActive, resume: props.resume }}
          >
            {Array.from({ length: count }, (_, index) => (
              <MessageCopyButton
                key={index}
                text={`${props.prefix} ${index}`}
                writeClipboardText={props.writer}
                disabled={props.disabled}
                copyRole={props.copyRole}
              />
            ))}
            {hook && <HookProbe />}
          </ConversationActivityContext>,
        ),
      );
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

test('forty real copy controls reuse their button/icon presentation on resume while read admission, feedback and input changes still update', async () => {
  const icon = HugeiconsIcon as unknown as { render: (...args: unknown[]) => unknown };
  const rendered = spyOn(icon, 'render');
  const f = await fixture();
  try {
    await f.render();
    expect(rendered).toHaveBeenCalledTimes(40);
    const buttons = [...f.host.querySelectorAll<HTMLButtonElement>('.message-copy')];
    for (let resume = 1; resume <= 5; resume++) await f.render({ resume });
    expect(rendered).toHaveBeenCalledTimes(40);
    expect([...f.host.querySelectorAll('.message-copy')]).toEqual(buttons);
    await act(async () => buttons[0]!.click());
    expect(f.writes).toEqual([]);
    await f.render({ readActive: true });
    expect(rendered).toHaveBeenCalledTimes(80);
    expect(buttons[0]!.getAttribute('aria-disabled')).toBeNull();
    await act(async () => buttons[0]!.click());
    expect(f.writes).toEqual(['saved 0']);
    expect(buttons[0]!.getAttribute('data-copy-state')).toBe('copied');
    expect(buttons[0]!.getAttribute('aria-label')).toBe('已复制消息');
    await f.render({ readActive: false });
    expect(buttons[0]!.getAttribute('aria-disabled')).toBe('true');
    await act(async () => buttons[0]!.click());
    expect(f.writes).toEqual(['saved 0']);
    await f.render({ readActive: true, disabled: true });
    expect(buttons[0]!.disabled).toBe(true);
    await f.render({ disabled: false, prefix: 'new saved', copyRole: 'user' });
    expect(buttons[0]!.getAttribute('data-copy-state')).toBe('idle');
    expect(buttons[0]!.getAttribute('aria-label')).toBe('复制本轮用户消息');
    await act(async () => buttons[0]!.click());
    expect(f.writes).toEqual(['saved 0', 'new saved 0']);
  } finally {
    await f.close();
    rendered.mockRestore();
  }
});

test('stable clipboard callbacks preserve the current read gate and obsolete text, writer and unmounted callbacks cannot dispatch', async () => {
  const f = await fixture(0, true);
  let completed = false;
  try {
    const oldWrites: string[] = [];
    const newWrites: string[] = [];
    const oldWriter = async (text: string) => {
      oldWrites.push(text);
    };
    const newWriter = async (text: string) => {
      newWrites.push(text);
    };
    await f.render({ readActive: true, prefix: 'first original', writer: oldWriter });
    const first = f.hook.copyMessage;
    await f.render({ resume: 1 });
    expect(f.hook.copyMessage).toBe(first);
    await f.render({ readActive: false });
    expect(f.hook.copyMessage).toBe(first);
    await act(async () => first());
    expect(oldWrites).toEqual([]);
    await f.render({ readActive: true, prefix: 'second original' });
    const second = f.hook.copyMessage;
    expect(second).not.toBe(first);
    await act(async () => first());
    expect(oldWrites).toEqual([]);
    await act(async () => second());
    expect(oldWrites).toEqual(['second original']);
    await f.render({ writer: newWriter });
    const current = f.hook.copyMessage;
    expect(current).not.toBe(second);
    await act(async () => second());
    expect(oldWrites).toEqual(['second original']);
    expect(newWrites).toEqual([]);
    await act(async () => current());
    expect(newWrites).toEqual(['second original']);
    await f.close();
    completed = true;
    await current();
    expect(newWrites).toEqual(['second original']);
  } finally {
    if (!completed) await f.close();
  }
});

test('a pending old clipboard completion cannot publish copied feedback after its writer changes', async () => {
  const f = await fixture(0, true);
  let finish: (() => void) | undefined;
  try {
    const oldWriter = async () =>
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    const newWrites: string[] = [];
    const newWriter = async (text: string) => {
      newWrites.push(text);
    };
    await f.render({ readActive: true, prefix: 'exact body', writer: oldWriter });
    const obsolete = f.hook.copyMessage;
    const pending = obsolete();
    expect(finish).toBeDefined();
    await f.render({ writer: newWriter });
    await act(async () => {
      finish!();
      await pending;
    });
    expect(f.hook.copyState).toBe('idle');
    await act(async () => obsolete());
    expect(newWrites).toEqual([]);
    await act(async () => f.hook.copyMessage());
    expect(newWrites).toEqual(['exact body']);
    expect(f.hook.copyState).toBe('copied');
  } finally {
    await f.close();
  }
});

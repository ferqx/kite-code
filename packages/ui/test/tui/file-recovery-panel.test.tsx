import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import type { TuiController } from '../../src/tui/controller';
import { TuiFileRecoveryPanel } from '../../src/tui/file-recovery-panel';
import { defaultTuiPreferences } from '../../src/tui/preferences';
import { TuiPresentationProvider } from '../../src/tui/presentation';

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
test('Files reader windows exact original points, previews real file impact and separately confirms a scope', async () => {
  const items = Array.from({ length: 9 }, (_, i) => ({
    checkpoint: {
      id: `point-${i}`,
      boundary: { triggerMessageId: `m-${i}`, storeId: 'store', sessionId: 'session' },
    },
    revision: '1',
  }));
  const calls: string[] = [];
  const state = {
    fileRecovery: {
      phase: 'ready',
      points: { payload: { items } },
      detail: undefined as unknown,
      intent: undefined as unknown,
      saved: [],
    },
    snapshot: {
      storeId: 'store',
      messages: items.map((_, i) => ({
        id: `m-${i}`,
        sessionId: 'session',
        content: `Original task ${i}`,
      })),
    },
  };
  const controller = {
    state,
    readFileRecoveryPoint: async (id: string) => {
      calls.push(`read:${id}`);
    },
    chooseFileRecoveryScope: (scope: string) => calls.push(`scope:${scope}`),
    startFileRecovery: async (scope: string) => calls.push(`begin:${scope}`),
    closePanel: () => calls.push('close'),
    observeFileRecovery: async (cont?: boolean) => calls.push(cont ? 'continue' : 'lookup'),
    selectSavedFileRecovery: () => calls.push('select'),
  } as unknown as TuiController;
  const ui = render(<TuiFileRecoveryPanel controller={controller} />);
  try {
    await tick();
    expect(ui.lastFrame()).toContain('Original task 0');
    expect(ui.lastFrame()).not.toContain('point-0');
    expect(ui.lastFrame()).not.toContain('Original task 8');
    for (let i = 0; i < 8; i++) {
      ui.stdin.write('\u001b[B');
      await tick();
    }
    expect(ui.lastFrame()).toContain('Original task 8');
    ui.stdin.write('\r');
    await tick();
    expect(calls).toEqual(['read:point-8']);
    state.fileRecovery.detail = {
      boundary: { checkpoint: items[8]!.checkpoint },
      preview: {
        payload: {
          files: [{ path: 'src/main.ts', status: 'conflict', reason: 'changed after checkpoint' }],
        },
      },
    };
    ui.rerender(<TuiFileRecoveryPanel controller={controller} />);
    await tick();
    expect(ui.lastFrame()).toContain('src/main.ts');
    expect(ui.lastFrame()).toContain('changed after checkpoint');
    ui.stdin.write('2');
    await tick();
    expect(calls).toEqual(['read:point-8', 'scope:code']);
    ui.stdin.write('\u001b');
    await tick();
    expect(calls).not.toContain('begin:code');
    ui.stdin.write('3');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(calls.at(-1)).toBe('begin:both');
    state.fileRecovery.intent = {
      scope: 'both',
      code: { phase: 'unknown' },
      fork: { phase: 'not_started' },
    };
    ui.rerender(<TuiFileRecoveryPanel controller={controller} />);
    await tick();
    const count = calls.length;
    ui.stdin.write('2\r');
    await tick();
    expect(calls).toHaveLength(count);
    ui.stdin.write('r');
    await tick();
    expect(calls.at(-1)).toBe('lookup');
    expect(ui.lastFrame()).not.toContain('"phase"');
  } finally {
    ui.unmount();
  }
});

test('original rewind shows verified recorded date, code statistics and read-only bounded text preview without submitting recovery', async () => {
  const point = {
    id: 'p',
    boundary: { triggerMessageId: 'm', storeId: 'store', sessionId: 'session' },
  };
  const calls: string[] = [];
  const state = {
    snapshot: {
      storeId: 'store',
      messages: [{ id: 'm', sessionId: 'session', content: 'Original task' }],
    },
    fileRecovery: {
      phase: 'ready',
      points: { payload: { items: [{ checkpoint: point, revision: '1', recordedAt: 2000 }] } },
      saved: [],
      detail: undefined as unknown,
    },
  };
  const controller = {
    state,
    readFileRecoveryPoint: async () => {
      calls.push('read');
    },
    chooseFileRecoveryScope: (scope: string) => calls.push(`scope:${scope}`),
    startFileRecovery: async () => calls.push('begin'),
    closePanel: () => {},
    observeFileRecovery: async () => {},
    selectSavedFileRecovery: () => {},
  } as unknown as TuiController;
  const ui = render(<TuiFileRecoveryPanel controller={controller} />);
  try {
    await tick();
    expect(ui.lastFrame()).toContain('Recorded at:');
    ui.stdin.write('\r');
    await tick();
    state.fileRecovery.detail = {
      boundary: { checkpoint: point },
      preview: {
        payload: {
          files: [
            {
              path: 'src/main.ts',
              status: 'restore',
              reason: null,
              textChange: {
                addedLines: 2,
                removedLines: 1,
                preview: Array.from({ length: 15 }, (_, i) => `+ original line ${i}`).join('\n'),
                truncated: true,
              },
            },
          ],
        },
      },
    };
    ui.rerender(<TuiFileRecoveryPanel controller={controller} />);
    await tick();
    expect(ui.lastFrame()).toContain('+2 −1');
    ui.stdin.write('2');
    await tick();
    ui.stdin.write('v');
    await tick();
    expect(ui.lastFrame()).toContain('original line 0');
    expect(ui.lastFrame()).toContain('Bounded preview; line counts use complete text.');
    ui.stdin.write('\u001b[F');
    await tick();
    expect(ui.lastFrame()).toContain('original line 14');
    ui.stdin.write('\r');
    await tick();
    expect(calls).toEqual(['read', 'scope:code']);
    ui.stdin.write('\u001b');
    await tick();
    expect(ui.lastFrame()).not.toContain('original line 14');
    ui.stdin.write('\u001b');
    await tick();
    ui.stdin.write('1');
    await tick();
    expect(ui.lastFrame()).toContain('Code will remain unchanged.');
    expect(calls).not.toContain('begin');
  } finally {
    ui.unmount();
  }
});

test('Chinese recovery keeps complete navigation and actual impact localized while requiring a separate explicit scope', async () => {
  const calls: string[] = [];
  const point = {
    id: 'point',
    boundary: { triggerMessageId: 'message', storeId: 'store', sessionId: 'session' },
  };
  const controller = {
    state: {
      snapshot: {
        storeId: 'store',
        messages: [{ id: 'message', sessionId: 'session', content: 'Original boundary' }],
      },
      fileRecovery: {
        phase: 'ready',
        points: { payload: { items: [{ checkpoint: point, recordedAt: 2000 }] } },
        saved: [],
        detail: {
          boundary: { checkpoint: point },
          preview: {
            payload: {
              files: [
                {
                  path: 'notes.md',
                  status: 'restore',
                  textChange: { addedLines: 1, removedLines: 1 },
                },
              ],
            },
          },
        },
      },
    },
    readFileRecoveryPoint: async () => calls.push('read'),
    chooseFileRecoveryScope: (scope: string) => calls.push(`scope:${scope}`),
    startFileRecovery: async (scope: string) => calls.push(`submit:${scope}`),
  } as unknown as TuiController;
  const ui = render(
    <TuiPresentationProvider
      value={{
        preferences: { ...defaultTuiPreferences, language: 'zh-CN', resolvedLanguage: 'zh-CN' },
        testDiagnostics: false,
      }}
    >
      <TuiFileRecoveryPanel controller={controller} />
    </TuiPresentationProvider>,
  );
  try {
    await tick();
    expect(ui.lastFrame()).toContain('Enter 继续');
    expect(ui.lastFrame()).toContain('Esc 关闭');
    expect(ui.lastFrame()).toContain('记录时间：');
    expect(ui.lastFrame()).not.toContain('Continue');
    expect(ui.lastFrame()).not.toContain('Close');
    ui.stdin.write('\r');
    await tick();
    expect(calls).toEqual(['read']);
    expect(ui.lastFrame()).toContain('代码将恢复 +1 −1，涉及 notes.md');
    expect(ui.lastFrame()).toContain('请明确选择恢复范围');
    ui.stdin.write('\r');
    await tick();
    expect(calls).toEqual(['read']);
    ui.stdin.write('3');
    await tick();
    expect(ui.lastFrame()).toContain('Enter 确认所选范围');
    expect(calls).toEqual(['read', 'scope:both']);
    ui.stdin.write('\r');
    await tick();
    expect(calls).toEqual(['read', 'scope:both', 'submit:both']);
  } finally {
    ui.unmount();
  }
});

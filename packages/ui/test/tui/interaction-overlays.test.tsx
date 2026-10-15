import { expect, test } from 'bun:test';
import type { Interaction } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import { TuiApprovalPanel } from '../../src/tui/approval-panel';
import { ComposerBuffer } from '../../src/tui/composer';
import type { QuestionDraft, QuestionForm } from '../../src/tui/question';
import { QuestionPanel, QuestionReviewPanel } from '../../src/tui/question-panel';

const form: QuestionForm = {
  object: true,
  description: 'Exact request context',
  fields: [
    {
      key: 'one',
      title: 'Choose a path',
      description: 'Question description',
      required: true,
      text: true,
      choices: [
        {
          value: 'original',
          title: 'Original path',
          description: 'Original option details',
        },
      ],
    },
    { key: 'two', title: 'Explain', required: true, text: true, choices: [] },
  ],
};
test('question overlay preserves original context, option descriptions, step and selected custom draft', () => {
  const buffer = new ComposerBuffer();
  buffer.sync('literal 🙂 answer');
  const draft: QuestionDraft = {
    step: 0,
    fields: [{ selected: 1, buffer }, { buffer: new ComposerBuffer() }],
  };
  const ui = render(<QuestionPanel form={form} draft={draft} />);
  try {
    const frame = ui.lastFrame()!;
    expect(frame).toContain('Choose a path');
    expect(frame).toContain('1 / 2');
    expect(frame).toContain('Exact request context');
    expect(frame).toContain('Original option details');
    expect(frame).toContain('literal 🙂 answer');
    expect(frame).toContain('Tab');
    expect(buffer.text).toBe('literal 🙂 answer');
  } finally {
    ui.unmount();
  }
});
test('question wizard last step shows exact prompt and submit shortcut without erasing earlier draft', () => {
  const buffer = new ComposerBuffer();
  buffer.sync('earlier draft');
  const draft: QuestionDraft = {
    step: 1,
    fields: [{ selected: 0, buffer }, { buffer: new ComposerBuffer() }],
  };
  const ui = render(<QuestionPanel form={form} draft={draft} />);
  try {
    expect(ui.lastFrame()).toContain('Explain');
    expect(ui.lastFrame()).toContain('2 / 2');
    expect(ui.lastFrame()).toContain('Submit');
    expect(buffer.text).toBe('earlier draft');
  } finally {
    ui.unmount();
  }
});
test('approval overlay displays exact request and only caller offered grants with unknown status', () => {
  const card = {
    kind: 'approval',
    request: { command: 'echo exact original' },
  } as unknown as Interaction;
  const ui = render(
    <TuiApprovalPanel
      card={card}
      choices={['approve', 'deny']}
      selected={1}
      busy
      error="original error"
    />,
  );
  try {
    const frame = ui.lastFrame()!;
    expect(frame).toContain('echo exact original');
    expect(frame).toContain('Approve this execution only');
    expect(frame).toContain('Do not call the tool and end this turn');
    expect(frame).not.toContain('same command');
    expect(frame).toContain('Original outcome pending or unknown');
    expect(frame).toContain('original error');
  } finally {
    ui.unmount();
  }
});

test('wizard review shows semantic option labels and full original feedback without posting', () => {
  const buffer = new ComposerBuffer();
  buffer.sync('完整\nsecond line 🙂');
  const draft: QuestionDraft = {
    step: 1,
    fields: [{ selected: 0, buffer: new ComposerBuffer() }, { buffer }],
  };
  const ui = render(<QuestionReviewPanel form={form} draft={draft} submitted />);
  try {
    expect(ui.lastFrame()).toContain('Original path');
    expect(ui.lastFrame()).toContain('完整');
    expect(ui.lastFrame()).toContain('second line 🙂');
    expect(ui.lastFrame()).toContain('Answer submitted');
    expect(buffer.text).toBe('完整\nsecond line 🙂');
  } finally {
    ui.unmount();
  }
});

test('actual approval card displays exact canonical tool and target without leaking file body', () => {
  const card = {
    kind: 'approval',
    definitionId: 'files.write_path',
    request: {
      definitionId: 'files.write_path',
      definitionVersion: '1',
      input: { path: '/owned/home/external.txt', content: 'private draft contents', base: null },
      grants: ['approve_once'],
      policy: { effects: ['external'] },
    },
  } as unknown as Interaction;
  const ui = render(<TuiApprovalPanel card={card} choices={['approve', 'deny']} selected={0} />);
  try {
    expect(ui.lastFrame()).toContain('files.write_path');
    expect(ui.lastFrame()).toContain('/owned/home/external.txt');
    expect(ui.lastFrame()).not.toContain('private draft contents');
    expect(ui.lastFrame()).not.toContain('same command');
  } finally {
    ui.unmount();
  }
});

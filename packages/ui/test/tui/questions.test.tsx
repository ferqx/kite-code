import { expect, test } from 'bun:test';
import type { Interaction, SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import { TuiController, type TuiPort, type TuiPreferences, TuiSession } from '../../src/tui';
import { questionForm } from '../../src/tui/question';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

test('a closed questionnaire keeps Alt+Enter newline and offers its exact null alternative only through explicit Alt+A', async () => {
  const schema = {
    oneOf: [
      {
        type: 'object',
        properties: { q1: { type: 'string', pattern: '\\S' } },
        required: ['q1'],
        additionalProperties: false,
      },
      { const: null, title: 'Cancel answering', description: 'Keep the current Run.' },
    ],
  };
  const f = fixture(schema);
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    expect(app.lastFrame()).toContain('Alt+A: Cancel answering');
    app.stdin.write('\u001b\r');
    await tick();
    expect(f.answers).toHaveLength(0);
    app.stdin.write('original');
    await tick();
    app.stdin.write('\u001ba');
    app.stdin.write('\u001ba');
    await tick();
    expect(f.answers.map((answer) => answer.answer)).toEqual([{ kind: 'question', answers: null }]);
    expect(f.commandCount()).toBe(1);
  } finally {
    app.unmount();
  }
  for (const rejected of [
    { ...schema, maxProperties: 1 },
    { oneOf: [...schema.oneOf, { const: true }] },
    { oneOf: [{ type: 'object', properties: { q1: { type: 'string' } } }, schema.oneOf[1]] },
  ])
    expect(questionForm({ schema: rejected })).toBeUndefined();
});

function fixture(schema: Record<string, unknown>) {
  let cards = [question(schema)];
  const answers: Parameters<TuiPort['answer']>[2][] = [];
  const reads: string[] = [];
  let unknown = false;
  let minted = 0;
  const saved = (sessionId: string, id: string, cardId: string, revision: string) => ({
    id,
    sessionId,
    kind: 'interaction.answer' as const,
    originStoreId: 'store',
    status: 'applied' as const,
    cancelRequestedAt: null,
    receipt: {
      outcome: 'answer_saved',
      interactionId: cardId,
      decisionRevision: String(BigInt(revision) + 1n),
    },
  });
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => `answer-${++minted}`,
    listSessions: async () => [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ],
    readSession: async (id) => ({
      storeId: 'store',
      view: {
        storeId: 'store',
        session: { id, workspaceId: 'w' },
        runs: [],
        executions: [],
        messages: [],
      } as unknown as SessionView,
      messages: [],
      interactions: cards.filter((c) => c.presentationSessionId === id),
    }),
    submit: async () => {
      throw Error('unexpected submit');
    },
    cancel: async () => {
      throw Error('unexpected cancel');
    },
    answer: async (sessionId, id, request) => {
      answers.push(request);
      if (unknown) throw Error('lost receipt');
      return saved(sessionId, request.commandId, id, request.expectedRevision);
    },
    getCommand: async (id, sessionId) => {
      reads.push(id);
      return saved(sessionId, id, 'q', '1');
    },
  };
  return {
    port,
    controller: new TuiController(port),
    answers,
    reads,
    commandCount: () => minted,
    cards: (next: Interaction[]) => {
      cards = next;
    },
    unknown: () => {
      unknown = true;
    },
  };
}
function question(schema: Record<string, unknown>, id = 'q', revision = '1'): Interaction {
  return {
    id,
    originStoreId: 'store',
    sessionId: 'a',
    presentationSessionId: 'a',
    ancestry: ['a'],
    runId: null,
    executionId: null,
    kind: 'question',
    state: 'pending',
    revision,
    request: { schema },
    answer: null,
  } as unknown as Interaction;
}
test('ordinary schema enum answers via actual Ink selection keys, with no initial default', async () => {
  const f = fixture({
    type: 'string',
    title: 'Pick original option',
    enum: ['internal-id', 'other-id'],
  });
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  await tick();
  expect(app.lastFrame()).not.toContain('Custom answer');
  app.stdin.write('\r');
  await tick();
  expect(f.answers).toHaveLength(0);
  app.stdin.write('\u001b[B');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers).toHaveLength(1);
  expect(f.answers[0]!.answer).toEqual({ kind: 'question', answers: 'internal-id' });
  app.unmount();
});

test('object wizard preserves exact keys, titles, text, later draft and grapheme cursor across Esc', async () => {
  const f = fixture({
    type: 'object',
    additionalProperties: false,
    required: ['route', 'detail', 'constructor'],
    properties: {
      route: {
        oneOf: [
          { const: 'wire-id', title: '原选项', description: '原说明' },
          { const: 'other-id', title: 'Second option' },
        ],
      },
      detail: { type: 'string', title: 'Original detail' },
      constructor: { enum: ['delivery-id', 'second-id'] },
    },
  });
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  await tick();
  expect(app.lastFrame()).toContain('原选项');
  expect(app.lastFrame()).toContain('原说明');
  app.stdin.write('\u001b[B');
  await tick();
  app.stdin.write('\r');
  await tick();
  app.stdin.write('  /recovery @path 👨‍👩‍👧‍👦é  ');
  await tick();
  app.stdin.write('\u001b[D');
  await tick();
  app.stdin.write('\u007f');
  await tick();
  app.stdin.write('\r');
  await tick();
  app.stdin.write('\u001b[B');
  await tick();
  app.stdin.write('\u001b');
  await tick();
  expect(app.lastFrame()).toContain('/recovery @path');
  app.stdin.write('\u001b');
  await tick();
  app.stdin.write('\u001b[B');
  await tick();
  app.stdin.write('\r');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(app.lastFrame()).toContain('delivery-id');
  app.stdin.write('\r');
  await tick();
  expect(f.answers).toHaveLength(1);
  expect(f.answers[0]!.answer).toEqual({
    kind: 'question',
    answers: {
      route: 'other-id',
      detail: '  /recovery @path 👨‍👩‍👧‍👦é ',
      constructor: 'delivery-id',
    },
  });
  app.unmount();
});

test('empty free answer does not submit, original whitespace and Unicode survive intact', async () => {
  const f = fixture({ type: 'string' });
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  await tick();
  app.stdin.write('   ');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers).toHaveLength(0);
  app.stdin.write('👨‍👩‍👧‍👦é');
  await tick();
  app.stdin.write('\u007f');
  await tick();
  app.stdin.write('原文  ');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers[0]!.answer).toEqual({ kind: 'question', answers: '   👨‍👩‍👧‍👦原文  ' });
  app.unmount();
});

test('question Home/End and vertical editing follow the visible 80-column wrap for ASCII and wide Unicode', async () => {
  for (const { text, boundary, language, narrow } of [
    { text: 'a'.repeat(150), boundary: 70, language: 'en-US', narrow: false },
    { text: '界'.repeat(80), boundary: 35, language: 'en-US', narrow: false },
    { text: 'b'.repeat(70), boundary: 32, language: 'zh-CN', narrow: true },
  ] as const) {
    const f = fixture({ type: 'string' });
    f.port.preferences = {
      read: async () => ({
        revision: 'a'.repeat(64),
        language,
        resolvedLanguage: language,
        colorPreset: 'teal',
        theme: 'dark',
      }),
      save: async () => {
        throw Error('unexpected preference write');
      },
    };
    await f.controller.refreshPreferences();
    await f.controller.select('a');
    const app = render(<TuiSession controller={f.controller} />);
    Object.defineProperty(app.stdout, 'columns', { value: 80, configurable: true });
    try {
      await tick();
      app.stdin.write(text);
      await tick();
      if (narrow) Object.defineProperty(app.stdout, 'columns', { value: 40, configurable: true });
      for (const key of ['\u001b[H', '\u001b[A', '\u001b[A', '\u001b[F']) {
        app.stdin.write(key);
        await tick();
      }
      app.stdin.write('X');
      await tick();
      app.stdin.write('\r');
      await tick();
      expect(f.answers).toHaveLength(1);
      expect(f.answers[0]!.answer).toEqual({
        kind: 'question',
        answers: `${text.slice(0, boundary)}X${text.slice(boundary)}`,
      });
    } finally {
      app.unmount();
      app.cleanup();
      f.controller.dispose();
    }
  }
});

test('drafts stay with card and revision, session switch preserves original draft', async () => {
  const schema = { type: 'string' };
  const f = fixture(schema);
  f.cards([question(schema), question(schema, 'other')]);
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  await tick();
  app.stdin.write('first draft');
  await tick();
  app.stdin.write('\u0002');
  await tick();
  app.stdin.write('\u001b[B');
  await tick();
  app.stdin.write('\r');
  await tick();
  app.stdin.write('second draft');
  await tick();
  app.stdin.write('\u0002');
  await tick();
  app.stdin.write('\u001b[A');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(app.lastFrame()).toContain('first draft');
  await f.controller.select('b');
  await tick();
  await f.controller.select('a');
  await tick();
  expect(app.lastFrame()).toContain('first draft');
  f.cards([question(schema, 'q', '2'), question(schema, 'other')]);
  await f.controller.select('a');
  await tick();
  expect(app.lastFrame()).not.toContain('first draft');
  app.stdin.write('\r');
  await tick();
  expect(f.answers).toHaveLength(0);
  app.unmount();
});

test('unknown answer freezes original request and Ctrl+L only queries original command', async () => {
  const f = fixture({ enum: ['wire-id'] });
  f.unknown();
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  await tick();
  app.stdin.write('\u001b[B');
  await tick();
  app.stdin.write('\r');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers).toHaveLength(1);
  await f.controller.select('b');
  await tick();
  app.stdin.write('\u000c');
  await tick();
  expect(f.reads).toEqual(['answer-1']);
  expect(f.answers).toHaveLength(1);
  app.unmount();
});

test('closed enum never offers custom; explicit anyOf string union allows original text', async () => {
  const f = fixture({ anyOf: [{ const: 'wire-id', title: 'Named option' }, { type: 'string' }] });
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  await tick();
  app.stdin.write('unselected text');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers).toHaveLength(0);
  app.stdin.write('\u001b[B');
  await tick();
  app.stdin.write('\u001b[B');
  await tick();
  app.stdin.write('  custom 原文  ');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers[0]!.answer).toEqual({ kind: 'question', answers: '  custom 原文  ' });
  app.unmount();
});

test('closed text-object custom answers keep option-like text distinct from an original option ID', async () => {
  const f = fixture({
    type: 'object',
    additionalProperties: false,
    required: ['q1', 'q2'],
    properties: {
      q1: {
        title: '原问题一',
        anyOf: [
          { const: 'q1-o1', title: '原选项一', description: '保留原说明' },
          { const: 'q1-o2', title: '原选项二' },
          {
            type: 'object',
            properties: { text: { type: 'string', minLength: 1, pattern: '\\S' } },
            required: ['text'],
            additionalProperties: false,
          },
        ],
      },
      q2: {
        title: '原问题二',
        anyOf: [
          { const: 'q2-o1', title: '原选项三' },
          {
            type: 'object',
            properties: { text: { type: 'string', minLength: 1, maxLength: 30, pattern: '\\S' } },
            required: ['text'],
            additionalProperties: false,
          },
        ],
      },
    },
  });
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    expect(app.lastFrame()).toContain('原问题一');
    expect(app.lastFrame()).toContain('原选项一');
    expect(app.lastFrame()).toContain('保留原说明');
    expect(app.lastFrame()).toContain('Custom answer');
    expect(app.lastFrame()).not.toContain('original-schema JSON');
    app.stdin.write('\u001b[B');
    await tick();
    app.stdin.write('\r');
    await tick();
    expect(f.answers).toHaveLength(0);
    app.stdin.write('\u001b[B');
    await tick();
    app.stdin.write('\u001b[B');
    await tick();
    app.stdin.write('\r');
    await tick();
    expect(f.answers).toHaveLength(0);
    app.stdin.write('   ');
    await tick();
    app.stdin.write('\r');
    await tick();
    expect(f.answers).toHaveLength(0);
    app.stdin.write('  q2-o1 é 🧭  ');
    await tick();
    app.stdin.write('\r');
    await tick();
    expect(f.answers).toHaveLength(1);
    expect(f.answers[0]!.answer).toEqual({
      kind: 'question',
      answers: { q1: 'q1-o1', q2: { text: '     q2-o1 é 🧭  ' } },
    });
  } finally {
    app.unmount();
  }
});

test('text-object presentation only accepts one required own string field and closed validation', () => {
  const custom = {
    type: 'object',
    properties: { text: { type: 'string', minLength: 1 } },
    required: ['text'],
    additionalProperties: false,
  };
  for (const branch of [
    { ...custom, additionalProperties: true },
    { ...custom, required: [] },
    { ...custom, required: ['text', 'text'] },
    { ...custom, properties: { text: { type: 'string' }, extra: { type: 'string' } } },
    { ...custom, properties: { text: { type: 'string', pattern: 'unhandled' } } },
    { ...custom, properties: { text: { type: 'object' } } },
    {
      ...custom,
      properties: JSON.parse('{"__proto__":{"type":"string"}}'),
      required: ['__proto__'],
    },
  ])
    expect(questionForm({ schema: { anyOf: [{ const: 'original-id' }, branch] } })).toBeUndefined();
  expect(
    questionForm({ schema: { type: 'string', anyOf: [{ const: 'original-id' }, custom] } }),
  ).toBeUndefined();
  expect(questionForm({ schema: { anyOf: [custom, custom] } })).toBeUndefined();
  expect(questionForm({ schema: { type: 'string', pattern: '\\S' } })).toBeDefined();
  expect(questionForm({ schema: { type: 'string', pattern: '\\S', const: '  ' } })).toBeUndefined();
});

test('unsupported schema retains explicit original-schema JSON input', async () => {
  const f = fixture({ type: 'array', items: { type: 'string' } });
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  await tick();
  expect(app.lastFrame()).toContain('original-schema JSON');
  app.stdin.write('["exact"]');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers[0]!.answer).toEqual({ kind: 'question', answers: ['exact'] });
  app.unmount();
});

test('complex JSON paste retains the complete Unicode value and submits only the original card', async () => {
  const f = fixture({ type: 'array', items: { type: 'string' } });
  const original = Array.from({ length: 30 }, (_, i) => `  原文 ${i} / @ café é 🧭  `);
  const raw = JSON.stringify(original, null, 2);
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers).toHaveLength(0);
  app.stdin.write(`\u001b[200~${raw}\u001b[201~`);
  await tick();
  expect(app.lastFrame()).toContain(`[Pasted ${Array.from(raw).length} characters]`);
  expect(f.answers).toHaveLength(0);
  app.stdin.write('\r');
  await tick();
  expect(f.answers).toEqual([
    {
      expectedStoreId: 'store',
      expectedRevision: '1',
      commandId: 'answer-1',
      answer: { kind: 'question', answers: original },
    },
  ]);
  expect(f.commandCount()).toBe(1);
  app.unmount();
});

test('complex JSON supports newline and grapheme cursor editing without an intermediate Answer', async () => {
  const f = fixture({ type: 'array', items: { type: 'string' } });
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  await tick();
  for (const key of ['[', '\u001b[13;2u', '"🧭"]', '\u001b[D', '\u001b[D', '\u007f', '原文']) {
    app.stdin.write(key);
    await tick();
  }
  expect(f.answers).toHaveLength(0);
  expect(app.lastFrame()).toContain('原文');
  expect(app.lastFrame()).not.toContain('🧭');
  app.stdin.write('\r');
  await tick();
  expect(f.answers[0]?.answer).toEqual({ kind: 'question', answers: ['原文'] });
  app.unmount();
});

test('complex JSON drafts retain original card/session scope and a new revision starts empty', async () => {
  const schema = { type: 'array', items: { type: 'string' } };
  const f = fixture(schema);
  f.cards([question(schema), question(schema, 'other')]);
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  await tick();
  for (const key of [
    '["first original"]',
    '\u0002',
    '\u001b[B',
    '\r',
    '["second original"]',
    '\u0002',
    '\u001b[A',
    '\r',
  ]) {
    app.stdin.write(key);
    await tick();
  }
  expect(app.lastFrame()).toContain('first original');
  await f.controller.select('b');
  await tick();
  await f.controller.select('a');
  await tick();
  expect(app.lastFrame()).toContain('first original');
  f.cards([question(schema, 'q', '2'), question(schema, 'other')]);
  await f.controller.select('a');
  await tick();
  expect(app.lastFrame()).not.toContain('first original');
  app.stdin.write('\r');
  await tick();
  expect(f.answers).toHaveLength(0);
  app.stdin.write('["fresh original"]');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers[0]?.expectedRevision).toBe('2');
  expect(f.answers[0]?.answer).toEqual({ kind: 'question', answers: ['fresh original'] });
  app.unmount();
});

test('required original attachment blocks question Answer until original verified reader finishes', async () => {
  const f = fixture({ enum: ['wire-id'] });
  const card = question({ enum: ['wire-id'] });
  card.request = {
    schema: { enum: ['wire-id'] },
    policy: {
      review: {
        kind: 'artifact',
        complete: true,
        reference: {
          id: 'body-q',
          mediaType: 'text/plain',
          size: '5',
          scope: { kind: 'execution', id: 'effect-q' },
        },
      },
    },
  };
  let release!: (body: string) => void;
  f.port.readAttachment = async () =>
    new Promise<string>((resolve) => {
      release = resolve;
    });
  f.cards([card]);
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  await tick();
  app.stdin.write('\u001b[B');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers).toHaveLength(0);
  app.stdin.write('\u0001');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers).toHaveLength(0);
  release('proof');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers).toHaveLength(1);
  app.unmount();
});

test('question editing while observation is stale retains original text and emits zero Answer', async () => {
  const f = fixture({ type: 'string' });
  await f.controller.select('a');
  f.controller.observationUnavailable('lost original SSE');
  const app = render(<TuiSession controller={f.controller} />);
  await tick();
  app.stdin.write('original pending draft');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers).toHaveLength(0);
  expect(app.lastFrame()).toContain('original pending draft');
  app.unmount();
});

test('schema presentation conservatively retains unsupported validators and overlapping oneOf as JSON', () => {
  for (const schema of [
    { type: 'string', pattern: 'complex' },
    { type: 'object', properties: { nested: { type: 'object' } } },
    { oneOf: [{ const: 'overlap' }, { type: 'string' }] },
    { type: 'number', enum: ['wrong type'] },
    { type: 'object', properties: { choice: { type: 'string' } }, required: ['missing'] },
    { type: 'string', const: 'one', enum: ['two'] },
  ])
    expect(questionForm({ schema })).toBeUndefined();
});

test('optional object field needs an explicit skip and preserves exact scalar null choice', async () => {
  const f = fixture({
    type: 'object',
    required: ['fixed'],
    properties: { optional: { type: 'string' }, fixed: { const: null, title: 'No value' } },
  });
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(app.lastFrame()).toContain('Question 1/2');
  app.stdin.write('\t');
  await tick();
  app.stdin.write('\r');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers).toHaveLength(0);
  app.stdin.write('\u001b[B');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers[0]!.answer).toEqual({ kind: 'question', answers: { fixed: null } });
  app.unmount();
});

test('existing Workflow decision and bounded detail schema is a wizard with local empty answer feedback', async () => {
  const f = fixture({
    type: 'object',
    additionalProperties: false,
    required: ['decision', 'detail'],
    properties: {
      decision: { type: 'string', enum: ['replan', 'waive', 'compensate'] },
      detail: { type: 'string', minLength: 1 },
    },
  });
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  await tick();
  expect(app.lastFrame()).not.toContain('Question: original-schema JSON');
  app.stdin.write('\u001b[B');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(app.lastFrame()).toContain('Answer needs at least 1 characters (0 entered).');
  app.stdin.write('\r');
  await tick();
  expect(f.answers).toHaveLength(0);
  app.stdin.write(' 原原因 ');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers[0]!.answer).toEqual({
    kind: 'question',
    answers: { decision: 'replan', detail: ' 原原因 ' },
  });
  app.unmount();
});

test('string bounds count emoji and combining Unicode codepoints and never truncate overlong answers', async () => {
  const f = fixture({ type: 'string', minLength: 2, maxLength: 2 });
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  await tick();
  app.stdin.write('😀');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers).toHaveLength(0);
  expect(app.lastFrame()).toContain('(1 entered)');
  app.stdin.write('é');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers).toHaveLength(0);
  expect(app.lastFrame()).toContain('at most 2 characters (3 entered)');
  app.stdin.write('\u001b[D');
  await tick();
  app.stdin.write('\u007f');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers[0]!.answer).toEqual({ kind: 'question', answers: 'é' });
  app.unmount();
});

test('ambiguous and nested choices, malformed enums, incompatible type and length branches remain explicit JSON', () => {
  for (const schema of [
    { oneOf: [{ const: 'same' }, { enum: ['same', 'other'] }] },
    { anyOf: [{ const: 'same' }, { const: 'same' }] },
    { oneOf: [{ anyOf: [{ const: 'a' }, { const: 'b' }] }, { const: 'c' }] },
    { enum: ['same', 'same'] },
    { type: 'string', enum: [] },
    { type: 'string', enum: false },
    { anyOf: [{ const: 'a' }, { type: 'string', minLength: 2 }] },
    { type: 'number', oneOf: [{ const: 'text' }, { const: 2 }] },
    { type: 'string', const: 'a', minLength: 2 },
    { enum: ['a', 'bb'], maxLength: 1 },
    { oneOf: [{ const: 'a' }, { const: 'bb' }], maxLength: 1 },
    { type: 'string', minLength: -1 },
    { type: 'string', maxLength: 1.5 },
    { type: 'string', minLength: 3, maxLength: 1 },
    { $schema: 'unaccepted', type: 'string' },
  ])
    expect(questionForm({ schema })).toBeUndefined();
});

test('required prototype keys must be actual own properties, while declared own keys remain valid', () => {
  for (const key of ['toString', 'constructor']) {
    expect(
      questionForm({
        schema: { type: 'object', properties: { choice: { type: 'string' } }, required: [key] },
      }),
    ).toBeUndefined();
    const form = questionForm({
      schema: { type: 'object', properties: { [key]: { type: 'string' } }, required: [key] },
    });
    expect(form?.fields).toHaveLength(1);
    expect(form?.fields[0]?.key).toBe(key);
    expect(form?.fields[0]?.required).toBe(true);
  }
});

test('Core unsupported own __proto__ property and required key stay in explicit JSON fallback', () => {
  expect(
    questionForm({ schema: { type: 'object', properties: { ['__proto__']: { type: 'string' } } } }),
  ).toBeUndefined();
  expect(
    questionForm({
      schema: {
        type: 'object',
        properties: { choice: { type: 'string' } },
        required: ['__proto__'],
      },
    }),
  ).toBeUndefined();
});

test('question language refresh translates owned labels and length hints while preserving original body and exact Answer', async () => {
  const f = fixture({
    type: 'object',
    required: ['detail'],
    properties: {
      route: {
        title: 'Question',
        anyOf: [
          {
            const: 'wire-id',
            title: 'Custom answer',
            description: 'No selection (Enter has no answer)',
          },
          { type: 'string' },
        ],
      },
      detail: {
        type: 'string',
        title: 'Answer',
        description: 'Custom answer',
        minLength: 2,
        maxLength: 6,
      },
    },
  });
  let language: 'en-US' | 'zh-CN' = 'en-US';
  f.port.preferences = {
    read: async (): Promise<TuiPreferences> => ({
      revision: 'a'.repeat(64),
      language,
      resolvedLanguage: language,
      colorPreset: 'teal',
      theme: 'dark',
    }),
    save: async () => {
      throw Error('unexpected preference write');
    },
  };
  const read = f.port.readSession;
  f.port.readSession = async (id, signal) => ({
    ...(await read(id, signal)),
    messages: [
      {
        id: 'model-original',
        sessionId: id,
        runId: null,
        seq: '1',
        status: 'complete',
        role: 'assistant',
        content: 'Question Answer Custom answer EXACT_MODEL_BODY',
      },
    ],
  });
  await f.controller.refreshPreferences();
  await f.controller.select('a');
  const app = render(<TuiSession controller={f.controller} />);
  await tick();
  expect(app.lastFrame()).toContain('Question 1/2: Question');
  expect(app.lastFrame()).toContain('Tab: skip optional answer');
  language = 'zh-CN';
  await f.controller.refreshPreferences();
  await tick();
  expect(app.lastFrame()).toContain('问题 1/2: Question');
  expect(app.lastFrame()).toContain('自定义回答');
  expect(app.lastFrame()).toContain('Tab：跳过可选回答');
  expect(app.lastFrame()).toContain('尚未选择（Enter 不提交回答）');
  expect(app.lastFrame()).toContain('选择:');
  expect(app.lastFrame()).toContain('Custom answer');
  expect(app.lastFrame()).toContain('No selection (Enter has no answer)');
  expect(app.lastFrame()).toContain('Question Answer Custom answer EXACT_MODEL_BODY');
  expect(app.lastFrame()).toContain('问题：选择或输入上方原 schema 的回答');
  expect(f.answers).toHaveLength(0);
  expect(f.commandCount()).toBe(0);
  app.stdin.write('\u001b[B');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(app.lastFrame()).toContain('问题 2/2: Answer');
  expect(app.lastFrame()).toContain('回答至少需要 2 个字符 (0 已输入)');
  language = 'en-US';
  await f.controller.refreshPreferences();
  await tick();
  expect(app.lastFrame()).toContain('Answer needs at least 2 characters (0 entered)');
  expect(f.answers).toHaveLength(0);
  expect(f.commandCount()).toBe(0);
  app.stdin.write('Answer!');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(app.lastFrame()).toContain('Answer allows at most 6 characters (7 entered)');
  expect(f.answers).toHaveLength(0);
  language = 'zh-CN';
  await f.controller.refreshPreferences();
  await tick();
  expect(app.lastFrame()).toContain('回答最多允许 6 个字符 (7 已输入)');
  expect(app.lastFrame()).toContain('Answer!');
  app.stdin.write('\u007f');
  await tick();
  app.stdin.write('\r');
  await tick();
  expect(f.answers[0]!.answer).toEqual({
    kind: 'question',
    answers: { route: 'wire-id', detail: 'Answer' },
  });
  expect(f.commandCount()).toBe(1);
  app.unmount();
});

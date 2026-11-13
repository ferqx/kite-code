import { type ToolResultPresentation, toolResultPresentationSchema } from '@kite-ai/trajectory';
import { expect, test } from '#kite-test';
import { canonicalJson } from '../../../src/json';
import { mcpToolResultContent } from '../../../src/mcp/result-feedback';
import type { Json } from '../../../src/storage/types';
import { toolResultEvidence } from '../../../src/trajectory/evidence-projection';
import { toolResultPresentation } from '../../../src/trajectory/tool-result-presentation';

test('only the frozen builtin definition can project File data and private sibling fields never enter a typed result', () => {
  const input = {
    definitionId: 'files.read',
    definitionVersion: '5',
    extensionId: 'builtin.files',
    executionId: 'read',
    input: { path: 'relative.txt' },
    result: {
      outcome: 'succeeded',
      content: JSON.stringify({
        path: '/canonical/relative.txt',
        executionId: 'read',
        content: 'original',
        private: 'NO',
      }),
      details: { diagnostic: 'NO', source: { token: 'NO' } },
      presentation: { kind: 'browser', text: 'FORGED' },
    },
  };
  expect(toolResultPresentation(input)).toEqual({
    kind: 'file',
    operation: 'read',
    path: '/canonical/relative.txt',
    text: 'original',
  });
  expect(toolResultPresentation({ ...input, definitionVersion: '6' })).toBeUndefined();
  expect(toolResultPresentation({ ...input, extensionId: 'untrusted' })).toBeUndefined();
  expect(toolResultPresentation({ ...input, executionId: 'other' })).toBeUndefined();
  expect(toolResultEvidence(input.result)).not.toHaveProperty('presentation');
  expect(
    toolResultPresentationSchema.safeParse({ kind: 'file', operation: 'read', private: 'NO' })
      .success,
  ).toBe(false);
});

test('Shell acceptance, wait timeout, partial output and gaps remain original observations', () => {
  const details = {
    accepted: true,
    timedOut: true,
    cancelRequested: false,
    truncated: true,
    next_cursor: 'saved-cursor',
    caught_up: false,
    terminal: false,
    private: 'NO',
    ref: { extensionId: 'builtin.shell', executionId: 'job', key: 'shell-handle' },
    execution: { id: 'job', status: 'running', authorization: { SECRET: 'NO' } },
    output: {
      items: [
        { seq: '3', throughSeq: '5', stream: 'gap', content: '', droppedBytes: '8', private: 'NO' },
      ],
    },
  };
  const input = {
    definitionId: 'shell.wait',
    definitionVersion: '1',
    extensionId: 'builtin.shell',
    executionId: 'wait',
    input: { shellId: 'shell-handle' },
    result: { outcome: 'succeeded', content: canonicalJson(details), details },
  };
  expect(toolResultPresentation(input)).toEqual({
    kind: 'shell',
    operation: 'wait',
    executionId: 'job',
    shellId: 'shell-handle',
    status: 'running',
    accepted: true,
    timedOut: true,
    cancelRequested: false,
    truncated: true,
    nextCursor: 'saved-cursor',
    caughtUp: false,
    terminal: false,
    output: [
      { sequence: '3', throughSequence: '5', stream: 'gap', content: '', droppedBytes: '8' },
    ],
  });
  expect(JSON.stringify(toolResultPresentation(input))).not.toContain('NO');
  expect(
    toolResultPresentation({ ...input, result: { ...input.result, content: 'different receipt' } }),
  ).toBeUndefined();
});

test('verified MCP content fields are public data while credentials, transport and invalid receipts keep fallback', () => {
  const publicResult = {
    content: [{ type: 'text', text: 'remote data' }],
    isError: true,
    structuredContent: { answer: 'original' },
  };
  const input = {
    definitionId: `mcp.server.${'a'.repeat(32)}`,
    definitionVersion: 'b'.repeat(64),
    extensionId: 'builtin.mcp.remote.server',
    executionId: 'remote',
    input: {},
    result: {
      outcome: 'failed',
      content: mcpToolResultContent(publicResult),
      details: { ...publicResult, credentials: 'NO', transport: 'NO' },
    },
  };
  expect(toolResultPresentation(input)).toEqual({
    kind: 'mcp',
    isError: true,
    text: ['remote data'],
    structuredContent: { answer: 'original' },
  });
  expect(
    toolResultPresentation({
      ...input,
      result: { ...input.result, content: 'not the verified response' },
    }),
  ).toBeUndefined();
  expect(toolResultPresentation({ ...input, definitionVersion: 'unknown' })).toBeUndefined();
  expect(
    toolResultPresentation({ ...input, extensionId: 'builtin.mcp.remote.other' }),
  ).toBeUndefined();
});

test('original plan body and steps and Browser interpreter text have explicit public projections', () => {
  const plan = toolResultPresentation({
    definitionId: 'planning.read',
    definitionVersion: '1',
    extensionId: 'builtin.planning',
    executionId: 'plan-read',
    input: {},
    result: {
      outcome: 'succeeded',
      content: 'original receipt',
      details: {
        plan: {
          planId: 'p',
          version: 2,
          title: 'Original plan',
          body: 'Original public plan',
          steps: [{ id: 'one', title: 'Original step', status: 'completed', private: 'NO' }],
        },
        source: 'NO',
      },
    },
  });
  expect(plan).toEqual({
    kind: 'plan',
    operation: 'read',
    planId: 'p',
    version: 2,
    title: 'Original plan',
    text: 'Original public plan',
    steps: [{ id: 'one', title: 'Original step', status: 'completed' }],
  });
  const details = {
    value: { snapshot: 'Arbitrary returned JSON is not an authoritative observation' },
    output: 'Original console output',
    operations: [],
  };
  const browser = toolResultPresentation({
    definitionId: 'browser.execute',
    definitionVersion: '1',
    extensionId: 'builtin.browser',
    executionId: 'browser-code',
    input: { code: 'original' },
    result: {
      outcome: 'succeeded',
      content: JSON.stringify({ ...details, private: 'NO' }),
      details,
    },
  });
  expect(browser).toEqual({
    kind: 'browser',
    operation: 'execute',
    text: 'Original console output',
  });
});

test('typed web, task, browser, plan, worktree, skill and question receipts do not promote internal detail trees', () => {
  const common = {
    definitionVersion: '1',
    executionId: 'e',
    input: {},
    result: { outcome: 'succeeded', content: 'public', details: {} },
  };
  const cases: {
    definitionId: string;
    extensionId: string;
    details: Json;
    expected: ToolResultPresentation['kind'];
  }[] = [
    {
      definitionId: 'web_fetch',
      extensionId: 'builtin.web',
      details: { executionId: 'e', title: 'Title', characters: 10 },
      expected: 'web',
    },
    {
      definitionId: 'task.spawn',
      extensionId: 'builtin.task',
      details: {
        accepted: true,
        agent_id: 'child',
        state: 'queued',
        diagnostic: { private: 'NO' },
      },
      expected: 'task',
    },
    {
      definitionId: 'browser.snapshot',
      extensionId: 'builtin.browser',
      details: {
        url: 'https://example.test',
        snapshot: 'original page',
        elements: [{ ref: 'PRIVATE_REF', role: 'button', name: 'Go' }],
      },
      expected: 'browser',
    },
    {
      definitionId: 'planning.write',
      extensionId: 'builtin.planning',
      details: { planId: 'p', version: 2, source: { private: 'NO' } },
      expected: 'plan',
    },
    {
      definitionId: 'git.worktree',
      extensionId: 'builtin.shell',
      details: {
        action: 'create',
        path: '/saved',
        mutation: 'created',
        cwdChanged: false,
        authorization: { private: 'NO' },
      },
      expected: 'worktree',
    },
    {
      definitionId: 'skills.load',
      extensionId: 'builtin.skills',
      details: { version: 'original-version', source: { private: 'NO' } },
      expected: 'skill',
    },
  ];
  for (const item of cases) {
    const result = {
      ...common.result,
      details: item.details,
      content: item.expected === 'skill' ? 'recorded skill body' : canonicalJson(item.details),
    };
    const view = toolResultPresentation({ ...common, ...item, result });
    expect(view?.kind).toBe(item.expected);
    expect(JSON.stringify(view)).not.toContain('NO');
    expect(JSON.stringify(view)).not.toContain('PRIVATE_REF');
  }
  expect(
    toolResultPresentation({
      ...common,
      definitionId: 'ask_user',
      extensionId: 'builtin.ask-user',
      input: { questions: [{ id: 'q', question: 'Which?' }] },
      result: {
        outcome: 'succeeded',
        content: 'answer',
        details: { answers: { q: 'Original choice' }, source: 'NO' },
      },
    }),
  ).toEqual({ kind: 'question', answers: [{ question: 'Which?', answer: 'Original choice' }] });
});

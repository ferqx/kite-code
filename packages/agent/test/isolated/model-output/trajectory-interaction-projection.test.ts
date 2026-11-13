import { expect, test } from '#kite-test';
import type { Json, ToolContext } from '../../../src/extensions';
import { createAskUserExtension } from '../../../src/tools/ask-user';
import { interactionEvidence } from '../../../src/trajectory/evidence-projection';

test('actual ask_user request schema retains only original public questions and const choice identities', async () => {
  let request: Json | undefined;
  await createAskUserExtension().tools![0]!.execute(
    {
      questions: [
        {
          question: '选择实现方式？',
          options: [
            { label: '方案甲', description: '甲说明' },
            { label: '方案乙', description: '乙说明' },
          ],
        },
        {
          question: '另一个决定？',
          options: [
            { label: '保留', description: '保留说明' },
            { label: '调整', description: '调整说明' },
          ],
        },
      ],
    },
    {
      requestInput: async (value: Json) => {
        request = value;
        return { q1: 'q1-o2', q2: { text: ' 原文\n自由回答 ' } };
      },
    } as unknown as ToolContext,
  );
  expect(request).toBeDefined();
  const saved: Json = {
    kind: 'question',
    request: request!,
    answer: { kind: 'question', answers: { q1: 'q1-o2', q2: { text: ' 原文\n自由回答 ' } } },
    source: { privateProof: 'PRIVATE_SOURCE' },
  };
  const before = structuredClone(saved);
  const result = interactionEvidence(saved) as {
    request: { questions: unknown[] };
    answer: unknown;
  };
  expect(result.request.questions).toEqual([
    {
      id: 'q1',
      question: '选择实现方式？',
      options: [
        { id: 'q1-o1', label: '方案甲 (Recommended)', description: '甲说明' },
        { id: 'q1-o2', label: '方案乙', description: '乙说明' },
      ],
    },
    {
      id: 'q2',
      question: '另一个决定？',
      options: [
        { id: 'q2-o1', label: '保留 (Recommended)', description: '保留说明' },
        { id: 'q2-o2', label: '调整', description: '调整说明' },
      ],
    },
  ]);
  expect(result.answer).toEqual({
    kind: 'question',
    answers: { q1: 'q1-o2', q2: { text: ' 原文\n自由回答 ' } },
  });
  expect(JSON.stringify(result)).not.toContain('schema');
  expect(JSON.stringify(result)).not.toContain('PRIVATE_SOURCE');
  expect(saved).toEqual(before);
});

test('closed display projection removes nested proof and permission fields while preserving explicit question options', () => {
  const result = interactionEvidence({
    kind: 'question',
    request: {
      title: '原请求',
      source: 'PRIVATE',
      transport: 'PRIVATE',
      requiredRefs: ['PRIVATE'],
      questions: [
        {
          id: 'q',
          header: '原分组',
          question: '原问题',
          multiSelect: true,
          proof: 'PRIVATE',
          options: [
            {
              id: 'choice',
              label: '选项',
              description: '原说明',
              permission: 'PRIVATE',
              source: 'PRIVATE',
            },
          ],
        },
      ],
    },
    answer: {
      kind: 'question',
      answers: { q: [], zero: 0, flag: false },
      proof: 'PRIVATE',
      permissions: 'PRIVATE',
    },
  });
  expect(result).toMatchObject({
    request: {
      title: '原请求',
      questions: [
        {
          id: 'q',
          header: '原分组',
          question: '原问题',
          multiSelect: true,
          options: [{ id: 'choice', label: '选项', description: '原说明' }],
        },
      ],
    },
    answer: { kind: 'question', answers: { q: [], zero: 0, flag: false } },
  });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});

test('schema display projection never copies arbitrary schemas or guesses among object alternatives', () => {
  const result = interactionEvidence({
    request: {
      schema: {
        oneOf: [
          {
            type: 'object',
            properties: {
              a: {
                title: '甲问题',
                source: 'PRIVATE',
                anyOf: [{ const: 'a1', title: '甲选项', privateProof: 'PRIVATE' }],
              },
            },
          },
          { type: 'object', properties: { b: { title: '乙问题', permission: 'PRIVATE' } } },
        ],
      },
    },
    answer: { kind: 'question', answers: { a: 'a1' } },
  });
  expect(result).toMatchObject({ request: {}, answer: { answers: { a: 'a1' } } });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  const array = interactionEvidence({
    request: {
      schema: {
        type: 'object',
        properties: {
          q: {
            title: '多选',
            type: 'array',
            items: {
              anyOf: [{ const: 'a', title: '选项甲', description: '甲说明', proof: 'PRIVATE' }],
            },
          },
        },
      },
    },
    answer: null,
  });
  expect(array).toMatchObject({
    request: {
      questions: [
        {
          id: 'q',
          question: '多选',
          multiSelect: true,
          options: [{ id: 'a', label: '选项甲', description: '甲说明' }],
        },
      ],
    },
  });
  expect(JSON.stringify(array)).not.toContain('PRIVATE');
});

test('approval option presentation and decisions remain public without grant authority and null answers do not acquire cancellation', () => {
  const result = interactionEvidence({
    kind: 'approval',
    request: {
      policy: 'PRIVATE',
      input: 'PRIVATE',
      options: [
        {
          optionId: 'once',
          kind: 'once',
          presentation: { label: '仅此次', details: ['原说明'] },
          grant: 'PRIVATE',
          scope: 'PRIVATE',
        },
      ],
    },
    answer: {
      kind: 'approval',
      decision: 'approve',
      optionId: 'once',
      feedback: '原反馈',
      authorization: 'PRIVATE',
    },
  });
  expect(result).toMatchObject({
    request: { options: [{ id: 'once', label: '仅此次', description: '原说明' }] },
    answer: { kind: 'approval', decision: 'approve', optionId: 'once', feedback: '原反馈' },
  });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  const cancelledInformation = interactionEvidence({
    request: {},
    answer: { kind: 'question', answers: null },
  });
  expect(cancelledInformation).toMatchObject({ answer: { kind: 'question', answers: null } });
  expect(JSON.stringify(cancelledInformation)).not.toContain('cancel');
});

test('original pending shell.execute approval exposes only its exact command, directory, scopes and public options', () => {
  const saved: Json = {
    kind: 'approval',
    request: {
      definitionId: 'shell.execute',
      definitionVersion: '1',
      input: {
        command: "printf 'original approval\\n'",
        workdir: 'workspace/subdir',
        filesystem: 'workspace_write',
        network: 'none',
        env: { TOKEN: 'PRIVATE_CREDENTIAL' },
        credentials: 'PRIVATE_CREDENTIAL',
        arbitrary: 'PRIVATE_ARGUMENT',
      },
      options: [
        {
          optionId: 'once',
          kind: 'once',
          presentation: { label: '仅此次', details: ['只适用于原操作'] },
          scope: 'PRIVATE_SCOPE',
        },
      ],
      policy: 'PRIVATE_POLICY',
      proof: 'PRIVATE_PROOF',
    },
    answer: null,
  };
  const before = structuredClone(saved);
  const result = interactionEvidence(saved);
  expect(result).toMatchObject({
    request: {
      action: {
        kind: 'shell',
        command: "printf 'original approval\\n'",
        workdir: 'workspace/subdir',
        filesystem: 'workspace_write',
        network: 'none',
      },
      options: [{ id: 'once', label: '仅此次', description: '只适用于原操作' }],
    },
    answer: null,
  });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  expect(result).not.toHaveProperty('request.input');
  expect(saved).toEqual(before);
});

test('approval action requires original exact shell definition and version and never copies unknown scopes', () => {
  for (const [kind, definitionId, definitionVersion] of [
    ['question', 'shell.execute', '1'],
    ['approval', 'custom.shell', '1'],
    ['approval', 'shell.execute', '2'],
    ['approval', 'shell.launch', '1'],
  ])
    expect(
      interactionEvidence({
        kind: kind!,
        request: {
          definitionId: definitionId!,
          definitionVersion: definitionVersion!,
          input: { command: 'PRIVATE_UNKNOWN_COMMAND' },
        },
      }),
    ).not.toHaveProperty('request.action');
  const result = interactionEvidence({
    kind: 'approval',
    request: {
      definitionId: 'shell.execute',
      definitionVersion: '1',
      input: { command: 'printf ok', filesystem: 'PRIVATE_SCOPE', network: 'PRIVATE_SCOPE' },
    },
  });
  expect(result).toMatchObject({ request: { action: { kind: 'shell', command: 'printf ok' } } });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_SCOPE');
});

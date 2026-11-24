import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { type ModelAdapter, ModelAttemptError, type ModelRequest } from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { createWorkspaceAssembly } from '../../src/assembly';

test('ordered Skill reads after reconnect survive source changes while a stale file write stays undispatched', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-skill-read-')));
  const workspace = join(root, 'workspace');
  const guide = join(workspace, 'guide');
  const manual = join(workspace, 'manual');
  for (const path of [guide, manual]) mkdirSync(path, { recursive: true });
  const instructions = join(workspace, 'AGENTS.md');
  const manualFile = join(manual, 'SKILL.md');
  const manualHeader = '---\nname: Manual\ndescription: A manual\n---\n';
  writeFileSync(instructions, 'Original project rule.');
  writeFileSync(manualFile, `${manualHeader}Original manual.`);
  writeFileSync(
    join(guide, 'SKILL.md'),
    '---\nname: Guide\ndescription: A guide\n---\n[Note](note.txt)\n',
  );
  writeFileSync(join(guide, 'note.txt'), 'Declared guide note.');
  writeFileSync(join(manual, 'private.txt'), 'Undeclared data.');
  writeFileSync(join(workspace, 'data.txt'), 'Independent ordinary file.');

  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  const store = await openSqliteStore(profile);
  const scope = {
    expectedStoreId: (await store.getMetadata()).storeId,
    sessionId: 's',
    subjectId: 'owner',
  };
  const requests: ModelRequest[] = [];
  const receiptReads: { afterSeq?: string; upperSeq?: string; count: number }[] = [];
  const noteAtCommit = Promise.withResolvers<void>();
  const ordinaryReadCommitted = Promise.withResolvers<void>();
  const rulesUpdated = Promise.withResolvers<void>();
  const model: ModelAdapter = {
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) throw new ModelAttemptError('connection_failed');
      if (requests.length === 2) {
        for (const [id, name, input] of [
          ['note', 'read_skill_resource', { skill_id: 'guide', path: 'note.txt' }],
          ['ordinary', 'read_file', { path: 'data.txt' }],
          ['manual', 'load_skill', { skill_id: 'manual' }],
          ['undeclared', 'read_skill_resource', { skill_id: 'manual', path: 'private.txt' }],
          ['write', 'write_file', { path: 'old.txt', content: 'Stale write.' }],
        ] as const)
          yield { type: 'tool_call', id, name, arguments: JSON.stringify(input) };
        yield { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 5, outputTokens: 3 } };
      } else {
        yield { type: 'text_delta', text: 'Finished.' };
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 5, outputTokens: 3 } };
      }
    },
  };
  const intercepted = new Proxy(store, {
    get(target, key) {
      if (key === 'readRunSkillReceipts')
        return async (input: Parameters<typeof store.readRunSkillReceipts>[0]) => {
          const receipts = await store.readRunSkillReceipts(input);
          receiptReads.push({
            afterSeq: input.afterSeq,
            upperSeq: input.upperSeq,
            count: receipts.length,
          });
          return receipts;
        };
      if (key === 'finishExecution')
        return async (input: Parameters<typeof store.finishExecution>[0]) => {
          const planned = await store.getExecution(input.executionId);
          if (planned?.callId === 'note' && input.status === 'succeeded') {
            const run = (await store.getRun(planned.runId!))!;
            expect(
              await store.readRunSkillReceipts({
                ...scope,
                runId: run.id,
                selectionId: run.contextSelectionId,
              }),
            ).toEqual([]);
            noteAtCommit.resolve();
            await ordinaryReadCommitted.promise;
          }
          const result = await store.finishExecution(input);
          const execution = await store.getExecution(input.executionId);
          if (execution?.callId === 'ordinary') ordinaryReadCommitted.resolve();
          if (execution?.callId === 'note' && execution.status === 'succeeded') {
            writeFileSync(instructions, 'Current project rule.');
            writeFileSync(manualFile, `${manualHeader}Current manual.`);
            rulesUpdated.resolve();
          }
          return result;
        };
      return Reflect.get(target, key);
    },
  });
  const permissions = {
    toolDispatchOrder: 'model' as const,
    async authorize(request: { definitionId: string; signal: AbortSignal }) {
      if (request.definitionId === 'files.read') await noteAtCommit.promise;
      if (request.definitionId === 'skills.load') await rulesUpdated.promise;
      request.signal.throwIfAborted();
      return { allowed: true, revision: 'owned' };
    },
  };
  const runtime = createRuntime({
    store: intercepted,
    artifacts: createArtifactStore({ profile, store: intercepted }),
    permissions,
    async resolveRunConfiguration() {
      const assembly = await createWorkspaceAssembly({
        workspaceRoot: workspace,
        profile,
        skills: [
          { id: 'guide', path: guide },
          { id: 'manual', path: manual },
        ],
        toolIds: ['skills.load', 'skills.resource', 'files.read', 'files.write'],
      });
      return { ...assembly, permissions, model, modelId: 'fixture', snapshot: {} };
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: scope.expectedStoreId,
      id: 'w',
      name: 'Workspace',
      rootUri: pathToFileURL(workspace).href,
    });
    await runtime.createSession({
      ...scope,
      workspaceId: 'w',
      commandId: 'create',
      title: 'Skill',
    });
    await runtime.submitCommand({
      ...scope,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Read the guide note and the manual.' },
    });
    const work = await runtime.waitForCommand('work', { timeoutMs: 8000 });
    const run = await store.getRun((work.receipt as { runId: string }).runId);
    expect(run).toMatchObject({
      status: 'completed',
      configuration: { toolDispatchOrder: 'model' },
    });
    expect(requests).toHaveLength(3);
    const modelAttempt = await store.getExecution(requests[1]!.requestId);
    expect(modelAttempt).toMatchObject({
      status: 'succeeded',
      decisionSource: { retry: { previousExecutionId: requests[0]!.requestId } },
    });
    const tools = new Map(
      (await store.listExecutions('s'))
        .filter(({ kind }) => kind === 'tool')
        .map((e) => [e.callId, e]),
    );
    expect(tools.size).toBe(5);
    for (const id of ['note', 'ordinary', 'manual'])
      expect(tools.get(id)).toMatchObject({
        status: 'succeeded',
        stepId: modelAttempt!.stepId,
        decisionSource: { modelExecutionId: modelAttempt!.id },
        authorization: { dispatched: true },
      });
    expect(tools.get('undeclared')).toMatchObject({
      status: 'failed',
      authorization: { dispatched: true },
      result: { details: { code: 'skill_resource_not_declared' } },
    });
    expect(tools.get('write')).toMatchObject({
      status: 'failed',
      authorization: { dispatched: false },
      result: { details: { code: 'context_refresh_required', adapterAttempted: false } },
    });
    expect(existsSync(join(workspace, 'old.txt'))).toBe(false);
    const toolOutput = (id: string) =>
      requests[2]!.messages.find((message) => message.role === 'tool' && message.toolCallId === id)
        ?.content;
    expect(toolOutput('note')).toContain('Declared guide note.');
    expect(
      requests[2]!.messages.filter(({ sourceIds }) => sourceIds?.includes('skill.body:guide')),
    ).toHaveLength(1);
    expect(toolOutput('manual')).toContain('instructions for Skill manual are included above');
    expect(
      requests[2]!.messages.filter(({ content }) => content.includes('Current manual.')),
    ).toHaveLength(1);
    expect(JSON.stringify(requests[2]!.messages)).toContain('Current project rule.');
    expect(receiptReads).toEqual([
      { afterSeq: undefined, upperSeq: expect.any(String), count: 0 },
      { afterSeq: receiptReads[0]?.upperSeq, upperSeq: expect.any(String), count: 2 },
    ]);
  } finally {
    noteAtCommit.resolve();
    ordinaryReadCommitted.resolve();
    rulesUpdated.resolve();
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('consecutive checkpoints preserve original Skill read order without replaying DeepSeek tool calls', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-skill-context-')));
  const workspace = join(root, 'workspace');
  const skill = join(workspace, 'guide');
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, 'SKILL.md'),
    '---\nname: Guide\ndescription: A guide\n---\n[Note](note.txt)\n',
  );
  const resource = join(skill, 'note.txt');
  writeFileSync(resource, 'Original resource text.');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  const store = await openSqliteStore(profile);
  const scope = {
    expectedStoreId: (await store.getMetadata()).storeId,
    sessionId: 's',
    subjectId: 'owner',
  };
  const correction = 'Use the latest version of the note for your answer.';
  const captured: {
    messages: {
      role: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: unknown;
    }[];
  }[] = [];
  const load = { name: 'load_skill', arguments: '{"skill_id":"guide"}' };
  const read = {
    name: 'read_skill_resource',
    arguments: '{"skill_id":"guide","path":"note.txt"}',
  };
  const responses = [load, read, null, load, null, null];
  const modelId = 'fixture';
  const binding = createCompatibleModelBinding({
    name: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    modelId: 'deepseek-v4-flash',
    apiKey: 'fixture-key',
    fetch: Object.assign(
      async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const step = captured.length;
        captured.push(JSON.parse(String(init?.body)));
        const call = responses[step];
        const chunk = (delta: object, finish_reason: string | null = null) =>
          `data: ${JSON.stringify({
            id: 'local',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`;
        return new Response(
          chunk({ role: 'assistant', reasoning_content: `private reasoning ${step}` }) +
            (call
              ? chunk({
                  tool_calls: [{ index: 0, id: `call-${step}`, type: 'function', function: call }],
                })
              : chunk({ content: `Answer ${step}` })) +
            chunk({}, call ? 'tool_calls' : 'stop') +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const model = createSdkModelAdapter({ models: new Map([[modelId, binding]]) });
  const intercepted = new Proxy(store, {
    get(target, key) {
      if (key === 'finishExecution')
        return async (input: Parameters<typeof store.finishExecution>[0]) => {
          const result = await store.finishExecution(input);
          const execution = await store.getExecution(input.executionId);
          if (execution?.definitionId === 'skills.resource' && execution.status === 'succeeded') {
            writeFileSync(resource, 'Current resource text.');
            const run = (await store.getRun(execution.runId!))!;
            await runtime.submitCommand({
              ...scope,
              commandId: 'correction',
              request: {
                kind: 'input.steer',
                targetRunId: run.id,
                contextSelectionId: run.contextSelectionId,
                content: correction,
              },
            });
          }
          return result;
        };
      return Reflect.get(target, key);
    },
  });
  const permissions = { authorize: async () => ({ allowed: true, revision: 'owned' }) };
  const runtime: ReturnType<typeof createRuntime> = createRuntime({
    store: intercepted,
    artifacts: createArtifactStore({ profile, store: intercepted }),
    permissions,
    async resolveRunConfiguration() {
      const assembly = await createWorkspaceAssembly({
        workspaceRoot: workspace,
        profile,
        skills: [{ id: 'guide', path: skill }],
        toolIds: ['skills.load', 'skills.resource'],
      });
      return {
        ...assembly,
        permissions,
        model,
        modelId,
        snapshot: { fixture: 'skill-context' },
        compressor: {
          id: 'fixture',
          version: '1',
          shouldCompress: async () => captured.length === 2 || captured.length === 4,
          prepare: async () => ({ instructions: 'Write a short checkpoint.', snapshot: {} }),
        },
      };
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: scope.expectedStoreId,
      id: 'w',
      name: 'Workspace',
      rootUri: pathToFileURL(workspace).href,
    });
    await runtime.createSession({
      ...scope,
      workspaceId: 'w',
      commandId: 'create',
      title: 'Skill',
    });
    await runtime.submitCommand({
      ...scope,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Read the guide and its note.' },
    });
    const work = await runtime.waitForCommand('work', { timeoutMs: 8000 });
    const run = await store.getRun((work.receipt as { runId: string }).runId);
    expect(run).toMatchObject({ status: 'completed' });
    expect(captured).toHaveLength(6);
    expect(captured[1]!.messages.find((m) => m.tool_calls)?.reasoning_content).toBe(
      'private reasoning 0',
    );
    for (const [index, alreadyLoaded] of [
      [3, false],
      [5, true],
    ] as const) {
      const messages = captured[index]!.messages;
      expect(messages.some((m) => m.role === 'tool' || m.tool_calls)).toBe(false);
      const loadIndex = messages.findIndex((m) => m.content?.includes('"tool":"load_skill"'));
      const readIndex = messages.findIndex((m) =>
        m.content?.includes('"tool":"read_skill_resource"'),
      );
      const correctionIndex = messages.findIndex((m) => m.content === correction);
      expect(readIndex).toBeGreaterThan(-1);
      expect(correctionIndex).toBeGreaterThan(readIndex);
      expect(loadIndex).toBeGreaterThan(-1);
      if (alreadyLoaded) expect(loadIndex).toBeGreaterThan(correctionIndex);
      else expect(loadIndex).toBeLessThan(readIndex);
      expect(messages[loadIndex]!.content?.includes('"already_loaded":true')).toBe(alreadyLoaded);
      expect(messages.filter((m) => m.content?.includes('Current resource text.'))).toHaveLength(1);
      expect(messages.some((m) => m.content?.includes('Original resource text.'))).toBe(false);
    }
  } finally {
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

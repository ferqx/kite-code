import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import type { Extension, Json } from '@kite-ai/agent/extensions';
import { createFileTools, createWorkspaceFiles } from '@kite-ai/agent/files';
import { createPlanningValidation, planningExtensionId } from '@kite-ai/agent/planning';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import type { ModelAdapter } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';

test('HTTP Run automatically verifies nested ordinary file Tools with persistent original obligations and cold reads', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-nested-automatic-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'owned' });
  const metadata = await store.getMetadata();
  const planning = createPlanningValidation({
    automaticValidation: {
      mutations: [
        { definitionId: 'files.write', definitionVersion: '2', effects: ['workspace_write'] },
        { definitionId: 'files.edit', definitionVersion: '2', effects: ['workspace_write'] },
      ],
      fileHashChecker: { definitionId: 'files.read', definitionVersion: '3' },
    },
  });
  const counts = { models: 0, wrappers: 0, writes: 0, edits: 0, reads: 0 };
  const finalContent = 'unchanged first line\nverified complete second line🙂\nFINAL_TAIL\n';
  const fileTools = createFileTools(createWorkspaceFiles({ root: workspace })).map((tool) => ({
    ...tool,
    async execute(input: Json, context: Parameters<typeof tool.execute>[1]) {
      if (tool.id === 'files.write') counts.writes++;
      if (tool.id === 'files.edit') counts.edits++;
      if (tool.id === 'files.read') counts.reads++;
      return tool.execute(input, context);
    },
  }));
  const wrapper: Extension = {
    id: 'external.nested-files',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'external.write_and_edit',
        version: '1',
        description: 'Perform the fixed original file work through ordinary operations',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        async execute(_input, context) {
          counts.wrappers++;
          const write = await context.operations.ensure({
            key: 'original-write',
            request: {
              kind: 'tool',
              definitionId: 'files.write',
              definitionVersion: '2',
              input: {
                path: 'result.txt',
                content: 'unchanged first line\nbefore\nFINAL_TAIL\n',
                base: null,
              },
            },
          });
          const written = await context.operations.wait(write);
          if (written.status !== 'succeeded')
            return { outcome: 'failed', content: 'nested_write_failed', details: written.result };
          const body = JSON.parse((written.result as { content: string }).content) as {
            baseline: Json;
          };
          const edit = await context.operations.ensure({
            key: 'original-edit',
            request: {
              kind: 'tool',
              definitionId: 'files.edit',
              definitionVersion: '2',
              input: {
                path: 'result.txt',
                find: 'before',
                replace: 'verified complete second line🙂',
                occurrences: 1,
                base: body.baseline,
              },
            },
          });
          const edited = await context.operations.wait(edit);
          return {
            outcome: edited.status === 'succeeded' ? 'succeeded' : 'failed',
            content: 'original nested operations settled',
            details: { write: written.result, edit: edited.result },
          };
        },
      },
    ],
  };
  const model: ModelAdapter = {
    async *stream() {
      const first = counts.models++ === 0;
      if (first)
        yield {
          type: 'tool_call',
          id: 'wrapper-call',
          name: 'external.write_and_edit',
          arguments: '{}',
        };
      else yield { type: 'text_delta', text: 'finished' };
      yield {
        type: 'finish',
        reason: first ? 'tool_calls' : 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    extensions: [
      planning.extension,
      { id: 'builtin.files', version: '1', apiMajor: 1, tools: fileTools },
      wrapper,
    ],
    initializeRunRequirements: planning.initializeRequirements,
    conditions: planning.conditions,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  const profile = resolveProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  const service = await startService({
    runtime,
    profile: {
      dataRoot: realpathSync(profile.dataRoot),
      name: 'owned',
      accessKey: profile.profileAccessKey,
    },
    buildId: 'nested-automatic',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['commands'],
    },
  });
  let passed = false;
  try {
    await runtime.createWorkspace({
      expectedStoreId: metadata.storeId,
      id: 'w',
      name: 'temporary',
      rootUri: pathToFileURL(workspace).href,
    });
    await runtime.createSession({
      expectedStoreId: metadata.storeId,
      commandId: 'create',
      sessionId: 's',
      subjectId: 'owner',
      workspaceId: 'w',
      title: 'nested automatic',
    });
    await client.connect();
    await client.startRun('s', {
      expectedStoreId: metadata.storeId,
      commandId: 'work',
      kind: 'run.start',
      content: 'Perform the original nested file work and verify before finishing',
    });
    let view = await client.getView('s');
    const until = Date.now() + 5000;
    while ((!view.runs[0] || view.runs[0].isActive) && Date.now() < until) {
      await Bun.sleep(10);
      view = await client.getView('s');
    }
    const run = view.runs[0]!;
    const executions = await store.listExecutions('s');
    const head =
      run &&
      (await store.getExtensionRecord({
        sessionId: 's',
        extensionId: planningExtensionId,
        key: `run/${run.id}/mutation.current`,
      }));
    writeFileSync(
      join(root, 'receipt.json'),
      JSON.stringify({ counts, view, executions, head }, null, 2),
    );
    // These checks precede completion so a malformed wrapper cannot masquerade as this regression.
    expect(counts.wrappers).toBe(1);
    expect(counts.writes).toBe(1);
    expect(counts.edits).toBe(1);
    expect(readFileSync(join(workspace, 'result.txt'), 'utf8')).toBe(finalContent);
    expect(run.status).toBe('completed');
    const storedRun = await store.getRun(run.id);
    const requirement = storedRun!.requirements.find(
      (ref) => ref.requirementId === 'mutation.required',
    )!;
    const nested = executions.filter((execution) =>
      ['files.write', 'files.edit'].includes(execution.definitionId ?? ''),
    );
    expect(nested).toHaveLength(2);
    for (const child of nested) {
      expect(child.runId).toBeNull();
      expect(child.status).toBe('succeeded');
      expect(child.requirements).toContainEqual(requirement);
      expect(child.parentExecutionId).toBe(
        executions.find((execution) => execution.definitionId === 'external.write_and_edit')!.id,
      );
      const intent = await store.getExtensionRecord({
        sessionId: 's',
        extensionId: planningExtensionId,
        key: `run/${run.id}/mutation/intent/${child.id}`,
      });
      const settled = await store.getExtensionRecord({
        sessionId: 's',
        extensionId: planningExtensionId,
        key: `run/${run.id}/mutation/settled/${child.id}`,
      });
      expect(intent?.value).toMatchObject({
        executionId: child.id,
        descriptor: { kind: 'file_hash', path: 'result.txt' },
      });
      expect(settled?.value).toMatchObject({
        executionId: child.id,
        status: 'succeeded',
        resultRevision: child.resultRevision,
      });
    }
    const page = await store.listMutationFacts({ expectedStoreId: metadata.storeId, requirement });
    expect(page.facts.map((fact) => fact.check?.outcome)).toEqual(['superseded', 'passed']);
    expect(head?.value).toMatchObject({ lastSeq: '2', checkedThrough: '2', lastOutcome: 'passed' });
    expect(counts.models).toBe(2);
    expect(counts.reads).toBe(1);
    const checked = executions.find((execution) => execution.definitionId === 'files.read')!;
    expect(JSON.parse((checked.result as { content: string }).content).baseline.hash).toBe(
      createHash('sha256').update(finalContent).digest('hex'),
    );
    const before = { ...counts };
    expect(await client.getRun(run.id)).toEqual(run);
    for (const child of nested)
      expect((await client.getExecution(child.id)).result).toEqual(child.result);
    expect(await client.getView('s')).toEqual(view);
    expect(counts).toEqual(before);
    expect(readFileSync(join(workspace, 'result.txt'), 'utf8')).toBe(finalContent);
    passed = true;
  } finally {
    client.disposeNetwork();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    try {
      await Promise.race([
        service.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`nested_automatic_cleanup_timeout:${root}`)),
            4000,
          );
        }),
      ]);
      closed = true;
    } finally {
      if (timer) clearTimeout(timer);
      if (passed && closed) rmSync(root, { recursive: true, force: true });
      else console.error(`nested automatic evidence retained: ${root}`);
    }
  }
}, 15000);

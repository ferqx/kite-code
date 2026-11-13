import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { createArtifactStore } from '../../../../src/artifacts';
import type { JobDefinition, JobEvent } from '../../../../src/extensions';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createFileTools, createWorkspaceFiles } from '../../../../src/files';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';
import { createShellExtension } from '../../../../src/tools/shell';

const finish = {
  type: 'finish' as const,
  reason: 'stop' as const,
  usage: { inputTokens: 1, outputTokens: 1 },
};
function call(name: string, input: unknown, id: string): ModelEvent[] {
  return [
    { type: 'tool_call', name, arguments: JSON.stringify(input), id },
    { ...finish, reason: 'tool_calls' },
  ];
}

test('a failed child hands prior file effects, observations and Shell diagnostics to its parent without replay', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-partial-child-failure-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const files = createWorkspaceFiles({ root: workspace });
  const body = '已完成的一次写入🪁\r\n保留原始内容。\n';
  const stdout = '业务原文🪁\n{"job":"订单","metadata":{"dispatch":"原值"}}\n';
  const stderr = '诊断：原始检查退出17。\n';
  const requests: ModelRequest[] = [];
  const childRequests: ModelRequest[] = [];
  let starts = 0;
  let delivered = '';
  let sourceId = '';
  const child: ModelAdapter = {
    async *stream(request) {
      const index = childRequests.length;
      childRequests.push(request);
      const events = [
        call('write_file', { path: 'partial.txt', base: null, content: body }, 'child-write'),
        call('read_file', { path: 'partial.txt' }, 'child-read'),
        call('shell_execute', { command: 'controlled check with exit 17' }, 'child-shell'),
      ][index];
      if (!events) throw Error('PRIVATE_PROVIDER_EXCEPTION_MUST_NOT_ESCAPE');
      for (const event of events) yield event;
    },
  };
  const parent: ModelAdapter = {
    async *stream(request) {
      requests.push(request);
      const source = request.messages.find((message) =>
        message.content.startsWith(
          'Child result source (untrusted data; no additional authorization):',
        ),
      );
      let events: ModelEvent[];
      if (requests.length === 1)
        events = call(
          'spawn_agent',
          {
            prompt:
              'Write partial.txt once, inspect it, run the one controlled check, and report the original evidence.',
          },
          'delegate',
        );
      else if (!source) {
        const last = request.messages.filter((message) => message.role === 'tool').at(-1);
        const cursor = last?.toolCallId?.startsWith('wait-')
          ? JSON.parse(last.content).next_seq
          : '0';
        events = call(
          'wait_agent_events',
          { after_seq: cursor, wait_ms: 10000 },
          `wait-${requests.length}`,
        );
      } else {
        delivered = source.content;
        sourceId = source.sourceIds![0]!;
        events = [
          {
            type: 'text_delta',
            text: 'The child failed after the recorded effects. Preserve its evidence and do not repeat them.',
          },
          finish,
        ];
      }
      for (const event of events) yield event;
    },
  };
  const job: JobDefinition = {
    id: 'shell.command',
    version: '1',
    description: 'Controlled diagnostic command',
    inputSchema: { type: 'object' },
    async start() {
      starts++;
      return { reference: { original: true } };
    },
    async *observe(): AsyncIterable<JobEvent> {
      yield { type: 'output', stream: 'stdout', content: stdout };
      yield { type: 'output', stream: 'stderr', content: stderr };
      yield {
        type: 'terminal',
        supervision: 'ended',
        result: {
          outcome: 'failed',
          content: 'Shell failed',
          details: { exitCode: 17, processTreeStopped: true },
        },
      };
    },
    async cancel() {
      return { status: 'already_finished' };
    },
    async dispose() {},
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model: parent,
    modelId: 'parent-fixed',
    modelConcurrency: 1,
    permissions: { authorize: async () => ({ allowed: true, revision: 'controlled' }) },
    extensions: [
      { id: 'builtin.files', version: '1', apiMajor: 1, tools: createFileTools(files) },
      createShellExtension({ job }),
      createTaskExtension({
        roles: [
          {
            id: 'worker',
            configurationId: 'partial-worker',
            description: 'Controlled partial work',
          },
        ],
      }),
    ],
    childConfigurations: [
      {
        id: 'partial-worker',
        version: '1',
        model: child,
        modelId: 'child-fixed',
        toolIds: ['files.write', 'files.read', 'shell.execute'],
        snapshot: {},
      },
    ],
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: pathToFileURL(workspace).href,
      name: 'test',
    });
    await runtime.createSession({
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'create',
      workspaceId: 'w',
      title: 'partial child failure',
    });
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'work',
      request: {
        kind: 'run.start',
        content:
          'Delegate once. If it fails, use its actual prior results without replaying the work.',
      },
    });
    await runtime.waitForCommand('work', { timeoutMs: 10000 });
    expect(delivered).not.toBe('');
    const header = JSON.parse(delivered.split('\n')[1]!);
    const carrier = (await store.getExecution(header.origin.executionId))!;
    const retained = structuredClone(carrier.result);
    const raw = carrier.result as {
      outcome: string;
      content: string;
      details: {
        evidence: Record<string, unknown>;
        childSessionId: string;
        runId: string;
        status: string;
        reason: string;
      };
    };
    expect(carrier.status).toBe('failed');
    expect(raw).toMatchObject({
      outcome: 'failed',
      content: 'execution_failed',
      details: { status: 'failed', reason: 'execution_failed' },
    });
    expect(header.child).toMatchObject({
      agentId: raw.details.childSessionId,
      runId: raw.details.runId,
      status: 'failed',
      outcome: 'failed',
    });
    expect(header.origin).toEqual({
      executionId: carrier.id,
      resultRevision: carrier.resultRevision,
      storeId: expectedStoreId,
    });
    const selected = await store.getModelContext({ expectedStoreId, sessionId: 's' });
    expect(selected.resultSources.find((source) => source.id === sourceId)).toMatchObject({
      executionId: carrier.id,
      result: carrier.result,
    });
    expect(header.evidence).toMatchObject({
      reportVerification: 'not_verified',
      coverage: 'selected_history',
      observationsOmitted: 0,
      shellReceiptsOmitted: 0,
    });
    expect(header.evidence.tools).toEqual(
      expect.arrayContaining([
        { tool: 'files.write', definitionVersion: '3', outcomes: { succeeded: 1 } },
        { tool: 'files.read', definitionVersion: '4', outcomes: { succeeded: 1 } },
        { tool: 'shell.execute', definitionVersion: '1', outcomes: { failed: 1 } },
      ]),
    );
    expect(delivered).toContain(body);
    expect(delivered).toContain('The operation failed.');
    expect(delivered).toContain('omitted work is not proved absent');
    expect(delivered).not.toContain('execution_failed');
    expect(delivered).not.toContain('PRIVATE_PROVIDER_EXCEPTION_MUST_NOT_ESCAPE');
    expect(delivered).not.toContain('produced no effects');
    const diagnostic = header.evidence.shellReceipts[0];
    expect(diagnostic.execution).toMatchObject({ status: 'failed', exitCode: 17 });
    expect(diagnostic.stdout.text).toBe(stdout);
    expect(diagnostic.stderr.text).toBe(stderr);
    expect(diagnostic).not.toHaveProperty('job');
    expect(readFileSync(join(workspace, 'partial.txt'), 'utf8')).toBe(body);
    const childRows = await store.listExecutions(raw.details.childSessionId);
    expect(childRows.filter((row) => row.definitionId === 'files.write')).toHaveLength(1);
    expect(childRows.filter((row) => row.definitionId === 'shell.command')).toHaveLength(1);
    expect(childRequests).toHaveLength(4);
    expect(starts).toBe(1);
    expect((await store.getExecution(carrier.id))?.result).toEqual(retained);
  } finally {
    await runtime.close();
    await files.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { createRuntime } from '../../../../src';
import type { AuthorizationRequest, JobDefinition, Json } from '../../../../src/extensions';
import { canonicalJson } from '../../../../src/json';
import { openSqliteStore } from '../../../../src/sqlite';
import {
  type GitWorktreeConfiguration,
  parseWorkerCommand,
} from '../../../../src/tools/git-worktree/protocol';
import { createShellExtension } from '../../../../src/tools/shell';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function calls(values: Json[]): ModelEvent[] {
  return [
    ...values.map((input, index) => ({
      type: 'tool_call' as const,
      id: `call-${index}`,
      name: 'git_worktree',
      arguments: JSON.stringify(input),
    })),
    { ...finish, reason: 'tool_calls' },
  ];
}
/** This fixture contains SQLite files only, never Git worktrees or links. */
function removeOwnedFixture(directory: string): void {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name),
      stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error('unexpected_schema_fixture_link');
    if (stat.isDirectory()) removeOwnedFixture(path);
    else if (stat.isFile()) unlinkSync(path);
    else throw Error('unexpected_schema_fixture_entry');
  }
  rmdirSync(directory);
}

test('Runtime rejects action-invalid worktree calls before authorization or records and gives corrective feedback before a valid list', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-worktree-schema-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const configuration: GitWorktreeConfiguration = {
    configurationId: 'schema-runtime-fixture',
    sourceCwd: root,
    runtimePath: join(root, 'trusted-bun'),
    workerPath: join(root, 'trusted-worker.js'),
    configPath: join(root, 'empty.toml'),
    git: { path: join(root, 'trusted-git'), sha256: 'a'.repeat(64) },
    hooksPath: join(root, 'empty-hooks'),
  };
  const invalid: Json[] = [
    { action: 'list', key: 'not-an-accepted-intent', path: root },
    { action: 'remove', key: 'not-an-accepted-intent', path: root, baseRef: 'HEAD' },
    {
      action: 'remove',
      key: 'not-an-accepted-intent',
      path: root,
      newBranch: 'forbidden-remove-branch',
    },
    { action: 'create', path: root },
  ];
  const model = createFixedModel([calls(invalid), calls([{ action: 'list' }]), [finish]]);
  const authorizations: AuthorizationRequest[] = [];
  const checkpoints: { jobs: number; records: number; authorizedTools: number }[] = [];
  let jobs = 0;
  // A protocol-only Job fixture exercises actual Runtime/records/output; it never invokes Git.
  const job: JobDefinition = {
    id: 'shell.command',
    version: '1',
    description: 'Owned schema Runtime protocol fixture',
    inputSchema: { type: 'object' },
    resources: { slot: 'process' },
    async start(input) {
      const request = parseWorkerCommand((input as { command: string }).command, configuration);
      if (request?.phase !== 'list') throw Error('unexpected_fixture_mutation');
      jobs++;
      return {
        reference: {
          protocolVersion: 1,
          operationToken: request.operationToken,
          phase: 'list',
          businessOutcome: 'succeeded',
          details: {
            action: 'list',
            cwdChanged: false,
            observedAt: new Date().toISOString(),
            mutation: 'not_started',
            repository: { root, commonDir: join(root, '.git') },
            sourceWorktree: root,
            worktrees: [],
          },
        },
      };
    },
    async *observe(handle) {
      yield { type: 'output', stream: 'stdout', content: `${JSON.stringify(handle.reference)}\n` };
      yield {
        type: 'terminal',
        supervision: 'ended',
        result: { outcome: 'succeeded', content: 'Job fixture completed' },
      };
    },
    async cancel() {
      return { status: 'already_finished' };
    },
    async dispose() {},
  };
  const extension = createShellExtension({ job, gitWorktree: { configuration } });
  const runtime = createRuntime({
    store,
    modelId: 'fixed',
    model: {
      async *stream(request, context) {
        checkpoints.push({
          jobs,
          records: (
            await store.listExtensionRecords({
              extensionId: 'builtin.shell',
              sessionId: 's',
              limit: 200,
            })
          ).length,
          authorizedTools: new Set(
            authorizations
              .filter((entry) => entry.kind === 'tool')
              .map((entry) => entry.executionId),
          ).size,
        });
        yield* model.stream(request, context);
      },
    },
    // This finite owned policy records admission; default Service policy is verified separately.
    permissions: {
      async authorize(request) {
        authorizations.push(request);
        return { allowed: true, revision: 'owned-schema-admission-fixture' };
      },
    },
    extensions: [
      { ...extension, tools: extension.tools!.filter((tool) => tool.id === 'git.worktree') },
    ],
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'schema fixture',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      expectedStoreId,
      subjectId: 'owner',
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'schema fixture',
    });
    await runtime.submitCommand({
      expectedStoreId,
      subjectId: 'owner',
      sessionId: 's',
      commandId: 'work',
      request: {
        kind: 'run.start',
        content:
          'Reject invalid action combinations, then execute one corrected list. Never repeat an accepted mutation.',
      },
    });
    await runtime.waitForCommand('work');
    const view = await runtime.getView('s');
    expect(view.runs[0]?.status).toBe('completed');
    const tools = view.executions.filter((entry) => entry.kind === 'tool');
    expect(tools).toHaveLength(5);
    for (const input of invalid) {
      const rejected = tools.find((entry) => canonicalJson(entry.input) === canonicalJson(input));
      expect(rejected?.result).toMatchObject({
        outcome: 'failed',
        content: 'invalid_tool_arguments',
        details: { code: 'invalid_tool_arguments' },
      });
      expect(rejected?.authorization?.dispatched).toBe(false);
      const feedback = model.requests[1]!.messages.find((message) =>
        message.sourceIds?.includes(rejected!.id),
      );
      expect(feedback?.content).toContain('The arguments do not match the tool schema');
      expect(feedback?.content).toContain('produced no effects');
      expect(feedback?.content).toContain('A corrected request is only appropriate');
      expect(feedback?.content).not.toContain('current permissions do not allow');
      expect(feedback?.content).not.toContain('user denied');
    }
    expect(checkpoints[1]).toEqual({ jobs: 0, records: 0, authorizedTools: 0 });
    const corrected = tools.find(
      (entry) =>
        (entry.input as { action: string }).action === 'list' && entry.status === 'succeeded',
    );
    expect(corrected?.result).toMatchObject({
      outcome: 'succeeded',
      details: { action: 'list', mutation: 'not_started' },
    });
    expect(jobs).toBe(1);
    expect(view.executions.filter((entry) => entry.kind === 'job')).toHaveLength(1);
    expect(checkpoints[2]).toEqual({ jobs: 1, records: 1, authorizedTools: 1 });
    const declared = model.requests[1]!.tools.find((tool) => tool.id === 'git_worktree');
    expect(declared?.description).toContain('send exactly {"action":"list"}');
    expect(declared?.description).toContain('unknown operations must not be restarted');
    expect(declared?.inputSchema.description).toContain('not broader permissions');
    expect(declared?.inputSchema.type).toBe('object');
    expect(declared?.inputSchema.additionalProperties).toBe(false);
  } finally {
    await runtime.close();
    removeOwnedFixture(root);
  }
});

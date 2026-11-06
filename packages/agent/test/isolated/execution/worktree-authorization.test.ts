import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import type { JobDefinition, JobEvent, Json, Permissions } from '../../../src/extensions';
import { createPermissionPolicy } from '../../../src/permissions';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import {
  digest,
  type GitWorktreeConfiguration,
  parseWorkerCommand,
  type WorktreeFrame,
  type WorktreePlan,
  type WorktreeRequest,
} from '../../../src/tools/git-worktree/protocol';
import { createShellExtension } from '../../../src/tools/shell';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const config: GitWorktreeConfiguration = {
  configurationId: 'inert-authorization',
  sourceCwd: '/repo',
  bunPath: '/trusted/bun',
  workerPath: '/trusted/worker.js',
  configPath: '/trusted/empty.toml',
  hooksPath: '/trusted/hooks',
  git: { path: '/trusted/git', sha256: 'a'.repeat(64) },
};
const identity = { dev: '1', ino: '2', ctimeNs: '3', birthtimeNs: '4' };
const plan: WorktreePlan = {
  action: 'create',
  sourceCwd: '/repo',
  sourceRoot: '/repo',
  commonDir: '/repo/.git',
  targetPath: '/target',
  baseRef: 'HEAD',
  baseOid: 'f'.repeat(40),
  evidence: {
    repository: {
      root: '/repo',
      gitDir: '/repo/.git',
      commonDir: '/repo/.git',
      bare: false,
      rootIdentity: identity,
      commonIdentity: identity,
    },
    parent: { path: '/', identity },
  },
};
const object = (value: unknown) => value as Record<string, Json>;
async function fixture(
  options: {
    mode?: 'auto' | 'accept_edits';
    wrongOwner?: boolean;
    independentHuman?: boolean;
    race?: 'record' | 'clear-grant' | 'deadline';
    grant?: 'approve_once' | 'same_command';
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-worktree-authorization-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const starts: WorktreeRequest[] = [];
  let checks = 0,
    raced = false;
  const job: JobDefinition = {
    id: 'shell.command',
    version: '1',
    description: 'Inert worker protocol; never executes Git or command text.',
    inputSchema: { type: 'object' },
    async start(input) {
      const request = parseWorkerCommand(String(object(input).command), config)!;
      expect(request).not.toBeNull();
      starts.push(request);
      const prepared = request.phase.startsWith('prepare_');
      const frame: WorktreeFrame = {
        protocolVersion: 1,
        operationToken: request.operationToken,
        phase: request.phase,
        businessOutcome: prepared ? 'prepared' : 'succeeded',
        details: {
          action: 'create',
          cwdChanged: false,
          mutation: prepared ? 'not_started' : 'completed',
          observedAt: new Date().toISOString(),
          repository: { root: '/repo', commonDir: '/repo/.git' },
          ...(prepared
            ? {}
            : {
                path: '/target',
                head: 'f'.repeat(40),
                branch: null,
                observed: { pathExists: true, registered: true },
                baseRef: 'HEAD',
                baseCommit: 'f'.repeat(40),
                detached: true,
              }),
        },
        ...(prepared ? { plan, planDigest: digest(plan) } : {}),
      };
      return { reference: { frame: frame as unknown as Json } };
    },
    async *observe(handle): AsyncIterable<JobEvent> {
      yield {
        type: 'output',
        stream: 'stdout',
        content: `${JSON.stringify(object(handle.reference).frame)}\n`,
      };
      yield {
        type: 'terminal',
        result: { outcome: 'succeeded', content: 'Inert protocol only.', details: { exitCode: 0 } },
        supervision: 'ended',
      };
    },
    async cancel() {
      return { status: 'already_finished' };
    },
    async dispose() {},
  };
  const shell = createShellExtension({ job, gitWorktree: { configuration: config } });
  const extension = { ...shell, ...(options.wrongOwner ? { id: 'other.shell' } : {}) };
  const policy = createPermissionPolicy({
    readPolicy: () => ({
      mode: options.mode ?? 'accept_edits',
      workspaceTrust: true,
      revision: 'fixed-current-policy',
      allowed: [
        { kind: 'model', definitionId: 'fixed', definitionVersion: '1' },
        { kind: 'tool', definitionId: 'git.worktree', definitionVersion: '1' },
        { kind: 'job', definitionId: 'shell.command', definitionVersion: '1' },
      ],
    }),
    describeCapability(request) {
      return {
        kind: request.kind,
        definitionId: request.definitionId,
        definitionVersion: request.definitionVersion,
        revision: 'trusted-inert-registration',
        hardAllowed: true,
        safeRead: false,
        effects:
          request.kind === 'model' ? ['network'] : ['process', 'workspace_write', 'record_write'],
        ...(request.kind !== 'model'
          ? {
              executionScope: { filesystem: 'full_access', network: 'none' },
              worktreeAuthorization: { configurationIdentity: digest(config) },
              commandDigest: digest({ kind: request.kind, input: request.input }),
            }
          : {}),
      };
    },
  });
  const permissions: Permissions = {
    async authorize(request) {
      const decision = await policy.authorize(request);
      return options.independentHuman && request.kind === 'job'
        ? {
            ...decision,
            approval: { request: { reason: 'custom_independent_human' } },
            ...(decision.check ? { check: { ...decision.check, requireApproval: true } } : {}),
          }
        : decision;
    },
  };
  const proxy = new Proxy(store, {
    get(target, key) {
      if (key === 'markDispatching')
        return async (input: Parameters<Store['markDispatching']>[0]) => {
          const execution = await store.getExecution(input.executionId);
          if (
            !raced &&
            options.race &&
            execution?.kind === 'job' &&
            input.authorization.policyEvidenceId &&
            (options.race === 'clear-grant' ||
              parseWorkerCommand(String(object(execution.input).command), config)?.phase ===
                'create')
          ) {
            raced = true;
            if (options.race === 'clear-grant') {
              const grants = await store.listPermissionGrants({
                expectedStoreId,
                sessionId: 's',
                subjectId: 'owner',
              });
              await store.clearPermissionGrants({
                expectedStoreId,
                sessionId: 's',
                subjectId: 'owner',
                commandId: 'clear-before-job',
                ifRevision: grants.revision,
              });
            } else {
              const parent = (await store.getExecution(execution.parentExecutionId!))!;
              const record = (await store.getExtensionRecord({
                extensionId: 'builtin.shell',
                sessionId: 's',
                key: 'git-worktree/intent',
              }))!;
              const value = structuredClone(record.value);
              if (options.race === 'deadline') {
                const timeout = Number(object(object(value).request).timeoutMs);
                const expired = Date.now() - 1000;
                object(value).acceptedAt = new Date(expired - timeout).toISOString();
                object(value).deadlineAt = new Date(expired).toISOString();
              } else {
                const changedPlan = object(object(value).plan);
                changedPlan.targetPath = '/replacement';
                object(value).planDigest = digest(changedPlan);
              }
              await store.writeExtensionRecord({
                expectedStoreId,
                owner: input.owner,
                extensionId: 'builtin.shell',
                sessionId: 's',
                originCommandId: parent.originCommandId,
                originExecutionId: parent.id,
                write: {
                  key: record.key,
                  expectedRevision: record.revision,
                  executable: true,
                  contentType: record.contentType,
                  contentVersion: record.contentVersion,
                  value,
                },
              });
            }
          }
          return store.markDispatching(input);
        };
      return Reflect.get(target, key);
    },
  });
  const runtime = createRuntime({
    store: proxy,
    modelId: 'fixed',
    permissions,
    extensions: [extension],
    model: createFixedModel([
      [
        {
          type: 'tool_call',
          id: 'create-call',
          name: 'git_worktree',
          arguments: JSON.stringify({
            action: 'create',
            key: 'intent',
            path: '/target',
            permissions: { filesystem: 'full_access', network: 'none' },
          }),
        },
        { ...finish, reason: 'tool_calls' },
      ],
      [{ type: 'text_delta', text: 'Controlled operation settled.' }, finish],
    ]),
    authorizationCheck: {
      id: 'generic',
      version: '1',
      modelId: 'reviewer',
      timeoutMs: 5000,
      model: {
        async *stream() {
          checks++;
          yield {
            type: 'text_delta',
            text: JSON.stringify({
              decision: 'approve_once',
              reason: 'The exact inert business action is authorized.',
            }),
          };
          yield finish;
        },
      },
    },
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'inert',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    expectedStoreId,
    commandId: 'session',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'Authorization boundaries',
  });
  return {
    store,
    starts,
    counts: () => ({ checks, raced }),
    async run() {
      await runtime.submitCommand({
        expectedStoreId,
        commandId: 'work',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'Perform this exact inert create action.' },
      });
      const cards = [];
      const deadline = Date.now() + 10000;
      for (;;) {
        const card = (
          await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' })
        ).interactions[0];
        if (card) {
          cards.push(card);
          await runtime.answerInteraction({
            expectedStoreId,
            commandId: `approve-${card.id}`,
            presentationSessionId: card.presentationSessionId,
            interactionId: card.id,
            expectedRevision: card.revision,
            subjectId: 'owner',
            answer: {
              kind: 'approval',
              decision: 'approve',
              grant: options.grant ?? 'approve_once',
            },
          });
        }
        const command = await store.getCommand('work'),
          id = object(command?.receipt).runId;
        const run = typeof id === 'string' ? await store.getRun(id) : null;
        if (run && !run.isActive)
          return { run, cards, executions: await store.listExecutions('s') };
        if (Date.now() > deadline) throw Error('inert_worktree_authorization_timeout');
        await Bun.sleep(5);
      }
    },
    async close() {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('one manual business approval derives only its two frozen inert Jobs', async () => {
  const f = await fixture();
  try {
    const result = await f.run();
    expect(result.cards.map((card) => card.definitionId)).toEqual(['git.worktree']);
    expect(f.starts.map((request) => request.phase)).toEqual(['prepare_create', 'create']);
    const parent = result.executions.find((row) => row.definitionId === 'git.worktree')!;
    for (const job of result.executions.filter((row) => row.kind === 'job'))
      expect(job.authorization?.policy).toMatchObject({
        reason: 'parent_review',
        sourceExecutionId: parent.id,
      });
    expect(f.counts().checks).toBe(0);
  } finally {
    await f.close();
  }
});

test('one generic Auto review derives both inert stages without classifying prepare as safeRead', async () => {
  const f = await fixture({ mode: 'auto' });
  try {
    const result = await f.run();
    expect(result.cards).toHaveLength(0);
    expect(f.counts().checks).toBe(1);
    expect(f.starts).toHaveLength(2);
    for (const job of result.executions.filter((row) => row.kind === 'job'))
      expect(job.authorization?.policy).toMatchObject({
        reason: 'parent_review',
        checkExecutionId: expect.any(String),
      });
  } finally {
    await f.close();
  }
});

for (const mode of ['accept_edits', 'auto'] as const)
  test(`${mode} custom independent human requirements keep their own Job approvals`, async () => {
    const f = await fixture({ mode, independentHuman: true });
    try {
      const result = await f.run();
      expect(result.cards.filter((card) => card.definitionId === 'shell.command')).toHaveLength(2);
      expect(f.starts).toHaveLength(2);
      expect(
        result.executions
          .filter((row) => row.kind === 'job')
          .every((row) => !row.authorization?.policy),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });

test('a same-name Tool in another extension cannot derive builtin Shell authority', async () => {
  const f = await fixture({ wrongOwner: true });
  try {
    const result = await f.run();
    expect(result.cards).toHaveLength(1);
    expect(f.starts).toHaveLength(0);
    expect(result.executions.some((row) => row.kind === 'job')).toBe(false);
    expect(
      result.executions.find((row) => row.definitionId === 'git.worktree')?.result,
    ).toMatchObject({ outcome: 'outcome_unknown' });
  } finally {
    await f.close();
  }
});

test('changing the frozen mutation plan after reuse was accepted stops mutation dispatch', async () => {
  const f = await fixture({ race: 'record' });
  try {
    const result = await f.run();
    expect(f.counts().raced).toBe(true);
    expect(result.cards).toHaveLength(1);
    expect(f.starts.map((request) => request.phase)).toEqual(['prepare_create']);
    expect(
      result.executions.filter((row) => row.kind === 'job').at(-1)?.authorization?.dispatched,
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test('clearing the original same_command grant between reuse and dispatch stops the first Job', async () => {
  const f = await fixture({ race: 'clear-grant', grant: 'same_command' });
  try {
    const result = await f.run();
    expect(f.counts().raced).toBe(true);
    expect(result.cards).toHaveLength(1);
    expect(f.starts).toHaveLength(0);
    expect(result.executions.find((row) => row.kind === 'job')?.authorization?.dispatched).toBe(
      false,
    );
  } finally {
    await f.close();
  }
});

test('expiry between reuse and mutation dispatch does not inherit an expired business action', async () => {
  const f = await fixture({ race: 'deadline' });
  try {
    const result = await f.run();
    expect(f.counts().raced).toBe(true);
    expect(result.cards).toHaveLength(1);
    expect(f.starts.map((request) => request.phase)).toEqual(['prepare_create']);
    expect(
      result.executions.filter((row) => row.kind === 'job').at(-1)?.authorization?.dispatched,
    ).toBe(false);
  } finally {
    await f.close();
  }
});

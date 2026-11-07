import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { fixtureGrant, fixtureScopeOption } from '../../../../../tests/fixtures/permission-grant';
import { persistentWorktreeDirectory } from '../../../../../tests/fixtures/worktree-filesystem';
import { createRuntime } from '../../../src';
import type { JobDefinition, JobEvent, Json, Permissions } from '../../../src/extensions';
import { createTaskExtension } from '../../../src/extensions/task';
import { createPermissionPolicy } from '../../../src/permissions';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { createWorktreeToolBehavior } from '../../../src/tools/git-worktree/approval';
import { sha256 } from '../../../src/tools/git-worktree/paths';
import {
  buildWorkerCommand,
  digest,
  type GitWorktreeConfiguration,
  parseWorkerCommand,
  type WorktreeFrame,
  type WorktreePlan,
  type WorktreeRequest,
} from '../../../src/tools/git-worktree/protocol';
import { executeWorktreeRequest } from '../../../src/tools/git-worktree/worker';
import { createShellExtension } from '../../../src/tools/shell';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
// The inert worker still passes the host's native absolute-path checks before dispatch.
const sourceCwd = resolve('/repo');
const targetPath = resolve('/target');
const trustedRoot = resolve('/trusted');
const commonDir = join(sourceCwd, '.git');
const config: GitWorktreeConfiguration = {
  configurationId: 'inert-authorization',
  sourceCwd,
  bunPath: join(trustedRoot, 'bun'),
  workerPath: join(trustedRoot, 'worker.js'),
  configPath: join(trustedRoot, 'empty.toml'),
  hooksPath: join(trustedRoot, 'hooks'),
  git: { path: join(trustedRoot, 'git'), sha256: 'a'.repeat(64) },
};
const identity = { dev: '1', ino: '2', ctimeNs: '3', birthtimeNs: '4' };
const plan: WorktreePlan = {
  action: 'create',
  sourceCwd,
  sourceRoot: sourceCwd,
  commonDir,
  targetPath,
  baseRef: 'HEAD',
  baseOid: 'f'.repeat(40),
  evidence: {
    repository: {
      root: sourceCwd,
      gitDir: commonDir,
      commonDir,
      bare: false,
      rootIdentity: identity,
      commonIdentity: identity,
    },
    parent: { path: dirname(targetPath), identity },
  },
};
const object = (value: unknown) => value as Record<string, Json>;
const removePlan: WorktreePlan = {
  ...plan,
  action: 'remove',
  evidence: {
    ...(plan.evidence as Record<string, Json>),
    target: {
      identity,
      pointerDigest: 'b'.repeat(64),
      adminGitDir: join(commonDir, 'worktrees/target'),
      adminIdentity: identity,
      head: 'f'.repeat(40),
      branch: null,
      registrationDigest: 'c'.repeat(64),
    },
  },
};
async function fixture(
  options: {
    mode?: 'auto' | 'accept_edits' | 'full';
    wrongOwner?: boolean;
    noBehavior?: boolean;
    independentHuman?: boolean;
    race?: 'record' | 'clear-grant' | 'deadline' | 'mode';
    grant?: 'once' | 'scope';
    autoExempt?: boolean;
    action?: 'list' | 'create' | 'remove';
    child?: boolean;
    childDeny?: boolean;
    ordinaryShell?: boolean;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-worktree-authorization-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const starts: WorktreeRequest[] = [];
  let checks = 0,
    raced = false;
  const controls = { expectedStoreId, subjectId: 'owner' };
  async function setMode(mode: 'auto' | 'accept_edits') {
    const scope = 'session:s';
    const current = await store.readHostControl({ ...controls, kind: 'permission.mode', scope });
    const defaults = await store.readHostControl({
      ...controls,
      kind: 'permission.mode',
      scope: 'user',
    });
    const safeRequest = {
      scope: 'session',
      sessionId: 's',
      mode,
      ifRevision: current.revision,
      makeDefault: false,
      ifDefaultRevision: defaults.revision,
    };
    const request = {
      ...controls,
      commandId: `mode-${mode}`,
      kind: 'permission.mode' as const,
      scope,
      safeRequest,
      requestDigest: digest(safeRequest),
    };
    await store.beginHostMutation(request);
    await store.finishHostMutation({
      ...controls,
      commandId: request.commandId,
      requestDigest: request.requestDigest,
      state: 'applied',
      receipt: { status: 'applied' },
    });
  }
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
      const action =
        request.phase === 'list' ? 'list' : request.phase.endsWith('remove') ? 'remove' : 'create';
      const frame: WorktreeFrame = {
        protocolVersion: 1,
        operationToken: request.operationToken,
        phase: request.phase,
        businessOutcome: prepared ? 'prepared' : 'succeeded',
        details: {
          action,
          cwdChanged: false,
          mutation: prepared || action === 'list' ? 'not_started' : 'completed',
          observedAt: new Date().toISOString(),
          repository: { root: sourceCwd, commonDir },
          ...(action === 'list'
            ? { sourceWorktree: sourceCwd, worktrees: [] }
            : prepared
              ? {}
              : action === 'remove'
                ? {
                    path: targetPath,
                    head: 'f'.repeat(40),
                    branch: null,
                    removed: true,
                    observed: { pathExists: false, registered: false },
                  }
                : {
                    path: targetPath,
                    head: 'f'.repeat(40),
                    branch: null,
                    observed: { pathExists: true, registered: true },
                    baseRef: 'HEAD',
                    baseCommit: 'f'.repeat(40),
                    detached: true,
                  }),
        },
        ...(prepared
          ? {
              plan: action === 'remove' ? removePlan : plan,
              planDigest: digest(action === 'remove' ? removePlan : plan),
            }
          : {}),
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
  const shell = createShellExtension({
    job,
    gitWorktree: {
      configuration: config,
      worktreeHost: {
        async readRegisteredWorkspaceRoots() {
          return { originStoreId: expectedStoreId, complete: true, roots: [root] };
        },
      },
    },
  });
  const extension = { ...shell, ...(options.wrongOwner ? { id: 'other.shell' } : {}) };
  const policy = createPermissionPolicy({
    readPolicy: async () => {
      const control =
        options.race === 'mode'
          ? await store.readHostControl({
              ...controls,
              kind: 'permission.mode',
              scope: 'session:s',
            })
          : undefined;
      return {
        mode: control
          ? (object(control.record?.safeRequest).mode as 'auto' | 'accept_edits')
          : (options.mode ?? 'accept_edits'),
        workspaceTrust: true,
        revision: 'fixed-current-policy',
        allowed: [
          { kind: 'model', definitionId: 'fixed', definitionVersion: '1' },
          { kind: 'tool', definitionId: 'git.worktree', definitionVersion: '1' },
          { kind: 'tool', definitionId: 'shell.execute', definitionVersion: '1' },
          { kind: 'job', definitionId: 'shell.command', definitionVersion: '1' },
          { kind: 'tool', definitionId: 'task.spawn', definitionVersion: '1' },
          { kind: 'job', definitionId: 'agent/worker', definitionVersion: '1' },
        ],
        ...(control
          ? {
              controlReads: [
                {
                  kind: 'permission.mode' as const,
                  scope: 'session:s',
                  revision: control.revision,
                },
              ],
            }
          : {}),
      };
    },
    describeCapability(request, current) {
      const list =
        request.kind === 'tool'
          ? object(request.input).action === 'list'
          : request.kind === 'job' &&
            parseWorkerCommand(String(object(request.input).command), config)?.phase === 'list';
      const task =
        (request.kind === 'tool' && request.definitionId === 'task.spawn') ||
        (request.kind === 'job' && request.definitionId === 'agent/worker');
      return {
        kind: request.kind,
        definitionId: request.definitionId,
        definitionVersion: request.definitionVersion,
        revision: 'trusted-inert-registration',
        hardAllowed: true,
        safeRead: list,
        ...(task ? { internalRecordOnly: true as const } : {}),
        ...(options.grant === 'scope' &&
        request.kind === 'tool' &&
        request.definitionId === 'git.worktree'
          ? {
              grantOffers: [
                fixtureGrant('git.worktree', {
                  configurationIdentity: digest(config),
                  action: 'create',
                  targetPath,
                }),
              ],
            }
          : {}),
        ...(request.kind === 'tool' &&
        request.definitionId === 'git.worktree' &&
        current?.mode === 'auto' &&
        options.autoExempt !== false &&
        !options.wrongOwner
          ? { autoReview: 'none' as const }
          : {}),
        effects:
          request.kind === 'model'
            ? ['network']
            : task
              ? ['record_write']
              : list
                ? ['read']
                : ['process', 'workspace_write', 'record_write'],
        ...(request.kind !== 'model' && !task
          ? {
              executionScope: { filesystem: 'full_access', network: 'none' },
              ...(!list && (request.kind === 'job' || request.definitionId === 'git.worktree')
                ? { worktreeAuthorization: { configurationIdentity: digest(config) } }
                : {}),
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
            if (options.race === 'mode') {
              await setMode('accept_edits');
            } else if (options.race === 'clear-grant') {
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
                changedPlan.targetPath = resolve('/replacement');
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
  const worktreeModel = createFixedModel([
    [
      {
        type: 'tool_call',
        id: 'worktree-call',
        name: options.ordinaryShell ? 'shell_execute' : 'git_worktree',
        arguments: JSON.stringify(
          options.ordinaryShell
            ? {
                command: buildWorkerCommand(config, {
                  schemaVersion: 1,
                  configurationId: config.configurationId,
                  operationToken: 'b'.repeat(64),
                  phase: 'prepare_create',
                  sourceCwd,
                  git: config.git,
                  hooksPath: config.hooksPath,
                  input: {
                    action: 'create',
                    key: 'intent',
                    path: targetPath,
                    baseRef: 'HEAD',
                    timeoutMs: 120000,
                    permissions: { filesystem: 'full_access', network: 'none' },
                  },
                }),
              }
            : options.action === 'list'
              ? { action: 'list' }
              : {
                  action: options.action ?? 'create',
                  path: targetPath,
                  filesystem: 'full_access',
                },
        ),
      },
      { ...finish, reason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'Controlled operation settled.' }, finish],
  ]);
  const runtime = createRuntime({
    store: proxy,
    modelId: 'fixed',
    permissions,
    toolBehaviors:
      options.wrongOwner || options.noBehavior
        ? []
        : [
            createWorktreeToolBehavior({
              definition: extension.tools!.find((tool) => tool.id === 'git.worktree')!,
              configuration: config,
              configurationDigest: digest(config),
            }),
          ],
    extensions: [
      extension,
      ...(options.child
        ? [
            createTaskExtension({
              presets: ['general'],
              roles: [
                { id: 'general', configurationId: 'worker', description: 'Inert direct child' },
              ],
            }),
          ]
        : []),
    ],
    model: options.child
      ? createFixedModel([
          [
            {
              type: 'tool_call',
              id: 'delegate',
              name: 'spawn_agent',
              arguments: JSON.stringify({
                preset: 'general',
                prompt: 'Perform the exact inert worktree operation.',
              }),
            },
            { ...finish, reason: 'tool_calls' },
          ],
          [finish],
        ])
      : worktreeModel,
    ...(options.child
      ? {
          childConfigurations: [
            {
              id: 'worker',
              version: '1',
              model: worktreeModel,
              modelId: 'fixed',
              toolIds: ['git.worktree'],
              snapshot: {},
              permissions: {
                authorize: async (request) =>
                  options.childDeny &&
                  request.kind === 'tool' &&
                  request.definitionId === 'git.worktree'
                    ? { allowed: false, revision: 'child-hard-cap', reason: 'child-denied' }
                    : permissions.authorize(request),
              },
            },
          ],
        }
      : {}),
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
  if (options.race === 'mode') await setMode('auto');
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
          if (options.race === 'mode') {
            const command = await store.getCommand('work');
            await runtime.cancelRun({
              expectedStoreId,
              commandId: 'cancel-revoked-auto',
              sessionId: 's',
              subjectId: 'owner',
              runId: String(object(command?.receipt).runId),
            });
          } else
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
                optionId: options.grant === 'scope' ? fixtureScopeOption(card.request) : 'once',
              },
            });
        }
        const command = await store.getCommand('work'),
          id = object(command?.receipt).runId;
        const parentRun = typeof id === 'string' ? await store.getRun(id) : null;
        const parentExecutions = await store.listExecutions('s');
        const sessionId = options.child
          ? parentExecutions.find((row) => row.childSessionId)?.childSessionId
          : 's';
        const view = sessionId ? await store.getView(sessionId) : null;
        const run = options.child ? view?.runs.at(-1) : parentRun;
        if (options.child && parentRun && !parentRun.isActive && !sessionId)
          throw Error(
            `inert_child_not_created:${JSON.stringify(parentExecutions.map((row) => ({ definitionId: row.definitionId, status: row.status, result: row.result })))}`,
          );
        if (run && !run.isActive)
          return {
            run,
            cards,
            executions: await store.listExecutions(sessionId!),
            parentExecutions,
          };
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

test('a Worktree without a registered owner behavior keeps each internal Job approval', async () => {
  const f = await fixture({ noBehavior: true });
  try {
    const result = await f.run();
    expect(result.cards.map((card) => card.definitionId)).toEqual([
      'git.worktree',
      'shell.command',
      'shell.command',
    ]);
    expect(f.starts.map((request) => request.phase)).toEqual(['prepare_create', 'create']);
    for (const job of result.executions.filter((row) => row.kind === 'job'))
      expect(job.authorization?.policy).toBeUndefined();
  } finally {
    await f.close();
  }
});

test('custom legacy Auto without the host exemption keeps its original generic review', async () => {
  const f = await fixture({ mode: 'auto', autoExempt: false });
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

for (const child of [false, true])
  for (const action of ['list', 'create', 'remove'] as const)
    test(`Auto ${child ? 'direct child' : 'root'} ${action} skips checks and approvals while retaining exact internal Job proof`, async () => {
      const f = await fixture({ mode: 'auto', action, child });
      try {
        const result = await f.run();
        expect(result.cards).toHaveLength(0);
        expect(f.counts().checks).toBe(0);
        const tool = result.executions.find((row) => row.definitionId === 'git.worktree')!;
        expect(tool.result).toMatchObject({
          outcome: 'succeeded',
          details: { action, cwdChanged: false },
        });
        expect(tool.authorization?.check).toBeUndefined();
        expect(tool.authorization?.human).toBeUndefined();
        expect(f.starts.map((request) => request.phase)).toEqual(
          action === 'list' ? ['list'] : [`prepare_${action}`, action],
        );
        for (const job of result.executions.filter((row) => row.definitionId === 'shell.command')) {
          expect(job.authorization?.dispatched).toBe(true);
          expect(job.authorization?.check).toBeUndefined();
          expect(job.authorization?.human).toBeUndefined();
          if (action !== 'list')
            expect(job.authorization?.policy).toMatchObject({
              reason: 'parent_review',
              sourceExecutionId: tool.id,
              effectiveScope: { filesystem: 'full_access', network: 'none' },
            });
        }
        if (child) {
          expect(tool.sessionId).not.toBe('s');
          expect(result.parentExecutions.some((row) => row.definitionId === 'git.worktree')).toBe(
            false,
          );
        }
      } finally {
        await f.close();
      }
    });

test('Auto exemption cannot override the actual direct child hard permission cap', async () => {
  const f = await fixture({ mode: 'auto', child: true, childDeny: true });
  try {
    const result = await f.run();
    expect(f.starts).toHaveLength(0);
    expect(f.counts().checks).toBe(0);
    expect(result.cards).toHaveLength(0);
    expect(
      result.executions.find((row) => row.definitionId === 'git.worktree')?.result,
    ).toMatchObject({ outcome: 'failed', details: { code: 'permission_denied' } });
  } finally {
    await f.close();
  }
});

test('Full preserves its original direct dispatch without adding an Auto proof', async () => {
  const f = await fixture({ mode: 'full' });
  try {
    const result = await f.run();
    expect(result.cards).toHaveLength(0);
    expect(f.counts().checks).toBe(0);
    expect(f.starts.map((request) => request.phase)).toEqual(['prepare_create', 'create']);
    for (const job of result.executions.filter((row) => row.kind === 'job')) {
      expect(job.authorization?.dispatched).toBe(true);
      expect(job.authorization?.policy).toBeUndefined();
    }
  } finally {
    await f.close();
  }
});

test('ordinary Shell cannot inherit Auto worktree authority even for the identical frozen worker command', async () => {
  const f = await fixture({ mode: 'auto', ordinaryShell: true });
  try {
    const result = await f.run();
    expect(result.executions.some((row) => row.definitionId === 'git.worktree')).toBe(false);
    expect(f.counts().checks).toBeGreaterThan(0);
    expect(f.starts.map((request) => request.phase)).toEqual(['prepare_create']);
    expect(
      result.executions
        .filter((row) => row.kind === 'job')
        .every((row) => row.authorization?.policy?.reason !== 'parent_review'),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('Auto permission mode revocation after reuse was accepted blocks mutation dispatch', async () => {
  const f = await fixture({ mode: 'auto', race: 'mode' });
  try {
    const result = await f.run();
    expect(f.counts()).toEqual({ checks: 0, raced: true });
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]?.definitionId).toBe('shell.command');
    expect(f.starts.map((request) => request.phase)).toEqual(['prepare_create']);
    expect(
      result.executions.filter((row) => row.kind === 'job').at(-1)?.authorization?.dispatched,
    ).toBe(false);
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

test('clearing the original structured scope grant between reuse and dispatch stops the first Job', async () => {
  const f = await fixture({ race: 'clear-grant', grant: 'scope' });
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

for (const drift of ['none', 'head', 'parent'] as const)
  test(`real worktree scope grant reaches SQLite mutation gate with ${drift} drift`, async () => {
    const persistent = realpathSync(persistentWorktreeDirectory('kite-worktree-scope-sql-'));
    const source = join(persistent, 'source'),
      parent = join(persistent, 'destinations'),
      hooks = join(persistent, 'hooks'),
      target = join(parent, 'target');
    for (const path of [source, parent, hooks]) mkdirSync(path);
    const gitPath = realpathSync(Bun.which('git')!);
    const git = (args: string[]) =>
      execFileSync(gitPath, args, {
        cwd: source,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_COUNT: '0',
          GIT_CONFIG_PARAMETERS: undefined,
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        },
      }).trim();
    git(['init', '-q']);
    git(['config', 'user.name', 'Scope SQL']);
    git(['config', 'user.email', 'scope@example.test']);
    writeFileSync(join(source, 'tracked.txt'), 'A\n');
    git(['add', '.']);
    git(['commit', '-qm', 'A']);
    const baseOid = git(['rev-parse', 'HEAD']);
    const configuration: GitWorktreeConfiguration = {
      configurationId: 'real-scope-sql',
      sourceCwd: source,
      bunPath: process.execPath,
      workerPath: join(persistent, 'unused-worker'),
      configPath: join(persistent, 'unused-config'),
      git: { path: gitPath, sha256: sha256(readFileSync(gitPath)) },
      hooksPath: hooks,
    };
    const data = realpathSync(mkdtempSync(join(tmpdir(), 'kite-scope-sql-store-')));
    const store = await openSqliteStore({ dataRoot: data, profile: 'test' });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const starts: WorktreeRequest['phase'][] = [];
    const job: JobDefinition = {
      id: 'shell.command',
      version: '1',
      description: 'Isolated actual Git worker owned by the original Tool.',
      inputSchema: { type: 'object' },
      async start(input) {
        const request = parseWorkerCommand(String(object(input).command), configuration)!;
        starts.push(request.phase);
        if (request.phase === 'prepare_create') {
          if (drift === 'head') {
            writeFileSync(join(source, 'tracked.txt'), 'B\n');
            git(['add', '.']);
            git(['commit', '-qm', 'B']);
          }
          if (drift === 'parent') {
            renameSync(parent, join(persistent, 'old-destinations'));
            mkdirSync(parent);
          }
        }
        return { reference: { frame: (await executeWorktreeRequest(request)) as unknown as Json } };
      },
      async *observe(handle) {
        yield {
          type: 'output',
          stream: 'stdout',
          content: `${JSON.stringify(object(handle.reference).frame)}\n`,
        };
        yield {
          type: 'terminal',
          result: {
            outcome: 'succeeded',
            content: 'Actual isolated Git frame.',
            details: { exitCode: 0 },
          },
          supervision: 'ended',
        };
      },
      async cancel() {
        return { status: 'already_finished' };
      },
      async dispose() {},
    };
    const extension = createShellExtension({
      job,
      gitWorktree: {
        configuration,
        worktreeHost: {
          async readRegisteredWorkspaceRoots() {
            return { originStoreId: expectedStoreId, complete: true, roots: [source] };
          },
        },
      },
    });
    const definition = extension.tools!.find((tool) => tool.id === 'git.worktree')!;
    const behavior = createWorktreeToolBehavior({
      definition,
      configuration,
      configurationDigest: digest(configuration),
    });
    const permissions = createPermissionPolicy({
      readPolicy: () => ({
        mode: 'accept_edits',
        workspaceTrust: true,
        revision: 'scope-sql-policy',
        allowed: [
          { kind: 'model', definitionId: 'fixed', definitionVersion: '1' },
          behavior.capability,
          { kind: 'job', definitionId: 'shell.command', definitionVersion: '1' },
        ],
      }),
      async describeCapability(request) {
        return {
          kind: request.kind,
          definitionId: request.definitionId,
          definitionVersion: request.definitionVersion,
          revision: 'trusted-real-worktree',
          hardAllowed: true,
          safeRead: false,
          effects:
            request.kind === 'model' ? ['network'] : ['process', 'workspace_write', 'record_write'],
          ...(request.kind !== 'model'
            ? {
                executionScope: { filesystem: 'full_access' as const, network: 'none' as const },
                worktreeAuthorization: { configurationIdentity: digest(configuration) },
              }
            : {}),
          ...(request.kind === 'tool' ? { grantOffers: await behavior.grantOffers!(request) } : {}),
        };
      },
    });
    const model = createFixedModel([
      [
        {
          type: 'tool_call',
          id: 'create-call',
          name: 'git_worktree',
          arguments: JSON.stringify({
            action: 'create',
            path: target,
            filesystem: 'full_access',
          }),
        },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
    ]);
    const runtime = createRuntime({
      store,
      model,
      modelId: 'fixed',
      extensions: [extension],
      toolBehaviors: [behavior],
      permissions,
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'real scope SQL',
        rootUri: pathToFileURL(source).href,
      });
      await runtime.createSession({
        expectedStoreId,
        sessionId: 's',
        workspaceId: 'w',
        commandId: 'session',
        subjectId: 'owner',
        title: 'real scope SQL',
      });
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 's',
        commandId: 'work',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'Create this exact isolated worktree.' },
      });
      const cards = [];
      const until = Date.now() + 20000;
      for (;;) {
        const pending = (
          await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' })
        ).interactions;
        for (const card of pending) {
          cards.push(card);
          expect(card.definitionId).toBe('git.worktree');
          const optionId = fixtureScopeOption(card.request);
          expect(JSON.stringify(card.request)).toContain(baseOid);
          await runtime.answerInteraction({
            expectedStoreId,
            presentationSessionId: card.presentationSessionId,
            interactionId: card.id,
            expectedRevision: card.revision,
            commandId: `answer-${card.id}`,
            subjectId: 'owner',
            answer: { kind: 'approval', decision: 'approve', optionId },
          });
        }
        const command = await store.getCommand('work');
        if (command?.status === 'rejected') throw Error(JSON.stringify(command.receipt));
        const runId = object(command?.receipt).runId;
        const run = typeof runId === 'string' ? await store.getRun(runId) : null;
        if (run && !run.isActive) break;
        if (Date.now() > until)
          throw Error(`scope_sql_timeout:${JSON.stringify(await store.listExecutions('s'))}`);
        await Bun.sleep(5);
      }
      expect(cards).toHaveLength(1);
      const grants = await store.listPermissionGrants({
        expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
      });
      expect(grants.items).toHaveLength(1);
      expect(grants.items[0]!.grant.ruleId).toBe('builtin.worktree.action');
      const executions = await store.listExecutions('s');
      const owner = executions.find((row) => row.definitionId === 'git.worktree')!;
      expect(owner.authorization?.human?.optionKind).toBe('scope');
      if (drift === 'none') {
        expect(starts).toEqual(['prepare_create', 'create']);
        expect(existsSync(target)).toBe(true);
        expect(git(['-C', target, 'rev-parse', 'HEAD'])).toBe(baseOid);
      } else {
        expect(starts).toEqual(['prepare_create']);
        expect(existsSync(target)).toBe(false);
        expect(owner.status).toBe('failed');
        expect(
          executions.filter((row) => row.kind === 'job').at(-1)?.authorization?.dispatched,
        ).toBe(false);
      }
    } finally {
      await runtime.close();
      await store.close();
      rmSync(data, { recursive: true, force: true });
    }
  }, 30000);

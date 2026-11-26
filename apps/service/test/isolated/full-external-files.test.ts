import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import type { AuthorizationRequest, Json } from '@kite-ai/agent/extensions';
import type { FileCheckpointRecord } from '@kite-ai/agent/files';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { authorizationCheckInstructions } from '../../../../packages/agent/src/execution/authorization-check-feedback';
import { taskQualityPresentedRead } from '../../../../tests/e2e/live/model/agent-task-quality-fixture';
import { simplePdf } from '../../../../tests/fixtures/pdf';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

// Historical paths remain protected after retiring the Files delivery adapter.
const retiredOutputDirectory = (profile: string, store: string, session: string) =>
  join(
    profile,
    'files',
    ...[store, session].map((value) => createHash('sha256').update(value).digest('hex')),
    'outputs',
  );

type Body = {
  messages: { role: string; content: string }[];
  tools: { function: { name: string; description: string; parameters: unknown } }[];
};
type Paths = {
  root: string;
  workspace: string;
  target: string;
  privateTarget: string;
  output: string;
  foreignOutput: string;
};
type Call = { name: string; input: Json };
type Program = (
  body: Body,
  step: number,
  actor: 'root' | 'child',
  paths: Paths,
) => Call | readonly Call[] | null;

async function fixture(options: {
  mode?: 'full' | 'accept_edits' | 'auto';
  editOnly?: boolean;
  failBatchSnapshot?: boolean;
  afterBatchPublication?: () => Promise<void>;
  afterBatchSettlement?: () => Promise<void>;
  fixtureParent?: string;
  forbidHumanApproval?: boolean;
  childFileCeiling?: 'approval' | 'deny';
  beforeDispatch?: 'demote' | 'untrust';
  decision?: 'approve' | 'deny' | 'ask_user' | 'unavailable' | 'timeout' | 'cancel' | 'invalid';
  humanAnswer?: 'approve' | 'deny';
  task?: (paths: Paths) => string;
  beforeAnswer?: (paths: Paths) => void;
  batchAnswer?: (
    card: import('@kite-ai/agent/storage').InteractionRecord,
    paths: Paths,
  ) => 'approve' | 'deny' | 'hold';
  decisionTool?: string;
  retryTimeouts?: number;
  beforeReview?: (body: Body, paths: Paths) => void | Promise<void>;
  program: Program;
}) {
  const root = realpathSync(
    mkdtempSync(join(options.fixtureParent ?? tmpdir(), 'kite-full-external-files-')),
  );
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'profiles'), profile: 'test' });
  privateDirectory(profile.profilePath);
  const paths = {
    root,
    workspace,
    target: join(root, 'external', 'missing-parent', 'report.txt'),
    privateTarget: join(profile.profilePath, 'must-not-create.txt'),
    output: '',
    foreignOutput: '',
  };
  const requests: Body[] = [];
  const reviewInputs: Body[] = [];
  let reviewing = false;
  let reviewRequests = 0;
  const steps = new Map<string, number>();
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Body;
      if (!body.tools?.length) {
        reviewInputs.push(body);
        await options.beforeReview?.(body, paths);
        reviewing = true;
        reviewRequests += 1;
        if (reviewRequests <= (options.retryTimeouts ?? 0))
          return new Response(JSON.stringify({ error: { message: 'controlled timeout' } }), {
            status: 408,
            headers: { 'content-type': 'application/json' },
          });
        const review = body.messages.flatMap((m) => {
          try {
            const value = JSON.parse(m.content);
            return value?.target ? [value] : [];
          } catch {
            return [];
          }
        })[0];
        const decision =
          !options.decisionTool || review?.target?.definitionId === options.decisionTool
            ? options.decision
            : 'approve';
        if (decision === 'timeout') await Bun.sleep(options.decisionTool ? 1800 : 300);
        if (decision === 'cancel') await Bun.sleep(300);
        if (decision === 'unavailable')
          return new Response('controlled unavailable reviewer', { status: 503 });
        const answer =
          decision === 'invalid'
            ? 'not-json'
            : JSON.stringify({
                decision:
                  decision === 'deny'
                    ? 'reject'
                    : decision === 'ask_user'
                      ? 'ask_user'
                      : 'approve_once',
                reason: 'Controlled fixture decision',
              });
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'check', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          `${frame({ content: answer }, null)}${frame({}, 'stop')}data: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      requests.push(body);
      const actor = body.messages.some(
        (message) => message.role === 'user' && message.content.startsWith('CHILD_'),
      )
        ? 'child'
        : 'root';
      const step = steps.get(actor) ?? 0;
      steps.set(actor, step + 1);
      const call = options.program(body, step, actor, paths);
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: `full-files-${requests.length}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        `${frame(
          call
            ? {
                tool_calls: (Array.isArray(call) ? call : [call as Call]).map(
                  (member: Call, index) => ({
                    index,
                    id: Array.isArray(call)
                      ? `call-${actor}-${step}-${index}`
                      : `call-${actor}-${step}`,
                    type: 'function',
                    function: { name: member.name, arguments: JSON.stringify(member.input) },
                  }),
                ),
              }
            : { content: 'Controlled file journey finished.' },
          null,
        )}${frame({}, call ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const configurationPath = join(profile.profilePath, 'config.jsonc');
  writeFileSync(
    configurationPath,
    JSON.stringify({
      // A targeted timeout still needs enough budget for its independently
      // approved prerequisite read. Only the exact target's response is delayed.
      autoApproval: {
        timeoutMs: options.decision === 'timeout' ? (options.decisionTool ? 600 : 50) : 8000,
      },
      modelId: 'fixed',
      models: [
        {
          id: 'fixed',
          provider: 'compatible',
          model: 'fixed',
          baseURL: `${provider.url.href}v1`,
        },
      ],
      tools: (options.editOnly
        ? ['files.read', 'files.edit']
        : ['files.read', 'files.write', 'files.edit', 'task.spawn', 'task.events', 'task.list']
      ).map((id) => ({ id })),
    }),
  );
  const host = createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: configurationPath,
    localCodex: false,
    credentialBackend: createTemporaryCredentialBackend(),
    ...(options.childFileCeiling
      ? {
          permissions: {
            async authorize(request: AuthorizationRequest) {
              const limited = request.sessionId !== 's' && request.definitionId === 'files.write';
              return {
                allowed: !limited,
                revision: 'independent-child-file-ceiling',
                ...(limited && options.childFileCeiling === 'approval'
                  ? { approval: { request: { reason: 'independent_child_confirmation' } } }
                  : limited
                    ? { reason: 'independent_child_denial' }
                    : {}),
              };
            },
          },
        }
      : {}),
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const storeId = (await store.getMetadata()).storeId;
  paths.output = join(retiredOutputDirectory(profile.profilePath, storeId, 's'), 'report.txt');
  paths.foreignOutput = join(
    retiredOutputDirectory(profile.profilePath, storeId, 'foreign-session'),
    'report.txt',
  );
  const artifacts = createArtifactStore({ profile, store });
  const locks = createWorkspaceSerialLocks(profile);
  host.bindWorkspaceSerialLocks?.(locks);
  let changedBeforeDispatch = false;
  let management: ReturnType<NonNullable<typeof host.permissionManagement>>;
  const observedStore = new Proxy(store, {
    get(target, property) {
      if (property === 'finishExecution' && options.afterBatchSettlement) {
        return async (input: Parameters<typeof store.finishExecution>[0]) => {
          const receipt = await store.finishExecution(input);
          if (
            receipt.definitionId === 'files.edit' &&
            receipt.status === 'succeeded' &&
            (receipt.decisionSource as Record<string, Json>).fileEditBatch
          )
            await options.afterBatchSettlement!();
          return receipt;
        };
      }
      if (property !== 'markDispatching') return Reflect.get(target, property);
      return async (input: Parameters<typeof store.markDispatching>[0]) => {
        const actual = await store.getExecution(input.executionId);
        if (
          options.beforeDispatch &&
          !changedBeforeDispatch &&
          actual?.definitionId === 'files.write' &&
          (actual.input as { path?: string }).path === paths.target
        ) {
          changedBeforeDispatch = true;
          if (options.beforeDispatch === 'demote') {
            const mode = await management.readMode({
              expectedStoreId: storeId,
              subjectId: 'owner',
              sessionId: 's',
            });
            await management.setMode({
              expectedStoreId: storeId,
              subjectId: 'owner',
              commandId: 'demote-before-publish',
              sessionId: 's',
              mode: 'accept_edits',
              makeDefault: false,
              ifRevision: mode.revision,
              ifDefaultRevision: mode.defaultRevision,
            });
          } else {
            const trust = await management.readTrust({
              expectedStoreId: storeId,
              subjectId: 'owner',
              workspaceId: 'w',
            });
            await management.setTrust({
              expectedStoreId: storeId,
              subjectId: 'owner',
              commandId: 'untrust-before-publish',
              workspaceId: 'w',
              trusted: false,
              ifRevision: trust.revision,
              canonicalIdentity: trust.canonicalIdentity,
              externalReadScopeDigest: trust.externalReadScopeDigest,
            });
          }
        }
        return store.markDispatching(input);
      };
    },
  });
  const observedArtifacts =
    options.failBatchSnapshot || options.afterBatchPublication
      ? new Proxy(artifacts, {
          get(target, property) {
            if (property !== 'publish') return Reflect.get(target, property);
            return async (input: Parameters<typeof target.publish>[0]) => {
              const execution =
                input.scope.kind === 'execution' ? await store.getExecution(input.scope.id) : null;
              if (input.mediaType === 'text/plain' && execution?.definitionId === 'files.edit') {
                if (options.failBatchSnapshot)
                  throw new Error('fixture-cannot-confirm-published-file');
                await options.afterBatchPublication?.();
              }
              return target.publish(input);
            };
          },
        })
      : artifacts;
  const runtime = createRuntime({
    ...host,
    store: observedStore,
    artifacts: observedArtifacts,
    workspaceSerialLocks: locks,
    permissions: host.permissions!,
  });
  management = host.permissionManagement!(runtime);
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'Owned external files',
    rootUri: pathToFileURL(workspace).href,
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    sessionId: 's',
    commandId: 'create',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'Full external file operations',
  });
  await initializeLivePermissionFixture({
    runtime,
    profile,
    expectedStoreId: storeId,
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    mode: options.mode ?? 'full',
    trusted: true,
  });
  return {
    ...paths,
    runtime,
    store,
    storeId,
    configurationPath,
    management,
    databasePath: profile.databasePath,
    profilePath: profile.profilePath,
    requests,
    reviewInputs,
    reviewing: () => reviewing,
    reviewRequests: () => reviewRequests,
    changed: () => changedBeforeDispatch,
    async run() {
      await runtime.submitCommand({
        expectedStoreId: storeId,
        sessionId: 's',
        commandId: 'work',
        subjectId: 'owner',
        request: {
          kind: 'run.start',
          content: options.task?.(paths) ?? 'FULL_FILE_JOURNEY: operate only owned test targets.',
        },
      });
      let settled = false;
      const completion = runtime.waitForCommand('work', { timeoutMs: 10000 }).finally(() => {
        settled = true;
      });
      const end = Date.now() + 10000;
      while (!settled && Date.now() < end) {
        const { interactions } = await runtime.listInteractions({
          expectedStoreId: storeId,
          sessionId: 's',
          state: 'pending',
        });
        if (options.forbidHumanApproval) expect(interactions).toEqual([]);
        for (const card of interactions) {
          options.beforeAnswer?.(paths);
          const decision = options.batchAnswer?.(card, paths);
          if (decision === 'hold') continue;
          await runtime.answerInteraction({
            expectedStoreId: storeId,
            commandId: `answer-${card.id}`,
            presentationSessionId: card.presentationSessionId,
            interactionId: card.id,
            expectedRevision: card.revision,
            subjectId: 'owner',
            answer:
              (decision ?? options.humanAnswer ?? options.decision) === 'deny'
                ? { kind: 'approval', decision: 'deny' }
                : { kind: 'approval', decision: 'approve', optionId: 'once' },
          });
        }
        await Bun.sleep(10);
      }
      await completion;
    },
    async close() {
      await runtime.close();
      await locks.close();
      await artifacts.close();
      await store.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const scenario of ['allow', 'deny', 'drift'] as const) {
  test(`same-file batch ${scenario}: one exact human card, one durable result for each original call`, async () => {
    const cards: import('@kite-ai/agent/storage').InteractionRecord[] = [];
    const original = 'const a = 1;\r\nconst b = 2;\r\n// original\r\n';
    const drifted = original.replace('// original', '// changed elsewhere');
    const f = await fixture({
      mode: 'accept_edits',
      editOnly: true,
      program: (_body, step, _actor, paths) => {
        if (step === 0) return { name: 'read_file', input: { path: paths.target } };
        if (step === 1)
          return [
            {
              name: 'edit_file',
              input: { path: paths.target, old_string: 'a = 1', new_string: 'a = 11' },
            },
            {
              name: 'edit_file',
              input: { path: paths.target, old_string: 'b = 2', new_string: 'b = 22' },
            },
          ];
        return null;
      },
      batchAnswer(card, paths) {
        if (card.definitionId !== 'files.edit') return 'approve';
        cards.push(card);
        if (scenario === 'drift') writeFileSync(paths.target, drifted);
        return scenario === 'deny' ? 'deny' : 'approve';
      },
    });
    try {
      mkdirSync(join(f.target, '..'), { recursive: true });
      writeFileSync(f.target, original);
      await f.run();
      expect(cards).toHaveLength(1);
      expect(cards[0]?.request).toMatchObject({
        options: [{ kind: 'once', optionId: 'once' }],
        fileEditBatch: {
          kind: 'file_edit_batch@1',
          counts: { added: 2, removed: 2 },
          members: [
            { find: 'a = 1', replace: 'a = 11', counts: { added: 1, removed: 1 } },
            { find: 'b = 2', replace: 'b = 22', counts: { added: 1, removed: 1 } },
          ],
        },
      });
      const edits = (await f.store.listExecutions('s')).filter(
        (value) => value.definitionId === 'files.edit',
      );
      expect(edits).toHaveLength(2);
      expect(edits.map((row) => row.status)).toEqual(
        Array(2).fill(scenario === 'allow' ? 'succeeded' : 'failed'),
      );
      expect(edits.filter((row) => row.authorization?.dispatched)).toHaveLength(
        scenario === 'deny' ? 0 : 1,
      );
      expect(readFileSync(f.target, 'utf8')).toBe(
        scenario === 'allow'
          ? original.replace('a = 1', 'a = 11').replace('b = 2', 'b = 22')
          : scenario === 'drift'
            ? drifted
            : original,
      );
      const next = f.requests.at(-1)?.messages.filter((message) => message.role === 'tool');
      const ids = next?.map(
        (item) => (item as typeof item & { tool_call_id: string }).tool_call_id,
      );
      expect(ids).toContain('call-root-1-0');
      expect(ids).toContain('call-root-1-1');
    } finally {
      await f.close();
    }
  }, 20000);
}

for (const action of ['stop', 'auto'] as const) {
  test(`pending same-file batch ${action} preserves the original tools and retires the exact card`, async () => {
    const pending = Promise.withResolvers<import('@kite-ai/agent/storage').InteractionRecord>();
    const f = await fixture({
      mode: 'accept_edits',
      editOnly: true,
      program: (_body, step, _actor, paths) =>
        step === 0
          ? { name: 'read_file', input: { path: paths.target } }
          : step === 1
            ? [
                {
                  name: 'edit_file',
                  input: { path: paths.target, old_string: 'a = 1', new_string: 'a = 11' },
                },
                {
                  name: 'edit_file',
                  input: { path: paths.target, old_string: 'b = 2', new_string: 'b = 22' },
                },
              ]
            : null,
      batchAnswer(card) {
        if (card.definitionId !== 'files.edit') return 'approve';
        pending.resolve(card);
        return 'hold';
      },
    });
    try {
      const original = 'a = 1\nb = 2\n';
      mkdirSync(join(f.target, '..'), { recursive: true });
      writeFileSync(f.target, original);
      const run = f.run();
      // Surface an early failure instead of waiting for an unproduced card.
      const card = await Promise.race([
        pending.promise,
        run.then(() => {
          throw Error('missing-batch-card');
        }),
      ]);
      const edits = async () =>
        (await f.store.listExecutions('s')).filter((row) => row.definitionId === 'files.edit');
      const before = await edits();
      expect(before).toHaveLength(2);
      expect(before.every((row) => row.status === 'planned')).toBe(true);
      if (action === 'stop') {
        await f.runtime.cancelCommand({
          expectedStoreId: f.storeId,
          sessionId: 's',
          subjectId: 'owner',
          commandId: 'stop-pending-batch',
          targetCommandId: 'work',
        });
      } else {
        const scope = { expectedStoreId: f.storeId, sessionId: 's', subjectId: 'owner' };
        const mode = await f.management.readMode(scope);
        await f.management.setMode({
          ...scope,
          commandId: 'batch-switch-auto',
          mode: 'auto',
          makeDefault: false,
          ifRevision: mode.revision,
          ifDefaultRevision: mode.defaultRevision,
        });
      }
      await run;
      const after = await edits();
      expect(after.map(({ id }) => id).sort()).toEqual(before.map(({ id }) => id).sort());
      const saved = await f.store.getInteraction({
        expectedStoreId: f.storeId,
        sessionId: 's',
        interactionId: card.id,
      });
      expect(saved?.state).toBe('cancelled');
      if (action === 'stop') {
        expect(after.map(({ status }) => status)).toEqual(['cancelled', 'cancelled']);
        expect(readFileSync(f.target, 'utf8')).toBe(original);
        expect(after.some((row) => row.authorization?.dispatched)).toBe(false);
        expect(f.reviewRequests()).toBe(0);
      } else {
        expect(f.reviewRequests()).toBe(2);
        expect(after.map(({ status }) => status).sort()).toEqual(['failed', 'succeeded']);
        expect(after.every((row) => row.authorization?.check !== undefined)).toBe(true);
        expect(readFileSync(f.target, 'utf8')).toBe(original.replace('a = 1', 'a = 11'));
      }
      const messages = (await f.store.listMessages('s')).filter(
        (message) =>
          message.role === 'tool' && before.some(({ callId }) => callId === message.toolCallId),
      );
      expect(messages.map(({ toolCallId }) => toolCallId).sort()).toEqual(
        before.map(({ callId }) => callId).sort(),
      );
    } finally {
      await f.close();
    }
  }, 20000);
}

const restartPhases = ['pending', 'published', 'committed'] as const;
const restartFixtureName = 'owned file batch restart child barrier';
const processPhase = process.env.KITE_TEST_FILE_BATCH_RESTART as
  | (typeof restartPhases)[number]
  | undefined;
const processParent = process.env.KITE_TEST_FILE_BATCH_RESTART_ROOT;
const restartSeed = 'a = 1\nb = 2\n';
const restartUpdate = 'a = 11\nb = 22\n';
const restartProgram: Program = (_body, step, _actor, paths) =>
  step === 0
    ? { name: 'read_file', input: { path: paths.target } }
    : step === 1
      ? [
          {
            name: 'edit_file',
            input: { path: paths.target, old_string: 'a = 1', new_string: 'a = 11' },
          },
          {
            name: 'edit_file',
            input: { path: paths.target, old_string: 'b = 2', new_string: 'b = 22' },
          },
        ]
      : null;

test('same-file batch stop after confirmed publication keeps both successful receipts', async () => {
  const atPublication = Promise.withResolvers<void>();
  const resumeReceipt = Promise.withResolvers<void>();
  const f = await fixture({
    mode: 'accept_edits',
    editOnly: true,
    program: restartProgram,
    async afterBatchPublication() {
      atPublication.resolve();
      await resumeReceipt.promise;
    },
  });
  try {
    mkdirSync(join(f.target, '..'), { recursive: true });
    writeFileSync(f.target, restartSeed);
    const finished = f.run();
    await Promise.race([
      atPublication.promise,
      finished.then(() => {
        throw Error('publication was not held');
      }),
    ]);
    expect(readFileSync(f.target, 'utf8')).toBe(restartUpdate);
    try {
      await f.runtime.cancelCommand({
        expectedStoreId: f.storeId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'stop-published-batch',
        targetCommandId: 'work',
      });
    } finally {
      resumeReceipt.resolve();
    }
    await finished;
    const after = (await f.store.listExecutions('s')).filter(
      (row) => row.definitionId === 'files.edit',
    );
    expect(after.map(({ status }) => status)).toEqual(['succeeded', 'succeeded']);
    expect(after.filter((row) => row.authorization?.dispatched)).toHaveLength(1);
    expect(after.every((row) => row.cancelRequestedAt !== null)).toBe(true);
    expect(readFileSync(f.target, 'utf8')).toBe(restartUpdate);
    expect(f.requests).toHaveLength(2);
  } finally {
    resumeReceipt.resolve();
    await f.close();
  }
}, 20000);

if (processPhase && processParent && restartPhases.includes(processPhase)) {
  test(restartFixtureName, async () => {
    const pending = Promise.withResolvers<import('@kite-ai/agent/storage').InteractionRecord>();
    const stopped = Promise.withResolvers<void>();
    const held = async () => {
      await capture();
      return stopped.promise;
    };
    const f = await fixture({
      fixtureParent: processParent,
      mode: 'accept_edits',
      editOnly: true,
      program: restartProgram,
      afterBatchPublication: processPhase === 'published' ? held : undefined,
      afterBatchSettlement: processPhase === 'committed' ? held : undefined,
      batchAnswer(card) {
        if (card.definitionId !== 'files.edit') return 'approve';
        pending.resolve(card);
        return processPhase === 'pending' ? 'hold' : 'approve';
      },
    });
    async function capture() {
      const card = await pending.promise;
      const edits = (await f.store.listExecutions('s')).filter(
        (row) => row.definitionId === 'files.edit',
      );
      expect(edits).toHaveLength(2);
      const dispatched = edits.filter((row) => row.authorization?.dispatched).length;
      expect(dispatched).toBe(processPhase === 'pending' ? 0 : 1);
      expect(edits.map(({ status }) => status).sort()).toEqual(
        processPhase === 'pending'
          ? ['planned', 'planned']
          : processPhase === 'published'
            ? ['dispatching', 'planned']
            : ['succeeded', 'succeeded'],
      );
      expect(readFileSync(f.target, 'utf8')).toBe(
        processPhase === 'pending' ? restartSeed : restartUpdate,
      );
      const session = (await f.store.getSession('s'))!;
      const ready = join(processParent!, 'ready.json');
      writeFileSync(
        ready + '.tmp',
        JSON.stringify({
          pid: process.pid,
          storeId: f.storeId,
          generation: session.ownerGeneration,
          root: f.root,
          target: f.target,
          card: card.id,
          edits: edits.map(({ id, callId }) => ({ id, callId })),
        }),
        { mode: 0o600 },
      );
      renameSync(ready + '.tmp', ready);
    }
    try {
      mkdirSync(join(f.target, '..'), { recursive: true });
      writeFileSync(f.target, restartSeed);
      const run = f.run();
      if (processPhase === 'pending') {
        await Promise.race([
          pending.promise,
          run.then(() => {
            throw Error('missing-batch-card');
          }),
        ]);
        await capture();
      }
      await stopped.promise;
    } finally {
      await f.close();
    }
  }, 30000);
}

for (const phase of restartPhases) {
  test.skipIf(process.platform === 'win32')(
    `same-file batch owned restart from ${phase} preserves shared effects and original receipts`,
    async () => {
      const parent = realpathSync(mkdtempSync(join(tmpdir(), 'kite-batch-restart-')));
      const child = Bun.spawn(
        [process.execPath, 'test', import.meta.path, '--test-name-pattern', restartFixtureName],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            ...process.env,
            KITE_TEST_FILE_BATCH_RESTART: phase,
            KITE_TEST_FILE_BATCH_RESTART_ROOT: parent,
          },
        },
      );
      const stdout = new Response(child.stdout).text(),
        stderr = new Response(child.stderr).text();
      let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
      let runtime: ReturnType<typeof createRuntime> | undefined;
      let artifacts: ReturnType<typeof createArtifactStore> | undefined;
      try {
        const path = join(parent, 'ready.json');
        const deadline = Date.now() + 12000;
        while (!existsSync(path)) {
          if (child.exitCode !== null) throw Error((await stdout) + (await stderr));
          if (Date.now() >= deadline) throw Error('restart barrier not reached');
          await Bun.sleep(10);
        }
        const ready = JSON.parse(readFileSync(path, 'utf8')) as {
          pid: number;
          root: string;
          target: string;
          storeId: string;
          generation: string;
          card: string;
          edits: { id: string; callId: string }[];
        };
        expect(ready.pid).toBe(child.pid);
        expect(ready.root.startsWith(parent + '/')).toBe(true);
        child.kill('SIGKILL');
        expect(await child.exited).not.toBe(0);
        const profile = selectProfile({ dataRoot: join(ready.root, 'profiles'), profile: 'test' });
        store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
        artifacts = createArtifactStore({ profile, store });
        runtime = createRuntime({
          store,
          artifacts,
          permissions: {
            async authorize() {
              throw Error('recovery_must_not_dispatch');
            },
          },
        });
        const ownership = { expectedStoreId: ready.storeId, sessionId: 's', subjectId: 'owner' };
        const reconciled = await runtime.reconcileSession({
          ...ownership,
          expectedOwnerGeneration: ready.generation,
          commandId: 'reconcile-owned-batch',
        });
        const expected =
          phase === 'pending'
            ? 'cancelled'
            : phase === 'published'
              ? 'outcome_unknown'
              : 'succeeded';
        const observe = async () =>
          Promise.all(ready.edits.map(({ id }) => store!.getExecution(id)));
        expect((await observe()).map((row) => row?.status)).toEqual([expected, expected]);
        if (reconciled.report)
          await runtime.recoverSession({
            ...ownership,
            expectedOwnerGeneration: reconciled.report.generation,
            commandId: 'recover-owned-batch',
            decision: 'interrupt',
          });
        const after = await observe();
        expect(after.map((row) => row?.status)).toEqual([expected, expected]);
        expect(after.filter((row) => row?.authorization?.dispatched)).toHaveLength(
          phase === 'pending' ? 0 : 1,
        );
        const messages = (await store.listMessages('s')).filter(
          (m) => m.role === 'tool' && ready.edits.some(({ callId }) => m.toolCallId === callId),
        );
        expect(messages.map(({ toolCallId }) => toolCallId).sort()).toEqual(
          ready.edits.map(({ callId }) => callId).sort(),
        );
        expect(readFileSync(ready.target, 'utf8')).toBe(
          phase === 'pending' ? restartSeed : restartUpdate,
        );
        if (phase === 'pending')
          expect(
            (await store.getInteraction({ ...ownership, interactionId: ready.card }))?.state,
          ).toBe('cancelled');
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
        await Promise.all([stdout, stderr]);
        await runtime?.close();
        await artifacts?.close();
        await store?.close();
        rmSync(parent, { recursive: true, force: true });
      }
    },
    25000,
  );
}

test('same-file batch reports one unknown effect for both original calls and does not write again', async () => {
  const original = 'alpha 1\nbeta 2\n';
  const updated = 'alpha 11\nbeta 22\n';
  const f = await fixture({
    mode: 'accept_edits',
    editOnly: true,
    failBatchSnapshot: true,
    program: (_body, step, _actor, paths) =>
      step === 0
        ? { name: 'read_file', input: { path: paths.target } }
        : step === 1
          ? [
              {
                name: 'edit_file',
                input: { path: paths.target, old_string: 'alpha 1', new_string: 'alpha 11' },
              },
              {
                name: 'edit_file',
                input: { path: paths.target, old_string: 'beta 2', new_string: 'beta 22' },
              },
            ]
          : null,
  });
  try {
    mkdirSync(join(f.target, '..'), { recursive: true });
    writeFileSync(f.target, original);
    await f.run();
    const snapshot = (await f.store.listExecutions('s')).filter(
      (value) => value.definitionId === 'files.edit',
    );
    expect(snapshot.map((value) => value.status)).toEqual(['outcome_unknown', 'outcome_unknown']);
    expect(snapshot.filter((value) => value.authorization?.dispatched)).toHaveLength(1);
    expect(readFileSync(f.target, 'utf8')).toBe(updated);
    const evidence = statSync(f.target, { bigint: true });
    await Bun.sleep(150);
    expect(
      (await f.store.listExecutions('s')).filter((value) => value.definitionId === 'files.edit'),
    ).toEqual(snapshot);
    expect(statSync(f.target, { bigint: true }).ino).toBe(evidence.ino);
    expect(statSync(f.target, { bigint: true }).mtimeNs).toBe(evidence.mtimeNs);
  } finally {
    await f.close();
  }
}, 20000);

for (const mode of ['accept_edits', 'auto', 'full'] as const) {
  test(`${mode} ordinary missing reads reach the next Model as observations with the final unified Files catalogue`, async () => {
    const f = await fixture({
      mode,
      program: (_body, step, _actor, paths) =>
        step < 2
          ? {
              name: 'read_file',
              input: { path: step === 0 ? 'missing-workspace.txt' : paths.target },
            }
          : null,
    });
    try {
      await f.run();
      const reads = (await f.store.listExecutions('s')).filter(
        (row) => row.definitionId === 'files.read',
      );
      expect(reads).toHaveLength(2);
      if (mode === 'auto') expect(f.reviewRequests()).toBe(0);
      for (const [index, row] of reads.entries()) {
        const path = index === 0 ? 'missing-workspace.txt' : f.target;
        expect(row.status).toBe('succeeded');
        expect(row.authorization?.dispatched).toBe(true);
        if (mode === 'auto') expect(row.authorization?.check).toBeUndefined();
        if (mode === 'accept_edits' && index === 1) expect(row.authorization?.human).toBeDefined();
        expect(row.result).toEqual({
          outcome: 'succeeded',
          content: `File does not exist: ${JSON.stringify(path)}.`,
          details: { path, exists: false },
        });
        expect(
          f.requests[index + 1]!.messages.some(
            (message) =>
              message.role === 'tool' &&
              message.content === `File does not exist: ${JSON.stringify(path)}.`,
          ),
        ).toBe(true);
      }
      for (const name of ['read_file', 'write_file', 'edit_file']) {
        const tool = f.requests[0]!.tools.find((value) => value.function.name === name)!.function;
        expect(tool.description).toContain(
          'Files read_file/write_file/edit_file use the current permission mode',
        );
        expect(tool.description).toContain('requests user approval for ordinary external paths');
        expect(tool.description).not.toContain('external reads are read-only and have no baseline');
        const properties = (
          tool.parameters as { properties: Record<string, { description?: string }> }
        ).properties;
        expect(properties.path!.description).toContain('including ordinary external files');
        expect(properties.filesystem).toBeUndefined();
        expect(properties.network).toBeUndefined();
      }
      expect(existsSync(f.target)).toBe(false);
      expect(
        (
          await f.runtime.listInteractions({
            expectedStoreId: f.storeId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions,
      ).toEqual([]);
    } finally {
      await f.close();
    }
  }, 20000);
}

test('ordinary missing PDF reaches the next model and completes the original Agent Run', async () => {
  const path = 'missing-report.pdf';
  const observation = 'File does not exist: "missing-report.pdf".';
  const finalText = 'Controlled file journey finished.';
  const f = await fixture({
    mode: 'auto',
    forbidHumanApproval: true,
    task: () => 'Check whether missing-report.pdf exists and report the observation.',
    program: (_body, step) => (step === 0 ? { name: 'read_file', input: { path } } : null),
  });
  try {
    await f.run();
    const command = await f.store.getCommand('work');
    expect(command?.status).toBe('applied');
    const runId = (command?.receipt as { runId: string }).runId;
    const run = await f.store.getRun(runId);
    const rows = (await f.store.listExecutions('s')).filter((row) => row.runId === runId);
    expect(run).toMatchObject({ status: 'completed', isActive: false });
    expect(rows.filter((row) => row.kind === 'model').map((row) => row.status)).toEqual([
      'succeeded',
      'succeeded',
    ]);
    expect(f.requests).toHaveLength(2);
    expect(f.reviewRequests()).toBe(0);
    expect(
      (await f.runtime.listMessages('s')).filter(
        (message) => message.role === 'assistant' && message.content === finalText,
      ),
    ).toHaveLength(1);
    expect(existsSync(join(f.workspace, path))).toBe(false);
    const tools = rows.filter((row) => row.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      definitionId: 'files.read',
      input: { path },
      authorization: { dispatched: true },
    });
    expect(tools[0]!.authorization?.check).toBeUndefined();
    expect({
      status: tools[0]!.status,
      result: tools[0]!.result,
      nextToolMessages: f.requests[1]!.messages.filter((message) => message.role === 'tool').map(
        (message) => message.content,
      ),
    }).toEqual({
      status: 'succeeded',
      result: {
        outcome: 'succeeded',
        content: observation,
        details: { path, exists: false },
      },
      nextToolMessages: [observation],
    });
  } finally {
    await f.close();
  }
}, 20000);

test('Full actual Service writes and edits an external file with native baselines and immutable Artifacts without checkpointing it', async () => {
  const first = 'before external 😀\r\n';
  const edited = 'after external 😀\r\n';
  const f = await fixture({
    program(body, step, _actor, paths): Call | null {
      if (step === 0) return { name: 'write_file', input: { path: paths.target, content: first } };
      if (step === 1 || step === 3) return { name: 'read_file', input: { path: paths.target } };
      if (step === 2) {
        const feedback = body.messages.filter((message) => message.role === 'tool').at(-1)!;
        const externalNotice =
          'External file; outside workspace checkpoints. The reference does not grant write permission.\n';
        expect(feedback.content).toContain(externalNotice);
        const actual = taskQualityPresentedRead(feedback.content.replace(externalNotice, ''));
        expect(actual?.path).toBe(paths.target);
        return {
          name: 'edit_file',
          input: {
            path: paths.target,
            old_string: 'before',
            new_string: 'after',
          },
        };
      }
      return step === 4
        ? {
            name: 'write_file',
            input: { path: 'local.txt', content: 'local checkpoint control' },
          }
        : null;
    },
  });
  try {
    await f.run();
    expect(readFileSync(f.target, 'utf8')).toBe(edited);
    const tools = (await f.store.listExecutions('s')).filter((e) => e.kind === 'tool');
    expect(tools.map((e) => [e.definitionId, e.status])).toEqual([
      ['files.write', 'succeeded'],
      ['files.read', 'succeeded'],
      ['files.edit', 'succeeded'],
      ['files.read', 'succeeded'],
      ['files.write', 'succeeded'],
    ]);
    expect(
      tools.every(
        (e) => e.authorization?.dispatched && !e.authorization.check && !e.authorization.human,
      ),
    ).toBe(true);
    for (const [execution, bytes] of [
      [tools[0]!, first],
      [tools[2]!, edited],
    ] as const) {
      const result = execution.result as {
        content: string;
        artifactRefs: { id: string; scope: { kind: 'execution'; id: string } }[];
      };
      const original = JSON.parse(result.content);
      expect(original.path).toBe(f.target);
      expect(original.baseline.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.artifactRefs).toHaveLength(1);
      const ref = result.artifactRefs[0]!;
      const artifact = await f.runtime.readArtifact({
        expectedStoreId: f.storeId,
        sessionId: 's',
        subjectId: 'owner',
        refId: ref.id,
        scope: ref.scope,
      });
      expect(Buffer.from(artifact.content).toString('utf8')).toBe(bytes);
    }
    const records = await f.store.listExtensionRecords({
      sessionId: 's',
      extensionId: 'builtin.files',
      limit: 200,
    });
    const capturedPaths = records
      .filter((r) => r.contentType === 'builtin.files.checkpoint.file')
      .map((r) => (r.value as unknown as FileCheckpointRecord).path);
    expect(capturedPaths).toEqual(['local.txt']);
    expect(
      await f.runtime.listInteractions({
        expectedStoreId: f.storeId,
        sessionId: 's',
        state: 'pending',
      }),
    ).toMatchObject({ interactions: [] });
  } finally {
    await f.close();
  }
}, 20000);

for (const mode of ['accept_edits', 'auto', 'full'] as const) {
  for (const decision of ['approve', 'deny', 'unavailable'] as const) {
    if (mode === 'full' && decision !== 'approve') continue;
    if (mode === 'accept_edits' && decision === 'unavailable') continue;
    test(`${mode} external Files write obeys ${decision} without unauthorized effects`, async () => {
      const f = await fixture({
        mode,
        decision,
        program: (_body, step, _actor, paths) =>
          step === 0
            ? { name: 'write_file', input: { path: paths.target, content: 'approved content' } }
            : null,
      });
      try {
        await f.run();
        const tool = (await f.store.listExecutions('s')).find(
          (row) => row.definitionId === 'files.write',
        )!;
        const approved = decision === 'approve';
        expect(existsSync(f.target)).toBe(approved);
        expect(tool.authorization?.dispatched).toBe(approved);
        expect(tool.status).toBe(approved ? 'succeeded' : 'failed');
        if (mode === 'auto')
          expect(tool.authorization?.check?.decision).toBe(
            decision === 'approve'
              ? 'approve_once'
              : decision === 'deny'
                ? 'reject'
                : 'unavailable',
          );
        if (approved) expect(readFileSync(f.target, 'utf8')).toBe('approved content');
      } finally {
        await f.close();
      }
    }, 30000);
  }
}

test('Full external file support keeps the private Profile protected', async () => {
  const f = await fixture({
    program: (_body, step, _actor, paths) =>
      step === 0
        ? {
            name: 'write_file',
            input: { path: paths.privateTarget, content: 'must not publish' },
          }
        : null,
  });
  const originalConfiguration = readFileSync(f.configurationPath);
  try {
    await f.run();
    expect(existsSync(f.privateTarget)).toBe(false);
    expect(readFileSync(f.configurationPath)).toEqual(originalConfiguration);
    const tool = (await f.store.listExecutions('s')).find((e) => e.definitionId === 'files.write')!;
    expect(tool.status).toBe('failed');
    expect(tool.result).toMatchObject({
      details: {
        code: 'permission_denied',
        reason: 'input_file_read_only',
        adapterAttempted: false,
        dispatchCommitted: false,
      },
    });
    expect((tool.result as { content: string }).content).toContain('input_file_read_only');
    expect(
      (
        await f.runtime.listInteractions({
          expectedStoreId: f.storeId,
          sessionId: 's',
          state: 'pending',
        })
      ).interactions,
    ).toEqual([]);
  } finally {
    await f.close();
  }
}, 20000);

for (const change of ['demote', 'untrust'] as const) {
  test(`Full external file publication rechecks durable ${change} before dispatch`, async () => {
    const f = await fixture({
      beforeDispatch: change,
      decision: 'deny',
      program: (_body, step, _actor, paths) =>
        step === 0
          ? {
              name: 'write_file',
              input: { path: paths.target, content: 'must not publish' },
            }
          : null,
    });
    try {
      await f.run();
      expect(f.changed()).toBe(true);
      expect(existsSync(f.target)).toBe(false);
      const tool = (await f.store.listExecutions('s')).find(
        (e) => e.definitionId === 'files.write',
      )!;
      expect(tool.status).not.toBe('succeeded');
      expect(tool.authorization?.dispatched).not.toBe(true);
      expect(
        (
          await f.runtime.listInteractions({
            expectedStoreId: f.storeId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions,
      ).toEqual([]);
    } finally {
      await f.close();
    }
  }, 20000);
}

for (const childFileCeiling of ['approval', 'deny'] as const) {
  test(`Full child retains an independent ${childFileCeiling} ceiling without widening the parent`, async () => {
    const f = await fixture({
      mode: 'full',
      childFileCeiling,
      program: (_body, step, actor, paths): Call | null =>
        actor === 'root'
          ? step === 0
            ? {
                name: 'spawn_agent',
                input: {
                  task_name: 'External write',
                  message: 'CHILD_LIMITED: write the owned file',
                },
              }
            : null
          : step === 0
            ? { name: 'write_file', input: { path: paths.target, content: 'explicitly approved' } }
            : null,
    });
    try {
      await f.run();
      const deadline = Date.now() + 8000;
      let carrier: Awaited<ReturnType<typeof f.store.listExecutions>>[number] | undefined;
      for (;;) {
        carrier = (await f.store.listExecutions('s')).find((row) => row.childSessionId);
        if (carrier && ['succeeded', 'failed', 'cancelled'].includes(carrier.status)) break;
        if (Date.now() > deadline) throw Error('full_child_ceiling_deadline');
        const { interactions } = await f.runtime.listInteractions({
          expectedStoreId: f.storeId,
          sessionId: 's',
          state: 'pending',
        });
        for (const card of interactions) {
          expect(childFileCeiling).toBe('approval');
          expect(existsSync(f.target)).toBe(false);
          await f.runtime.answerInteraction({
            expectedStoreId: f.storeId,
            commandId: `explicit-ceiling-${card.id}`,
            presentationSessionId: card.presentationSessionId,
            interactionId: card.id,
            expectedRevision: card.revision,
            subjectId: 'owner',
            answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
          });
        }
        await Bun.sleep(5);
      }
      const executions = await f.store.listExecutions(carrier.childSessionId!);
      const write = executions.find((row) => row.definitionId === 'files.write')!;
      expect(write).toBeDefined();
      expect(f.reviewRequests()).toBe(0);
      if (childFileCeiling === 'approval') {
        expect(readFileSync(f.target, 'utf8')).toBe('explicitly approved');
        expect(write.authorization?.human).toMatchObject({ accepted: true, decision: 'approve' });
      } else {
        expect(existsSync(f.target)).toBe(false);
        expect(write.authorization?.dispatched).toBe(false);
        expect(write.result).toMatchObject({
          outcome: 'failed',
          details: { reason: 'independent_child_denial', dispatchCommitted: false },
        });
      }
    } finally {
      await f.close();
    }
  }, 20000);
}

for (const mode of ['full', 'auto', 'accept_edits'] as const) {
  for (const preset of ['general', 'explore'] as const) {
    test(`${mode} child ${preset} preserves the selected file tool boundary`, async () => {
      const f = await fixture({
        mode,
        forbidHumanApproval: mode === 'full',
        program: (_body, step, actor, paths): Call | null =>
          actor === 'root'
            ? step === 0
              ? {
                  name: 'spawn_agent',
                  input: {
                    agent_type: preset,
                    task_name: 'Write fixture',
                    message: `CHILD_WRITE_ONLY: write ${paths.target} with the exact content child`,
                  },
                }
              : null
            : step === 0
              ? { name: 'write_file', input: { path: paths.target, content: 'child' } }
              : null,
      });
      try {
        await f.run();
        const deadline = Date.now() + 8000;
        let carrier = (await f.store.listExecutions('s')).find(
          (e) => e.kind === 'job' && e.childSessionId,
        );
        while (
          !carrier ||
          !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(carrier.status)
        ) {
          if (Date.now() > deadline) throw new Error('full_external_child_deadline');
          const { interactions } = await f.runtime.listInteractions({
            expectedStoreId: f.storeId,
            sessionId: 's',
            state: 'pending',
          });
          if (mode === 'full') expect(interactions).toEqual([]);
          for (const card of interactions)
            await f.runtime.answerInteraction({
              expectedStoreId: f.storeId,
              commandId: `child-answer-${card.id}`,
              presentationSessionId: card.presentationSessionId,
              interactionId: card.id,
              expectedRevision: card.revision,
              subjectId: 'owner',
              answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
            });
          await Bun.sleep(5);
          carrier = (await f.store.listExecutions('s')).find(
            (e) => e.kind === 'job' && e.childSessionId,
          );
        }
        const child = (await f.store.listExecutions(carrier.childSessionId!)).filter(
          (e) => e.kind === 'tool',
        );
        if (mode === 'full') {
          expect(f.reviewRequests()).toBe(0);
          const history = await f.runtime.listInteractions({
            expectedStoreId: f.storeId,
            sessionId: 's',
          });
          expect(history.interactions).toEqual([]);
          const rootMode = await f.store.readHostControl({
            expectedStoreId: f.storeId,
            subjectId: 'owner',
            kind: 'permission.mode',
            scope: 'session:s',
          });
          for (const execution of child.filter((row) => row.authorization?.dispatched)) {
            expect(execution.authorization?.human).toBeUndefined();
            expect(execution.authorization?.check).toBeUndefined();
            const db = new Database(f.databasePath, { readonly: true });
            try {
              const saved = db
                .query('SELECT dispatch_authorization_json AS proof FROM execution WHERE id=?')
                .get(execution.id) as { proof: string };
              expect(JSON.parse(saved.proof).controlReads).toContainEqual({
                kind: 'permission.mode',
                scope: 'session:s',
                revision: rootMode.revision,
              });
            } finally {
              db.close();
            }
          }
        }
        const childRequests = f.requests.filter((body) =>
          body.messages.some((m) => m.role === 'user' && m.content.startsWith('CHILD_')),
        );
        expect(childRequests.length).toBeGreaterThan(0);
        expect(childRequests[0]!.tools.some((tool) => tool.function.name === 'write_file')).toBe(
          preset === 'general',
        );
        if (preset === 'general') {
          expect(readFileSync(f.target, 'utf8')).toBe('child');
          expect(child.find((e) => e.definitionId === 'files.write')?.status).toBe('succeeded');
        } else {
          expect(existsSync(f.target)).toBe(false);
          expect(child.every((e) => e.status !== 'succeeded')).toBe(true);
        }
        expect(
          (
            await f.runtime.listInteractions({
              expectedStoreId: f.storeId,
              sessionId: 's',
              state: 'pending',
            })
          ).interactions,
        ).toEqual([]);
      } finally {
        await f.close();
      }
    }, 20000);
  }
}

for (const scope of ['workspace', 'external'] as const) {
  for (const name of ['read_file', 'write_file'] as const) {
    for (const decision of ['approve', 'deny', 'unavailable'] as const) {
      test(`Auto ${scope} ${name} uses the expected review boundary: ${decision}`, async () => {
        const f = await fixture({
          mode: 'auto',
          decision,
          program: (_body, step, _actor, paths) =>
            step === 0
              ? {
                  name,
                  input: {
                    path:
                      scope === 'workspace' ? join(paths.workspace, 'review.txt') : paths.target,
                    ...(name === 'write_file' ? { content: 'new' } : {}),
                  },
                }
              : null,
        });
        const path = scope === 'workspace' ? join(f.workspace, 'review.txt') : f.target;
        if (name === 'read_file') {
          mkdirSync(join(path, '..'), { recursive: true });
          writeFileSync(path, 'private fixture content');
        }
        try {
          await f.run();
          const row = (await f.store.listExecutions('s')).find(
            (e) => e.definitionId === (name === 'read_file' ? 'files.read' : 'files.write'),
          )!;
          const directRead = scope === 'workspace' && name === 'read_file';
          if (directRead) {
            expect(row.authorization?.check).toBeUndefined();
            expect(f.reviewRequests()).toBe(0);
            expect(row.status).toBe('succeeded');
            expect(JSON.stringify(row.result)).toContain('private fixture content');
          } else
            expect(row.authorization?.check?.decision).toBe(
              decision === 'approve'
                ? 'approve_once'
                : decision === 'deny'
                  ? 'reject'
                  : 'unavailable',
            );
          expect(row.authorization?.dispatched).toBe(directRead || decision === 'approve');
          if (name === 'write_file') expect(existsSync(path)).toBe(decision === 'approve');
          else if (!directRead && decision !== 'approve')
            expect(JSON.stringify(row.result)).not.toContain('private fixture content');
        } finally {
          await f.close();
        }
      }, 30000);
    }
  }
}

for (const mode of ['auto', 'accept_edits', 'full'] as const) {
  for (const decision of ['approve', 'deny'] as const) {
    if (mode === 'full' && decision === 'deny') continue;
    test(`${mode} retired session output stays protected even with ${decision}`, async () => {
      const f = await fixture({
        mode,
        decision,
        program: (_body, step, _actor, paths) =>
          step === 0
            ? { name: 'write_file', input: { path: paths.output, content: 'owned deliverable' } }
            : step === 1
              ? {
                  name: 'write_file',
                  input: { path: paths.foreignOutput, content: 'must not publish' },
                }
              : null,
      });
      try {
        await f.run();
        const writes = (await f.store.listExecutions('s')).filter(
          (row) => row.definitionId === 'files.write',
        );
        expect(writes[0]?.authorization?.dispatched).toBe(false);
        expect(existsSync(f.output)).toBe(false);
        expect(existsSync(f.foreignOutput)).toBe(false);
        expect(writes[1]?.authorization?.dispatched).toBe(false);
        expect(f.reviewRequests()).toBe(0);
      } finally {
        await f.close();
      }
    }, 30000);
  }
}

test('Auto reviewer timeout does not publish an external file or replay the write', async () => {
  const f = await fixture({
    mode: 'auto',
    decision: 'timeout',
    program: (_body, step, _actor, paths) =>
      step === 0 ? { name: 'write_file', input: { path: paths.target, content: 'never' } } : null,
  });
  try {
    await f.run();
    const writes = (await f.store.listExecutions('s')).filter(
      (row) => row.definitionId === 'files.write',
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.authorization?.dispatched).toBe(false);
    expect(existsSync(f.target)).toBe(false);
    expect(writes[0]?.authorization?.check?.decision).toBe('unavailable');
    // Preparation and queueing share the deadline with the recorded attempts.
    expect(f.reviewRequests()).toBeGreaterThan(0);
    expect(f.reviewRequests()).toBeLessThanOrEqual(3);
  } finally {
    await f.close();
  }
}, 30000);

for (const decision of ['approve', 'deny', 'timeout'] as const) {
  test(`Auto external edit obeys ${decision} after an independently approved baseline read`, async () => {
    const f = await fixture({
      mode: 'auto',
      decision,
      decisionTool: 'files.edit',
      program: (body, step, _actor, paths): Call | null => {
        if (step === 0) return { name: 'read_file', input: { path: paths.target } };
        if (step !== 1) return null;
        const feedback = body.messages.filter((m) => m.role === 'tool').at(-1)!;
        const actual = taskQualityPresentedRead(
          feedback.content.replace(
            'External file; outside workspace checkpoints. The reference does not grant write permission.\n',
            '',
          ),
        );
        expect(actual?.path).toBe(paths.target);
        return {
          name: 'edit_file',
          input: {
            path: paths.target,
            old_string: 'before',
            new_string: 'after',
          },
        };
      },
    });
    mkdirSync(join(f.target, '..'), { recursive: true });
    writeFileSync(f.target, 'before');
    try {
      await f.run();
      const row = (await f.store.listExecutions('s')).find((e) => e.definitionId === 'files.edit')!;
      expect(row.authorization?.dispatched).toBe(decision === 'approve');
      if (decision === 'timeout') expect(row.authorization?.check?.decision).toBe('unavailable');
      expect(readFileSync(f.target, 'utf8')).toBe(decision === 'approve' ? 'after' : 'before');
    } finally {
      await f.close();
    }
  }, 30000);
}

test('cancelling a pending Auto reviewer cannot later dispatch its approved write', async () => {
  const f = await fixture({
    mode: 'auto',
    decision: 'cancel',
    program: (_body, step, _actor, paths) =>
      step === 0 ? { name: 'write_file', input: { path: paths.target, content: 'never' } } : null,
  });
  try {
    const running = f.run();
    const end = Date.now() + 5000;
    while (!f.reviewing()) {
      if (Date.now() > end) throw Error('review_not_started');
      await Bun.sleep(5);
    }
    await f.runtime.cancelCommand({
      expectedStoreId: f.storeId,
      sessionId: 's',
      commandId: 'cancel',
      subjectId: 'owner',
      targetCommandId: 'work',
    });
    await running;
    await Bun.sleep(350);
    expect(existsSync(f.target)).toBe(false);
    const row = (await f.store.listExecutions('s')).find((e) => e.definitionId === 'files.write')!;
    expect(row.authorization?.dispatched).not.toBe(true);
  } finally {
    await f.close();
  }
}, 30000);

for (const absolutePath of [false, true])
  test(`Auto workspace read-back skips review and retains the native baseline; absolute=${absolutePath}`, async () => {
    const f = await fixture({
      mode: 'auto',
      decision: 'approve',
      program: (_body, step, _actor, paths): Call | null =>
        step === 0
          ? { name: 'write_file', input: { path: 'notes.md', content: 'WORKSPACE_READ_BACK' } }
          : step === 1
            ? {
                name: 'read_file',
                input: { path: absolutePath ? join(paths.workspace, 'notes.md') : 'notes.md' },
              }
            : null,
    });
    try {
      await f.run();
      expect(f.reviewRequests()).toBe(1); // The write still receives its own review.
      const read = (await f.store.listExecutions('s')).find(
        (row) => row.definitionId === 'files.read',
      )!;
      expect(read.status).toBe('succeeded');
      expect(read.authorization?.check).toBeUndefined();
      expect(JSON.stringify(read.result)).toContain('WORKSPACE_READ_BACK');
      expect(JSON.parse((read.result as { content: string }).content).baseline).toBeDefined();
    } finally {
      await f.close();
    }
  }, 30000);

// Default Service classification and actual SDK serialization, with controlled
// decisions. This proves the compact wire and execution gates, not model judgment.
for (const scope of ['workspace', 'external'] as const)
  for (const decision of ['approve', 'deny', 'ask_user'] as const)
    test(`default Auto Files compact wire preserves authored instructions: ${scope} / ${decision}`, async () => {
      const pathFor = (paths: Paths) =>
        scope === 'workspace' ? join(paths.workspace, 'wire.txt') : paths.target;
      const taskFor = (paths: Paths) => {
        const instruction = `Write ${JSON.stringify(pathFor(paths))} containing exactly "wire output".`;
        return scope === 'workspace'
          ? `These are my instructions, carry them out:\n\`\`\`text\n${instruction}\n\`\`\``
          : `These are my instructions, carry them out:\n> ${instruction}`;
      };
      let pendingApprovals = 0;
      const f = await fixture({
        mode: 'auto',
        decision,
        humanAnswer: 'deny',
        task: taskFor,
        beforeAnswer(paths) {
          pendingApprovals++;
          expect(existsSync(pathFor(paths))).toBe(false);
        },
        program: (_body, step, _actor, paths) =>
          step === 0
            ? {
                name: 'write_file',
                input: { path: pathFor(paths), content: 'wire output' },
              }
            : null,
      });
      try {
        await f.run();
        expect(f.reviewInputs).toHaveLength(1);
        const wire = f.reviewInputs[0]!;
        expect(wire.tools ?? []).toHaveLength(0);
        const system = wire.messages.find((message) => message.role === 'system')!.content;
        expect(system).toBe(authorizationCheckInstructions);
        expect(system).toContain(
          'User-authored instructions retain their authority when quoted or written in code blocks',
        );
        expect(system).toContain('never ask merely for incomplete context');
        const payload = JSON.parse(
          wire.messages.find((message) => message.role === 'user')!.content,
        );
        expect(payload.purpose).toBe('authorization_check');
        expect(payload).not.toHaveProperty('request');
        expect(payload).not.toHaveProperty('decisionContext');
        expect(payload.target).toMatchObject({
          definitionId: 'files.write',
          definitionVersion: '3',
          sessionId: 's',
          input: { path: pathFor(f), content: 'wire output' },
        });
        expect(payload.policy).toMatchObject({
          appliesToExecutionId: payload.target.executionId,
          constraints: {
            mode: 'auto',
            effects: scope === 'workspace' ? ['workspace_write'] : ['external'],
          },
        });
        expect(payload.authorizationContext.availability).toBe('available');
        expect(payload.authorizationContext.taskInputs).toContainEqual(
          expect.objectContaining({
            commandId: 'work',
            sessionId: 's',
            source: 'user',
            recipientRelation: 'current',
            content: taskFor(f),
          }),
        );
        const writes = (await f.store.listExecutions('s')).filter(
          (row) => row.definitionId === 'files.write',
        );
        expect(writes).toHaveLength(1);
        expect(writes[0]!.id).toBe(payload.target.executionId);
        expect(writes[0]!.authorization?.check?.decision).toBe(
          decision === 'approve' ? 'approve_once' : decision === 'deny' ? 'reject' : 'ask_user',
        );
        expect(writes[0]!.authorization?.dispatched).toBe(decision === 'approve');
        expect(existsSync(pathFor(f))).toBe(decision === 'approve');
        expect(pendingApprovals).toBe(decision === 'ask_user' ? 1 : 0);
      } finally {
        await f.close();
      }
    }, 30000);

for (const retryTimeouts of [2, 3])
  test(`Auto actual Files retries only the review request, not the write: ${retryTimeouts}`, async () => {
    const f = await fixture({
      mode: 'auto',
      retryTimeouts,
      program: (_body, step, _actor, paths) =>
        step === 0
          ? {
              name: 'write_file',
              input: { path: paths.target, content: 'exactly one approved write' },
            }
          : null,
    });
    try {
      await f.run();
      const writes = (await f.store.listExecutions('s')).filter(
        (e) => e.definitionId === 'files.write',
      );
      expect(writes).toHaveLength(1);
      expect(f.reviewRequests()).toBe(3);
      expect(writes[0]?.authorization?.dispatched).toBe(retryTimeouts === 2);
      expect(existsSync(f.target)).toBe(retryTimeouts === 2);
      if (retryTimeouts === 2)
        expect(readFileSync(f.target, 'utf8')).toBe('exactly one approved write');
      const checks = (await f.store.listExecutions('s')).filter(
        (e) => e.kind === 'model' && e.runId === null,
      );
      expect(checks).toHaveLength(1);
      expect(checks[0]?.result).toHaveProperty('reviewAttempts');
    } finally {
      await f.close();
    }
  }, 30000);

// The canary is only on the local source disk until the final dispatch consumes
// the private snapshot. SQLite serialization includes committed WAL contents.
function assertQuarantined(f: Awaited<ReturnType<typeof fixture>>, canary: string) {
  expect(JSON.stringify(f.requests)).not.toContain(canary);
  expect(JSON.stringify(f.reviewInputs)).not.toContain(canary);
  const database = new Database(f.databasePath, { readonly: true });
  try {
    expect(database.serialize().includes(Buffer.from(canary))).toBe(false);
  } finally {
    database.close();
  }
  const blobs = join(f.profilePath, 'blobs');
  if (existsSync(blobs))
    for (const path of readdirSync(blobs, { recursive: true })) {
      const entry = join(blobs, String(path));
      if (statSync(entry).isFile())
        expect(readFileSync(entry).includes(Buffer.from(canary))).toBe(false);
    }
}

for (const decision of ['approve', 'deny', 'unavailable', 'timeout', 'invalid'] as const)
  test(`Auto external read quarantines full bytes through ${decision}`, async () => {
    const canary = `UNREVIEWED_EXTERNAL_CANARY_${decision}_947`; // Never in task/input.
    const body = `${canary}\r\n${'x'.repeat(1100000)}\r\n`;
    let checked = false;
    const f = await fixture({
      mode: 'auto',
      decision,
      beforeReview(_request, paths) {
        assertQuarantined(f, canary);
        // A review cannot cause a second path read. Even replacement publishes
        // exactly the already frozen bytes, never the newly substituted file.
        writeFileSync(join(paths.root, 'replacement.txt'), 'REPLACED_DURING_REVIEW');
        renameSync(join(paths.root, 'replacement.txt'), paths.target);
        checked = true;
      },
      program: (_request, step, _actor, paths) =>
        step === 0 ? { name: 'read_file', input: { path: paths.target, limit: 10 } } : null,
    });
    mkdirSync(join(f.target, '..'), { recursive: true });
    writeFileSync(f.target, body);
    try {
      await f.run();
      expect(checked).toBe(true);
      const read = (await f.store.listExecutions('s')).find(
        (row) => row.definitionId === 'files.read',
      )!;
      if (decision === 'approve') {
        expect(read.status).toBe('succeeded');
        expect(read.authorization?.dispatched).toBe(true);
        const presented = f.requests
          .at(-1)!
          .messages.filter((m) => m.role === 'tool')
          .at(-1)!.content;
        expect(presented).toContain(canary);
        expect(presented).not.toContain('REPLACED_DURING_REVIEW');
        const result = read.result as { artifactRefs?: unknown[] };
        expect(result.artifactRefs).toHaveLength(1);
      } else {
        expect(read.authorization?.dispatched).not.toBe(true);
        assertQuarantined(f, canary);
      }
    } finally {
      await f.close();
    }
  }, 30000);

test('cancelling an external Auto read discards its snapshot and ignores late allow', async () => {
  const canary = 'CANCELLED_EXTERNAL_READ_BODY_947';
  const f = await fixture({
    mode: 'auto',
    decision: 'cancel',
    program: (_body, step, _actor, paths) =>
      step === 0 ? { name: 'read_file', input: { path: paths.target } } : null,
  });
  mkdirSync(join(f.target, '..'), { recursive: true });
  writeFileSync(f.target, canary);
  try {
    const running = f.run();
    const end = Date.now() + 5000;
    while (!f.reviewing()) {
      if (Date.now() > end) throw Error('review_not_started');
      await Bun.sleep(5);
    }
    assertQuarantined(f, canary);
    await f.runtime.cancelCommand({
      expectedStoreId: f.storeId,
      sessionId: 's',
      commandId: 'cancel-read',
      subjectId: 'owner',
      targetCommandId: 'work',
    });
    await running;
    await Bun.sleep(350);
    assertQuarantined(f, canary);
    const read = (await f.store.listExecutions('s')).find(
      (row) => row.definitionId === 'files.read',
    )!;
    expect(read.authorization?.dispatched).not.toBe(true);
  } finally {
    await f.close();
  }
}, 30000);

for (const error of ['encoding', 'binary', 'not-directory', 'protected'] as const)
  test(`Auto external pre-read ${error} is not a missing observation or an approval`, async () => {
    const f = await fixture({
      mode: 'auto',
      decision: 'approve',
      program: (_body, step, _actor, paths) =>
        step === 0
          ? {
              name: 'read_file',
              input: { path: error === 'protected' ? paths.privateTarget : paths.target },
            }
          : null,
    });
    if (error === 'not-directory') {
      mkdirSync(join(f.root, 'external'));
      writeFileSync(join(f.root, 'external', 'missing-parent'), 'not a directory');
    } else if (error !== 'protected') {
      mkdirSync(join(f.target, '..'), { recursive: true });
      writeFileSync(
        f.target,
        error === 'encoding' ? Buffer.from([0xff]) : Buffer.from([65, 0, 66]),
      );
    }
    try {
      await f.run();
      const read = (await f.store.listExecutions('s')).find(
        (row) => row.definitionId === 'files.read',
      )!;
      expect(read.status).toBe('failed');
      expect(read.authorization?.dispatched).not.toBe(true);
      expect(f.reviewRequests()).toBe(0);
      expect(JSON.stringify(read.result)).not.toContain('"exists":false');
      expect(JSON.stringify(read.result)).not.toContain('File does not exist');
    } finally {
      await f.close();
    }
  }, 30000);

for (const mode of ['auto', 'full'] as const)
  for (const exists of [true, false])
    for (const params of [{ pages: '1' }, { mode: 'text' }, { mode: 'image' }] as Record<
      string,
      Json
    >[])
      test(`${mode} external ${exists ? 'present' : 'missing'} read rejects retired PDF options: ${JSON.stringify(params)}`, async () => {
        const canary = 'INVALID_PDF_OPTIONS_EXTERNAL_TEXT_947';
        const f = await fixture({
          mode,
          decision: 'approve',
          program: (_body, step, _actor, paths) =>
            step === 0 ? { name: 'read_file', input: { path: paths.target, ...params } } : null,
        });
        if (exists) {
          mkdirSync(join(f.target, '..'), { recursive: true });
          writeFileSync(f.target, canary);
        }
        try {
          await f.run();
          const read = (await f.store.listExecutions('s')).find(
            (row) => row.definitionId === 'files.read',
          )!;
          expect(read.status).toBe('failed');
          const code = 'invalid_tool_arguments';
          expect(read.result).toMatchObject({
            outcome: 'failed',
            content: code,
            details: { code },
          });
          expect(read.authorization?.dispatched).toBe(false);
          expect(f.reviewRequests()).toBe(0);
          assertQuarantined(f, canary);
          expect(existsSync(f.target)).toBe(exists);
        } finally {
          await f.close();
        }
      }, 30000);

for (const mode of ['auto', 'full'] as const)
  test(mode +
    ' gives Shell guidance for external document types without opening them for review', async () => {
    const canary = 'PRIVATE_DOCUMENT_BODY_SHOULD_REMAIN_UNREAD';
    const documentPath = (target: string) => join(target, '..', 'scope.pdf');
    const f = await fixture({
      mode,
      decision: 'approve',
      program: (_body, step, _actor, paths) =>
        step === 0 ? { name: 'read_file', input: { path: documentPath(paths.target) } } : null,
    });
    const path = documentPath(f.target);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, canary);
    try {
      await f.run();
      const read = (await f.store.listExecutions('s')).find(
        (row) => row.definitionId === 'files.read',
      )!;
      expect(read.status).toBe('failed');
      const result = read.result as { content: string; artifactRefs?: unknown[] };
      expect(result).toMatchObject({ details: { code: 'unsupported_file_type' } });
      expect(result.content).toContain('pdf-text');
      expect(result.artifactRefs).toBeUndefined();
      expect(f.reviewRequests()).toBe(0);
      assertQuarantined(f, canary);
    } finally {
      await f.close();
    }
  }, 30000);

test('Full read-only external fallback rejects a PDF header after leading bytes', async () => {
  const targetPath = (target: string) => join(target, '..', 'prefixed.ts');
  const f = await fixture({
    mode: 'full',
    program: (_body, step, _actor, paths) =>
      step === 0 ? { name: 'read_file', input: { path: targetPath(paths.target) } } : null,
  });
  const path = targetPath(f.target);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.concat([Buffer.from('\r\n'), simplePdf()]));
  // A second link forces the read-only adapter to handle the refusal.
  linkSync(path, join(path, '..', 'prefixed-link.ts'));
  try {
    await f.run();
    const read = (await f.store.listExecutions('s')).find(
      (row) => row.definitionId === 'files.read',
    )!;
    expect(read.status).toBe('failed');
    expect(read.result).toMatchObject({
      content: expect.stringContaining('pdf-text'),
      details: { code: 'unsupported_file_type' },
    });
    assertQuarantined(f, 'Hello PDF');
  } finally {
    await f.close();
  }
}, 30000);

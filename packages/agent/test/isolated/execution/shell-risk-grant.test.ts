import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import type {
  AuthorizationRequest,
  JobDefinition,
  JobEvent,
  Json,
  Permissions,
} from '../../../src/extensions';
import { createPermissionPolicy } from '../../../src/permissions';
import { intersectPermissionPolicies } from '../../../src/permissions/inheritance';
import { openSqliteStore } from '../../../src/sqlite';
import { createShellExtension } from '../../../src/tools/shell';
import { createShellToolBehaviors } from '../../../src/tools/shell-approval';
import { fixtureReviewBinding } from '../../fixtures/review-behavior';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const command = (input: Json) => (input as { command: string }).command;

async function fixture(
  options: {
    changedCommand?: boolean;
    independentJobApproval?: boolean;
    genericCheck?: boolean;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-risk-grant-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const commands = ['printf same', options.changedCommand ? 'printf different' : 'printf same'];
  const starts: { command: string; reviewed: boolean }[] = [];
  let reviews = 0;
  const job: JobDefinition = {
    id: 'shell.command',
    version: '1',
    description: 'Controlled inert Job; records one marker without interpreting Shell text.',
    inputSchema: { type: 'object' },
    async start(input, context) {
      starts.push({
        command: command(input),
        reviewed: context.dispatchAuthorization?.materialReviewed === true,
      });
      appendFileSync(join(root, 'effects'), `${command(input)}\n`);
      return { reference: { command: command(input) } };
    },
    async *observe(): AsyncIterable<JobEvent> {
      yield {
        type: 'terminal',
        result: { outcome: 'succeeded', content: 'One controlled effect recorded.' },
        supervision: 'ended',
      };
    },
    async cancel() {
      return { status: 'already_finished' };
    },
    async dispose() {},
  };
  const extension = createShellExtension({ job });
  const model = createFixedModel([
    ...commands.map((value, index): ModelEvent[] => [
      {
        type: 'tool_call',
        id: `call-${index}`,
        name: 'shell_execute',
        arguments: JSON.stringify({ command: value }),
      },
      { ...finish, reason: 'tool_calls' },
    ]),
    [{ type: 'text_delta', text: 'Both controlled effects completed.' }, finish],
  ]);
  const prepareRiskReview = async (request: AuthorizationRequest) => {
    return {
      material: { command: command(request.input), cwd: root },
      fingerprint: hash({ command: command(request.input), cwd: root }),
      reusable: false,
    };
  };
  const behaviors = createShellToolBehaviors({
    extensions: [extension],
    snapshot: { configuration: 'fixture' },
    commandDigest: (request) =>
      hash({
        kind: request.kind,
        definitionId: request.definitionId,
        command: command(request.input),
      }),
    prepareRiskReview,
  });
  const policy = createPermissionPolicy({
    readPolicy: () => ({
      mode: 'auto',
      workspaceTrust: true,
      revision: 'stable-authority',
      allowed: [
        { kind: 'model', definitionId: 'fixed', definitionVersion: '1' },
        ...extension.tools!.map((tool) => ({
          kind: 'tool' as const,
          definitionId: tool.id,
          definitionVersion: tool.version,
        })),
        { kind: 'job', definitionId: 'shell.command', definitionVersion: '1' },
      ],
    }),
    describeCapability: async (request: AuthorizationRequest) => ({
      kind: request.kind,
      definitionId: request.definitionId,
      definitionVersion: request.definitionVersion,
      revision: 'actual-controlled-registration',
      hardAllowed: true,
      safeRead: false,
      effects: request.kind === 'model' ? ['network'] : ['process', 'unknown'],
      ...(request.kind !== 'model'
        ? {
            autoReview: 'check' as const,
            reviewBehavior: fixtureReviewBinding(behaviors, request),
            grantSatisfiesDefaultCheck: true as const,
            grantOffers:
              (await behaviors
                .find(
                  (behavior) =>
                    behavior.capability.kind === request.kind &&
                    behavior.capability.definitionId === request.definitionId,
                )
                ?.grantOffers?.(request)) ?? [],
            executionScope: { filesystem: 'workspace_write' as const, network: 'none' as const },
            autoReviewKey: hash({ command: command(request.input) }),
            commandDigest: hash({
              kind: request.kind,
              definitionId: request.definitionId,
              command: command(request.input),
            }),
          }
        : {}),
    }),
  });
  const effectivePolicy = options.genericCheck
    ? intersectPermissionPolicies(policy, {
        async authorize(request) {
          return request.kind === 'model'
            ? { allowed: true, revision: 'independent-generic' }
            : {
                allowed: false,
                revision: 'independent-generic',
                check: {
                  request: { purpose: 'independent-policy' },
                  operationKey: hash({ command: command(request.input) }),
                },
              };
        },
      })
    : policy;
  const permissions: Permissions = {
    toolDispatchOrder: effectivePolicy.toolDispatchOrder,
    reuseRevision: effectivePolicy.reuseRevision,
    async authorize(request) {
      const decision = await effectivePolicy.authorize(request);
      return options.independentJobApproval && request.kind === 'job' && decision.check
        ? { ...decision, check: { ...decision.check, requireApproval: true } }
        : decision;
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model,
    modelId: 'fixed',
    permissions,
    extensions: [extension],
    toolBehaviors: behaviors,
    authorizationCheck: {
      id: 'risk',
      version: 'same-command-fixture',
      modelId: 'reviewer',
      timeoutMs: 5000,
      model: {
        async *stream() {
          reviews++;
          yield {
            type: 'text_delta',
            text: JSON.stringify(
              options.genericCheck
                ? {
                    decision: 'approve_once',
                    reason: 'Independent generic checker accepts only this invocation.',
                  }
                : {
                    risk: 'high',
                    reason: 'Controlled high-risk finding for this exact operation.',
                  },
            ),
          };
          yield finish;
        },
      },
    },
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'fixture',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'Risk grants',
  });
  const interactions = () =>
    runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' });
  return {
    root,
    runtime,
    store,
    model,
    starts,
    counts: () => ({ effects: starts.length, reviews }),
    async run() {
      await runtime.submitCommand({
        expectedStoreId,
        commandId: 'work',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'Run the two exact controlled Shell operations.' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 4000 });
      return (await store.getView('s')).runs[0]!;
    },
    async pending() {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const card = (await interactions()).interactions[0];
        if (card) return card;
        await Bun.sleep(5);
      }
      throw Error('expected_risk_grant_approval_card');
    },
    async approve(
      card: Awaited<ReturnType<typeof interactions>>['interactions'][number],
      grant: 'same_command' | 'approve_once',
    ) {
      await runtime.answerInteraction({
        expectedStoreId,
        commandId: `answer-${card.id}`,
        presentationSessionId: card.presentationSessionId,
        interactionId: card.id,
        expectedRevision: card.revision,
        subjectId: 'owner',
        answer: {
          kind: 'approval',
          decision: 'approve',
          optionId: (
            card.request as { options: { kind: string; optionId: string }[] }
          ).options.find((option) => option.kind === (grant === 'same_command' ? 'scope' : 'once'))!
            .optionId,
        },
      });
    },
    async close() {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('Auto same_command Tool grant carries to its exact next Job without a second risk review or approval', async () => {
  const f = await fixture();
  try {
    const work = f.run();
    void work.catch(() => {});
    const card = await f.pending();
    expect(card.definitionId).toBe('shell.execute');
    expect(f.counts()).toEqual({ effects: 0, reviews: 1 });
    await f.approve(card, 'same_command');
    expect((await work).status).toBe('completed');
    expect(f.counts()).toEqual({ effects: 2, reviews: 1 });
    expect(readFileSync(join(f.root, 'effects'), 'utf8')).toBe('printf same\nprintf same\n');
    expect(f.starts).toEqual([
      { command: 'printf same', reviewed: true },
      { command: 'printf same', reviewed: false },
    ]);
    const jobs = (await f.store.listExecutions('s')).filter(
      (row) => row.definitionId === 'shell.command',
    );
    expect(jobs).toHaveLength(2);
    for (const current of jobs)
      expect(current).toMatchObject({
        status: 'succeeded',
        authorization: { policy: { reason: 'parent_review' } },
      });
    expect(
      (
        await f.runtime.listInteractions({
          expectedStoreId: (await f.store.getMetadata()).storeId,
          sessionId: 's',
        })
      ).interactions,
    ).toHaveLength(1);
    expect(
      f.model.requests.at(-1)!.messages.filter((message) => message.role === 'tool'),
    ).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('Auto same_command grant cannot authorize a different Shell command', async () => {
  const f = await fixture({ changedCommand: true });
  try {
    const work = f.run();
    void work.catch(() => {});
    const original = await f.pending();
    await f.approve(original, 'same_command');
    const changed = await f.pending();
    expect(changed.id).not.toBe(original.id);
    expect(changed.definitionId).toBe('shell.execute');
    expect(changed.request).toMatchObject({ input: { command: 'printf different' } });
    expect(f.counts()).toEqual({ effects: 1, reviews: 2 });
    await f.approve(changed, 'approve_once');
    expect((await work).status).toBe('completed');
    expect(f.counts()).toEqual({ effects: 2, reviews: 2 });
    expect(readFileSync(join(f.root, 'effects'), 'utf8')).toBe('printf same\nprintf different\n');
  } finally {
    await f.close();
  }
});

test('Auto same_command parent grant never removes an independent Job approval', async () => {
  const f = await fixture({ independentJobApproval: true });
  try {
    const work = f.run();
    void work.catch(() => {});
    const tool = await f.pending();
    expect(tool.definitionId).toBe('shell.execute');
    await f.approve(tool, 'same_command');
    const firstJob = await f.pending();
    expect(firstJob.definitionId).toBe('shell.command');
    expect(f.counts()).toEqual({ effects: 0, reviews: 2 });
    await f.approve(firstJob, 'approve_once');
    const nextJob = await f.pending();
    expect(nextJob.id).not.toBe(firstJob.id);
    expect(nextJob.definitionId).toBe('shell.command');
    expect(f.counts()).toEqual({ effects: 1, reviews: 3 });
    await f.approve(nextJob, 'approve_once');
    expect((await work).status).toBe('completed');
    expect(f.counts()).toEqual({ effects: 2, reviews: 3 });
    expect(readFileSync(join(f.root, 'effects'), 'utf8')).toBe('printf same\nprintf same\n');
  } finally {
    await f.close();
  }
});

test('generic checker fallback cannot turn domain nonreusable Shell material into cross-call reuse', async () => {
  const f = await fixture({ genericCheck: true });
  try {
    expect((await f.run()).status).toBe('completed');
    expect(f.counts()).toEqual({ effects: 2, reviews: 2 });
    const checks = (await f.store.listExecutions('s')).filter(
      (row) => row.kind === 'model' && row.definitionId === 'reviewer',
    );
    expect(checks).toHaveLength(2);
  } finally {
    await f.close();
  }
});

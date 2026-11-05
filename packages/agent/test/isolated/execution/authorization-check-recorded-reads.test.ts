import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent, type ModelRequest } from '@kite-ai/ai';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { createArtifactStore } from '../../../src/artifacts';
import type { Extension, ToolResult } from '../../../src/extensions';
import { canonicalJson, semanticDigest } from '../../../src/json';
import { createPermissionPolicy } from '../../../src/permissions';
import { createPermissionCheckContextReader } from '../../../src/permissions/check-context';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage/types';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (id: string, name: string, input: Json): ModelEvent[] => [
  { type: 'tool_call', id, name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
async function fixture(
  options: {
    large?: boolean;
    trusted?: boolean;
    legacyCompact?: boolean;
    human?: boolean;
    aliasWorkspace?: boolean;
  } = {},
) {
  const root = temporaryDirectory('kite-review-file-evidence-');
  const canonicalRoot = realpathSync(root);
  const workspaceRoot = options.aliasWorkspace ? join(root, 'workspace-alias') : root;
  if (options.aliasWorkspace) symlinkSync(canonicalRoot, workspaceRoot, 'dir');
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  let runtime!: ReturnType<typeof createRuntime>,
    reviews = 0,
    effects = 0;
  const reviewInputs: ModelRequest[] = [];
  let originalEnsure: Parameters<typeof store.ensureAuthorizationCheck>[0] | undefined;
  const ensure = store.ensureAuthorizationCheck.bind(store);
  store.ensureAuthorizationCheck = async (input) => {
    originalEnsure = structuredClone(input);
    const fact = await ensure(input);
    if (!options.legacyCompact || !fact.created) return fact;
    // Simulate the exact previous compact producer before sealing its Model input.
    // The old shape differs only by absence of this new presentation evidence field.
    const payload = structuredClone(fact.input) as Record<string, Json>;
    const context = payload.authorizationContext as Record<string, Json>;
    delete context.recordedReads;
    const command = (await store.getCommand(fact.commandId))!;
    const request = { ...(command.request as Record<string, Json>), input: payload };
    const hash = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
    const physical = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
    try {
      physical.run(
        'UPDATE command SET request_json=?,request_digest=?,operation_key=? WHERE id=?',
        [canonicalJson(request), hash(request), `check/${hash(payload)}`, command.id],
      );
    } finally {
      physical.close();
    }
    return { ...fact, input: payload };
  };
  const artifactBody = options.large
    ? `${'Z'.repeat(1024 * 1024 + 3)}\n`
    : 'tiny exact artifact page\n';
  const ordinary = createFixedModel([
    call('job', 'files.read', { path: 'job.json' }),
    call('script', 'files.read', { path: 'validate.sh' }),
    call('unrelated', 'files.read', { path: 'unrelated.txt' }),
    call('artifact', 'files.read', { path: 'large.txt' }),
    call('execute', 'shell.execute', { command: './validate.sh', key: 'registered-validator' }),
    [finish],
  ]);
  const fileExtension: Extension = {
    id: options.trusted === false ? 'other-extension' : 'builtin.files',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'files.read',
        version: '4',
        description: 'Synthetic exact Files text read result',
        inputSchema: { type: 'object' },
        async execute(input, context): Promise<ToolResult> {
          const path = String((input as { path: string }).path);
          const text =
            path === 'job.json'
              ? '{"validator":"./validate.sh","fallback":"result.json"}\n'
              : path === 'validate.sh'
                ? '#!/bin/sh\nprintf validated\n'
                : path === 'large.txt'
                  ? artifactBody
                  : 'UNRELATED_FILE_MUST_NOT_ENTER_REVIEW\n';
          const metadata = {
            path,
            baseline: {
              hash: createHash('sha256').update(text).digest('hex'),
              size: Buffer.byteLength(text),
              device: '1',
              inode: path,
            },
            selection: {
              fromLine: 1,
              toLine: text.split('\n').length - 1,
              totalLines: text.split('\n').length - 1,
              nextOffset: null,
            },
            executionId: context.executionId,
            runId: context.runId,
          };
          if (path !== 'large.txt')
            return {
              outcome: 'succeeded',
              content: JSON.stringify({ ...metadata, content: text }),
            };
          const reference = await context.artifacts!.publish({
            key: 'read.body',
            content: Buffer.from(text),
            mediaType: 'text/plain',
          });
          return {
            outcome: 'succeeded',
            content: JSON.stringify({
              ...metadata,
              body: { complete: true, encoding: 'utf-8', format: 'file_text', reference },
              inlineBody: false,
            }),
            artifactRefs: [reference],
            modelContent: { kind: 'artifact', reference, encoding: 'utf-8' },
          };
        },
      },
    ],
  };
  const policy = createPermissionPolicy({
    readPolicy: () => ({
      mode: 'auto',
      workspaceTrust: true,
      revision: 'current',
      allowed: [
        { kind: 'model', definitionId: 'fixed', definitionVersion: '1' },
        { kind: 'tool', definitionId: 'files.read', definitionVersion: '4' },
        { kind: 'tool', definitionId: 'shell.execute', definitionVersion: '1' },
      ],
    }),
    describeCapability: (request) => ({
      kind: request.kind,
      definitionId: request.definitionId,
      definitionVersion: request.definitionVersion,
      revision: 'fixture',
      hardAllowed: true,
      safeRead: request.definitionId !== 'shell.execute',
      effects:
        request.definitionId === 'shell.execute'
          ? ['process', 'unknown']
          : request.kind === 'model'
            ? []
            : ['read'],
      ...(request.definitionId === 'shell.execute'
        ? { executionScope: { filesystem: 'workspace_write' as const, network: 'none' as const } }
        : {}),
    }),
    readCheckContext: createPermissionCheckContextReader({
      readRuntime: () => runtime,
      subjectId: 'owner',
      originStoreId: expectedStoreId,
    }),
  });
  runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model: ordinary,
    modelId: 'fixed',
    permissions: {
      async authorize(request) {
        const decision = await policy.authorize(request);
        return (options.legacyCompact || options.human) && decision.check
          ? { ...decision, check: { ...decision.check, requireApproval: true } }
          : decision;
      },
    },
    authorizationCheck: {
      id: 'checker',
      version: '1',
      modelId: 'reviewer',
      timeoutMs: 10000,
      model: {
        async *stream(input) {
          reviews++;
          reviewInputs.push(structuredClone(input));
          yield {
            type: 'text_delta',
            text: '{"decision":"approve_once","reason":"Exact registered operation under the fixture task."}',
          };
          yield finish;
        },
      },
    },
    extensions: [
      fileExtension,
      {
        id: 'builtin.shell',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'shell.execute',
            version: '1',
            description: 'Controlled effect counter, no native Shell',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              return { outcome: 'succeeded', content: 'validated' };
            },
          },
        ],
      },
    ],
    ...(options.aliasWorkspace
      ? {
          resolveRunConfiguration: async () => ({
            model: ordinary,
            modelId: 'fixed',
            snapshot: {
              version: 1,
              digest: 'fixture-service-host',
              configuration: { shell: { available: true, cwd: '/business/not-runtime' } },
              shell: { available: true, cwd: canonicalRoot },
            },
            toolIds: ['files.read', 'shell.execute'],
          }),
        }
      : {}),
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(workspaceRoot).href,
    name: 'Fixture',
  });
  await runtime.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'File evidence',
  });
  const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  return {
    store,
    runtime,
    scope,
    reviewInputs,
    artifactBody,
    workspaceRoot,
    canonicalRoot,
    counts: () => ({ reviews, effects }),
    ensureInput: () => originalEnsure!,
    async completeLaterRead() {
      const input = originalEnsure!;
      const target = (await store.getExecution(input.targetExecutionId))!;
      const owned = { expectedStoreId, owner: input.owner };
      const source = { kind: 'host_intent', commandId: target.originCommandId };
      const readInput = { path: 'job.json' };
      const execution = await store.planExecution({
        ...owned,
        executionId: 'later-read',
        sessionId: 's',
        runId: target.runId,
        originCommandId: target.originCommandId,
        stepId: 'later-read',
        callId: 'later-read',
        kind: 'tool',
        definitionId: 'files.read',
        definitionVersion: '4',
        input: readInput,
        decisionSource: source,
      });
      await store.markDispatching({
        ...owned,
        executionId: execution.id,
        authorization: {
          allowed: true,
          revision: 'allowed-read',
          definitionVersion: '4',
          inputDigest: await semanticDigest(readInput),
        },
        requirements: [],
        freshness: { checked: true, source },
      });
      const text = '{"validator":"./validate.sh","fallback":"result.json","new_fact":true}\n';
      await store.finishExecution({
        ...owned,
        executionId: execution.id,
        status: 'succeeded',
        result: {
          outcome: 'succeeded',
          content: JSON.stringify({
            path: 'job.json',
            content: text,
            baseline: {
              hash: createHash('sha256').update(text).digest('hex'),
              size: Buffer.byteLength(text),
              device: '1',
              inode: 'later-read',
            },
            selection: { fromLine: 1, toLine: 1, totalLines: 1, nextOffset: null },
            executionId: execution.id,
            runId: target.runId,
          }),
        },
      });
    },
    async start() {
      await runtime.submitCommand({
        ...scope,
        commandId: 'work',
        request: {
          kind: 'run.start',
          content:
            'Use job.json for registered validator and fallback targets; inspect large.txt as task data. Do not choose unrelated files.',
        },
      });
    },
    async finish() {
      await runtime.waitForCommand('work');
    },
    async close() {
      await runtime.close();
      await store.close();
      if (options.aliasWorkspace) unlinkSync(workspaceRoot);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const large of [false, true])
  test(`compact reviewer receives exact named file evidence and ${large ? 'large' : 'tiny'} Artifact page with public Inspector matching the actual request`, async () => {
    const f = await fixture({ large });
    try {
      await f.start();
      await f.finish();
      expect(f.counts()).toEqual({ reviews: 1, effects: 1 });
      const actual = f.reviewInputs[0]!;
      const payload = JSON.parse(
        actual.messages.find((message) => message.role === 'user')!.content,
      );
      expect(
        payload.authorizationContext.recordedReads.map((read: { path: string }) => read.path),
      ).toEqual(['job.json', 'validate.sh', 'large.txt']);
      expect(JSON.stringify(payload)).not.toContain('UNRELATED_FILE_MUST_NOT_ENTER_REVIEW');
      const page = payload.authorizationContext.recordedReads.find(
        (read: { path: string }) => read.path === 'large.txt',
      );
      expect(page.body).toBe(f.artifactBody);
      expect(page.bodyScope).toBe('recorded_selected_window');
      expect(page.selection.nextOffset).toBeNull();
      const execution = (await f.store.getExecution(actual.requestId))!;
      expect(execution.input).toHaveProperty('body');
      expect(execution.input).not.toHaveProperty('messages');
      const first = await f.runtime.readModelInput({ ...f.scope, executionId: actual.requestId });
      const second = await f.runtime.readModelInput({ ...f.scope, executionId: actual.requestId });
      expect(first.request).toEqual(actual);
      expect(second.request).toEqual(actual);
      expect(first.bodyHash).toBe(second.bodyHash);
      expect(
        JSON.parse(first.request.messages.find((message) => message.role === 'user')!.content),
      ).toEqual(payload);
    } finally {
      await f.close();
    }
  });

test('a selected same-name external extension does not contribute builtin recorded file evidence', async () => {
  const f = await fixture({ trusted: false });
  try {
    await f.start();
    await f.finish();
    const payload = JSON.parse(
      f.reviewInputs[0]!.messages.find((message) => message.role === 'user')!.content,
    );
    expect(payload.authorizationContext.recordedReads).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('registered validator and fallback targets"');
    expect(f.counts()).toEqual({ reviews: 1, effects: 1 });
  } finally {
    await f.close();
  }
});

test('an actual workspace symlink and its frozen builtin Shell canonical root select the same explicitly named script', async () => {
  const f = await fixture({ aliasWorkspace: true });
  try {
    expect(f.workspaceRoot).not.toBe(f.canonicalRoot);
    expect(realpathSync(f.workspaceRoot)).toBe(f.canonicalRoot);
    await f.start();
    await f.finish();
    const payload = JSON.parse(
      f.reviewInputs[0]!.messages.find((message) => message.role === 'user')!.content,
    );
    expect(payload.authorizationContext.workspaceRoot).toBe(f.workspaceRoot);
    expect(payload.authorizationContext.executionBase.cwd).toBe(f.canonicalRoot);
    expect(
      payload.authorizationContext.recordedReads.find(
        (read: { path: string }) => read.path === 'validate.sh',
      ),
    ).toMatchObject({
      matchedBy: 'current_operation',
      absolutePath: join(f.workspaceRoot, 'validate.sh'),
      canonicalPath: join(f.canonicalRoot, 'validate.sh'),
    });
    expect(f.counts()).toEqual({ reviews: 1, effects: 1 });
  } finally {
    await f.close();
  }
});

for (const legacyCompact of [true, false])
  test(`a sealed ${legacyCompact ? 'older compact check without recordedReads' : 'current compact check after another relevant read completes'} is reused exactly while human approval is pending`, async () => {
    const f = await fixture({ legacyCompact, human: true });
    try {
      await f.start();
      let card:
        | Awaited<ReturnType<typeof f.runtime.listInteractions>>['interactions'][number]
        | undefined;
      const deadline = Date.now() + 5000;
      while (!card) {
        card = (await f.runtime.listInteractions({ ...f.scope, state: 'pending' })).interactions[0];
        if (Date.now() > deadline) throw Error('pending_fixture_approval_timeout');
        if (!card) await Bun.sleep(5);
      }
      const actual = f.reviewInputs[0]!;
      const reads = JSON.parse(actual.messages.find((message) => message.role === 'user')!.content)
        .authorizationContext.recordedReads;
      if (legacyCompact) expect(reads).toBeUndefined();
      else {
        expect(reads).toHaveLength(3);
        await f.completeLaterRead();
      }
      const before = (await f.store.getExecution(actual.requestId))!;
      const again = await f.store.ensureAuthorizationCheck({
        ...f.ensureInput(),
        timeout: { startedAt: Date.now(), deadlineAt: Date.now() + 10000 },
      });
      expect(again.created).toBe(false);
      expect(again.execution.id).toBe(actual.requestId);
      expect((await f.store.getExecution(actual.requestId))!.input).toEqual(before.input);
      expect(
        (await f.runtime.readModelInput({ ...f.scope, executionId: actual.requestId })).request,
      ).toEqual(actual);
      await f.runtime.answerInteraction({
        ...f.scope,
        commandId: 'approve',
        presentationSessionId: 's',
        interactionId: card.id,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve' },
      });
      await f.finish();
      expect(f.counts()).toEqual({ reviews: 1, effects: 1 });
    } finally {
      await f.close();
    }
  });

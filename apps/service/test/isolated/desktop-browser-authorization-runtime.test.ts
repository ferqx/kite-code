import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type AgentRuntime, createRuntime } from '@kite-ai/agent';
import {
  createBrowserController,
  createBrowserExecution,
  createBrowserExtension,
  type NativeBrowserTransport,
} from '@kite-ai/agent/browser';
import {
  builtinCapability,
  createPermissionPolicy,
  type PermissionMode,
  type PermissionPolicySnapshot,
} from '@kite-ai/agent/permissions';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createDesktopBrowserAuthorization } from '../../src/desktop-browser-authorization';

async function until(read: () => boolean | Promise<boolean>) {
  const limit = Date.now() + 5000;
  while (!(await read())) {
    if (Date.now() > limit) throw Error('browser_permission_runtime_timeout');
    await Bun.sleep(5);
  }
}
const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
type Scenario = {
  mode: PermissionMode;
  nested?: boolean;
  review?: 'approve' | 'reject' | 'invalid';
  hardDenied?: boolean;
  ackLost?: boolean;
  failCreation?: boolean;
  cancelAfterPrepare?: boolean;
  changedPolicyAfterCommit?: boolean;
  denySession?: boolean;
  denyCode?: 'browser.execute' | 'browser.code_session';
  released?: boolean;
  existingFailure?: 'missing' | 'mismatch';
};

async function runScenario(options: Scenario) {
  const root = mkdtempSync(join(tmpdir(), 'kite-browser-dispatch-permission-'));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const storeId = (await store.getMetadata()).storeId;
  let runtime!: AgentRuntime;
  let policyMode = options.mode;
  let policyRevision = 'actual-controlled-mode';
  let prepares = 0,
    commits = 0,
    starts = 0,
    pageOperations = 0;
  const calls: Record<string, unknown>[] = [];
  let proposal:
    | {
        requestId: unknown;
        state: string;
        url: unknown;
        requireExisting?: true;
        existingPage?: unknown;
        page: { kind: string; id: string; title: string; url: string };
      }
    | undefined;
  let acquired: { grantId: string; grantExecutionId: string } | undefined;
  const authorizer = createDesktopBrowserAuthorization({
    runtime: () => runtime,
    releasedPage: (sessionId, url) => {
      expect(sessionId).toBe('session');
      expect(url).toBe('https://example.test/');
      return options.released
        ? url === 'https://example.test/'
          ? {
              url,
              identity: { pageId: 'local-page', incarnation: 'local-incarnation' },
            }
          : {
              url: 'https://example.test/most-recent-other-page',
              identity: { pageId: 'other-page', incarnation: 'other-incarnation' },
            }
        : null;
    },
    async call(input) {
      calls.push(structuredClone(input));
      if (input.op === 'prepareGrant') {
        prepares++;
        if (options.released) expect(input.requireExisting).toBe(true);
        else expect(input.requireExisting).toBeUndefined();
        if (options.existingFailure)
          throw Error(`browser_page_existing_${options.existingFailure}`);
        proposal = {
          requestId: input.requestId,
          state: 'question',
          url: input.url,
          ...(input.requireExisting === true ? { requireExisting: true as const } : {}),
          ...(input.existingPage ? { existingPage: structuredClone(input.existingPage) } : {}),
          page: {
            kind: 'existing',
            id: 'local-page',
            title: 'Local signed-in form',
            url: options.released ? 'https://example.test/' : 'https://example.test/current',
          },
        };
        if (options.cancelAfterPrepare)
          await runtime.cancelCommand({
            expectedStoreId: storeId,
            subjectId: 'owner',
            sessionId: 'session',
            commandId: 'cancel-reservation',
            targetCommandId: 'work',
          });
      } else if (input.op === 'commitGrant') {
        commits++;
        expect(input.executionId).toBeDefined();
        expect(input.authorizationDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(input.interactionId).toBeUndefined();
        expect(input.decisionRevision).toBeUndefined();
        if (options.failCreation) {
          proposal!.state = 'expired';
          throw Error('browser_page_grant_create_failed');
        }
        proposal!.state = 'committed';
        if (options.changedPolicyAfterCommit) {
          policyMode = 'accept_edits';
          policyRevision = 'changed-controls-after-open';
        }
        if (options.ackLost) throw Error('response_lost_after_commit');
      } else if (input.op === 'cancelGrant') proposal!.state = 'cancelled';
      else if (input.op !== 'inspectGrant') throw Error('unexpected_grant_rpc');
      return structuredClone(proposal);
    },
  });
  let ended!: (value: { confirmed: boolean }) => void;
  const completion = new Promise<{ confirmed: boolean }>((resolve) => {
    ended = resolve;
  });
  const controller = createBrowserController({
    sharedPage: true,
    captureIntervalMs: 60000,
    createTransport(context, binding): NativeBrowserTransport {
      starts++;
      return {
        ready: (async () => {
          acquired = await authorizer.grantForJob(context, binding.browserId);
        })(),
        completion,
        async request() {
          pageOperations++;
          return { success: true, data: { snapshot: 'Local form' } };
        },
        async capture() {
          return {
            frame: { mimeType: 'image/jpeg', data: 'fixture', width: 400, height: 300 },
            annotations: [],
          };
        },
        async close() {
          ended({ confirmed: true });
          return { confirmed: true };
        },
        async dispose() {},
      };
    },
  });
  const base = createBrowserExtension({
    controller,
    prepareOpen: authorizer.prepareOpen,
    cancelOpen: authorizer.cancelOpen,
  });
  const code = createBrowserExecution({
    controller,
    createExecutor() {
      return {
        async execute({ call }) {
          const page = await call('open', { url: 'https://example.test/' });
          await call('snapshot', { page, args: [] });
          return { value: page, output: '' };
        },
        async close() {
          return { confirmed: true };
        },
      };
    },
  });
  const extension = options.nested
    ? {
        ...base,
        tools: [...base.tools!, ...code.tools],
        jobs: [...base.jobs!, ...code.jobs],
        records: [
          ...base.records!,
          {
            contentType: 'application/vnd.kite.browser-code+json',
            contentVersion: 1,
            schema: { type: 'object' as const },
          },
        ],
      }
    : base;
  const model = createFixedModel([
    [
      {
        type: 'tool_call',
        id: 'open',
        name: options.nested ? 'browser_execute' : 'browser_open',
        arguments: JSON.stringify(
          options.nested
            ? {
                code: "var page = await browser.open('https://example.test/'); await page.snapshot();",
              }
            : { key: 'original', url: 'https://example.test/' },
        ),
      },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  const reviewResponse = [
    {
      type: 'text_delta',
      text:
        options.review === 'invalid'
          ? 'invalid-review'
          : JSON.stringify({
              decision: options.review === 'reject' ? 'reject' : 'approve_once',
              reason: 'The actual user task covers the exact local page.',
            }),
    },
    finish,
  ] as const;
  const review = createFixedModel([reviewResponse, reviewResponse]);
  function policySnapshot(): PermissionPolicySnapshot {
    return {
      mode: policyMode,
      workspaceTrust: true,
      revision: policyRevision,
      allowed: [
        { kind: 'model', definitionId: 'fixed', definitionVersion: '1' },
        { kind: 'model', definitionId: 'check', definitionVersion: '1' },
        ...extension.tools!.map((tool) => ({
          kind: 'tool' as const,
          definitionId: tool.id,
          definitionVersion: tool.version,
        })),
        ...extension.jobs!.map((job) => ({
          kind: 'job' as const,
          definitionId: job.id,
          definitionVersion: job.version,
        })),
      ],
    };
  }
  const permissions = createPermissionPolicy({
    readPolicy: () => policySnapshot(),
    async describeCapability(request) {
      return {
        kind: request.kind,
        definitionId: request.definitionId,
        definitionVersion: request.definitionVersion,
        revision: 'registered-fixture',
        ...(request.kind === 'model'
          ? { effects: ['read'] as const, safeRead: true }
          : builtinCapability(
              'builtin.browser',
              request.definitionId,
              request.kind,
              '',
              request.definitionVersion,
            )),
        hardAllowed:
          (!options.hardDenied || request.definitionId !== 'browser.open') &&
          (!options.denySession || request.definitionId !== 'browser.session') &&
          options.denyCode !== request.definitionId,
      };
    },
  });
  runtime = createRuntime({
    store,
    model: {
      async *stream(request, context) {
        if (!options.nested && model.requests.length === 1)
          await until(() => controller.view('session')?.state === 'agent');
        yield* model.stream(request, context);
      },
    },
    modelId: 'fixed',
    extensions: [extension],
    permissions,
    authorizationCheck: {
      id: 'browser-policy-review',
      version: '1',
      modelId: 'check',
      model: review,
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'workspace',
      name: 'Local browser test',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      sessionId: 'session',
      workspaceId: 'workspace',
      commandId: 'create',
      subjectId: 'owner',
      title: 'Local browser test',
    });
    await runtime.submitCommand({
      expectedStoreId: storeId,
      sessionId: 'session',
      commandId: 'work',
      subjectId: 'owner',
      request: {
        kind: 'run.start',
        content: 'Use the current local form to inspect its visible state.',
      },
    });
    await runtime.waitForCommand('work', { timeoutMs: 5000 });
    const interactions = (
      await runtime.listInteractions({ expectedStoreId: storeId, sessionId: 'session' })
    ).interactions;
    expect(interactions.filter((interaction) => interaction.kind === 'question')).toEqual([]);
    expect(interactions).toEqual([]);
    const rejected =
      options.hardDenied ||
      options.denyCode ||
      options.denySession ||
      options.cancelAfterPrepare ||
      options.failCreation ||
      options.existingFailure;
    if (!rejected) {
      await until(() => controller.view('session')?.state === 'agent');
      expect(prepares).toBe(1);
      expect(commits).toBe(1);
      expect(starts).toBe(1);
      const executions = await store.listExecutions('session');
      const open = executions.find((execution) => execution.definitionId === 'browser.open')!;
      const job = executions.find((execution) => execution.definitionId === 'browser.session')!;
      expect(open.authorization?.dispatched).toBe(true);
      expect(job.parentExecutionId).toBe(open.id);
      expect(acquired).toEqual({ grantId: String(proposal!.requestId), grantExecutionId: open.id });
      const record = (
        await store.listExtensionRecords({
          sessionId: 'session',
          extensionId: 'builtin.browser',
          contentType: 'application/vnd.kite.browser-grant+json',
        })
      )[0]!;
      expect(record.value).toMatchObject({
        state: 'ready',
        executionId: open.id,
        dispatch: { digest: calls.find((call) => call.op === 'commitGrant')!.authorizationDigest },
      });
      if (options.released) expect(record.value).toMatchObject({ requireExisting: true });
      expect((record.value as { accepted?: unknown }).accepted).toBeUndefined();
      if (options.nested) {
        expect(open.runId).toBeNull();
        expect((record.value as { taskRunId?: unknown }).taskRunId).toBeDefined();
      }
      if (options.ackLost)
        expect(calls.map((call) => call.op)).toEqual([
          'prepareGrant',
          'commitGrant',
          'inspectGrant',
        ]);
    } else {
      expect(acquired).toBeUndefined();
      expect(starts).toBe(0);
      expect(pageOperations).toBe(0);
      expect(
        (await store.listExecutions('session')).some(
          (execution) => execution.definitionId === 'browser.session',
        ),
      ).toBe(options.denySession === true);
      if (options.denySession) {
        const session = (await store.listExecutions('session')).find(
          (execution) => execution.definitionId === 'browser.session',
        )!;
        expect(session.authorization?.dispatched).not.toBe(true);
      }
      if (options.cancelAfterPrepare || options.failCreation)
        expect(calls.map((call) => call.op)).toContain('cancelGrant');
      else expect(prepares).toBe(options.denySession || options.existingFailure ? 1 : 0);
      if (options.existingFailure) {
        expect(commits).toBe(0);
        expect(calls.map((call) => call.op)).toEqual(['prepareGrant']);
        const open = (await store.listExecutions('session')).find(
          (execution) => execution.definitionId === 'browser.open',
        )!;
        expect(open.result).toMatchObject({
          outcome: 'failed',
          details: { code: `browser_page_existing_${options.existingFailure}` },
        });
      }
    }
    expect(review.requests).toHaveLength(0);
  } finally {
    await code.disposeCommand('session', 'work');
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}

for (const mode of ['full', 'auto', 'accept_edits'] as const)
  for (const nested of [false, true])
    test(
      `${mode} ${nested ? 'unified' : 'legacy'} binds the exact page without review, approval or a page Question`,
      () => runScenario({ mode, nested }),
      15000,
    );
test(
  'a configured rejecting reviewer is never called for browser control',
  () => runScenario({ mode: 'auto', nested: true, review: 'reject' }),
  15000,
);
test(
  'a configured invalid reviewer creates no fallback approval for browser control',
  () => runScenario({ mode: 'auto', nested: true, review: 'invalid' }),
  15000,
);
test(
  'Full cannot override a host hard capability denial',
  () => runScenario({ mode: 'full', nested: true, hardDenied: true }),
  15000,
);
test(
  'cancel after exact reservation prevents commit and cancels that original request',
  () => runScenario({ mode: 'full', nested: true, cancelAfterPrepare: true }),
  15000,
);
test(
  'lost commit ACK inspects the original accepted dispatch without replay',
  () => runScenario({ mode: 'auto', nested: true, ackLost: true }),
  15000,
);
test(
  'confirmed page creation failure remains the actual error without approval',
  () => runScenario({ mode: 'full', nested: true, failCreation: true }),
  15000,
);
test(
  'mode changes never introduce browser approval after open',
  () => runScenario({ mode: 'auto', nested: true, changedPolicyAfterCommit: true }),
  15000,
);
test(
  'the exact session intent still obeys its own hard capability ceiling',
  () => runScenario({ mode: 'auto', nested: true, denySession: true }),
  15000,
);
for (const denyCode of ['browser.execute', 'browser.code_session'] as const)
  test(
    `${denyCode} controlled orchestration remains subject to hard capability denial`,
    () => runScenario({ mode: 'full', nested: true, denyCode }),
    15000,
  );

test(
  'a new exact Runtime dispatch rebinds the released URL with a durable existing-only requirement and no approval',
  () => runScenario({ mode: 'auto', nested: true, released: true }),
  15000,
);
for (const existingFailure of ['missing', 'mismatch'] as const)
  test(
    `an existing-only ${existingFailure} refusal ends before any Browser Job or page operation`,
    () => runScenario({ mode: 'auto', nested: true, released: true, existingFailure }),
    15000,
  );

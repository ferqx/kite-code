import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { historyBinding } from './history-followup-fixture';

const [directory, baseURL, mode] = process.argv.slice(2) as [string, string, string?];
const profile = { dataRoot: join(directory, 'data'), profile: 'owned' };
const store = await openSqliteStore(profile);
const expectedStoreId = (await store.getMetadata()).storeId;
const beforePlan = Promise.withResolvers<void>();
const beforeDispatch = Promise.withResolvers<void>();
const focusedToolHeld = Promise.withResolvers<void>();
const awaitingApproval = mode === 'deny-then-stop' || mode === 'stop-then-deny';
const mixedHistory = mode === 'stop-bad-arguments' || awaitingApproval;
function ready(value: object) {
  writeFileSync(join(directory, 'ready.tmp'), JSON.stringify(value));
  renameSync(join(directory, 'ready.tmp'), join(directory, 'ready.json'));
}
const wrapped = new Proxy(store, {
  get(target, key) {
    if (key === 'planExecution' && mode)
      return async (input: Parameters<Store['planExecution']>[0]) => {
        if (
          input.kind === 'tool' &&
          (mode === 'stop-before-planning' ||
            input.callId === 'original-two' ||
            input.callId === 'a-unplanned')
        ) {
          beforePlan.resolve();
          await new Promise<void>(() => {});
        }
        return store.planExecution(input);
      };
    if (key === 'finishExecution' && mixedHistory)
      return async (input: Parameters<Store['finishExecution']>[0]) => {
        if ((await store.getExecution(input.executionId))?.callId === 'z-first') {
          focusedToolHeld.resolve();
          await new Promise<void>(() => {});
        }
        return store.finishExecution(input);
      };
    if (key === 'getInteraction' && awaitingApproval)
      return async () => {
        focusedToolHeld.resolve();
        await new Promise<void>(() => {});
      };
    if (key === 'markDispatching' && !mixedHistory)
      return async (input: Parameters<Store['markDispatching']>[0]) => {
        if ((await store.getExecution(input.executionId))?.kind === 'tool') {
          if (mode) beforeDispatch.resolve();
          else
            ready({
              expectedStoreId,
              executionId: input.executionId,
              expectedOwnerGeneration: (await store.getSession('s'))!.ownerGeneration,
            });
          await new Promise<void>(() => {});
        }
        return store.markDispatching(input);
      };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const runtime = createRuntime({
  store: wrapped,
  artifacts: createArtifactStore({ profile, store: wrapped }),
  ...historyBinding(directory, baseURL),
  permissions: {
    async authorize(request) {
      return awaitingApproval &&
        request.input &&
        typeof request.input === 'object' &&
        'value' in request.input &&
        request.input.value === 'z-first'
        ? { allowed: false, revision: '1', approval: { request: { title: 'First call' } } }
        : { allowed: true, revision: '1' };
    },
  },
});
await runtime.createWorkspace({
  expectedStoreId,
  id: 'w',
  name: 'owned',
  rootUri: pathToFileURL(directory).href,
});
await runtime.createSession({
  expectedStoreId,
  commandId: 'create',
  sessionId: 's',
  workspaceId: 'w',
  title: 'Original',
  subjectId: 'owner',
});
await runtime.submitCommand({
  expectedStoreId,
  commandId: 'work',
  sessionId: 's',
  subjectId: 'owner',
  request: { kind: 'run.start', content: 'Original decision' },
});
if (mode) {
  await beforePlan.promise;
  if (mode === 'stop-mixed') await beforeDispatch.promise;
  if (mixedHistory) {
    await focusedToolHeld.promise;
    while (!(await store.listMessages('s')).some((message) => message.toolCallId === 'm-done'))
      await Bun.sleep(5);
  }
  const identity = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  const approval = awaitingApproval
    ? (await runtime.listInteractions({ ...identity, state: 'pending' })).interactions[0]!
    : null;
  const deny = () =>
    runtime.answerInteraction({
      ...identity,
      presentationSessionId: 's',
      interactionId: approval!.id,
      commandId: 'deny',
      expectedRevision: approval!.revision,
      answer: { kind: 'approval', decision: 'deny' },
    });
  if (mode === 'deny-then-stop') await deny();
  const stop = await runtime.cancelCommand({
    ...identity,
    commandId: 'stop',
    targetCommandId: 'work',
  });
  if (mode === 'stop-then-deny') await deny();
  const original = (await store.getCommand('work'))!;
  ready({
    expectedStoreId,
    expectedOwnerGeneration: (await store.getSession('s'))!.ownerGeneration,
    runId: (original.receipt as { runId: string }).runId,
    stopApplied: stop.status === 'applied',
  });
}
await new Promise<void>(() => {});

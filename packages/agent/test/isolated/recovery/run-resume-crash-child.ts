import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { binding } from './run-resume-fixture';
import { groupOptions } from './run-resume-group-fixture';

const [directory, mode, recoveryPhase] = process.argv.slice(2) as [
  string,
  string,
  string | undefined,
];
if (!recoveryPhase) writeFileSync(join(directory, 'ledger'), '');
const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
const store = await openSqliteStore(profile);
const expectedStoreId = (await store.getMetadata()).storeId;
async function stop(executionId: string) {
  const run = (await store.getView('s')).runs.find((r) => r.isActive)!;
  const session = (await store.getSession('s'))!;
  writeFileSync(
    join(directory, 'ready.tmp'),
    JSON.stringify({
      expectedStoreId,
      runId: run.id,
      expectedOwnerGeneration: session.ownerGeneration,
      executionId,
    }),
  );
  renameSync(
    join(directory, 'ready.tmp'),
    join(directory, recoveryPhase ? `ready-${recoveryPhase}.json` : 'ready.json'),
  );
  await new Promise<void>(() => {});
}
let settledTools = 0;
let dispatchedModels = 0;
const groupPartials = new Set<string>();
let groupActivations = 0;
const groupApprovals = new Set<string>();
const wrapped = new Proxy(store, {
  get(target, key) {
    if (key === 'requestInteraction' && mode === 'group_approval')
      return async (input: Parameters<Store['requestInteraction']>[0]) => {
        const result = await store.requestInteraction(input);
        groupApprovals.add(result.id);
        if (groupApprovals.size === 3) {
          for (;;) {
            const root = await store.getView('s');
            if (root.runs.find((run) => run.isActive)?.status === 'waiting_execution')
              await stop(
                root.executions.filter((execution) => execution.kind === 'model').at(-1)!.id,
              );
            await Bun.sleep(5);
          }
        }
        return result;
      };
    if (key === 'activateChildRun' && mode === 'group_activation')
      return async () => {
        if (++groupActivations === 3) {
          for (;;) {
            const root = await store.getView('s');
            if (root.runs.find((run) => run.isActive)?.status === 'waiting_execution') {
              await stop(
                root.executions.filter((execution) => execution.kind === 'model').at(-1)!.id,
              );
            }
            await Bun.sleep(5);
          }
        }
        await new Promise<void>(() => {});
      };
    if (key === 'setRunResultWait' && mode.startsWith('group_'))
      return async (input: Parameters<Store['setRunResultWait']>[0]) => {
        const result = await store.setRunResultWait(input);
        if (
          ![
            'group_foreground',
            'group_nested',
            'group_terminal',
            'group_terminal_descendant',
            'group_approval',
          ].includes(mode) &&
          mode !== 'group_activation' &&
          input.executionIds.length === (mode === 'group_queued' ? 4 : 3)
        ) {
          const root = await store.getView('s');
          await stop(root.executions.filter((execution) => execution.kind === 'model').at(-1)!.id);
        }
        return result;
      };
    if (key === 'persistModelPartial')
      return async (input: Parameters<Store['persistModelPartial']>[0]) => {
        const result = await store.persistModelPartial(input);
        const ex = await store.getExecution(input.executionId);
        if (mode === 'group_new_descendant' && ex?.sessionId !== 's') {
          for (;;) {
            const root = await store.getView('s');
            if (root.runs.find((run) => run.isActive)?.status === 'waiting_execution')
              await stop(
                root.executions.filter((execution) => execution.kind === 'model').at(-1)!.id,
              );
            await Bun.sleep(5);
          }
        }
        if (mode === 'group_foreground' && ex?.sessionId !== 's') {
          groupPartials.add(input.executionId);
          if (groupPartials.size === 3) {
            const root = await store.getView('s');
            await stop(root.executions.find((execution) => execution.kind === 'model')!.id);
          }
        }
        if (mode === 'group_nested' && ex?.sessionId !== 's') {
          const run = ex?.runId ? await store.getRun(ex.runId) : null;
          const command = run ? await store.getCommand(run.originCommandId) : null;
          if ((command?.request as { input?: { content?: string } })?.input?.content === 'grand') {
            const root = await store.getView('s');
            await stop(
              root.executions.filter((execution) => execution.kind === 'model').at(-1)!.id,
            );
          }
        }
        if (
          mode.startsWith('running_') ||
          (mode === 'continuation_running' && dispatchedModels === 2) ||
          mode === 'retry_lineage' ||
          (mode === 'compression_running' &&
            (ex?.decisionSource as Record<string, unknown>)?.compressionId)
        )
          await stop(input.executionId);
        return result;
      };
    if (key === 'commitCompression' && mode === 'compression_published')
      return async (input: Parameters<Store['commitCompression']>[0]) => {
        const result = await store.commitCompression(input);
        await stop(result.modelExecutionId);
        return result;
      };
    if (key === 'markDispatching')
      return async (input: Parameters<Store['markDispatching']>[0]) => {
        const ex = await store.getExecution(input.executionId);
        if (ex?.kind === 'model') {
          if (mode === 'steer_applied') {
            const run = (await store.getView('s')).runs.find((candidate) => candidate.isActive)!;
            await store.acceptCommand({
              expectedStoreId,
              sessionId: 's',
              subjectId: 'owner',
              commandId: 'applied-steer',
              request: {
                kind: 'input.steer',
                targetRunId: run.id,
                contextSelectionId: run.contextSelectionId,
                content: 'Keep the original task; correction: Blue 雪, never Red.',
              },
            });
            await store.applyInput({
              expectedStoreId,
              owner: input.owner,
              commandId: 'applied-steer',
              kind: 'steer',
              runId: run.id,
            });
            await stop(ex.id);
          }
          dispatchedModels++;
          if (
            mode.startsWith('planned_') ||
            (['length_planned', 'retry_planned', 'continuation_planned'].includes(mode) &&
              dispatchedModels === 2) ||
            (mode === 'length_history' && dispatchedModels === 3)
          )
            await stop(ex.id);
        }
        return store.markDispatching(input);
      };
    if (key === 'finishExecution')
      return async (input: Parameters<Store['finishExecution']>[0]) => {
        if (
          ['group_terminal', 'group_terminal_descendant'].includes(mode) &&
          (await store.getExecution(input.executionId))?.kind === 'job'
        ) {
          for (;;) {
            const root = await store.getView('s');
            if (
              root.runs.find((run) => run.isActive)?.status === 'waiting_execution' &&
              (mode !== 'group_terminal_descendant' ||
                readFileSync(join(directory, 'ledger'), 'utf8').includes('child-model:grand'))
            )
              await stop(
                root.executions.filter((execution) => execution.kind === 'model').at(-1)!.id,
              );
            await Bun.sleep(5);
          }
        }
        if (mode === 'dispatched' && (await store.getExecution(input.executionId))?.kind === 'tool')
          await stop(input.executionId);
        const result = await store.finishExecution(input);
        const ex = await store.getExecution(input.executionId);
        if (
          (mode === 'completion' && ex?.kind === 'model') ||
          (mode === 'length_response' && ex?.kind === 'model') ||
          (mode === 'retry_failed' && ex?.kind === 'model') ||
          (mode === 'continuation_failed' && ex?.kind === 'model' && ex.status === 'failed') ||
          (mode === 'compression_pending' &&
            ex?.kind === 'model' &&
            (ex.decisionSource as Record<string, unknown>)?.compressionId) ||
          (['tool_result', 'large'].includes(mode) && ex?.kind === 'tool') ||
          (mode === 'repeat_failure' && ex?.kind === 'tool' && ++settledTools === 4)
        )
          await stop(input.executionId);
        return result;
      };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const runtime = createRuntime({
  permissions: binding(directory, mode).permissions!,
  store: wrapped,
  artifacts: createArtifactStore({ profile, store: wrapped }),
  resolveRunConfiguration: async () => binding(directory, mode),
  ...(recoveryPhase
    ? { resolveRecoveryRunConfiguration: async () => binding(directory, mode) }
    : {}),
  ...(mode === 'initializer'
    ? {
        initializeRunRequirements: async () => {
          await stop('');
          return [];
        },
      }
    : {}),
  ...(mode.startsWith('group_') ? groupOptions(directory, mode) : {}),
});
if (recoveryPhase) {
  const original = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8'));
  await runtime.resumeRun({
    ...original,
    commandId: `resume-child-${recoveryPhase}`,
    sessionId: 's',
    subjectId: 'owner',
  });
  await new Promise<void>(() => {});
}
await runtime.createWorkspace({
  expectedStoreId,
  id: 'w',
  name: 'owned',
  rootUri: pathToFileURL(directory).href,
});
await runtime.createSession({
  expectedStoreId,
  subjectId: 'owner',
  commandId: 'create',
  sessionId: 's',
  workspaceId: 'w',
  title: 'Original',
});
await runtime.submitCommand({
  expectedStoreId,
  subjectId: 'owner',
  commandId: 'work',
  sessionId: 's',
  request: { kind: 'run.start', content: 'original' },
});
await new Promise<void>(() => {});

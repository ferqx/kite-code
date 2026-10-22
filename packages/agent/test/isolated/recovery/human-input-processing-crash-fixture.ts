import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSqliteStore } from '../../../src/sqlite';

/** Synthetic pre-removal records, never a simulated Provider effect. */
export async function seedLegacyProcessing(root: string, planned = true) {
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'legacy',
    rootUri: pathToFileURL(root).href,
  });
  await store.createSession({
    ...scope,
    commandId: 'create',
    workspaceId: 'w',
    title: 'legacy input',
  });
  const session = (await store.getSession('s'))!;
  const raw = await store.registerHumanInput({
    ...scope,
    commandId: 'legacy-raw',
    content: 'Old ambiguous input',
    contextSelectionId: session.contextSelectionId,
    observedRunId: null,
    candidateWorkCommandIds: [],
  });
  const processing = await store.beginHumanInputProcessing({
    ...scope,
    inputCommandId: raw.id,
    inputDigest: raw.requestDigest,
  });
  const owner = (await store.acquireSessionOwner('s', 'legacy-host'))!;
  const run = planned
    ? await store.startRun({
        expectedStoreId,
        owner,
        commandId: processing.id,
        configuration: {
          modelId: 'old-model',
          snapshot: {
            kind: 'human_input_processing',
            inputCommandId: raw.id,
            inputDigest: raw.requestDigest,
            originalConfiguration: { modelId: 'old-model' },
          },
        },
      })
    : null;
  if (run) {
    await store.beginRunRequirementsInitialization({ expectedStoreId, owner, runId: run.id });
    await store.registerRunRequirements({
      expectedStoreId,
      owner,
      runId: run.id,
      requirements: [],
      initialize: true,
    });
    await store.planExecution({
      expectedStoreId,
      owner,
      sessionId: 's',
      runId: run.id,
      executionId: 'legacy-model',
      originCommandId: processing.id,
      stepId: 'model',
      callId: 'model',
      kind: 'model',
      definitionId: 'old-model',
      definitionVersion: '1',
      input: { modelId: 'old-model', messages: [], tools: [] },
      decisionSource: {
        kind: 'model_request',
        humanInputInterpretation: { inputCommandId: raw.id, inputDigest: raw.requestDigest },
        toolBindings: [],
      },
    });
  }
  return {
    store,
    profile,
    scope,
    raw: (await store.getCommand(raw.id))!,
    processing,
    run,
    generation: (await store.getSession('s'))!.ownerGeneration,
  };
}
if (import.meta.main) {
  const fixture = await seedLegacyProcessing(process.argv[2]!, process.argv[3] === 'planned');
  console.log(
    JSON.stringify({
      expectedStoreId: fixture.scope.expectedStoreId,
      rawId: fixture.raw.id,
      processingId: fixture.processing.id,
      runId: fixture.run?.id ?? null,
      generation: fixture.generation,
    }),
  );
  await new Promise(() => {});
}

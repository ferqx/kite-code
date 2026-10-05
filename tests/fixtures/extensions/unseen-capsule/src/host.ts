import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { ArtifactRef, Json } from '@kite-ai/agent/extensions';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelAdapter } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { capsuleId, createCapsule } from './index';

const [root, mode, nodePath, workerPath, priorPath] = process.argv.slice(2);
if (!root || !mode || !nodePath || !workerPath) throw Error('host_arguments_missing');
const profile = { dataRoot: join(root, 'data'), profile: 'new' };
const privateRoot = join(root, 'owned-worker');
mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
const readonly = mode === 'cold' || mode === 'compat-cold';
const store = await openSqliteStore({
  ...profile,
  ...(readonly ? { mode: 'readonly' as const } : {}),
});
const storeId = (await store.getMetadata()).storeId;
const artifacts = createArtifactStore({ profile, store });
const capsule = createCapsule({
  root: privateRoot,
  nodePath,
  workerPath,
  missingCondition: mode === 'missing',
});
const payload = 'capsule正文\r\n'.repeat(8000);
let modelCalls = 0;
const fixed = createFixedModel([
  [
    {
      type: 'tool_call',
      id: 'capsule-call',
      name: mode === 'compat' ? 'fixture.count' : `${capsuleId}.require`,
      arguments:
        mode === 'compat' ? '{"value":"prior-bytes"}' : JSON.stringify({ key: 'main', payload }),
    },
    { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
  ],
  [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
]);
const model: ModelAdapter = {
  async *stream(...args) {
    modelCalls++;
    yield* fixed.stream(...args);
  },
};
let compat: ReturnType<typeof createCapsule>['extension'] | undefined;
if (mode === 'compat' || mode === 'compat-cold') {
  if (!priorPath) throw Error('prior_bytes_missing');
  const prior = await import(priorPath);
  compat = prior.countedTool(join(root, 'prior-ledger'));
}
const sourceFile = join(root, 'project-source');
if (mode === 'source-drift') writeFileSync(sourceFile, 'original applicable project source');
const runtime = createRuntime({
  ...(mode === 'source-drift'
    ? {
        sources: {
          async capture(request) {
            const content = readFileSync(sourceFile, 'utf8');
            return [
              {
                id: 'fixture:project',
                kind: 'project',
                scope: request.workspaceId,
                digest: createHash('sha256').update(content).digest('hex'),
                content,
              },
            ];
          },
        },
      }
    : {}),
  store,
  artifacts,
  model,
  modelId: 'fixed',
  extensions: [compat ?? capsule.extension],
  permissions: {
    authorize: async (request) =>
      request.kind === 'model'
        ? { allowed: true, revision: 'fixture-read' }
        : {
            allowed: false,
            revision: 'fixture-independent-ask',
            approval: {
              request: {
                title: `Approve ${request.definitionId}`,
                definitionId: request.definitionId,
                input: request.input,
              },
            },
          },
  },
});
const paths = resolveProfile(profile);
const service = await startService({
  runtime,
  profile: { dataRoot: profile.dataRoot, name: 'new', accessKey: paths.profileAccessKey },
  buildId: 'unseen-public-built',
  subjectId: 'owner',
});
const client = createClient({
  endpoint: service.endpoint,
  token: service.bootstrap.token,
  expected: {
    apiMajor: 1,
    profile: service.bootstrap.profile,
    requiredCapabilities: [
      'sessions',
      'commands',
      'history',
      'interactions',
      'extension_queries',
      'extensions_actions',
    ],
  },
});
const approvals: string[] = [];
async function answerPending(deny = false) {
  const cards = await client.listInteractions('s', { storeId, state: 'pending', limit: 100 });
  for (const card of cards.interactions) {
    approvals.push(card.definitionId);
    if (mode === 'source-drift' && card.definitionId === `${capsuleId}.pack`)
      writeFileSync(sourceFile, 'changed applicable project source');
    await client.answerInteraction(card.presentationSessionId, card.id, {
      expectedStoreId: storeId,
      commandId: `answer-${card.id}`,
      expectedRevision: card.revision,
      answer: {
        kind: 'approval',
        decision: deny ? 'deny' : 'approve',
        ...(deny ? {} : { grant: 'approve_once' as const }),
      },
    });
  }
}
async function pumpUntil(commandId: string, deny = false) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const command = await client.getCommand(commandId);
    if (['applied', 'rejected', 'needs_review'].includes(command.status)) {
      const receipt = command.receipt as { runId?: string; executionId?: string } | null;
      const runId = receipt?.runId,
        executionId = receipt?.executionId;
      if (
        runId
          ? ['completed', 'failed', 'cancelled', 'interrupted'].includes(
              (await client.getRun(runId)).status,
            )
          : executionId
            ? ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(
                (await client.getExecution(executionId)).status,
              )
            : true
      )
        return command;
    }
    await answerPending(deny);
    if (Date.now() > deadline) throw Error(`actual_command_deadline:${commandId}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function action(commandId: string, actionId: string, input: Json) {
  await client.invokeExtension('s', {
    expectedStoreId: storeId,
    commandId,
    kind: 'extension.invoke',
    extensionId: capsuleId,
    actionId,
    definitionVersion: '1',
    input,
  });
  return pumpUntil(commandId);
}
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
let evidence: Record<string, unknown>;
try {
  await client.connect();
  if (!readonly) {
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: `file://${root}`,
      name: 'Owned unseen',
    });
    await store.createSession({
      expectedStoreId: storeId,
      subjectId: 'owner',
      commandId: 'create-s',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Unseen capsule',
    });
  }
  if (mode === 'positive' || mode === 'missing' || mode === 'deny') {
    await client.startRun('s', {
      expectedStoreId: storeId,
      commandId: 'work',
      kind: 'run.start',
      content: 'Create and prove capsule with the ordinary external Tool.',
    });
    const command = await pumpUntil('work', mode === 'deny');
    const view = await store.getView('s');
    const views = await client.queryExtension('s', capsuleId, 'capsules', {});
    let body: { size: number; digest: string; equals: boolean } | null = null;
    if (views[0]?.artifactRefs[0]) {
      const ref = views[0].artifactRefs[0] as ArtifactRef;
      const bytes = await client.readArtifact(
        's',
        { expectedStoreId: storeId, refId: ref.id, scope: ref.scope! },
        { expectedReference: { size: ref.size, mediaType: ref.mediaType } },
      );
      body = {
        size: bytes.content.length,
        digest: sha(bytes.content),
        equals:
          Buffer.from(bytes.content).toString() ===
          `capsule@1\n${sha(payload)}\n${Array.from(payload).reverse().join('')}`,
      };
    }
    const accept = mode === 'positive' ? await action('accept', 'accept', { key: 'main' }) : null;
    const records = await store.listExtensionRecords({
      sessionId: 's',
      extensionId: capsuleId,
      limit: 100,
    });
    evidence = {
      mode,
      storeId,
      command,
      runs: view.runs,
      executions: view.executions.map((e) => ({
        id: e.id,
        kind: e.kind,
        status: e.status,
        definitionId: e.definitionId,
        definitionVersion: e.definitionVersion,
        decisionSource: e.decisionSource,
        originStoreId: e.originStoreId,
        originCommandId: e.originCommandId,
        parentExecutionId: e.parentExecutionId,
        rootWorkCommandId: e.rootWorkCommandId,
        resultRevision: e.resultRevision,
        result: e.result,
      })),
      views,
      body,
      accept,
      records,
      approvals,
      stats: capsule.stats(),
      modelCalls,
    };
  } else if (mode === 'cold') {
    const before = await store.getMetadata(),
      ledger = readFileSync(join(privateRoot, 'worker-ledger'), 'utf8');
    const command = await client.getCommand('work'),
      views = await client.queryExtension('s', capsuleId, 'capsules', {}),
      ref = views[0]!.artifactRefs[0] as ArtifactRef;
    const bytes = await client.readArtifact(
      's',
      { expectedStoreId: storeId, refId: ref.id, scope: ref.scope! },
      { expectedReference: { size: ref.size, mediaType: ref.mediaType } },
    );
    const after = await store.getMetadata();
    evidence = {
      mode,
      storeId,
      command,
      views,
      body: { size: bytes.content.length, digest: sha(bytes.content) },
      cursorBefore: before.lastChangeCursor,
      cursorAfter: after.lastChangeCursor,
      ledgerUnchanged: ledger === readFileSync(join(privateRoot, 'worker-ledger'), 'utf8'),
      stats: capsule.stats(),
      modelCalls,
      approvals,
    };
  } else if (mode === 'source-drift') {
    const stage = await action('stage-drift', 'stage', {
      key: 'drift',
      payload: 'original authorized bytes',
      hold: true,
    });
    const deadline = Date.now() + 5000;
    for (;;) {
      await answerPending();
      const views = await client.queryExtension('s', capsuleId, 'capsules', {});
      const execution = views[0]?.payload as { execution?: { status: string } } | undefined;
      if (
        execution?.execution &&
        ['failed', 'outcome_unknown', 'cancelled'].includes(execution.execution.status)
      ) {
        evidence = {
          mode,
          storeId,
          stage,
          views,
          approvals,
          stats: capsule.stats(),
          modelCalls,
          source: readFileSync(sourceFile, 'utf8'),
        };
        break;
      }
      if (Date.now() > deadline) throw Error('drift_job_deadline');
      await new Promise((r) => setTimeout(r, 5));
    }
  } else if (mode === 'detach' || mode === 'cancel') {
    const first = await action('stage-one', 'stage', {
      key: 'one',
      payload: 'first detached bytes',
      hold: true,
    });
    const second = await action('stage-two', 'stage', {
      key: 'two',
      payload: 'second detached bytes',
      hold: true,
    });
    const deadline = Date.now() + 5000;
    while (capsule.stats().starts < 2) {
      await answerPending();
      if (Date.now() > deadline) {
        const view = await store.getView('s');
        console.error(
          'actual_detach_failure',
          JSON.stringify({
            first,
            second,
            stats: capsule.stats(),
            approvals,
            executions: view.executions.map((e) => ({
              id: e.id,
              kind: e.kind,
              status: e.status,
              definitionId: e.definitionId,
              originCommandId: e.originCommandId,
              result: e.result,
            })),
            commands: await store.listAcceptedCommands('s'),
          }),
        );
        throw Error('detached_jobs_not_started');
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const before = await client.queryExtension('s', capsuleId, 'capsules', {});
    let cancel = null;
    if (mode === 'cancel') cancel = await action('cancel-one', 'cancel', { key: 'one' });
    else capsule.release('one');
    capsule.release('two');
    const collectTwo = await action('collect-two', 'collect', { key: 'two' });
    const collectOne =
      mode === 'detach' ? await action('collect-one', 'collect', { key: 'one' }) : null;
    const after = await client.queryExtension('s', capsuleId, 'capsules', {});
    evidence = {
      mode,
      storeId,
      first,
      second,
      before,
      after,
      cancel,
      collectTwo,
      collectOne,
      approvals,
      stats: capsule.stats(),
      modelCalls,
      ledger: readFileSync(join(privateRoot, 'worker-ledger'), 'utf8'),
    };
  } else if (mode === 'compat-cold') {
    const before = await store.getMetadata(),
      ledger = readFileSync(join(root, 'prior-ledger'), 'utf8');
    const command = await client.getCommand('prior-work');
    const runId = (command.receipt as { runId: string }).runId;
    const run = await client.getRun(runId);
    const after = await store.getMetadata();
    evidence = {
      mode,
      storeId,
      command,
      run,
      modelCalls,
      approvals,
      priorDigest: sha(readFileSync(priorPath!)),
      ledgerUnchanged: ledger === readFileSync(join(root, 'prior-ledger'), 'utf8'),
      cursorBefore: before.lastChangeCursor,
      cursorAfter: after.lastChangeCursor,
    };
  } else if (mode === 'compat') {
    await client.startRun('s', {
      expectedStoreId: storeId,
      commandId: 'prior-work',
      kind: 'run.start',
      content: 'Execute the unchanged original built extension.',
    });
    const command = await pumpUntil('prior-work');
    const view = await store.getView('s');
    const ledger = readFileSync(join(root, 'prior-ledger'), 'utf8');
    evidence = {
      mode,
      storeId,
      command,
      runs: view.runs,
      executions: view.executions.filter((e) => e.kind === 'tool'),
      ledger,
      approvals,
      modelCalls,
      priorDigest: sha(readFileSync(priorPath!)),
    };
  } else throw Error('unknown_fixture_mode');
  console.log(JSON.stringify(evidence));
} finally {
  client.disposeNetwork();
  await capsule.drain();
  await service.close();
  await artifacts.close();
  await store.close();
}

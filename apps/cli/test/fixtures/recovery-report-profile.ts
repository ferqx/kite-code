import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import type { CLIServiceArtifact } from '../../host';
import { buildOwnedDaemon } from './daemon-host-build';
import { untilRecovery } from './recovery-profile';

/** Programmatic finite afterTurn policy; actual default Task/SDK/SQLite, no forged report. */
export async function recoveryReportProfile() {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-report-caller-')),
    workspace = join(root, 'workspace'),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' }),
    ledger = join(root, 'ledger'),
    ready = join(root, 'ready');
  mkdirSync(workspace);
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let parentCalls = 0,
    childCalls = 0,
    reviewCalls = 0;
  let warm: Awaited<ReturnType<typeof launchPairedService>> | undefined;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        model: string;
        messages: { role: string; content: unknown }[];
      };
      const review = body.messages.some((message) =>
        String(message.content).includes('"instructions":"Review only this exact operation.'),
      );
      const child = body.model === 'child';
      if (review) {
        reviewCalls++;
        appendFileSync(ledger, 'review\n');
      } else if (child) {
        childCalls++;
        appendFileSync(ledger, 'child\n');
        await held;
      } else {
        parentCalls++;
        appendFileSync(
          ledger,
          parentCalls === 1
            ? 'parent-start\n'
            : parentCalls === 2
              ? 'parent-complete\n'
              : 'report\n',
        );
      }
      const content = review
        ? JSON.stringify({
            decision: 'ask_user',
            reason: 'Explicit original user approval required',
          })
        : child
          ? 'EXACT_ORIGINAL_CHILD_DONE'
          : parentCalls === 2
            ? 'ORIGINAL_PARENT_DONE'
            : 'REPORT_ORIGINAL_CHILD_DONE';
      const delta =
        !review && !child && parentCalls === 1
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: 'original-task',
                  type: 'function',
                  function: {
                    name: 'task',
                    arguments: JSON.stringify({
                      key: 'original-child',
                      role: 'reader',
                      resultDisposition: 'after_turn',
                      cancellation: 'detached',
                      input: { content: 'Original child effect' },
                    }),
                  },
                },
              ],
            }
          : { content };
      const frame = (delta: unknown, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
      return new Response(
        frame(delta, null) +
          frame({}, !review && !child && parentCalls === 1 ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const rows = (sql: string) => {
    const db = new Database(profile.databasePath, { readonly: true });
    try {
      return db.query(sql).all();
    } finally {
      db.close();
    }
  };
  try {
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'parent',
        tools: [{ id: 'task', definitionVersion: '1' }],
        models: ['parent', 'child'].map((id) => ({
          id,
          provider: 'compatible',
          model: id,
          baseURL: provider.url.href + 'v1',
        })),
      }),
      { mode: 0o600 },
    );
    const artifactRoot = join(root, 'artifact');
    await buildOwnedDaemon(artifactRoot);
    const source = join(artifactRoot, 'report-service.ts');
    writeFileSync(
      source,
      `import {existsSync,writeFileSync} from 'node:fs';import {selectProfile} from '@kite-ai/agent/profile';import {createDefaultProcessConfiguration} from '@kite-ai/service/configuration';import {runServiceProcess} from '@kite-ai/service/main';await runServiceProcess({configure(startup){return createDefaultProcessConfiguration({profile:selectProfile(startup.profile),hostConfiguration:startup.hostConfiguration,child:[{id:'reader',version:'1',modelId:'child',toolIds:[]}],afterTurn:{async authorize(input){const allowed=input.session.id==='s'&&input.command.id==='work'&&input.execution.definitionId==='task'&&input.execution.originCommandId==='work';if(allowed&&input.phase==='apply'&&!existsSync(${JSON.stringify(ready)})){writeFileSync(${JSON.stringify(ready)},JSON.stringify({executionId:input.execution.id,parentId:input.run.id}));await new Promise(()=>{});}return {allowed,revision:'owned-original-report-policy-v1'};}}});}});`,
    );
    const built = await Bun.build({
      entrypoints: [source],
      target: 'bun',
      packages: 'external',
      outdir: artifactRoot,
    });
    if (!built.success) throw Error('report_service_build');
    const entrypoint = join(artifactRoot, 'report-service.js'),
      hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const artifact: CLIServiceArtifact = {
      entrypoint,
      entrypointSha256: hash(entrypoint),
      executable: realpathSync(process.execPath),
      executableSha256: hash(process.execPath),
      buildId: 'owned-report-caller',
      apiMajor: 1,
    };
    const launch = () =>
      launchPairedService({
        ...artifact,
        profile,
        instanceId: crypto.randomUUID(),
        requiredCapabilities: ['sessions', 'commands', 'interactions', 'job_report_resume'],
      });
    warm = await launch();
    const client = warm.client,
      storeId = warm.bootstrap.storeId!;
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'Owned',
      rootUri: `file://${workspace}`,
    });
    const trust = await client.getWorkspaceTrust('w', { storeId });
    await client.setWorkspaceTrust('w', {
      expectedStoreId: storeId,
      commandId: 'trust',
      ifRevision: trust.revision,
      trusted: true,
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Original report',
    });
    await client.startRun('s', {
      kind: 'run.start',
      expectedStoreId: storeId,
      commandId: 'work',
      content: 'Delegate original child',
    });
    await untilRecovery(
      async () =>
        (await client.listInteractions('s', { storeId, state: 'pending' })).interactions.length > 0,
    );
    const card = (await client.listInteractions('s', { storeId, state: 'pending' }))
      .interactions[0]!;
    if (card.definitionId !== 'task') throw Error('original_task_card_unavailable');
    await client.answerInteraction('s', card.id, {
      expectedStoreId: storeId,
      commandId: 'approve-task',
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    await untilRecovery(async () =>
      (await client.getView('s')).runs.some(
        (run) => run.originCommandId === 'work' && run.status === 'completed',
      ),
    );
    await untilRecovery(async () =>
      (await client.listInteractions('s', { storeId, state: 'pending' })).interactions.some(
        (card) => card.definitionId === 'agent/reader',
      ),
    );
    const originalJob = (
      await client.listInteractions('s', { storeId, state: 'pending' })
    ).interactions.find((card) => card.definitionId === 'agent/reader')!;
    await client.answerInteraction('s', originalJob.id, {
      expectedStoreId: storeId,
      commandId: 'approve-original-job',
      expectedRevision: originalJob.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    release();
    await untilRecovery(async () => existsSync(ready));
    const original = JSON.parse(readFileSync(ready, 'utf8')) as {
      executionId: string;
      parentId: string;
    };
    const reports = rows("SELECT id,status,request_json FROM command WHERE kind='job.report'") as {
      id: string;
      status: string;
      request_json: string;
    }[];
    if (reports.length !== 1 || reports[0]!.status !== 'accepted')
      throw Error('original_report_not_accepted');
    const reportRequest = JSON.parse(reports[0]!.request_json) as {
      executionId: string;
      parentRunId: string;
    };
    const carrier = rows(
      `SELECT after_turn_json FROM execution WHERE id='${reportRequest.executionId}'`,
    ) as { after_turn_json: string }[];
    if (
      carrier.length !== 1 ||
      JSON.parse(carrier[0]!.after_turn_json).sourceExecutionId !== original.executionId ||
      reportRequest.parentRunId !== original.parentId
    )
      throw Error('original_report_carrier_mismatch');
    const reportId = reports[0]!.id;
    await client.getCommand(reportId);
    process.kill(warm.pid, 'SIGKILL');
    await warm.exited;
    client.disposeNetwork();
    warm = undefined;
    let closed = false;
    return {
      root,
      workspace,
      profile,
      artifact,
      storeId,
      ...original,
      sourceExecutionId: original.executionId,
      executionId: reportRequest.executionId,
      reportId,
      launch,
      rows,
      ledger,
      calls: () => ({ parentCalls, childCalls, reviewCalls }),
      close() {
        if (closed) return;
        closed = true;
        release();
        provider.stop(true);
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    release();
    if (warm) {
      console.error(
        'actual report preparation',
        await warm.client.getView('s').catch(() => null),
        await warm.client.getCommand('work').catch(() => null),
      );
      await warm.close().catch(() => {});
    }
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

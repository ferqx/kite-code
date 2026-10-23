import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { ordinaryHostConfigurationDefaults } from '../../../service/src/configuration-defaults';
import { ownedUserConfiguration } from '../../../service/test/fixtures/user-configuration-fixture';
import type { CLIServiceArtifact } from '../../host';
import {
  createStdioPermissionReader,
  promptPermissionMode,
  promptWorkspaceTrust,
} from '../../src/permissions';
import { buildOwnedDaemon } from './daemon-host-build';
import { type OriginalMessage, originalToolResults } from './original-tool-results';

export async function untilRecovery(check: () => Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > end) throw Error('recovery_fixture_timeout');
    await Bun.sleep(5);
  }
}

/** Default compatible SDK, actual original Auto ask_user card, real SIGKILL and owned SQLite. */
export async function recoveryProfile(
  options: { holdModelSessionId?: string; completeModelSessionId?: string } = {},
) {
  const root = temporaryDirectory('kite-client-recovery-'),
    workspace = join(root, 'workspace'),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  const userConfiguration = ownedUserConfiguration(join(root, 'home'));
  privateDirectory(workspace);
  privateDirectory(join(profile.profilePath, 'ui'));
  writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
    mode: 0o600,
  });
  const ledger = join(root, 'model-ledger');
  let calls = 0,
    heldModelRequests = 0;
  let observer: Database | undefined;
  const database = () => {
    if (!observer) {
      observer = new Database(profile.databasePath, { readonly: true });
      observer.run('PRAGMA query_only=ON');
      observer.run('PRAGMA busy_timeout=100');
    }
    return observer;
  };
  const reviews: { body: Record<string, unknown>; input: Record<string, unknown> }[] = [];
  const provider = (() => {
    try {
      return Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        idleTimeout: 0,
        async fetch(request) {
          const body = (await request.json()) as Record<string, unknown>;
          const messages = body.messages as OriginalMessage[];
          let input: Record<string, unknown> | undefined;
          try {
            const candidate = JSON.parse(
              (messages
                .slice()
                .reverse()
                .find((message) => message.role === 'user')?.content as string) ?? '',
            );
            if (candidate.purpose === 'authorization_check') input = candidate;
          } catch {}
          if (input) reviews.push({ body, input });
          else calls++;
          let complete = false;
          if (!input) {
            const row = database()
              .query(
                'SELECT command.request_json,run.session_id FROM run JOIN command ON command.id=run.origin_command_id WHERE run.is_active=1 ORDER BY command.seq DESC LIMIT 1',
              )
              .get() as { request_json: string; session_id: string } | null;
            const human = row && JSON.parse(row.request_json).content;
            if (typeof human !== 'string') throw Error('original_recovery_work_missing');
            if (row?.session_id === options.completeModelSessionId) {
              // Plain caller completion is independent of the original Files recovery approval.
              const frame = (delta: unknown, finish_reason: string | null) =>
                `data: ${JSON.stringify({ id: 'completed-caller', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
              return new Response(
                `${frame({ content: 'ORIGINAL_CALLER_DONE' }, null)}${frame({}, 'stop')}data: [DONE]\n\n`,
                { headers: { 'content-type': 'text/event-stream' } },
              );
            }
            if (row?.session_id === options.holdModelSessionId) {
              // A caller-journal fixture can hold its own real Model request active.
              // The original recovery work still follows the strict Files identity below.
              heldModelRequests++;
              return new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(
                      new TextEncoder().encode(
                        `data: ${JSON.stringify({ id: 'held-caller', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
                      ),
                    );
                  },
                }),
                { headers: { 'content-type': 'text/event-stream' } },
              );
            }
            complete = originalToolResults(messages, human, [
              { id: 'original-file', name: 'write_file' },
            ]);
          }
          if (!input) appendFileSync(ledger, complete ? 'completion\n' : 'decision\n');
          const delta = input
            ? {
                content: JSON.stringify({
                  decision: 'ask_user',
                  reason: 'Confirm the exact original recovery file edit',
                }),
              }
            : complete
              ? { content: 'RECOVERED_ORIGINAL_DONE' }
              : {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'original-file',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({
                          path: 'effect',
                          content: 'ORIGINAL_EFFECT_ONCE',
                          base: null,
                        }),
                      },
                    },
                  ],
                };
          const frame = (delta: unknown, reason: string | null) =>
            `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
          return new Response(
            `${frame(delta, null)}${frame({}, input || complete ? 'stop' : 'tool_calls')}data: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      });
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  })();
  let warm: Awaited<ReturnType<typeof launchPairedService>> | undefined;
  try {
    writeFileSync(
      userConfiguration.path,
      JSON.stringify({
        modelId: 'fixed',
        // This recovery case owns one Files effect; defaults merge by tool ID.
        tools: ordinaryHostConfigurationDefaults(true, true).tools.map(({ id }) => ({
          id,
          enabled: id === 'ask_user' || id === 'files.write',
          ...(id === 'files.write' ? { definitionVersion: '2' } : {}),
        })),
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `${provider.url.href}v1`,
          },
        ],
      }),
      { mode: 0o600 },
    );
    await buildOwnedDaemon(join(root, 'artifact'));
    const chosen = join(root, 'artifact/node_modules/@kite-ai/service/main.js');
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const artifact: CLIServiceArtifact = {
      entrypoint: chosen,
      entrypointSha256: hash(chosen),
      executable: realpathSync(process.execPath),
      executableSha256: hash(process.execPath),
      buildId: 'owned-recovery',
      apiMajor: 1,
    };
    const launch = () =>
      launchPairedService({
        profile,
        ...artifact,
        spawnChild: userConfiguration.spawnChild,
        instanceId: crypto.randomUUID(),
        requiredCapabilities: [
          'sessions',
          'commands',
          'history',
          'events',
          'interactions',
          'run_resume',
          'session_recovery',
        ],
      });
    warm = await launch();
    const client = warm.client,
      storeId = warm.bootstrap.storeId!;
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'Owned',
      rootUri: pathToFileURL(workspace).href,
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Original recovery',
    });
    for (const [line, invoke] of [
      ['trust\n', promptWorkspaceTrust],
      ['auto\n', promptPermissionMode],
    ] as const) {
      const reader = createStdioPermissionReader(Readable.from([line]));
      try {
        await invoke(line.startsWith('trust') ? 'w' : 's', storeId, reader, { client, write() {} });
      } finally {
        reader.dispose();
      }
    }
    // Retain one read-only WAL observer before dispatch. Reopening and closing
    // the shared-memory mapping inside every Provider callback races the writer.
    if (
      (database().query('SELECT store_id FROM storage_meta').get() as { store_id: string })
        .store_id !== storeId
    )
      throw Error('recovery_observer_store_changed');
    await client.startRun('s', {
      kind: 'run.start',
      expectedStoreId: storeId,
      commandId: 'work',
      content: 'Create the original effect once',
    });
    await untilRecovery(
      async () =>
        (await client.listInteractions('s', { storeId, state: 'pending' })).interactions.length > 0,
    );
    const card = (await client.listInteractions('s', { storeId, state: 'pending' }))
      .interactions[0]!;
    if (card.definitionId !== 'files.write' || calls !== 1)
      throw Error('original_tool_card_not_ready');
    const run = (await client.getView('s')).runs.find((run) => run.isActive)!;
    const rows = (sql: string) => database().query(sql).all();
    const reviewProof = () =>
      rows(
        "SELECT e.state,json_extract(e.result_json,'$.outcome') AS outcome,json_extract(json_extract(e.result_json,'$.content'),'$.decision') AS decision,e.parent_execution_id AS target FROM execution e JOIN command c ON c.id=e.origin_command_id WHERE c.kind='authorization.check'",
      ) as { state: string; outcome: string | null; decision: string | null; target: string }[];
    if (
      reviews.length !== 1 ||
      JSON.stringify(reviews[0]!.body.tools ?? []) !== '[]' ||
      existsSync(join(workspace, 'effect')) ||
      readFileSync(ledger, 'utf8') !== 'decision\n'
    )
      throw Error('original_actual_review_not_ready');
    const target = reviews[0]!.input.target as {
      executionId: string;
      sessionId: string;
      runId: string;
      originCommandId: string;
    };
    if (
      target.sessionId !== 's' ||
      target.runId !== run.id ||
      target.originCommandId !== 'work' ||
      JSON.stringify(reviewProof()) !==
        JSON.stringify([
          {
            state: 'succeeded',
            outcome: null,
            decision: 'ask_user',
            target: target.executionId,
          },
        ])
    )
      throw Error('original_actual_review_proof_invalid');
    process.kill(warm.pid, 'SIGKILL');
    await warm.exited;
    warm.client.disposeNetwork();
    warm = undefined;
    let closed = false;
    return {
      userConfiguration,
      root,
      workspace,
      profile,
      artifact,
      storeId,
      run,
      card,
      ledger,
      launch,
      calls: () => calls,
      heldModelRequests: () => heldModelRequests,
      rows,
      reviews,
      reviewProof,
      close() {
        if (closed) return;
        closed = true;
        provider.stop(true);
        observer?.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (warm) {
      console.error('original crash preparation', String(error), 'modelCalls', calls);
      await warm.close().catch(() => {});
    }
    provider.stop(true);
    observer?.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

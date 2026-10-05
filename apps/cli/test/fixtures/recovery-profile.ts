import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import type { CLIServiceArtifact } from '../../host';
import {
  createStdioPermissionReader,
  promptPermissionMode,
  promptWorkspaceTrust,
} from '../../src/permissions';
import { buildOwnedDaemon } from './daemon-host-build';

export async function untilRecovery(check: () => Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > end) throw Error('recovery_fixture_timeout');
    await Bun.sleep(5);
  }
}

/** Default compatible SDK, actual original Ask card, real SIGKILL and owned SQLite. */
export async function recoveryProfile() {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-client-recovery-')),
    workspace = join(root, 'workspace'),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(join(profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
  writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
    mode: 0o600,
  });
  const ledger = join(root, 'model-ledger');
  let calls = 0;
  const provider = (() => {
    try {
      return Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as { messages: { role: string }[] };
          calls++;
          const complete = body.messages.at(-1)?.role === 'tool';
          appendFileSync(ledger, complete ? 'completion\n' : 'decision\n');
          const delta = complete
            ? { content: 'RECOVERED_ORIGINAL_DONE' }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: 'original-file',
                    type: 'function',
                    function: {
                      name: 'files.write',
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
            `${frame(delta, null)}${frame({}, complete ? 'stop' : 'tool_calls')}data: [DONE]\n\n`,
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
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'fixed',
        tools: [{ id: 'files.write', definitionVersion: '2' }],
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
      rootUri: `file://${workspace}`,
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
      ['ask\n', promptPermissionMode],
    ] as const) {
      const reader = createStdioPermissionReader(Readable.from([line]));
      try {
        await invoke(line.startsWith('trust') ? 'w' : 's', storeId, reader, { client, write() {} });
      } finally {
        reader.dispose();
      }
    }
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
    process.kill(warm.pid, 'SIGKILL');
    await warm.exited;
    warm.client.disposeNetwork();
    warm = undefined;
    let closed = false;
    return {
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
      rows(sql: string) {
        const db = new Database(profile.databasePath, { readonly: true });
        try {
          return db.query(sql).all();
        } finally {
          db.close();
        }
      },
      close() {
        if (closed) return;
        closed = true;
        provider.stop(true);
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (warm) {
      console.error(
        'original crash preparation',
        JSON.stringify(await warm.client.getView('s').catch(() => null)),
        'modelCalls',
        calls,
      );
      await warm.close().catch(() => {});
    }
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

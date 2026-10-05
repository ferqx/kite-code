import { appendFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { selectProfile } from '@kite-ai/agent/profile';
import {
  type CallerCommandRequest,
  canonicalCallerCommandRequest,
  createClient,
} from '@kite-ai/client';
import {
  callerDigest,
  callerMetadata,
  callerTextDigest,
  NativeCallerJournal,
} from '../electron/caller-journal';
import { openPrivateData } from '../electron/private-data';
import { acquireDesktopProfileAccess } from '../electron/profile-access';

const [
  mode,
  profileJson,
  connectionJson,
  bunExecutable,
  bunSha256,
  helperPath,
  helperSha256,
  requestJson,
  wire,
] = process.argv.slice(2) as string[];
const profileInput = JSON.parse(profileJson!),
  connection = JSON.parse(connectionJson!),
  input = JSON.parse(requestJson!) as CallerCommandRequest;
const actual = globalThis.fetch;
let drop = true;
globalThis.fetch = Object.assign(
  async (...args: Parameters<typeof fetch>) => {
    const method = args[1]?.method ?? 'GET',
      url = String(args[0]),
      path = new URL(url).pathname;
    appendFileSync(
      wire!,
      `${JSON.stringify({
        mode,
        method,
        path,
        body: args[1]?.body ? JSON.parse(String(args[1].body)) : null,
      })}\n`,
    );
    if (
      drop &&
      ((mode === 'post' && method === 'POST' && path === '/v1/sessions/s/commands') ||
        (mode === 'get' && method === 'GET' && path === `/v1/commands/${input.commandId}`))
    ) {
      drop = false;
      return await new Promise<Response>((resolve, reject) => {
        const req = httpRequest(
          url,
          { method, headers: args[1]?.headers as Record<string, string> },
          (res) => {
            const socket = res.socket;
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                res.on('data', () => {
                  socket.destroy();
                  controller.error(Error('owned_physical_loss'));
                  if (mode === 'post') process.kill(process.pid, 'SIGKILL');
                });
                res.on('error', (e) => controller.error(e));
              },
            });
            resolve(
              new Response(body, {
                status: res.statusCode,
                headers: { 'content-type': 'application/json' },
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(args[1]?.body);
      });
    }
    return actual(...args);
  },
  { preconnect: actual.preconnect },
);
const access = await acquireDesktopProfileAccess({
    profile: profileInput,
    bunExecutable: bunExecutable!,
    bunSha256: bunSha256!,
    helperPath: helperPath!,
    helperSha256: helperSha256!,
  }),
  data = openPrivateData(selectProfile(profileInput).profilePath, access),
  client = createClient({
    endpoint: connection.endpoint,
    token: connection.token,
    expected: { profile: connection.profile, apiMajor: 1, requiredCapabilities: [] },
  });
try {
  await client.connect();
  const journal = new NativeCallerJournal(client, data);
  if (mode === 'capacity' || mode === 'bad-row') {
    const db = new DatabaseSync(
      join(selectProfile(profileInput).profilePath, 'desktop-private/data.sqlite'),
    );
    const created: string[] = [];
    let failure: string | undefined;
    try {
      if (mode === 'capacity') {
        while (journal.records().length < 128) {
          const commandId = `native-capacity-${created.length}`;
          await journal.prepare('s', { ...input, commandId });
          created.push(commandId);
        }
      } else
        db.prepare('INSERT INTO caller_intents VALUES(?,?)').run('native-corrupt-row', '{broken');
      try {
        await journal.prepare('s', { ...input, commandId: 'native-refused' });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      const retained = db
        .prepare('SELECT state FROM caller_intents WHERE command_id=?')
        .get(mode === 'bad-row' ? 'native-corrupt-row' : created[0]!);
      console.log(
        JSON.stringify({
          failure,
          retained: retained?.state,
          refused: db
            .prepare('SELECT count(*) AS n FROM caller_intents WHERE command_id=?')
            .get('native-refused')?.n,
        }),
      );
    } finally {
      for (const id of created) db.prepare('DELETE FROM caller_intents WHERE command_id=?').run(id);
      db.prepare('DELETE FROM caller_intents WHERE command_id=?').run('native-corrupt-row');
      db.close();
    }
  } else {
    if (mode === 'post' || mode === 'prepared' || mode === 'prepare' || mode === 'hot-drift') {
      await journal.prepare('s', input);
      if (mode === 'prepared') process.kill(process.pid, 'SIGKILL');
    }
    const db =
      mode?.startsWith('drift-') || mode === 'hot-drift'
        ? new DatabaseSync(
            join(selectProfile(profileInput).profilePath, 'desktop-private/data.sqlite'),
          )
        : undefined;
    const saved = db
      ?.prepare('SELECT state FROM caller_intents WHERE command_id=?')
      .get(input.commandId)?.state as string | undefined;
    if (saved && db) {
      const record = JSON.parse(saved);
      if (mode === 'drift-subject') record.intent.subjectId = 'different-real-subject';
      else if (mode === 'drift-workspace') record.intent.scope.workspaceId = 'other-workspace';
      else {
        record.intent.request.content += ' altered';
        record.intent.bodyDigest = callerDigest(record.intent.request);
        record.intent.requestDigest = callerTextDigest(
          canonicalCallerCommandRequest(record.intent.request),
        );
      }
      db.prepare('UPDATE caller_intents SET state=? WHERE command_id=?').run(
        JSON.stringify(record),
        input.commandId,
      );
    }
    let lookupError: string | undefined;
    try {
      if (mode !== 'prepare') await journal.submit(input.commandId);
    } catch (error) {
      lookupError = error instanceof Error ? error.message : String(error);
    }
    const row = journal.records().find((r) => r.intent.request.commandId === input.commandId);
    console.log(
      JSON.stringify(
        row
          ? { ...callerMetadata(row), ...(lookupError ? { lookupError } : {}) }
          : { missing: true },
      ),
    );
    if (saved && db)
      db.prepare('UPDATE caller_intents SET state=? WHERE command_id=?').run(
        saved,
        input.commandId,
      );
    db?.close();
  }
} finally {
  client.disposeNetwork();
  data.close();
  access.close();
}

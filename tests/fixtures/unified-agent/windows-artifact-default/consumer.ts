import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';

const [root] = process.argv.slice(2);
assert(root);
const resolver = createRequire(join(import.meta.dir, 'package.json'));
for (const specifier of [
  '@kite-ai/agent/artifacts',
  '@kite-ai/agent/sqlite',
  '@kite-ai/client',
  '@kite-ai/service/main',
]) {
  const path = resolver.resolve(specifier);
  assert(path.startsWith(join(import.meta.dir, 'node_modules')) && path.endsWith('.js'));
  assert(!existsSync(join(import.meta.dir, 'node_modules/@kite-ai/agent/src')));
}
const profile = selectProfile({ dataRoot: join(root, 'private'), profile: 'owned' });
// Actual default native creation precedes writing the private configuration (no broad-ACL repair).
const initialStore = await openSqliteStore(profile);
await initialStore.close();
const workspace = join(root, 'workspace');
mkdirSync(workspace);
const source = 'ORIGINAL_DEFAULT_ARTIFACT_SOURCE\r\nUse no tools.';
writeFileSync(join(workspace, 'AGENTS.md'), source);
const original = `\ufeffORIGINAL_USER_BEGIN\r\n${'完整原文 α😀\r\n'.repeat(12000)}ORIGINAL_USER_END`;
const requests: {
  messages: { role: string; content: string }[];
  tools?: { function: { name: string } }[];
}[] = [];
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    requests.push((await request.json()) as (typeof requests)[number]);
    const frame = (delta: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: 'owned-default-media', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(
      `${frame({ content: 'DEFAULT_MEDIA_COMPLETE' }, null)}${frame({}, 'stop')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  },
});
writeFileSync(
  join(profile.profilePath, 'config.jsonc'),
  JSON.stringify({
    modelId: 'fixed',
    tools: [],
    models: [
      { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
    ],
  }),
  { mode: 0o600 },
);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw Error('non_json_body');
  return text;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const launch = (instanceId: string) =>
  launchPairedService({
    profile,
    entrypoint: resolver.resolve('@kite-ai/service/main'),
    executable: process.execPath,
    instanceId,
    buildId: 'owned-sourcefree-default-media',
    apiMajor: 1,
    requiredCapabilities: ['sessions', 'commands', 'model_inputs', 'permission_controls'],
  });
let service: Awaited<ReturnType<typeof launch>> | undefined;
let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
let db: Database | undefined;
const counts = () =>
  ['command', 'run', 'execution', 'change_event', 'blob', 'blob_ref'].map((table) =>
    db!.query(`SELECT COUNT(*) AS n FROM ${table}`).get(),
  );
try {
  service = await launch('live');
  // Explicitly use the freshly built public Client consumer; no injected Service configure/policy.
  const client = createClient({
    endpoint: service.bootstrap.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
      apiMajor: 1,
      instanceId: 'live',
      buildId: 'owned-sourcefree-default-media',
      requiredCapabilities: ['model_inputs', 'permission_controls'],
    },
  });
  await client.connect();
  const storeId = service.bootstrap.storeId;
  assert(storeId);
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'owned',
    rootUri: pathToFileURL(workspace).href,
  });
  for (const sessionId of ['s', 'other'])
    await client.createSession({
      expectedStoreId: storeId,
      commandId: `create-${sessionId}`,
      sessionId,
      workspaceId: 'w',
      title: 'owned',
    });
  const trust = await client.getWorkspaceTrust('w', { storeId });
  assert.equal(
    (
      await client.setWorkspaceTrust('w', {
        expectedStoreId: storeId,
        commandId: 'trust',
        trusted: true,
        canonicalIdentity: trust.canonicalIdentity,
        externalReadScopeDigest: trust.externalReadScopeDigest,
        ifRevision: trust.revision,
      })
    ).state,
    'applied',
  );
  const mode = await client.getPermissionMode('s', { storeId });
  assert.equal(
    (
      await client.setPermissionMode('s', {
        expectedStoreId: storeId,
        commandId: 'full',
        mode: 'full',
        makeDefault: false,
        ifRevision: mode.revision,
        ifDefaultRevision: mode.defaultRevision,
      })
    ).state,
    'applied',
  );
  await client.startRun('s', {
    expectedStoreId: storeId,
    commandId: 'work',
    kind: 'run.start',
    content: original,
  });
  const deadline = Date.now() + 10000;
  let view = await client.getView('s');
  while (!view.runs.some((run) => run.status === 'completed')) {
    if (Date.now() > deadline) throw Error(`owned_model_deadline:${JSON.stringify(view.runs)}`);
    await Bun.sleep(10);
    view = await client.getView('s');
  }
  assert.equal(view.runs.length, 1);
  const run = view.runs[0]!;
  assert.equal(run.sessionId, 's');
  const model = view.executions.find((execution) => execution.kind === 'model');
  assert(model);
  assert.equal(model.status, 'succeeded');
  assert.equal(model.runId, run.id);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]!.tools?.map((tool) => tool.function.name) ?? [], ['ask_user']);
  assert(
    requests[0]!.messages.some(
      (message) => message.role === 'user' && message.content === original,
    ),
  );
  const command = await client.getCommand('work');
  assert.equal(command.status, 'applied');
  store = await openSqliteStore({ ...profile, mode: 'readonly' });
  const storedRun = await store.getRun(run.id);
  assert(storedRun);
  const storedSession = await store.getSession(storedRun.sessionId);
  assert(storedSession);
  assert.equal(storedSession.workspaceId, 'w');
  const stored = await store.getExecution(model.id);
  assert(stored);
  assert(stored.input && typeof stored.input === 'object' && !Array.isArray(stored.input));
  const body = stored.input.body;
  assert(body && typeof body === 'object' && !Array.isArray(body));
  assert.equal(body.kind, 'model_body');
  assert.equal(body.version, 1);
  const ref = body.reference;
  assert(ref && typeof ref === 'object' && !Array.isArray(ref));
  assert.equal(ref.storeId, storeId);
  assert.equal(ref.sessionId, 's');
  assert.equal(typeof ref.id, 'string');
  assert.equal(typeof ref.hash, 'string');
  assert.equal(typeof ref.size, 'string');
  assert.equal(ref.mediaType, 'application/json');
  assert(ref.scope && typeof ref.scope === 'object' && !Array.isArray(ref.scope));
  assert.equal(ref.scope.kind, 'session');
  assert.equal(ref.scope.id, 's');
  assert(BigInt(ref.size as string) > 65536n);
  db = new Database(profile.databasePath, { readonly: true });
  const before = counts(),
    metadata = await store.getMetadata();
  const snapshot = await client.getModelInput('s', model.id, { expectedStoreId: storeId });
  assert.equal(snapshot.storeId, storeId);
  assert.equal(snapshot.sessionId, 's');
  assert.equal(snapshot.runId, run.id);
  assert.equal(snapshot.executionId, model.id);
  assert.equal(snapshot.originCommandId, 'work');
  assert.equal(snapshot.confirmation, 'succeeded');
  assert.equal(snapshot.bodyHash, ref.hash);
  assert.equal(snapshot.bodyBytes, ref.size);
  const complete = Buffer.from(canonical(snapshot.request));
  assert.equal(hash(complete), snapshot.bodyHash);
  assert.equal(String(complete.length), snapshot.bodyBytes);
  assert(
    snapshot.request.messages.some(
      (message) => message.role === 'user' && message.content === original,
    ),
  );
  assert(snapshot.request.messages.some((message) => message.content === source));
  const media = await client.readArtifact(
    's',
    { expectedStoreId: storeId, refId: ref.id as string, scope: { kind: 'session', id: 's' } },
    {
      expectedReference: {
        size: ref.size as string,
        hash: ref.hash as string,
        mediaType: 'application/json',
        storeId,
      },
    },
  );
  assert.equal(hash(media.content), ref.hash);
  assert.deepEqual(media.content, Uint8Array.from(complete));
  let rejected = false;
  try {
    await client.getModelInput('other', model.id);
  } catch {
    rejected = true;
  }
  assert(rejected);
  assert.deepEqual(counts(), before);
  assert.deepEqual(await store.getMetadata(), metadata);
  assert.equal(requests.length, 1);
  await service.close();
  assert.equal(await service.exited, 0);
  service = undefined;
  // Complete close is the real drain boundary; every original blob remains intact before cold reopen.
  assert.deepEqual(counts(), before);
  assert.equal(
    hash(
      readFileSync(
        join(profile.profilePath, 'blobs', (ref.hash as string).slice(0, 2), ref.hash as string),
      ),
    ),
    ref.hash,
  );
  writeFileSync(join(workspace, 'AGENTS.md'), 'CURRENT_SOURCE_MUST_NOT_REPLACE_ORIGINAL');
  service = await launch('cold');
  const cold = await service.client.getModelInput('s', model.id);
  assert.deepEqual(cold.request, snapshot.request);
  assert.deepEqual(cold.metadata, snapshot.metadata);
  assert.equal(cold.bodyHash, snapshot.bodyHash);
  assert.deepEqual(await service.client.getCommand('work'), command);
  const coldMedia = await service.client.readArtifact(
    's',
    { expectedStoreId: storeId, refId: ref.id as string, scope: { kind: 'session', id: 's' } },
    {
      expectedReference: {
        size: ref.size as string,
        hash: ref.hash as string,
        mediaType: 'application/json',
        storeId,
      },
    },
  );
  assert.deepEqual(coldMedia.content, media.content);
  assert.deepEqual(counts(), before);
  assert.deepEqual(await store.getMetadata(), metadata);
  assert.equal(requests.length, 1);
  await service.close();
  assert.equal(await service.exited, 0);
  service = undefined;
  console.log(
    JSON.stringify({
      platform: process.platform,
      sourceFree: true,
      defaultConfiguration: true,
      providerCalls: requests.length,
      recordCounts: Object.fromEntries(
        ['command', 'run', 'execution', 'change_event', 'blob', 'blob_ref'].map((name, index) => [
          name,
          before[index],
        ]),
      ),
      cursor: metadata.lastChangeCursor,
      bodyBytes: snapshot.bodyBytes,
      bodyHash: snapshot.bodyHash,
      originalInputHash: hash(Buffer.from(original)),
      storeId,
      sessionId: snapshot.sessionId,
      workspaceId: storedSession.workspaceId,
      runId: snapshot.runId,
      executionId: snapshot.executionId,
      refId: ref.id,
      originalCommand: command.status,
      completeClose: true,
      coldNoNewRecords: true,
    }),
  );
} finally {
  await service?.close();
  db?.close();
  await store?.close();
  provider.stop(true);
}

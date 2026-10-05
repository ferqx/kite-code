import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { getLoadedSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { launchPairedService } from '@kite-ai/service/paired';
import { verifyTerminalRuntimeBundle } from '@kite-ai/service/runtime-assets';

const [workspace, candidateRoot, barrier] = process.argv.slice(2);
if (!workspace || !candidateRoot || !barrier) throw Error('platform_probe_helper_arguments');
const lease = acquireArtifactAccess({ root: candidateRoot, mode: 'shared' });
const candidate = verifyTerminalRuntimeBundle(candidateRoot);
const home = join(workspace, 'home');
mkdirSync(home, { recursive: true, mode: 0o700 });
process.env.HOME = home;
const profile = selectProfile({
  dataRoot: join(home, '.kite-code/unified-agent'),
  profile: 'default',
});
mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
writeFileSync(join(barrier, 'ready'), 'second-owned-shared', { mode: 0o600, flag: 'wx' });
let service: Awaited<ReturnType<typeof launchPairedService>> | undefined;
let reader: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
let calls = 0;
const asset = 'candidate/node_modules/@kite-ai/agent/storage/migrations/0001-baseline.sql';
const body = 'actual ordinary Files 😀\r\n';
const assetHash = createHash('sha256')
  .update(readFileSync(join(workspace, asset)))
  .digest('hex');
const assetStat = lstatSync(join(workspace, asset));
const assetBaseline = {
  hash: assetHash,
  size: assetStat.size,
  device: String(assetStat.dev),
  inode: String(assetStat.ino),
};
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const raw = (await request.json()) as { messages: unknown[] };
    if (!Array.isArray(raw.messages)) throw Error('fixed_provider_bad_request');
    calls++;
    const call =
      calls === 1
        ? { name: 'files.write', input: { path: 'ordinary.txt', base: null, content: body } }
        : calls === 2
          ? { name: 'files.read', input: { path: 'ordinary.txt' } }
          : calls === 3
            ? { name: 'files.read', input: { path: asset } }
            : calls === 4
              ? {
                  name: 'files.write',
                  input: { path: asset, base: assetBaseline, content: 'MUST_NOT_PUBLISH' },
                }
              : null;
    const delta = call
      ? {
          tool_calls: [
            {
              index: 0,
              id: `platform-${calls}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            },
          ],
        }
      : { content: 'actual platform diagnostic complete' };
    const frame = (delta: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: 'owned-fixed', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(
      `${frame(delta, null)}${frame({}, call ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  },
});
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
  const end = Date.now() + 30000;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > end) throw Error('platform_probe_actual_deadline');
    await Bun.sleep(10);
  }
}
let result: Record<string, unknown> | undefined;
let cleanup = 'confirmed';
try {
  const deadline = Date.now() + 15000;
  while (!existsSync(join(barrier, 'continue'))) {
    if (Date.now() > deadline) throw Error('platform_probe_lease_barrier_expired');
    await Bun.sleep(5);
  }
  const configuration = (tools: { id: string; definitionVersion: string }[]) =>
    JSON.stringify({
      modelId: 'fixed',
      models: [
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
      ],
      tools,
    });
  const configPath = join(profile.profilePath, 'config.jsonc');
  writeFileSync(configPath, configuration([{ id: 'shell.launch', definitionVersion: '1' }]), {
    mode: 0o600,
  });
  service = await launchPairedService({
    profile,
    entrypoint: join(candidateRoot, candidate.manifest.entries.service),
    executable: join(candidateRoot, candidate.manifest.entries.runtime),
    instanceId: 'unified-platform-owned',
    buildId: `terminal-${candidate.digest}`,
    apiMajor: 1,
    runtimeProtection: {
      kind: 'terminal.candidate',
      root: candidateRoot,
      manifestSha256: candidate.digest,
    },
    requiredCapabilities: ['sessions', 'commands', 'history', 'permission_controls'],
  });
  const client = service.client,
    storeId = service.bootstrap.storeId!;
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'Owned platform probe',
    rootUri: pathToFileURL(workspace).href,
  });
  await client.createSession({
    expectedStoreId: storeId,
    commandId: 'create-platform',
    sessionId: 's',
    workspaceId: 'w',
    title: 'Platform diagnostic',
  });
  const trust = await client.getWorkspaceTrust('w', { storeId });
  await client.setWorkspaceTrust('w', {
    expectedStoreId: storeId,
    commandId: 'trust-platform',
    trusted: true,
    canonicalIdentity: trust.canonicalIdentity,
    externalReadScopeDigest: trust.externalReadScopeDigest,
    ifRevision: trust.revision,
  });
  const mode = await client.getPermissionMode('s', { storeId });
  await client.setPermissionMode('s', {
    expectedStoreId: storeId,
    commandId: 'full-platform',
    mode: 'full',
    makeDefault: false,
    ifRevision: mode.revision,
    ifDefaultRevision: mode.defaultRevision,
  });
  await client.startRun('s', {
    kind: 'run.start',
    expectedStoreId: storeId,
    commandId: 'no-default-shell',
    content: 'Selected Shell must remain unavailable.',
  });
  const shell = await until(
    () => client.getCommand('no-default-shell'),
    (value) => value.status !== 'accepted',
  );
  const shellView = await client.getView('s');
  if (
    shell.status !== 'rejected' ||
    !JSON.stringify(shell).includes('shell_unavailable') ||
    calls !== 0 ||
    shellView.executions.length !== 0
  )
    throw Error('default_shell_gate_not_closed');
  writeFileSync(
    configPath,
    configuration([
      { id: 'files.read', definitionVersion: '3' },
      { id: 'files.write', definitionVersion: '2' },
    ]),
    { mode: 0o600 },
  );
  await client.startRun('s', {
    kind: 'run.start',
    expectedStoreId: storeId,
    commandId: 'actual-files',
    content: 'Ordinary Files and protected runtime assets.',
  });
  const command = await until(
    () => client.getCommand('actual-files'),
    (value) => value.status !== 'accepted',
  );
  const id = (command.receipt as { runId?: string } | null)?.runId;
  if (command.status !== 'applied' || !id) throw Error('actual_files_run_not_applied');
  const run = await until(
    () => client.getRun(id),
    (value) => !value.isActive,
  );
  const view = await client.getView('s');
  const tools = view.executions.filter((value) => value.kind === 'tool');
  if (
    run.status !== 'completed' ||
    Number(calls) !== 5 ||
    tools.length !== 4 ||
    tools.filter((e) => e.status === 'succeeded').length !== 2 ||
    tools.filter((e) => e.status === 'failed').length !== 2 ||
    readFileSync(join(workspace, 'ordinary.txt'), 'utf8') !== body ||
    assetHash !==
      createHash('sha256')
        .update(readFileSync(join(workspace, asset)))
        .digest('hex')
  )
    throw Error('actual_files_boundary_failed');
  const servicePid = service.pid;
  await service.close();
  service = undefined;
  reader = await openSqliteStore({
    dataRoot: profile.dataRoot,
    profile: profile.profile,
    mode: 'readonly',
  });
  const originalTools = (await reader.listExecutions('s'))
    .filter((e) => e.kind === 'tool')
    .sort((a, b) => a.callId.localeCompare(b.callId));
  if (
    originalTools.map((e) => e.callId).join(',') !==
      'platform-1,platform-2,platform-3,platform-4' ||
    !JSON.stringify(originalTools[1]?.result).includes('ordinary') ||
    !JSON.stringify(originalTools[2]?.result).includes('file_path_protected') ||
    !JSON.stringify(originalTools[3]?.result).includes('file_path_protected')
  )
    throw Error('exact_original_tool_results_mismatch');
  const loaded = getLoadedSqliteEngine();
  if (
    !loaded ||
    loaded.selection.manifestSha256 !== candidate.manifest.sqlite.manifestSha256 ||
    loaded.version !== candidate.manifest.sqlite.version ||
    loaded.sourceId !== candidate.manifest.sqlite.sourceId
  )
    throw Error('actual_selected_sqlite_mismatch');
  const cursor = (await reader.getMetadata()).lastChangeCursor;
  if (
    (await reader.getCommand('no-default-shell'))?.status !== 'rejected' ||
    (await reader.getRun(id))?.status !== 'completed' ||
    (await reader.getMetadata()).lastChangeCursor !== cursor
  )
    throw Error('cold_platform_facts_changed');
  result = {
    status: 'passed',
    pid: process.pid,
    servicePid,
    runtimeVersion: process.versions.bun,
    storeId,
    sessionId: 's',
    providerCalls: calls,
    cursor,
    files: {
      status: 'passed',
      runId: id,
      writeExecutionId: originalTools[0]!.id,
      readExecutionId: originalTools[1]!.id,
      bodySha256: createHash('sha256').update(body).digest('hex'),
    },
    runtimeAssets: {
      status: 'passed',
      readExecutionId: originalTools[2]!.id,
      writeExecutionId: originalTools[3]!.id,
      unchangedSha256: assetHash,
    },
    shell: {
      status: 'unavailable',
      commandId: shell.id,
      reason: 'shell_unavailable',
      providerCalls: 0,
      jobs: 0,
    },
    sqlite: {
      status: 'passed',
      driver: 'bun:sqlite',
      version: loaded.version,
      sourceId: loaded.sourceId,
      manifestSha256: loaded.selection.manifestSha256,
    },
  };
} catch (error) {
  result = {
    status: 'failed',
    reason: error instanceof Error ? error.message.slice(0, 512) : 'platform_helper_failed',
    pid: process.pid,
  };
} finally {
  for (const close of [
    async () => reader?.close(),
    async () => service?.close(),
    async () => provider.stop(true),
    async () => lease.release(),
  ]) {
    try {
      await close();
    } catch {
      cleanup = 'unconfirmed';
    }
  }
}
console.log(JSON.stringify({ ...result, cleanup }));
if (result?.status !== 'passed' || cleanup !== 'confirmed') process.exitCode = 1;

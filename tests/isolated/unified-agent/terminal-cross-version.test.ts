import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { SqliteEngineObservation } from '@kite-ai/agent/sqlite-engine';
import { createFixedModel } from '@kite-ai/ai';
import type { Command, ModelOutputSnapshot, ServerInfo, SessionView } from '@kite-ai/client';
import { inspectProcess } from '@kite-ai/service/daemon';
import { ownedUserConfiguration } from '../../../apps/service/test/fixtures/user-configuration-fixture';
import { sessionTitleInstructions } from '../../../packages/agent/src/business/session-title/title';
import {
  packTerminalBundle,
  unpackTerminalBundle,
} from '../../../scripts/release/terminal-archive';
import {
  buildTerminalBundle,
  installTerminalBundle,
  rollbackTerminalBundle,
  uninstallTerminalBundle,
} from '../../../scripts/release/terminal-bundle';
import { privateDirectory } from '../../fixtures/test-filesystem';
import {
  CURRENT_SCHEMA_TERMINAL_PREDECESSOR_COMMIT,
  materializeCurrentSchemaTerminalPredecessor,
  materializeTerminalPredecessor,
  TERMINAL_PREDECESSOR_COMMIT,
} from '../../fixtures/unified-agent/terminal-predecessor';

const repositoryRoot = resolve(import.meta.dir, '../../..');
const sessionId = 'terminal-version-session';
const tasks = [
  'cross-version-A-before',
  'New task: cross-version-B-produced',
  'cross-version-A-after',
];
const bodies = [
  'ORIGINAL A BODY',
  `B CURRENT FULL BODY\n${'\u4e8c\u4ee3\u{1f642}\n'.repeat(32000)}B EXACT ORIGINAL TAIL`,
  'A AFTER ROLLBACK BODY',
];
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
interface Snapshot {
  server: ServerInfo;
  process: { pid: number; startIdentity: string; instanceId: string; buildId: string };
  store: { storeId: string; cursor: string };
  engine: SqliteEngineObservation;
  view: SessionView;
  messages: { id: string; outputBody?: { executionId: string; contentBytes: string } }[];
  receipts: Command[];
  outputs: ModelOutputSnapshot[];
  titleOutputs: ModelOutputSnapshot[];
}
async function execute(argv: string[], cwd: string, home: string, timeoutMs = 30000) {
  const child = Bun.spawn(argv, {
    cwd,
    env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0)
      throw Error(
        `terminal_version_command_failed:${argv[1]}:${code}:${stderr.slice(-6000)}:${stdout.slice(-1000)}`,
      );
    return stdout;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}

test('real Terminal code upgrade and cold rollback preserve new data and continue the same original Store', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-terminal-versions-')));
  const home = join(root, 'home'),
    workspace = join(root, 'workspace');
  for (const path of [home, workspace]) privateDirectory(path);
  const profile = selectProfile({
    dataRoot: join(home, '.kite-code/unified-agent'),
    profile: 'default',
  });
  const socket = join(root, 'owned.sock'),
    prefix = join(root, 'installed');
  const cli = join(prefix, 'bin/kite');
  const snapshots: Snapshot[] = [];
  const commandIds: string[] = [];
  const modelExecutionIds: string[] = [];
  const instances: string[] = [];
  const stopped: number[] = [];
  const requestFacts: { task: string; contextHasB: boolean }[] = [];
  let titleCalls = 0;
  let daemonLive = false,
    succeeded = false;
  let provider: ReturnType<typeof Bun.serve> | undefined;
  try {
    const predecessor = await materializeCurrentSchemaTerminalPredecessor({ root, repositoryRoot });
    expect(predecessor.provenance.commit).toBe(CURRENT_SCHEMA_TERMINAL_PREDECESSOR_COMMIT);
    expect(predecessor.provenance.platform).toBe(process.platform);
    expect(predecessor.provenance.sourceRemoved).toBe(true);
    expect(existsSync(predecessor.provenance.sourceRoot)).toBe(false);
    const currentHead = (await execute(['git', 'rev-parse', 'HEAD'], repositoryRoot, home)).trim();
    const current = await buildTerminalBundle({
      destination: join(root, 'current-output'),
      repositoryRoot,
      bunExecutable: process.execPath,
    });
    expect(current.manifest.source.commit).toBe(currentHead);
    expect(currentHead).not.toBe(CURRENT_SCHEMA_TERMINAL_PREDECESSOR_COMMIT);
    expect(current.manifest.productVersion).toBe(predecessor.candidate.manifest.productVersion);
    expect(current.candidateId).not.toBe(predecessor.candidate.digest);
    const oldFiles = new Map(
      predecessor.candidate.manifest.files.map((file) => [file.path, file.sha256]),
    );
    expect(
      current.manifest.files.some(
        (file) =>
          file.path.startsWith('node_modules/@kite-ai/agent/') &&
          oldFiles.get(file.path) !== file.sha256,
      ),
    ).toBe(true);
    const candidates = [];
    for (const [name, source] of [
      ['old', predecessor.candidate.root],
      ['new', current.root],
    ] as const) {
      const archive = await packTerminalBundle({
        bundleRoot: source,
        archivePath: join(root, `${name}.tar.gz`),
      });
      const candidate = await unpackTerminalBundle({
        archivePath: archive.archivePath,
        sha256: archive.sha256,
        destination: join(root, `${name}-relocated`),
      });
      candidates.push(candidate);
      rmSync(source, { recursive: true });
      expect(existsSync(source)).toBe(false);
    }
    const old = candidates[0]!,
      newer = candidates[1]!;
    expect(old.candidateId).toBe(predecessor.candidate.digest);
    expect(newer.candidateId).toBe(current.candidateId);
    const compiled = await Bun.build({
      entrypoints: [
        resolve(repositoryRoot, 'tests/fixtures/unified-agent/terminal-cross-version-read.ts'),
      ],
      target: 'bun',
      packages: 'external',
      outdir: join(root, 'reader'),
      naming: 'read.js',
    });
    expect(compiled.success).toBe(true);
    const readerHash = hash(readFileSync(join(root, 'reader/read.js')));
    const text = (value: unknown): string =>
      typeof value === 'string'
        ? value
        : Array.isArray(value)
          ? value.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
          : '';
    provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
        if (
          body.messages.some(
            (message) =>
              message.role === 'system' && text(message.content) === sessionTitleInstructions,
          )
        ) {
          titleCalls++;
          const frame = (delta: unknown, reason: string | null) =>
            `data: ${JSON.stringify({ id: 'version-title', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
          return new Response(
            `${frame({ content: 'Cross-version' }, null)}${frame({}, 'stop')}data: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        const task = text(
          [...body.messages]
            .reverse()
            .find((message) => message.role === 'user' && tasks.includes(text(message.content)))
            ?.content,
        );
        const index = tasks.indexOf(task);
        if (index !== requestFacts.length || index < 0)
          return new Response('unexpected original work', { status: 500 });
        requestFacts.push({
          task,
          contextHasB: body.messages.some((message) => text(message.content) === bodies[1]),
        });
        const frame = (delta: unknown, reason: string | null) =>
          `data: ${JSON.stringify({ id: `owned-version-${index}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
        let response = '';
        for (let offset = 0; offset < bodies[index]!.length; offset += 16000)
          response += frame({ content: bodies[index]!.slice(offset, offset + 16000) }, null);
        response += `${frame({}, 'stop')}data: [DONE]\n\n`;
        return new Response(response, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    privateDirectory(profile.profilePath);
    const configurationPath = join(profile.profilePath, 'config.jsonc');
    writeFileSync(
      configurationPath,
      JSON.stringify({
        modelId: 'fixed',
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `${provider.url.href}v1`,
            // This finite Provider accepts the full original history, with no summary protocol.
            modelCapabilities: { contextWindowTokens: 1_000_000 },
          },
        ],
      }),
      { mode: 0o600 },
    );
    const configBytes = readFileSync(configurationPath);
    // The original predecessor reads Profile configuration; current code reads the user source.
    const userConfiguration = ownedUserConfiguration(home);
    writeFileSync(userConfiguration.path, configBytes, { mode: 0o600 });
    const installedRoots: string[] = [];
    const start = async (candidate: typeof old) => {
      const status = JSON.parse(
        await execute(
          [cli, 'server', 'start', '--server', socket, '--workspace', workspace],
          workspace,
          home,
        ),
      );
      daemonLive = true;
      expect(status.state).toBe('accepting');
      expect(status.runningBuildId).toBe(candidate.buildId);
      expect(instances).not.toContain(status.instanceId);
      instances.push(status.instanceId);
    };
    const read = async (candidate: typeof old, releaseRoot: string) => {
      const moduleLink = join(root, 'reader/node_modules');
      rmSync(moduleLink, { force: true });
      symlinkSync(join(releaseRoot, 'node_modules'), moduleLink, 'dir');
      const runtime = join(releaseRoot, candidate.manifest.entries.runtime);
      const result = JSON.parse(
        await execute(
          [
            runtime,
            join(root, 'reader/read.js'),
            profile.dataRoot,
            socket,
            sessionId,
            JSON.stringify(commandIds),
            candidate.buildId,
          ],
          workspace,
          home,
        ),
      ) as Snapshot;
      expect(result.server.buildId).toBe(candidate.buildId);
      expect(result.engine.version).toBe(candidate.manifest.sqlite.version);
      expect(result.engine.sourceId).toBe(candidate.manifest.sqlite.sourceId);
      expect(result.process.instanceId).toBe(instances.at(-1)!);
      expect(result.view.session.id).toBe(sessionId);
      expect(result.outputs).toHaveLength(commandIds.length);
      expect(titleCalls).toBe(1);
      expect(result.titleOutputs).toHaveLength(1);
      expect(result.titleOutputs[0]!.output).toMatchObject({
        content: 'Cross-version',
        complete: true,
      });
      expect(result.titleOutputs[0]!.runId).toBeNull();
      if (snapshots.length) {
        const prior = snapshots[0]!.titleOutputs[0]!;
        expect(result.titleOutputs[0]!.executionId).toBe(prior.executionId);
        expect(result.titleOutputs[0]!.bodyHash).toBe(prior.bodyHash);
        expect(result.titleOutputs[0]!.output).toEqual(prior.output);
      }
      expect(result.view.runs).toHaveLength(commandIds.length);
      expect(result.view.runs.every((run) => run.status === 'completed')).toBe(true);
      expect(result.receipts.map((receipt) => receipt.id)).toEqual(commandIds);
      expect(result.receipts.every((receipt) => receipt.status === 'applied')).toBe(true);
      expect(
        result.receipts.every((receipt) => receipt.originStoreId === result.store.storeId),
      ).toBe(true);
      for (const [index, executionId] of modelExecutionIds.entries()) {
        const output = result.outputs.find((value) => value.executionId === executionId)!;
        expect(output).toBeDefined();
        expect(output.storeId).toBe(result.store.storeId);
        const receipt = result.receipts[index]!.receipt;
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
          throw Error('terminal_version_command_receipt_missing');
        const sourceCommandId =
          typeof receipt.businessCommandId === 'string'
            ? receipt.businessCommandId
            : commandIds[index]!;
        expect(output.originCommandId).toBe(sourceCommandId);
        const run = result.view.runs.find((value) => value.id === output.runId)!;
        expect(run.originCommandId).toBe(sourceCommandId);
        if (typeof receipt.runId !== 'string') throw Error('terminal_version_run_receipt_missing');
        expect(run.id).toBe(receipt.runId);
        expect(sourceCommandId).toBe(commandIds[index]!);
        // The historical reader predates this optional DTO field, but must retain the exact original command origin.
        if (candidate.candidateId === newer.candidateId)
          expect(run.rootWorkCommandId).toBe(commandIds[index]!);
        expect(output.output.complete).toBe(true);
        expect(output.output.content === bodies[index]).toBe(true);
        expect(hash(output.output.content)).toBe(hash(bodies[index]!));
        expect(output.contentBytes).toBe(String(Buffer.byteLength(output.output.content)));
      }
      expect(requestFacts).toHaveLength(commandIds.length);
      if (snapshots.length) {
        expect(result.store.storeId).toBe(snapshots[0]!.store.storeId);
        for (const prior of snapshots.at(-1)!.outputs) {
          const saved = result.outputs.find((output) => output.executionId === prior.executionId)!;
          expect(saved).toBeDefined();
          expect(saved.runId).toBe(prior.runId);
          expect(saved.bodyHash).toBe(prior.bodyHash);
          expect(saved.output).toEqual(prior.output);
        }
        for (const prior of snapshots.at(-1)!.receipts)
          expect(result.receipts.find((value) => value.id === prior.id)).toEqual(prior);
        for (const prior of snapshots.at(-1)!.messages) {
          const saved = result.messages.find((value) => value.id === prior.id);
          expect(saved).toBeDefined();
          expect(saved?.outputBody).toEqual(prior.outputBody);
        }
      }
      return result;
    };
    const stop = async (candidate: typeof old, snapshot: Snapshot) => {
      await execute([cli, 'server', 'stop', '--server', socket], workspace, home);
      daemonLive = false;
      expect(
        JSON.parse(await execute([cli, 'server', 'status', '--server', socket], workspace, home))
          .state,
      ).toBe('absent');
      expect(inspectProcess(snapshot.process.pid, snapshot.process.startIdentity)).toBe('dead');
      stopped.push(snapshot.process.pid);
      for (const releaseRoot of installedRoots) {
        const lease = acquireArtifactAccess({ root: releaseRoot, mode: 'exclusive' });
        lease.release();
      }
      expect(snapshot.process.buildId).toBe(candidate.buildId);
    };
    const run = async (index: number) => {
      const stdout = await execute(
        [
          cli,
          'run',
          '--server',
          socket,
          '--thread',
          sessionId,
          '--task',
          tasks[index]!,
          '--workspace',
          workspace,
          '--trust-workspace',
          '--full',
        ],
        workspace,
        home,
      );
      const intent = /^work intent (\{.*\})$/m.exec(stdout);
      expect(intent).not.toBeNull();
      const parsed = JSON.parse(intent![1]!) as {
        storeId: string;
        sessionId: string;
        commandId: string;
      };
      expect(parsed.sessionId).toBe(sessionId);
      expect(commandIds).not.toContain(parsed.commandId);
      // The formal CLI emits one JSON-escaped complete answer, including every newline.
      const answers = stdout.split('\n').filter((line) => line.startsWith('answer {'));
      expect(answers).toHaveLength(1);
      const answer = JSON.parse(answers[0]!.slice('answer '.length)) as {
        storeId: string;
        sessionId: string;
        commandId: string;
        executionId: string;
        complete: boolean;
        content: string;
      };
      expect(answer.storeId).toBe(parsed.storeId);
      expect(answer.sessionId).toBe(parsed.sessionId);
      expect(answer.commandId).toBe(parsed.commandId);
      expect(answer.complete).toBe(true);
      expect(answer.content === bodies[index]).toBe(true);
      expect(Buffer.byteLength(answer.content)).toBe(Buffer.byteLength(bodies[index]!));
      expect(hash(answer.content)).toBe(hash(bodies[index]!));
      expect(modelExecutionIds).not.toContain(answer.executionId);
      commandIds.push(parsed.commandId);
      modelExecutionIds.push(answer.executionId);
      expect(requestFacts).toHaveLength(index + 1);
    };
    const first = await installTerminalBundle({ bundleRoot: old.root, prefix });
    installedRoots.push(first.releaseRoot);
    await start(old);
    await run(0);
    snapshots.push(await read(old, first.releaseRoot));
    await stop(old, snapshots.at(-1)!);
    const databaseIdentity = lstatSync(profile.databasePath);
    const second = await installTerminalBundle({ bundleRoot: newer.root, prefix });
    installedRoots.push(second.releaseRoot);
    expect(second.previousCandidateId).toBe(old.candidateId);
    await start(newer);
    const upgradedBefore = await read(newer, second.releaseRoot);
    expect(upgradedBefore.outputs).toEqual(
      snapshots[0]!.outputs.map((value) => ({
        ...value,
        snapshotCursor: upgradedBefore.outputs[0]!.snapshotCursor,
      })),
    );
    await run(1);
    snapshots.push(await read(newer, second.releaseRoot));
    await stop(newer, snapshots.at(-1)!);
    const generatedBytes = readFileSync(profile.databasePath);
    const rolledBack = rollbackTerminalBundle(prefix);
    expect(rolledBack.candidateId).toBe(old.candidateId);
    expect(rolledBack.previousCandidateId).toBe(newer.candidateId);
    expect(readFileSync(profile.databasePath)).toEqual(generatedBytes);
    await start(old);
    const coldOld = await read(old, first.releaseRoot);
    expect(coldOld.outputs.find((output) => output.output.content === bodies[1])!.bodyHash).toBe(
      snapshots[1]!.outputs.find((output) => output.output.content === bodies[1])!.bodyHash,
    );
    await run(2);
    expect(requestFacts[2]!.contextHasB).toBe(true);
    snapshots.push(await read(old, first.releaseRoot));
    await stop(old, snapshots.at(-1)!);
    expect(rollbackTerminalBundle(prefix).candidateId).toBe(newer.candidateId);
    await start(newer);
    const final = await read(newer, second.releaseRoot);
    expect(final.store.storeId).toBe(snapshots[0]!.store.storeId);
    expect(requestFacts).toHaveLength(3);
    expect(commandIds).toHaveLength(3);
    expect(new Set(final.view.runs.map((value) => value.id)).size).toBe(3);
    await stop(newer, final);
    const finalDatabase = readFileSync(profile.databasePath);
    expect(lstatSync(profile.databasePath).ino).toBe(databaseIdentity.ino);
    expect(readFileSync(configurationPath)).toEqual(configBytes);
    uninstallTerminalBundle(prefix);
    expect(existsSync(prefix)).toBe(false);
    expect(readFileSync(profile.databasePath)).toEqual(finalDatabase);
    expect(readFileSync(configurationPath)).toEqual(configBytes);
    expect(readFileSync(userConfiguration.path)).toEqual(configBytes);
    console.log(
      `TERMINAL_REAL_CODE_COMPATIBILITY ${JSON.stringify({ prior: predecessor.provenance, current: current.manifest.source, candidates: [old.candidateId, newer.candidateId], readerHash, storeId: final.store.storeId, commandIds, runIds: final.view.runs.map((value) => value.id), modelExecutionIds: final.outputs.map((value) => value.executionId), fullBodyBytes: Buffer.byteLength(bodies[1]!), fullBodyHash: hash(bodies[1]!), requests: requestFacts, instances, stopped, exclusiveAfterStops: true, databaseInodeRetained: true, dataRestored: false, cleanup: 'confirmed' })}`,
    );
    succeeded = true;
  } finally {
    if (daemonLive) await execute([cli, 'server', 'stop', '--server', socket], workspace, home);
    provider?.stop(true);
    if (succeeded) rmSync(root, { recursive: true });
    else console.log(`OWNED_TERMINAL_VERSION_FAILURE_ROOT ${root}`);
  }
}, 360000);

test('the original Terminal predecessor rejects recovery-audit schema without changing the current Store', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-terminal-reject-'))),
    home = join(root, 'home'),
    workspace = join(root, 'workspace'),
    prefix = join(root, 'installed'),
    socket = join(root, 'owned.sock'),
    cli = join(prefix, 'bin/kite');
  for (const path of [home, workspace]) privateDirectory(path);
  const profile = selectProfile({
    dataRoot: join(home, '.kite-code/unified-agent'),
    profile: 'default',
  });
  const model = createFixedModel([
    [
      { type: 'text_delta', text: 'Original current-schema history 雪🙂' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
  ]);
  const store = await openSqliteStore(profile),
    runtime = createRuntime({
      store,
      model,
      modelId: 'fixed',
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'owned' };
        },
      },
    });
  let daemonLive = false,
    succeeded = false;
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'workspace',
      rootUri: pathToFileURL(workspace).href,
      name: 'Schema rejection',
    });
    await runtime.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId,
      workspaceId: 'workspace',
      subjectId: 'owner',
      title: 'Original schema history',
    });
    await runtime.submitCommand({
      expectedStoreId,
      commandId: 'original',
      sessionId,
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Retain this original history' },
    });
    await runtime.waitForCommand('original');
    const before = await store.getView(sessionId),
      metadata = await store.getMetadata();
    expect(before.runs[0]!.status).toBe('completed');
    expect(model.requests).toHaveLength(1);
    await runtime.close();
    const configuration = ownedUserConfiguration(home);
    writeFileSync(configuration.path, '{"modelId":"fixed","models":[]}', { mode: 0o600 });
    const configurationPath = join(profile.profilePath, 'config.jsonc');
    writeFileSync(configurationPath, readFileSync(configuration.path), { mode: 0o600 });
    const protectedFiles = [
      profile.databasePath,
      join(profile.profilePath, 'profile.json'),
      configurationPath,
      configuration.path,
    ].map((path) => ({ path, bytes: readFileSync(path), inode: lstatSync(path).ino }));
    const predecessor = await materializeTerminalPredecessor({ root, repositoryRoot });
    expect(predecessor.provenance.commit).toBe(TERMINAL_PREDECESSOR_COMMIT);
    expect(predecessor.provenance.sourceRemoved).toBe(true);
    expect(existsSync(predecessor.provenance.sourceRoot)).toBe(false);
    const installed = await installTerminalBundle({
      bundleRoot: predecessor.candidate.root,
      prefix,
    });
    rmSync(predecessor.candidate.root, { recursive: true });
    expect(existsSync(predecessor.candidate.root)).toBe(false);
    const compiled = await Bun.build({
      entrypoints: [
        resolve(repositoryRoot, 'tests/fixtures/unified-agent/terminal-incompatible-store-read.ts'),
      ],
      target: 'bun',
      packages: 'external',
      outdir: join(root, 'reader'),
      naming: 'read.js',
    });
    expect(compiled.success).toBe(true);
    symlinkSync(
      join(installed.releaseRoot, 'node_modules'),
      join(root, 'reader/node_modules'),
      'dir',
    );
    const started = JSON.parse(
      await execute(
        [cli, 'server', 'start', '--server', socket, '--workspace', workspace],
        workspace,
        home,
      ),
    );
    daemonLive = true;
    expect(started.state).toBe('accepting');
    expect(started.runningBuildId).toBe(`terminal-${predecessor.candidate.digest}`);
    const rejected = JSON.parse(
      await execute(
        [
          join(installed.releaseRoot, predecessor.candidate.manifest.entries.runtime),
          join(root, 'reader/read.js'),
          profile.dataRoot,
          socket,
          sessionId,
          `terminal-${predecessor.candidate.digest}`,
        ],
        workspace,
        home,
      ),
    );
    expect(rejected).toMatchObject({
      code: 'store_incompatible',
      historyCode: 'data_unavailable',
      dataAvailability: 'unavailable',
      buildId: `terminal-${predecessor.candidate.digest}`,
      instanceId: started.instanceId,
    });
    await execute([cli, 'server', 'stop', '--server', socket], workspace, home);
    daemonLive = false;
    expect(inspectProcess(rejected.pid, rejected.startIdentity)).toBe('dead');
    expect(
      JSON.parse(await execute([cli, 'server', 'status', '--server', socket], workspace, home))
        .state,
    ).toBe('absent');
    const lease = acquireArtifactAccess({ root: installed.releaseRoot, mode: 'exclusive' });
    lease.release();
    const current = await openSqliteStore({ ...profile, mode: 'readonly' });
    try {
      expect(await current.getMetadata()).toEqual(metadata);
      expect(await current.getView(sessionId)).toEqual(before);
    } finally {
      await current.close();
    }
    for (const file of protectedFiles) {
      expect(readFileSync(file.path)).toEqual(file.bytes);
      expect(lstatSync(file.path).ino).toBe(file.inode);
    }
    expect(model.requests).toHaveLength(1);
    await uninstallTerminalBundle(prefix);
    for (const file of protectedFiles) expect(readFileSync(file.path)).toEqual(file.bytes);
    succeeded = true;
    console.log(
      `TERMINAL_INCOMPATIBLE_PREDECESSOR_REJECTED ${JSON.stringify({ prior: predecessor.provenance, rejection: rejected, storeId: expectedStoreId, originalCommand: 'original', providerCalls: model.requests.length, dataUnchanged: true, originalProcessExited: true })}`,
    );
  } finally {
    await runtime.close();
    if (daemonLive)
      await execute([cli, 'server', 'stop', '--server', socket], workspace, home).catch(() => {});
    if (succeeded) rmSync(root, { recursive: true, force: true });
    else console.error(`OWNED_TERMINAL_SCHEMA_REJECTION_FAILURE_ROOT ${root}`);
  }
}, 240_000);

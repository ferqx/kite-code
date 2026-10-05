import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import {
  createProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { getLoadedSqliteEngine, initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { ClientError, createClient, requiresInteractionAttachment } from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';
import type { TuiMcpSourceMutationFact } from '@kite-ai/ui/tui';
import type { CLIServiceArtifact } from '../../host';
import { parseMcpSourceMutationRecord } from '../../host/mcp-source-mutation-intents';
import { verifyTerminalBundle } from '../../host/terminal-artifact';
import { decodeMcpSourceMutationFact } from '../../host/tui-mcp-source-mutation';

const repo = resolve(import.meta.dir, '../../../..');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const privateFile = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
async function until<T>(
  label: string,
  read: () => Promise<T | undefined>,
  signal: AbortSignal,
): Promise<T> {
  const deadline = performance.now() + 10000;
  for (;;) {
    signal.throwIfAborted();
    const value = await read();
    signal.throwIfAborted();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw Error(`source_mutation_pty_deadline:${label}`);
    await Bun.sleep(10);
  }
}
function installed(name: string, owner: string) {
  for (const root of createRequire(join(owner, 'package.json')).resolve.paths(
    `${name}/package.json`,
  ) ?? []) {
    const path = join(root, name, 'package.json');
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as { version: string };
  }
  throw Error('owned_dependency_missing');
}
type Wire = {
  phase: string;
  pid: number;
  method: string;
  path: string;
  body?: {
    kind?: string;
    commandId?: string;
    actionId?: string;
    answerKind?: string;
    decision?: string;
  };
};

test('80x24 basic source Add and exact Remove retain independent approval, cold original GET-only and foreign restored bytes', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-tui-source-mutation-'));
  const evidence = `/private/tmp/kite-tui-source-mutation-evidence-${randomUUID()}`;
  mkdirSync(evidence, { mode: 0o700 });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(join(workspace, '.kite-code'), { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
  const userPath = join(profile.profilePath, 'mcp.json'),
    projectPath = join(workspace, '.kite-code/mcp.json');
  const journalPath = join(profile.profilePath, 'ui/mcp-source-mutation-intents.json');
  const originalUser =
    '// retained user\r\n{"mcpServers":{"shared":{"type":"http","url":"https://controlled.invalid/user"}},"unknown":{"keep":true}}\r\n';
  const originalProject = '// retained project\r\n{"mcpServers":{},"unknown":{"keep":true}}\r\n';
  const facts: unknown[] = [],
    cleanupErrors: unknown[] = [],
    closing = new AbortController();
  const controlWork = new Set<Promise<Response>>();
  let phase = 'warm',
    storeId = '',
    currentStoreId = '',
    subjectId: string | undefined;
  let artifact: CLIServiceArtifact | undefined,
    candidateAccess: ReturnType<typeof acquireArtifactAccess> | undefined;
  let build: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined,
    python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let seed: Awaited<ReturnType<typeof launchPairedService>> | undefined,
    observer: ReturnType<typeof createClient> | undefined;
  let control: ReturnType<typeof Bun.serve> | undefined,
    model: ReturnType<typeof Bun.serve> | undefined;
  let modelCalls = 0,
    success = false,
    cleanupConfirmed = false,
    failure: unknown;
  let original:
    | { commandId: string; executionId: string; fact: TuiMcpSourceMutationFact }
    | undefined;
  let journalBytes: Buffer<ArrayBuffer> | undefined,
    journalHash = '',
    cursorBaseline = '',
    selectionBaseline = 0;
  let credentialChecks = 0;
  const ledger = (name: string): Record<string, unknown>[] =>
    existsSync(join(root, name))
      ? readFileSync(join(root, name), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const wire = () => ledger('ui-http.jsonl') as Wire[];
  const posts = () =>
    wire().filter((row) => row.method === 'POST' && row.body?.kind === 'extension.invoke');
  const originalGets = () =>
    wire().filter(
      (row) =>
        row.phase === phase &&
        row.method === 'GET' &&
        (row.path.includes('mcp.source.mutation.result') ||
          (original && row.path.includes(original.commandId))),
    ).length;
  const settings = () =>
    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({ root, workspace, dataRoot: profile.dataRoot, phase, artifact }),
      { mode: 0o600 },
    );
  async function bounded<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Error(label)), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    model = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        modelCalls++;
        return new Response('owned_model_forbidden', { status: 500 });
      },
    });
    build = Bun.spawn(
      [
        process.execPath,
        join(repo, 'scripts/release/terminal.ts'),
        'build',
        '--directory',
        join(root, 'candidate'),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [out, err, code] = await bounded(
      Promise.all([
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
        build.exited,
      ]),
      60000,
      'owned_source_mutation_build_deadline',
    );
    writeFileSync(join(evidence, 'build.log'), out + err, { mode: 0o600, flag: 'wx' });
    expect(code).toBe(0);
    const first = verifyTerminalBundle(join(root, 'candidate'));
    candidateAccess = acquireArtifactAccess({ root: first.root, mode: 'shared' });
    const candidate = verifyTerminalBundle(first.root);
    expect(candidate.digest).toBe(first.digest);
    const engineSelection = {
      root: join(candidate.root, 'node_modules/@kite-ai/agent/storage/engine'),
      manifestSha256: candidate.manifest.sqlite.manifestSha256,
    };
    const engine = initializeSqliteEngine(engineSelection);
    expect(engine.version).toBe('3.51.3');
    expect(engine.version).toBe(candidate.manifest.sqlite.version);
    expect(engine.sourceId).toBe(candidate.manifest.sqlite.sourceId);
    expect(getLoadedSqliteEngine()).toEqual(engine);
    privateFile(join(evidence, 'candidate.json'), {
      digest: candidate.digest,
      candidateId: candidate.candidateId,
      manifest: candidate.manifest,
      engine,
    });
    const serviceOwner = join(repo, 'apps/service'),
      serviceBuilt = join(candidate.root, 'node_modules/@kite-ai/service');
    const declared = JSON.parse(readFileSync(join(serviceOwner, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const dependencies: Record<string, string> = {};
    for (const [name, range] of Object.entries(declared.dependencies ?? {})) {
      if (range.startsWith('workspace:')) continue;
      dependencies[name] = installed(name, serviceOwner).version;
      expect(installed(name, serviceBuilt).version).toBe(dependencies[name]);
    }
    privateFile(join(evidence, 'service-dependencies.json'), dependencies);
    symlinkSync(join(candidate.root, 'node_modules'), join(root, 'node_modules'));
    const helperPath = join(import.meta.dir, '../fixtures/tui-mcp-source-mutation-pty.ts');
    const compiled = await Bun.build({
      entrypoints: [helperPath],
      outdir: root,
      naming: 'host.js',
      target: 'bun',
      packages: 'external',
    });
    expect(compiled.success).toBe(true);
    artifact = {
      executable: candidate.artifact.executable,
      executableSha256: candidate.artifact.executableSha256,
      entrypoint: join(root, 'host.js'),
      entrypointSha256: sha(readFileSync(join(root, 'host.js'))),
      buildId: 'owned-source-mutation',
      apiMajor: 1,
    };
    privateFile(join(evidence, 'helper.json'), {
      helperSourceSha256: sha(readFileSync(helperPath)),
      compiledSha256: artifact.entrypointSha256,
      pythonSha256: sha(
        readFileSync(join(import.meta.dir, '../fixtures/tui-mcp-source-mutation-pty.py')),
      ),
      candidateDigest: candidate.digest,
    });
    settings();
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    writeFileSync(userPath, originalUser, { mode: 0o600 });
    writeFileSync(projectPath, originalProject, { mode: 0o600 });
    mkdirSync(join(profile.profilePath, 'ui'), { mode: 0o700 });
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'forbidden',
        models: [
          {
            id: 'forbidden',
            provider: 'compatible',
            model: 'forbidden',
            baseURL: `${model.url.href}v1`,
          },
        ],
      }),
      { mode: 0o600 },
    );
    seed = await launchPairedService({
      ...artifact,
      profile,
      instanceId: randomUUID(),
      requiredCapabilities: ['sessions', 'commands', 'interactions'],
    });
    appendFileSync(
      join(root, 'owned-services.jsonl'),
      `${JSON.stringify({ phase, servicePid: seed.pid, owner: 'seed' })}\n`,
      { mode: 0o600 },
    );
    storeId = seed.bootstrap.storeId!;
    currentStoreId = storeId;
    subjectId = seed.bootstrap.subjectId;
    await seed.client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(workspace).href,
    });
    await seed.client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 'a',
      workspaceId: 'w',
      title: 'Owned Source entries',
    });
    await seed.close();
    expect(await seed.exited).toBe(0);
    seed = undefined;
    async function connected() {
      if (observer) return observer;
      const secret = await until(
        'observer',
        async () =>
          existsSync(join(root, 'observer-private.json'))
            ? (JSON.parse(readFileSync(join(root, 'observer-private.json'), 'utf8')) as {
                endpoint: string;
                token: string;
              })
            : undefined,
        closing.signal,
      );
      observer = createClient({
        endpoint: secret.endpoint,
        token: secret.token,
        expected: {
          profile: {
            dataRoot: profile.dataRoot,
            name: profile.profile,
            accessKey: profile.profileAccessKey,
          },
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'commands', 'interactions'],
        },
      });
      await observer.connect();
      expect(observer.serverInfo!.storeId).toBe(currentStoreId);
      expect(observer.serverInfo!.subjectId).toBe(subjectId);
      return observer;
    }
    async function safeWindow(stage: string) {
      const view = await (await connected()).getView('a');
      expect(view.runs).toHaveLength(0);
      expect(
        view.executions.every(
          (execution) =>
            execution.kind === 'job' &&
            [
              'builtin.mcp.sources/mcp.source.add',
              'builtin.mcp.sources/mcp.source.remove',
            ].includes(execution.definitionId),
        ),
      ).toBe(true);
      expect(modelCalls).toBe(0);
      expect(ledger('credentials.jsonl')).toHaveLength(credentialChecks);
      expect(
        ledger('credentials.jsonl').every((row) =>
          ['status', 'resolve'].includes(String(row.operation)),
        ),
      ).toBe(true);
      expect(ledger('resolutions.jsonl')).toHaveLength(0);
      expect(wire().filter((row) => row.body?.kind === 'command.cancel')).toHaveLength(0);
      facts.push({
        stage,
        phase,
        storeId: currentStoreId,
        cursor: view.snapshotCursor,
        uiPost: wire().filter((row) => row.phase === phase && row.method === 'POST').length,
        originalGet: originalGets(),
        executions: view.executions.map((execution) => ({
          id: execution.id,
          definitionId: execution.definitionId,
          status: execution.status,
        })),
        modelCalls,
        credentials: ledger('credentials.jsonl').length,
        resolutions: ledger('resolutions.jsonl').length,
      });
      return view;
    }
    const query = async (commandId: string) =>
      decodeMcpSourceMutationFact(
        await (await connected()).queryExtension(
          'a',
          'builtin.mcp.sources',
          'mcp.source.mutation.result',
          { commandId },
        ),
      );
    async function submitted(count: number, expectedAction: string) {
      return until(
        'submission',
        async () => {
          const all = posts();
          if (all.length < count) return undefined;
          expect(all).toHaveLength(count);
          expect(all[count - 1]!.body!.actionId).toBe(expectedAction);
          const commandId = all[count - 1]!.body!.commandId!;
          try {
            const command = await (await connected()).getCommand(commandId);
            const executionId = (command.receipt as { executionId?: string }).executionId;
            if (!executionId) return undefined;
            const document = JSON.parse(readFileSync(journalPath, 'utf8')) as {
              records: unknown[];
            };
            const record = document.records
              .map(parseMcpSourceMutationRecord)
              .find((entry) => entry.intent.request.commandId === commandId);
            expect(record).toBeDefined();
            expect(command.originStoreId).toBe(storeId);
            expect(command.sessionId).toBe('a');
            expect(command.subjectId).toBe(subjectId);
            expect(command.requestDigest).toBe(record!.requestSha256);
            return { command, executionId };
          } catch (error) {
            if (
              error instanceof ClientError &&
              error.status === 404 &&
              error.code === 'command_not_found'
            )
              return undefined;
            throw error;
          }
        },
        closing.signal,
      );
    }
    async function approve(count: number, expectedAction: string) {
      const { command, executionId } = await submitted(count, expectedAction),
        client = await connected();
      const card = await until(
        'ordinary approval',
        async () =>
          (await client.listInteractions('a', { storeId, state: 'pending' })).interactions.find(
            (row) => row.executionId === executionId,
          ),
        closing.signal,
      );
      expect(card.kind).toBe('approval');
      expect(card.originStoreId).toBe(storeId);
      expect(card.sessionId).toBe('a');
      expect(card.definitionId).toBe(`builtin.mcp.sources/${expectedAction}`);
      expect(readFileSync(userPath, 'utf8')).toBe(originalUser);
      if (count === 1) expect(readFileSync(projectPath, 'utf8')).toBe(originalProject);
      else
        expect(
          JSON.parse(readFileSync(projectPath, 'utf8').replace(/^\/\/[^\r\n]*\r?\n/, '')).mcpServers
            .shared,
        ).toBeDefined();
      if (requiresInteractionAttachment(card)) await client.readInteractionAttachment(card);
      await client.answerInteraction('a', card.id, {
        expectedStoreId: storeId,
        commandId: `answer-${card.id}`,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
      });
      const fact = await until(
        'saved original',
        async () => {
          const value = await query(command.id);
          return value.phase === 'saved' ? value : undefined;
        },
        closing.signal,
      );
      expect(fact.command!.id).toBe(command.id);
      expect(fact.execution!.id).toBe(executionId);
      expect(fact.execution!.runId).toBeNull();
      expect(fact.receipt!.operationId).toBe(executionId);
      expect(fact.mutation!.state).toBe('applied');
      expect(fact.mutation!.scope).toBe('w');
      expect(fact.mutation!.etag).toBe(fact.receipt!.newEtag);
      expect(
        (await client.listInteractions('a', { storeId, state: 'pending' })).interactions,
      ).toHaveLength(0);
      facts.push({
        stage: expectedAction,
        commandId: command.id,
        executionId,
        interactionId: card.id,
        fact,
      });
      if (expectedAction === 'mcp.source.remove') {
        expect(ledger('credentials.jsonl').map((row) => row.operation)).toEqual([
          'status',
          'resolve',
        ]);
        credentialChecks = 2;
      }
      await safeWindow(expectedAction);
      return { commandId: command.id, executionId, fact };
    }
    async function priorClosed(count: number) {
      await until(
        'prior owned Services closed',
        async () => {
          const owned = ledger('owned-services.jsonl'),
            exits = ledger('service-exits.jsonl');
          return owned.length === count &&
            owned.every((row) =>
              exits.some(
                (entry) =>
                  entry.pid === row.servicePid &&
                  entry.phase === row.phase &&
                  entry.exitCode === 0 &&
                  entry.returnedAfterCleanup === true,
              ),
            )
            ? true
            : undefined;
        },
        closing.signal,
      );
    }
    async function controlRequest(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      try {
        closing.signal.throwIfAborted();
        if (['/empty-name', '/add-review', '/add-confirm'].includes(path)) {
          expect(posts()).toHaveLength(0);
          expect(readFileSync(userPath, 'utf8')).toBe(originalUser);
          expect(readFileSync(projectPath, 'utf8')).toBe(originalProject);
        } else if (path === '/approve-add') {
          const value = await approve(1, 'mcp.source.add');
          const document = JSON.parse(
            readFileSync(projectPath, 'utf8').replace(/^\/\/[^\r\n]*\r?\n/, ''),
          );
          expect(document.mcpServers.shared._kiteSourceCreation).toEqual({
            version: 1,
            operationId: value.executionId,
          });
          const source = (
            await (await connected()).queryExtension('a', 'builtin.mcp.sources', 'mcp.sources', {})
          )[0]!.payload as {
            items: { name: string; source: { kind: string }; admitted: boolean; reason: string }[];
          };
          expect(source.items).toHaveLength(1);
          expect(source.items[0]!.source.kind).toBe('workspace');
          expect(source.items[0]!.admitted).toBe(false);
          expect(source.items[0]!.reason).toBe('mcp_project_approval_pending');
          return Response.json({ commandId: value.commandId, executionId: value.executionId });
        } else if (path === '/remove-review' || path === '/remove-confirm') {
          expect(posts()).toHaveLength(1);
          expect(readFileSync(userPath, 'utf8')).toBe(originalUser);
        } else if (path === '/approve-remove') {
          original = await approve(2, 'mcp.source.remove');
          expect(original.fact.receipt!.fallback!.name).toBe('shared');
          expect(original.fact.receipt!.fallback!.source.kind).toBe('user');
          const source = (
            await (await connected()).queryExtension('a', 'builtin.mcp.sources', 'mcp.sources', {})
          )[0]!.payload as { items: { source: { kind: string }; admitted: boolean }[] };
          expect(source.items).toHaveLength(1);
          expect(source.items[0]!.source.kind).toBe('user');
          expect(source.items[0]!.admitted).toBe(true);
          return Response.json({
            commandId: original.commandId,
            executionId: original.executionId,
          });
        } else if (path === '/warm-complete') {
          expect(posts()).toHaveLength(2);
          expect(new Set(posts().map((row) => row.body!.commandId)).size).toBe(2);
          journalBytes = readFileSync(journalPath);
          journalHash = sha(journalBytes);
          expect(
            (JSON.parse(journalBytes.toString('utf8')) as { records: unknown[] }).records,
          ).toHaveLength(2);
          expect(readFileSync(userPath, 'utf8')).toBe(originalUser);
        } else if (path === '/cold-removed') {
          await priorClosed(2);
          observer?.disposeNetwork();
          observer = undefined;
          rmSync(join(root, 'observer-private.json'), { force: true });
          renameSync(workspace, join(root, 'removed-workspace'));
          rmSync(userPath);
          phase = 'cold-removed';
          settings();
        } else if (path === '/cold-foreign') {
          await priorClosed(3);
          observer?.disposeNetwork();
          observer = undefined;
          rmSync(join(root, 'observer-private.json'), { force: true });
          const backup = await createProfileBackup({
            profile,
            destinationRoot: join(root, 'backups'),
            signal: closing.signal,
          });
          expect(backup.manifest.version).toBe(12);
          const inspection = await inspectProfileBackup(backup);
          expect(inspection.manifest.assets.mcpSourceMutationIntents?.present).toBe(true);
          const restored = await restoreProfileBackup({
            profile,
            expectedStoreId: storeId,
            backup,
            intent: 'replace_with_selected_backup',
            signal: closing.signal,
          });
          currentStoreId = restored.storeId;
          expect(currentStoreId).not.toBe(storeId);
          expect(readFileSync(journalPath)).toEqual(journalBytes!);
          expect(sha(readFileSync(journalPath))).toBe(journalHash);
          facts.push({
            stage: 'public-v12-restore',
            originalStoreId: storeId,
            newStoreId: currentStoreId,
            journalHash,
            bytes: journalBytes!.length,
          });
          phase = 'cold-foreign';
          settings();
        } else if (path === '/selection-baseline') {
          selectionBaseline = originalGets();
          cursorBaseline = (await safeWindow(path)).snapshotCursor;
        } else if (path === '/cold-selected' || path === '/foreign-selected') {
          expect(originalGets()).toBe(selectionBaseline);
          expect((await safeWindow(path)).snapshotCursor).toBe(cursorBaseline);
        } else if (path === '/cold-lookup' || path === '/foreign-lookup') {
          if (path === '/cold-lookup') {
            expect(originalGets() - selectionBaseline).toBe(2);
            expect(await query(original!.commandId)).toEqual(original!.fact);
          } else {
            expect(originalGets()).toBe(0);
            expect(currentStoreId).not.toBe(storeId);
          }
          expect(readFileSync(journalPath)).toEqual(journalBytes!);
          expect(sha(readFileSync(journalPath))).toBe(journalHash);
          expect((await safeWindow(path)).snapshotCursor).toBe(cursorBaseline);
        }
        if (phase !== 'warm')
          expect(wire().filter((row) => row.phase === phase && row.method === 'POST')).toHaveLength(
            0,
          );
        if (path === '/cold-removed' || path === '/cold-foreign') {
          expect(modelCalls).toBe(0);
          expect(ledger('credentials.jsonl')).toHaveLength(credentialChecks);
          expect(ledger('resolutions.jsonl')).toHaveLength(0);
          facts.push({
            stage: path,
            phase,
            storeId: currentStoreId,
            priorServicesClosed: true,
            awaitingColdStart: true,
          });
          return Response.json({ checked: true });
        }
        await safeWindow(path);
        return Response.json({ checked: true });
      } catch (error) {
        facts.push({
          stage: 'control-failure',
          path,
          message: error instanceof Error ? error.message.slice(0, 4096) : 'unknown',
        });
        return Response.json({ error: 'owned_source_mutation_control_failed' }, { status: 500 });
      }
    }
    control = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const work = controlRequest(request);
        controlWork.add(work);
        void work.finally(() => controlWork.delete(work));
        return work;
      },
    });
    writeFileSync(join(evidence, 'pty-owned.jsonl'), '', { mode: 0o600, flag: 'wx' });
    python = Bun.spawn(
      [
        'python3',
        join(import.meta.dir, '../fixtures/tui-mcp-source-mutation-pty.py'),
        control.url.href,
        process.execPath,
        join(root, 'host.js'),
        root,
        evidence,
        storeId,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [ptyOut, ptyErr, ptyCode] = await Promise.all([
      new Response(python.stdout).text(),
      new Response(python.stderr).text(),
      python.exited,
    ]);
    writeFileSync(join(evidence, 'pty.log'), ptyOut + ptyErr, { mode: 0o600, flag: 'wx' });
    expect(ptyCode).toBe(0);
    expect(ptyOut).toContain('SOURCE_MUTATION_WARM_COLD_FOREIGN_COMPLETE');
    expect(posts()).toHaveLength(2);
    expect(wire().filter((row) => row.phase !== 'warm' && row.method === 'POST')).toHaveLength(0);
    const exits = JSON.parse(readFileSync(join(evidence, 'pty-exits.json'), 'utf8')) as {
      normalComplete: boolean;
      exits: { exitCode: number; normalCtrlQ: boolean }[];
    };
    expect(exits.normalComplete).toBe(true);
    expect(exits.exits).toHaveLength(3);
    expect(exits.exits.every((row) => row.exitCode === 0 && row.normalCtrlQ)).toBe(true);
    await priorClosed(4);
    expect(ledger('service-exits.jsonl')).toHaveLength(4);
    expect(modelCalls).toBe(0);
    expect(ledger('resolutions.jsonl')).toHaveLength(0);
    expect(ledger('credentials.jsonl').map((row) => row.operation)).toEqual(['status', 'resolve']);
    success = true;
  } catch (error) {
    failure = error;
  } finally {
    closing.abort(Error('owned_source_mutation_closing'));
    const collect = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    await collect(async () => observer?.disposeNetwork());
    await collect(async () => {
      if (python?.exitCode === null) {
        python.kill('SIGINT');
        await bounded(python.exited, 9000, 'owned_pty_cleanup_unconfirmed');
      }
    });
    await collect(async () => {
      if (build?.exitCode === null) {
        build.kill('SIGTERM');
        await bounded(build.exited, 9000, 'owned_build_cleanup_unconfirmed');
      }
    });
    await collect(async () => {
      if (seed) {
        await seed.close();
        expect(await seed.exited).toBe(0);
      }
    });
    await collect(async () => {
      await control?.stop(true);
      await bounded(
        Promise.allSettled([...controlWork]),
        12000,
        'owned_control_cleanup_unconfirmed',
      );
      if (controlWork.size) throw Error('owned_control_still_active');
    });
    await collect(async () => {
      await model?.stop(true);
    });
    const serviceCleanupReceipts: { phase: unknown; servicePid: unknown; confirmed: boolean }[] =
      [];
    try {
      const owned = ledger('owned-services.jsonl'),
        exits = ledger('service-exits.jsonl');
      for (const row of owned) {
        const matches = exits.filter(
          (entry) => entry.pid === row.servicePid && entry.phase === row.phase,
        );
        const confirmed =
          Number.isSafeInteger(row.servicePid) &&
          Number(row.servicePid) > 0 &&
          matches.length === 1 &&
          matches[0]!.exitCode === 0 &&
          matches[0]!.returnedAfterCleanup === true;
        serviceCleanupReceipts.push({ phase: row.phase, servicePid: row.servicePid, confirmed });
        if (!confirmed) cleanupErrors.push(Error('owned_service_cleanup_unconfirmed'));
      }
      if (new Set(owned.map((row) => `${row.phase}:${row.servicePid}`)).size !== owned.length)
        cleanupErrors.push(Error('owned_service_identity_duplicate'));
      if (
        controlWork.size ||
        python?.exitCode === null ||
        !serviceCleanupReceipts.every((row) => row.confirmed)
      )
        cleanupErrors.push(Error('candidate_lease_retained_unconfirmed'));
      else {
        candidateAccess?.release();
        candidateAccess = undefined;
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const name of [
      'ui-http.jsonl',
      'permissions.jsonl',
      'credentials.jsonl',
      'resolutions.jsonl',
      'owned-services.jsonl',
      'service-exits.jsonl',
    ]) {
      try {
        if (existsSync(join(root, name)))
          writeFileSync(join(evidence, name), readFileSync(join(root, name)), {
            mode: 0o600,
            flag: 'wx',
          });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    cleanupConfirmed =
      (python === undefined || python.exitCode !== null) &&
      (build === undefined || build.exitCode !== null) &&
      controlWork.size === 0 &&
      cleanupErrors.length === 0;
    if (success && cleanupConfirmed) {
      try {
        rmSync(root, { recursive: true, force: true });
        if (existsSync(root)) {
          cleanupErrors.push(Error('owned_root_delete_unconfirmed'));
          cleanupConfirmed = false;
        }
      } catch (error) {
        cleanupErrors.push(error);
        cleanupConfirmed = false;
      }
    }
    privateFile(join(evidence, 'packet.json'), {
      success,
      cleanupConfirmed,
      candidateLeaseRetained: candidateAccess !== undefined,
      retainedRoot: existsSync(root) ? root : null,
      serviceCleanupReceipts,
      cleanupErrors: cleanupErrors.map((error) =>
        error instanceof Error ? error.message : String(error),
      ),
      failure:
        failure instanceof Error
          ? { name: failure.name, message: failure.message }
          : (failure ?? null),
      originalStoreId: storeId,
      currentStoreId,
      subjectId,
      journalBytes: journalBytes?.length ?? null,
      journalHash,
      facts,
    });
  }
  if (failure) throw failure;
  expect(success).toBe(true);
  expect(cleanupConfirmed).toBe(true);
  expect(cleanupErrors).toEqual([]);
}, 120000);

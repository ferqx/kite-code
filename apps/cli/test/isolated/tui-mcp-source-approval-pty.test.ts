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
import { ClientError, createClient, type Interaction } from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';
import type { TuiMcpSourceApprovalFact } from '@kite-ai/ui/tui';
import type { CLIServiceArtifact } from '../../host';
import { mcpSha } from '../../host/mcp-selection-intents';
import { verifyTerminalBundle } from '../../host/terminal-artifact';
import {
  decodeMcpSourceApprovalFact,
  decodeMcpSourcePage,
} from '../../host/tui-mcp-source-approval';

const repo = resolve(import.meta.dir, '../../../..');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const privateFile = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
async function until<T>(
  label: string,
  read: () => Promise<T | undefined>,
  signal: AbortSignal,
): Promise<T> {
  const end = performance.now() + 10000;
  for (;;) {
    signal.throwIfAborted();
    const value = await read();
    signal.throwIfAborted();
    if (value !== undefined) return value;
    if (performance.now() > end) throw Error(`source_pty_deadline:${label}`);
    await Bun.sleep(10);
  }
}
type Wire = {
  phase: string;
  pid: number;
  method: string;
  path: string;
  body?: {
    kind?: string;
    commandId?: string;
    extensionId?: string;
    actionId?: string;
    requestSha256?: string;
    answerKind?: string;
    decision?: string;
  };
};
function installed(name: string, owner: string) {
  for (const search of createRequire(join(owner, 'package.json')).resolve.paths(
    `${name}/package.json`,
  ) ?? []) {
    const path = join(search, name, 'package.json');
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as { version: string };
  }
  throw Error('owned_declared_dependency_missing');
}

test('80x24 Source Review independently confirms Action and original Question decisions; cold removed Source/Workspace checks original IDs GET-only and foreign restored Store rejects original lookups', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-tui-mcp-source-approval-'));
  const evidence = `/private/tmp/kite-tui-mcp-source-approval-evidence-${randomUUID()}`;
  mkdirSync(evidence, { mode: 0o700 });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(join(workspace, '.kite-code'), { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
  const ledger = (name: string): Record<string, unknown>[] =>
    existsSync(join(root, name))
      ? readFileSync(join(root, name), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const wire = () => ledger('ui-http.jsonl') as Wire[];
  const sourcePosts = () =>
    wire().filter(
      (row) =>
        row.method === 'POST' &&
        row.body?.kind === 'extension.invoke' &&
        row.body.actionId === 'mcp.source.approve',
    );
  const answers = () =>
    wire().filter((row) => row.method === 'POST' && row.body?.kind === 'interaction.answer');
  const facts: unknown[] = [],
    identities: {
      commandId: string;
      executionId: string;
      question: Interaction;
      fact: TuiMcpSourceApprovalFact;
    }[] = [];
  let phase = 'warm',
    storeId = '',
    currentStoreId = '',
    subjectId: string | undefined,
    sourceId = '',
    modelCalls = 0,
    peerCalls = 0,
    success = false,
    cleanupConfirmed = false;
  let build: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined,
    python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined,
    seed: Awaited<ReturnType<typeof launchPairedService>> | undefined,
    observer: ReturnType<typeof createClient> | undefined,
    artifact: CLIServiceArtifact | undefined,
    control: ReturnType<typeof Bun.serve> | undefined;
  let failure: unknown;
  let candidateAccess: ReturnType<typeof acquireArtifactAccess> | undefined;
  const cleanupErrors: unknown[] = [],
    closing = new AbortController(),
    controlWork = new Set<Promise<Response>>();
  let model: ReturnType<typeof Bun.serve> | undefined,
    peer: ReturnType<typeof Bun.serve> | undefined;
  const parentFetch = globalThis.fetch,
    observerHttp: { method: string; path: string }[] = [];
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const request = args[0],
        url = new URL(request instanceof Request ? request.url : String(request));
      observerHttp.push({
        method: args[1]?.method ?? (request instanceof Request ? request.method : 'GET'),
        path: url.pathname,
      });
      return parentFetch(...args);
    },
    { preconnect: parentFetch.preconnect },
  );
  const settings = () =>
    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({ root, workspace, dataRoot: profile.dataRoot, phase, artifact }),
      { mode: 0o600 },
    );
  try {
    model = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        modelCalls++;
        return new Response('owned_model_forbidden', { status: 500 });
      },
    });
    peer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        peerCalls++;
        return new Response('owned_rpc_forbidden', { status: 500 });
      },
    });
    // Public builder reads real Git provenance and copies installed owner resolution; no source aliases or installs.
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
    const [out, err, code] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ]);
    writeFileSync(join(evidence, 'build.log'), out + err, { mode: 0o600, flag: 'wx' });
    expect(code).toBe(0);
    const initialCandidate = verifyTerminalBundle(join(root, 'candidate'));
    candidateAccess = acquireArtifactAccess({ root: initialCandidate.root, mode: 'shared' });
    const candidate = verifyTerminalBundle(initialCandidate.root);
    expect(candidate.digest).toBe(initialCandidate.digest);
    // Parent maintenance must use the same verified engine as the independently built caller.
    const engineSelection = {
      root: join(candidate.root, 'node_modules/@kite-ai/agent/storage/engine'),
      manifestSha256: candidate.manifest.sqlite.manifestSha256,
    };
    const engine = initializeSqliteEngine(engineSelection);
    expect(engine.version).toBe(candidate.manifest.sqlite.version);
    expect(engine.sourceId).toBe(candidate.manifest.sqlite.sourceId);
    expect(engine.selection).toEqual(engineSelection);
    expect(getLoadedSqliteEngine()).toEqual(engine);
    facts.push({ stage: 'candidate_parent_engine', engine: getLoadedSqliteEngine() });
    privateFile(join(evidence, 'candidate.json'), {
      digest: candidate.digest,
      candidateId: candidate.candidateId,
      manifest: candidate.manifest,
    });
    const serviceOwner = join(repo, 'apps/service'),
      serviceBuilt = join(candidate.root, 'node_modules/@kite-ai/service');
    const declared = JSON.parse(readFileSync(join(serviceOwner, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const dependencyVersions: Record<string, string> = {};
    for (const [name, range] of Object.entries(declared.dependencies ?? {})) {
      if (range.startsWith('workspace:')) continue;
      const expected = installed(name, serviceOwner).version;
      expect(installed(name, serviceBuilt).version).toBe(expected);
      dependencyVersions[name] = expected;
    }
    privateFile(join(evidence, 'service-dependencies.json'), dependencyVersions);
    symlinkSync(join(candidate.root, 'node_modules'), join(root, 'node_modules'));
    const compiled = await Bun.build({
      entrypoints: [join(import.meta.dir, '../fixtures/tui-mcp-source-approval-pty.ts')],
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
      buildId: 'owned-source-approval',
      apiMajor: 1,
    };
    settings();
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(workspace, '.kite-code/mcp.json'),
      JSON.stringify({
        mcpServers: {
          target: { type: 'http', url: `${peer.url.href}mcp`, auth: { type: 'none' } },
        },
      }),
      { mode: 0o600 },
    );
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
      title: 'Owned Source decisions',
    });
    const directory = decodeMcpSourcePage(
      await seed.client.queryExtension('a', 'builtin.mcp.sources', 'mcp.sources', { limit: 25 }),
    );
    expect(directory.items).toHaveLength(1);
    sourceId = directory.items[0]!.id;
    expect(directory.items[0]!.admitted).toBe(false);
    const seedPid = seed.pid;
    await seed.close();
    expect(await seed.exited).toBe(0);
    seed = undefined;
    facts.push({ seedPid, storeId, subjectId, sourceId });
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
    async function original(n: number) {
      return until(
        'original-command',
        async () => {
          const posts = sourcePosts();
          if (posts.length < n) return undefined;
          if (posts.length !== n) throw Error('source_pty_duplicate_post');
          let command: Awaited<ReturnType<ReturnType<typeof createClient>['getCommand']>>;
          try {
            command = await (await connected()).getCommand(posts[n - 1]!.body!.commandId!);
          } catch (error) {
            // The wire logs the POST attempt before its acceptance transaction commits.
            if (
              error instanceof ClientError &&
              error.status === 404 &&
              error.code === 'command_not_found'
            )
              return undefined;
            throw error;
          }
          const executionId = (command.receipt as { executionId?: string }).executionId;
          return executionId ? { command, executionId } : undefined;
        },
        closing.signal,
      );
    }
    async function card(n: number, kind: 'approval' | 'question') {
      const { command, executionId } = await original(n);
      const interaction = await until(
        `original-${kind}`,
        async () =>
          (
            await (await connected()).listInteractions('a', { storeId, state: 'pending' })
          ).interactions.find((row) => row.executionId === executionId && row.kind === kind),
        closing.signal,
      );
      expect(interaction.definitionId).toBe('builtin.mcp.sources/mcp.source.approve');
      expect(interaction.definitionVersion).toBe('1');
      expect(interaction.originStoreId).toBe(storeId);
      expect(interaction.sessionId).toBe('a');
      expect(interaction.runId).toBeNull();
      return { command, executionId, interaction };
    }
    const query = async (commandId: string) =>
      decodeMcpSourceApprovalFact(
        await (await connected()).queryExtension('a', 'builtin.mcp.sources', 'mcp.source.result', {
          commandId,
        }),
      );
    let journalHash = '',
      journalBytes = 0,
      selectedBaseline = 0;
    let originalJournalBytes: Buffer<ArrayBuffer> | undefined;
    const sourceGets = () =>
      wire().filter(
        (row) =>
          row.phase === phase &&
          (row.path.includes('mcp.source.result') ||
            identities.some((id) => row.path.includes(id.commandId))),
      ).length;
    async function controlRequest(request: Request): Promise<Response> {
      const parts = new URL(request.url).pathname.split('/').filter(Boolean),
        action = parts[0],
        n = Number(parts[1]);
      let maintenanceStage = 'not_started';
      try {
        closing.signal.throwIfAborted();
        if (action === 'before-confirm') {
          expect(sourcePosts()).toHaveLength(n - 1);
          expect(answers()).toHaveLength((n - 1) * 2);
          return Response.json({ checked: true });
        }
        if (action === 'ordinary') {
          const actual = await card(n, 'approval');
          expect(answers()).toHaveLength((n - 1) * 2);
          expect(peerCalls).toBe(0);
          facts.push({
            stage: 'ordinary',
            commandId: actual.command.id,
            executionId: actual.executionId,
            interactionId: actual.interaction.id,
          });
          return Response.json({ id: actual.interaction.id, commandId: actual.command.id });
        }
        if (action === 'question' || action === 'question-blank') {
          const actual = await card(n, 'question');
          expect(answers().filter((row) => row.body?.answerKind === 'approval')).toHaveLength(n);
          expect(answers().filter((row) => row.body?.answerKind === 'question')).toHaveLength(
            n - 1,
          );
          if (action === 'question')
            facts.push({
              stage: 'question',
              commandId: actual.command.id,
              executionId: actual.executionId,
              interactionId: actual.interaction.id,
              requestDigest: mcpSha(actual.interaction.request),
            });
          return Response.json({ id: actual.interaction.id });
        }
        if (action === 'finish') {
          const { command, executionId } = await original(n),
            decision = (['approved', 'rejected', 'cancel'] as const)[n - 1]!;
          const fact = await until(
            'saved-original-fact',
            async () => {
              const value = await query(command.id);
              return value.phase === (decision === 'cancel' ? 'cancelled' : 'saved')
                ? value
                : undefined;
            },
            closing.signal,
          );
          const questionRow = (
            await (await connected()).listInteractions('a', { storeId, state: 'answered' })
          ).interactions.find((row) => row.executionId === executionId && row.kind === 'question');
          expect(questionRow).toBeDefined();
          const question = questionRow!;
          expect(fact.command!.id).toBe(command.id);
          expect(fact.execution!.id).toBe(executionId);
          expect(fact.serverId).toBe(sourceId);
          expect(fact.decision).toBe(decision);
          expect(fact.proof!.interactionId).toBe(question.id);
          expect(fact.proof!.acceptedRevision).toBe(question.acceptedDecisionRevision!);
          expect(fact.proof!.subjectId).toBe(subjectId!);
          expect(fact.proof!.requestDigest).toBe(mcpSha(question.request));
          if (decision === 'cancel') {
            expect(fact.mutation).toBeNull();
          } else {
            expect(fact.mutation!.id).toBe(`mcp-source-${executionId}`);
            expect(fact.mutation!.state).toBe('applied');
            expect(fact.mutation!.subjectId).toBe(subjectId!);
            expect(fact.recordKey).toMatch(/^[a-f0-9]{64}$/);
          }
          identities.push({ commandId: command.id, executionId, question, fact });
          facts.push({
            stage: 'original-terminal',
            commandId: command.id,
            executionId,
            questionId: question.id,
            proof: fact.proof,
            mutation: fact.mutation,
            decision,
          });
          return Response.json({ commandId: command.id, phase: fact.phase });
        }
        if (action === 'warm-saved') {
          const data = JSON.parse(
            readFileSync(join(profile.profilePath, 'ui/mcp-source-approval-intents.json'), 'utf8'),
          ) as { records: { intent: { request: { commandId: string } }; phase: string }[] };
          expect(data.records[n - 1]!.intent.request.commandId).toBe(identities[n - 1]!.commandId);
          expect(data.records[n - 1]!.phase).toBe(n === 3 ? 'cancelled' : 'saved');
          return Response.json({ checked: true });
        }
        if (action === 'warm-complete') {
          const journal = readFileSync(
            join(profile.profilePath, 'ui/mcp-source-approval-intents.json'),
          );
          originalJournalBytes = Buffer.from(journal);
          journalHash = sha(journal);
          journalBytes = journal.byteLength;
          const data = JSON.parse(journal.toString()) as {
            records: { intent: { request: { commandId: string } } }[];
          };
          expect(data.records.map((row) => row.intent.request.commandId)).toEqual(
            identities.map((row) => row.commandId),
          );
          return Response.json({ ids: identities.map((row) => row.commandId) });
        }
        if (action === 'cold-removed' || action === 'cold-missing') {
          observer?.disposeNetwork();
          observer = undefined;
          phase = action;
          if (action === 'cold-removed') rmSync(join(workspace, '.kite-code/mcp.json'));
          else renameSync(workspace, join(root, 'removed-workspace'));
          rmSync(join(root, 'observer-private.json'), { force: true });
          settings();
          selectedBaseline = 0;
          return Response.json({ phase });
        }
        if (action === 'cold-foreign') {
          observer?.disposeNetwork();
          observer = undefined;
          maintenanceStage = 'prior_services_close';
          // The previous Popen has been reaped; require every owned Service's own close receipt
          // before acquiring the public exclusive maintenance lease.
          await until(
            'all-prior-services-closed',
            async () => {
              const owned = ledger('owned-services.jsonl'),
                exits = ledger('service-exits.jsonl');
              if (owned.length !== 4) return undefined;
              return owned.every((row) => {
                const matching = exits.filter(
                  (exit) => exit.pid === row.servicePid && exit.phase === row.phase,
                );
                return (
                  matching.length === 1 &&
                  matching[0]!.exitCode === 0 &&
                  matching[0]!.returnedAfterCleanup === true
                );
              })
                ? true
                : undefined;
            },
            closing.signal,
          );
          expect(originalJournalBytes).toBeDefined();
          const journalPath = join(profile.profilePath, 'ui/mcp-source-approval-intents.json'),
            before = readFileSync(journalPath);
          expect(before).toEqual(originalJournalBytes!);
          maintenanceStage = 'backup_create';
          const backup = await createProfileBackup({
            profile,
            destinationRoot: join(root, 'source-backups'),
            signal: closing.signal,
          });
          expect(backup.manifest.version).toBe(10);
          expect(backup.manifest.assets.mcpSourceApprovalIntents?.proof?.sha256).toBe(journalHash);
          maintenanceStage = 'backup_inspect';
          expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
          expect(
            readFileSync(join(backup.directory, 'ui/mcp-source-approval-intents.json')),
          ).toEqual(before);
          maintenanceStage = 'backup_restore';
          const restored = await restoreProfileBackup({
            profile,
            expectedStoreId: storeId,
            backup,
            intent: 'replace_with_selected_backup',
            signal: closing.signal,
          });
          expect(restored.storeId).not.toBe(storeId);
          maintenanceStage = 'restored_bytes';
          currentStoreId = restored.storeId;
          expect(readFileSync(journalPath)).toEqual(before);
          phase = 'cold-foreign';
          rmSync(join(root, 'observer-private.json'), { force: true });
          settings();
          selectedBaseline = 0;
          facts.push({
            stage: 'public-backup-restore',
            storeA: storeId,
            storeB: currentStoreId,
            backupVersion: backup.manifest.version,
            journalHash,
            journalBytes,
          });
          maintenanceStage = 'complete';
          return Response.json({ storeA: storeId, storeB: currentStoreId });
        }
        if (action === 'foreign-selected' || action === 'foreign-lookup') {
          expect(currentStoreId).not.toBe(storeId);
          const client = await connected();
          expect(client.serverInfo!.storeId).toBe(currentStoreId);
          const rows = wire().filter((row) => row.phase === 'cold-foreign');
          expect(rows.filter((row) => row.method === 'POST')).toHaveLength(0);
          expect(sourceGets()).toBe(0);
          expect(
            readFileSync(join(profile.profilePath, 'ui/mcp-source-approval-intents.json')),
          ).toEqual(originalJournalBytes!);
          expect(sha(originalJournalBytes!)).toBe(journalHash);
          const id = identities[n - 1]!;
          expect(id.fact.storeId).toBe(storeId);
          if (action === 'foreign-lookup')
            facts.push({
              stage: 'cold-foreign',
              currentStoreId,
              originalStoreId: storeId,
              commandId: id.commandId,
              executionId: id.executionId,
              fixtureConfirmedReason: 'original_store_mismatch',
              publicReason: null,
              checkObservation:
                'Explicit key on proven original detail; identical unknown display is retained, not a new server receipt',
              originalLookupHttp: 0,
              post: 0,
              journalHash,
            });
          return Response.json({ checked: true });
        }
        if (action === 'selection-baseline') {
          selectedBaseline = sourceGets();
          return Response.json({ checked: true });
        }
        if (action === 'cold-selected') {
          const rows = wire().filter((row) => row.phase === phase);
          expect(rows.filter((row) => row.method === 'POST')).toHaveLength(0);
          expect(sourceGets()).toBe(selectedBaseline);
          return Response.json({ checked: true });
        }
        if (action === 'cold-lookup') {
          const id = identities[n - 1]!,
            fact = await query(id.commandId);
          expect(fact).toEqual(id.fact);
          expect(wire().filter((row) => row.phase === phase && row.method === 'POST')).toHaveLength(
            0,
          );
          expect(sourceGets()).toBeGreaterThan(selectedBaseline);
          expect(
            sha(readFileSync(join(profile.profilePath, 'ui/mcp-source-approval-intents.json'))),
          ).toBe(journalHash);
          facts.push({
            stage: phase,
            commandId: id.commandId,
            executionId: fact.execution!.id,
            proof: fact.proof,
            mutation: fact.mutation,
          });
          return Response.json({ checked: true });
        }
        const view = await (await connected()).getView('a');
        expect(view.runs).toHaveLength(0);
        expect(view.executions.every((row) => row.kind === 'job')).toBe(true);
        expect(modelCalls).toBe(0);
        expect(peerCalls).toBe(0);
        expect(ledger('credentials.jsonl')).toHaveLength(0);
        expect(ledger('resolutions.jsonl')).toHaveLength(0);
        expect(wire().filter((row) => row.body?.kind === 'command.cancel')).toHaveLength(0);
        return Response.json({ checked: true });
      } catch (error) {
        facts.push({
          controlFailure: error instanceof Error ? error.name : 'unknown',
          action,
          n: Number.isFinite(n) ? n : null,
          message: error instanceof Error ? error.message.slice(0, 4096) : null,
          ...(action === 'cold-foreign'
            ? {
                maintenanceStage,
                loadedSqliteEngine: getLoadedSqliteEngine(),
                privateStack: error instanceof Error ? error.stack?.slice(0, 8192) : undefined,
              }
            : {}),
        });
        return Response.json({ error: 'owned_source_control_failed' }, { status: 500 });
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
    const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct,json,urllib.request,codecs
p=None;master=None;buffer='';decoder=codecs.getincrementaldecoder('utf-8')('strict');exits=[];cleanup=False;trace=[];failure=None

def note(kind,**values):
 trace.append(dict(kind=kind,time=time.monotonic(),**values))
 if len(trace)>512:del trace[0]

def control(path):
 note('control',path=path,frame=normalized()[-32768:])
 with urllib.request.urlopen(${JSON.stringify(control.url.href)}+path,timeout=12) as response:return json.load(response)
def normalized():
 frames=buffer.split('\\x1b[?2026h')
 complete=next((frame.split('\\x1b[?2026l')[0] for frame in reversed(frames[1:]) if '\\x1b[?2026l' in frame),'')
 return re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',complete))
def receive(timeout=.05):
 global buffer
 if select.select([master],[],[],timeout)[0]:
  chunk=os.read(master,65536)
  if not chunk:raise RuntimeError('owned_pty_eof')
  buffer=(buffer+decoder.decode(chunk))[-1048576:]
def drain(deadline=None):
 reads=0
 while select.select([master],[],[],0)[0]:
  if reads>=16:raise RuntimeError('owned_frame_drain_limit')
  if deadline is not None and time.monotonic()>deadline:raise RuntimeError('owned_frame_drain_deadline')
  receive(0);reads+=1
def wait(text,compact=False,deadline=None):
 if deadline is None:deadline=time.monotonic()+10
 while True:
  drain(deadline)
  if text in (normalized().replace(' ','') if compact else normalized()):
   note('matched',text=text,frame=normalized()[-32768:]);return
  if time.monotonic()>deadline:raise RuntimeError('owned_frame_deadline:'+text)
  receive()
def wait_new_original(previous):
 # Keep draining the PTY while the host publishes this request, and reject an older receipt.
 deadline=time.monotonic()+10
 while True:
  drain(deadline)
  original=next((match.group(1) for match in re.finditer(r'Originalsourcedecision:([a-f0-9-]{36})',normalized().replace(' ','')) if match.group(1) not in previous),None)
  if original:
   note('new-original',commandId=original,frame=normalized()[-32768:]);return original
  if time.monotonic()>deadline:raise RuntimeError('owned_new_original_deadline')
  receive()
def key(value,preserveSelectedFrame=False):
 global buffer
 if not value:return
 drain()
 note('key',hex=value.hex(),preserveSelectedFrame=preserveSelectedFrame,frame=normalized()[-32768:])
 if not preserveSelectedFrame:buffer=''
 os.write(master,value)
def choose_source(label):
 # Select the exact visible menu row in a fresh complete Ink frame, not a fixed offset.
 deadline=time.monotonic()+10
 for step in range(16):
  drain(deadline)
  frame=normalized().replace(' ','');target=label.replace(' ','')
  if '›'+target in frame:
   note('source-choice',label=label,frame=normalized()[-32768:]);return
  selected_at=frame.find('›');target_at=frame.find(target)
  if selected_at<0:raise RuntimeError('owned_source_selection_absent')
  # Long original IDs can push the earlier lookup row outside this 80x24 frame.
  # The actual panel puts lookup before originals; move toward it, then require its visible selection.
  if target_at<0 and label!='Check original source decision':raise RuntimeError('owned_source_choice_absent:'+label)
  key(b'\\x1b[A' if target_at<0 or target_at<selected_at else b'\\x1b[B');wait('Project sources',deadline=deadline)
 raise RuntimeError('owned_source_choice_unavailable:'+label)
def selected(command_id):
 # Only the outcome detail has the original Session suffix; list labels do not.
 detail='Originalsourcedecision:'+command_id+'·OriginalStore:'+${JSON.stringify(storeId)}+'·Sessiona'
 wait(detail,True)
def start(phase):
 global p,master,buffer,decoder
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
 decoder=codecs.getincrementaldecoder('utf-8')('strict')
 p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(join(root, 'host.js'))}],stdin=slave,stdout=slave,stderr=slave,start_new_session=True,env=dict(os.environ,HOME=${JSON.stringify(root)},KITE_CODE_HOME=${JSON.stringify(join(root, 'owned-home'))}))
 os.close(slave);buffer=''
 with open(${JSON.stringify(join(evidence, 'pty-owned.jsonl'))},'a') as log:log.write(json.dumps({'phase':phase,'pid':p.pid})+'\\n');log.flush();os.fsync(log.fileno())
 wait('New Run >')
def sources():
 key(b'/mcp');wait('New Run > /mcp');key(b'\\r');wait('› Project sources');key(b'\\r');wait('Project sources')
def close(phase):
 global master,p
 key(b'\\x11');deadline=time.monotonic()+6
 while p.poll() is None and time.monotonic()<deadline:
  if select.select([master],[],[],.05)[0]:
   try:os.read(master,65536)
   except OSError:break
 p.wait(timeout=3)
 exits.append({'phase':phase,'pid':p.pid,'exitCode':p.returncode,'normalCtrlQ':True})
 assert p.returncode==0
 os.close(master);master=None;p=None
try:
 start('warm')
 ids=[]
 for n,decision in enumerate(['approved','rejected','cancel'],1):
  sources();wait('Source list ready');key(b'\\r');wait('› Review project source');key(b'\\r');wait('Confirm project source review:');control('before-confirm/'+str(n));key(b'\\r');original_id=wait_new_original(ids);key(b'\\x03');ordinary=control('ordinary/'+str(n));assert ordinary['commandId']==original_id;wait('approval['+ordinary['id']+']originalSessiona',True)
  key(b'approve');wait('revise feedback / deny. approve');key(b'\\r');question=control('question/'+str(n));wait('question['+question['id']+']originalSessiona',True);wait('Up/Down explicit source decision: none (Enter has no answer)');key(b'\\r');control('question-blank/'+str(n));key(b'\\x1b[B'*n);wait('Up/Down explicit source decision: '+decision);key(b'\\r');terminal=control('finish/'+str(n));ids.append(terminal['commandId']);wait('New Run >');sources();wait('Source list ready');choose_source('Check original source decision');key(b'\\r');wait(['Source approval saved','Source rejection saved','Source request cancelled'][n-1]);control('warm-saved/'+str(n));key(b'\\x03');wait('New Run >');control('check')
 control('warm-complete');close('warm')
 for cold in ['cold-removed','cold-missing']:
  control(cold);start(cold);sources();wait('Source list ready' if cold=='cold-removed' else 'Source list unknown; original decisions remain available')
  for n,command_id in enumerate(ids,1):
   control('selection-baseline');choose_source('Original source decision: '+command_id)
   if n==1:selected(command_id)
   key(b'\\r',preserveSelectedFrame=True);selected(command_id);control('cold-selected');choose_source('Check original source decision');key(b'\\r');wait(['Source approval saved','Source rejection saved','Source request cancelled'][n-1]);control('cold-lookup/'+str(n))
  key(b'\\x03');wait('New Run >');control('check');close(cold)
 control('cold-foreign');start('cold-foreign');sources();wait('Source list unknown; original decisions remain available')
 for n,command_id in enumerate(ids,1):
  control('selection-baseline');choose_source('Original source decision: '+command_id);key(b'\\r',preserveSelectedFrame=True);selected(command_id);wait('Source outcome unknown; check original');control('foreign-selected/'+str(n));choose_source('Check original source decision');note('foreign-check-key',commandId=command_id,observation='retained identical known detail; no new frame or public receipt');key(b'\\r',preserveSelectedFrame=True);selected(command_id);wait('Source outcome unknown; check original');control('foreign-lookup/'+str(n))
 key(b'\\x03');wait('New Run >');control('check');close('cold-foreign')
 cleanup=True;print('SOURCE_APPROVAL_WARM_COLD_COMPLETE')
except BaseException as error:
 failure={'type':type(error).__name__,'message':str(error)[:4096],'frame':normalized()[-32768:]}
 raise
finally:
 try:
  if p is not None:
   if p.poll() is None:
    p.terminate()
    try:p.wait(timeout=6)
    except subprocess.TimeoutExpired:p.kill();p.wait(timeout=3)
   exits.append({'phase':'cleanup','pid':p.pid,'exitCode':p.returncode,'normalCtrlQ':False});p=None
 finally:
  if master is not None:os.close(master);master=None
  with os.fdopen(os.open(${JSON.stringify(join(evidence, 'pty-trace.json'))},os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'w') as log:json.dump({'failure':failure,'latestCompleteFrame':normalized()[-32768:],'trace':trace},log);log.flush();os.fsync(log.fileno())
  with os.fdopen(os.open(${JSON.stringify(join(evidence, 'pty-exits.json'))},os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'w') as log:json.dump({'normalComplete':cleanup,'exits':exits},log);log.flush();os.fsync(log.fileno())
`;
    python = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
    const [ptyOut, ptyErr, ptyCode] = await Promise.all([
      new Response(python.stdout).text(),
      new Response(python.stderr).text(),
      python.exited,
    ]);
    writeFileSync(join(evidence, 'pty.log'), ptyOut + ptyErr, { mode: 0o600, flag: 'wx' });
    expect(ptyCode).toBe(0);
    expect(ptyOut).toContain('SOURCE_APPROVAL_WARM_COLD_COMPLETE');
    expect(sourcePosts()).toHaveLength(3);
    expect(new Set(sourcePosts().map((row) => row.body!.commandId)).size).toBe(3);
    expect(answers()).toHaveLength(6);
    expect(wire().filter((row) => row.phase === 'warm' && row.method === 'POST')).toHaveLength(9);
    expect(answers().filter((row) => row.body!.answerKind === 'approval')).toHaveLength(3);
    expect(
      answers()
        .filter((row) => row.body!.answerKind === 'question')
        .map((row) => row.body!.decision),
    ).toEqual(['approved', 'rejected', 'cancel']);
    expect(wire().filter((row) => row.phase !== 'warm' && row.method === 'POST')).toHaveLength(0);
    expect(peerCalls).toBe(0);
    expect(modelCalls).toBe(0);
    expect(ledger('credentials.jsonl')).toHaveLength(0);
    expect(ledger('resolutions.jsonl')).toHaveLength(0);
    const ptyExits = JSON.parse(readFileSync(join(evidence, 'pty-exits.json'), 'utf8')) as {
      normalComplete: boolean;
      exits: { exitCode: number; normalCtrlQ: boolean }[];
    };
    expect(ptyExits.normalComplete).toBe(true);
    expect(ptyExits.exits).toHaveLength(4);
    expect(ptyExits.exits.every((row) => row.exitCode === 0 && row.normalCtrlQ)).toBe(true);
    expect(ledger('owned-services.jsonl')).toHaveLength(5);
    expect(ledger('service-exits.jsonl')).toHaveLength(5);
    expect(
      ledger('service-exits.jsonl').every(
        (row) => row.exitCode === 0 && row.returnedAfterCleanup === true,
      ),
    ).toBe(true);
    success = true;
    facts.push({ journalHash, journalBytes, sourceId });
  } catch (error) {
    failure = error;
  } finally {
    closing.abort(Error('owned_source_pty_closing'));
    const collect = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    async function bounded(work: Promise<unknown>, ms: number) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          work,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(Error('owned_source_cleanup_unconfirmed')), ms);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    try {
      await collect(async () => observer?.disposeNetwork());
      await collect(async () => {
        if (python?.exitCode === null) {
          python.kill('SIGINT');
          await bounded(python.exited, 9000);
        }
      });
      await collect(async () => {
        if (build?.exitCode === null) {
          build.kill('SIGTERM');
          await bounded(build.exited, 9000);
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
      });
      await collect(async () => {
        await bounded(Promise.allSettled([...controlWork]), 12000);
        if (controlWork.size) throw Error('owned_control_unconfirmed');
      });
      await collect(async () => {
        await peer?.stop(true);
      });
      await collect(async () => {
        await model?.stop(true);
      });
    } finally {
      try {
        candidateAccess?.release();
        candidateAccess = undefined;
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        observer?.disposeNetwork();
      } catch (error) {
        cleanupErrors.push(error);
      }
      const serviceCleanupReceipts: { phase: unknown; servicePid: unknown; confirmed: boolean }[] =
        [];
      try {
        const owned = ledger('owned-services.jsonl'),
          exits = ledger('service-exits.jsonl');
        for (const row of owned) {
          const matches = exits.filter(
            (receipt) => receipt.pid === row.servicePid && receipt.phase === row.phase,
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
      if (controlWork.size === 0) globalThis.fetch = parentFetch;
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
      try {
        privateFile(join(evidence, 'packet.json'), {
          success,
          cleanupConfirmed,
          serviceCleanupReceipts,
          retainedRoot: existsSync(root) ? root : null,
          failure:
            failure instanceof Error
              ? { name: failure.name, message: failure.message }
              : failure
                ? { name: 'unknown' }
                : null,
          cleanupErrors: cleanupErrors.map((error) =>
            error instanceof Error ? error.name : 'unknown',
          ),
          storeId,
          subjectId,
          currentStoreId,
          sourceId,
          peerCalls,
          modelCalls,
          observerHttp,
          facts,
          deadlines: {
            stepMs: 10000,
            controlMs: 12000,
            normalExitMs: 6000,
            exitWaitMs: 3000,
            testMs: 180000,
          },
          limits: {
            foreignRestore:
              'Public v10 A→B; terminal original ID lookup rejects foreign Store before original lookup HTTP',
            cursorUnchanged: false,
            windows: false,
            linux: false,
            faultCleanup: false,
          },
        });
      } catch (error) {
        cleanupErrors.push(error);
        cleanupConfirmed = false;
      }
      console.error(
        JSON.stringify({
          evidence,
          originalFailure: failure instanceof Error ? failure.name : failure ? 'unknown' : null,
          publicationOrCleanupFailure: cleanupErrors.map((error) =>
            error instanceof Error ? error.name : 'unknown',
          ),
          success,
          cleanupConfirmed,
          serviceCleanupReceipts,
          retainedRoot: existsSync(root) ? root : null,
        }),
      );
    }
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'owned_source_cleanup_failed');
  if (failure) throw failure;
}, 180000);

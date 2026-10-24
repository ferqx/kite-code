import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
import { assertSqliteReleaseIdentity } from '@kite-ai/service/sqlite-release-assets';
import type { TuiMcpSourceApprovalFact } from '@kite-ai/ui/tui';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { serviceBundledDependencies } from '../../../service/bundled-dependencies';
import type { CLIServiceArtifact } from '../../host';
import { mcpSha } from '../../host/mcp-selection-intents';
import { verifyTerminalBundle } from '../../host/terminal-artifact';
import {
  decodeMcpSourceApprovalFact,
  decodeMcpSourcePage,
} from '../../host/tui-mcp-source-approval';
import { installedDependency, verifyBuiltDependency } from '../fixtures/built-dependency-proof';

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
    expectedStoreId?: string;
    expectedOwnerGeneration?: string;
    extensionId?: string;
    actionId?: string;
    requestSha256?: string;
    answerKind?: string;
    decision?: string;
  };
};

test('80x24 Source Review independently confirms Action and original Question decisions; cold removed Source/Workspace checks original IDs GET-only and foreign restored Store rejects original lookups', async () => {
  const root = temporaryDirectory('kite-tui-mcp-source-approval-');
  const evidence = join(tmpdir(), `kite-tui-mcp-source-approval-evidence-${randomUUID()}`);
  privateDirectory(evidence);
  const workspace = join(root, 'workspace');
  privateDirectory(join(root, 'build'));
  privateDirectory(workspace);
  privateDirectory(join(workspace, '.kite-code'));
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
    driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined,
    seed: Awaited<ReturnType<typeof launchPairedService>> | undefined,
    observer: ReturnType<typeof createClient> | undefined,
    artifact: CLIServiceArtifact | undefined,
    control: ReturnType<typeof Bun.serve> | undefined;
  const sessionOwners = new Map<string, { storeId: string; generation: string }>();
  const captureSessionOwner = () => {
    const db = new Database(join(profile.profilePath, 'core.db'), { readonly: true });
    try {
      const row = db
        .query<{ generation: string }, []>(
          "SELECT CAST(owner_generation AS TEXT) AS generation FROM session WHERE id='a'",
        )
        .get();
      expect(row).not.toBeNull();
      sessionOwners.set(phase, { storeId: currentStoreId, generation: row!.generation });
    } finally {
      db.close();
    }
  };
  const assertSessionPosts = (targetPhase = phase) => {
    const posts = wire().filter((row) => row.phase === targetPhase && row.method === 'POST');
    if (targetPhase === 'cold-missing' || targetPhase === 'cold-foreign') {
      // A missing Workspace enters the existing read-only observer. It cannot
      // acquire live Session authority or perform even lifecycle reconciliation.
      expect(existsSync(workspace)).toBe(false);
      expect(posts).toHaveLength(0);
      return;
    }
    expect(['warm', 'cold-removed']).toContain(targetPhase);
    const frozen = sessionOwners.get(targetPhase);
    expect(frozen).toBeDefined();
    const reconciliations = posts.filter((row) => row.path === '/v1/sessions/a/reconcile');
    // Host admission and first selection reconcile this frozen Session scope.
    // Source actions and original decisions remain strictly GET-only on reopen.
    expect(reconciliations).toHaveLength(2);
    const commandId = `session-reconcile-${sha(
      Buffer.from(JSON.stringify([frozen!.storeId, 'a', frozen!.generation])),
    )}`;
    const request = {
      expectedStoreId: frozen!.storeId,
      commandId,
      expectedOwnerGeneration: frozen!.generation,
    };
    for (const row of reconciliations)
      expect(row.body).toEqual({
        commandId,
        expectedStoreId: frozen!.storeId,
        expectedOwnerGeneration: frozen!.generation,
        requestSha256: sha(Buffer.from(JSON.stringify(request))),
      });
    expect(posts.filter((row) => !reconciliations.includes(row))).toHaveLength(
      targetPhase === 'warm' ? 9 : 0,
    );
  };
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
        join(root, 'build/candidate'),
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
    const initialCandidate = verifyTerminalBundle(join(root, 'build/candidate'));
    candidateAccess = acquireArtifactAccess({ root: initialCandidate.root, mode: 'shared' });
    const candidate = verifyTerminalBundle(initialCandidate.root);
    expect(candidate.digest).toBe(initialCandidate.digest);
    // Parent maintenance must use the same verified engine as the independently built caller.
    const engineSelection = {
      root: join(candidate.root, 'node_modules/@kite-ai/agent/storage/engine'),
      manifestSha256: candidate.manifest.sqlite.manifestSha256,
    };
    const engine = initializeSqliteEngine(engineSelection);
    if (process.platform !== 'darwin') {
      const { driver, linkage, version, sourceId } = candidate.manifest.sqlite;
      assertSqliteReleaseIdentity({ driver, linkage, version, sourceId }, engine);
      expect(linkage).toBe('builtin');
    }
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
      const expected = installedDependency(name, serviceOwner);
      expect(
        verifyBuiltDependency(
          name,
          serviceBuilt,
          expected,
          serviceBundledDependencies.includes(name),
        ),
      ).toEqual(expected);
      dependencyVersions[name] = expected.version;
    }
    privateFile(join(evidence, 'service-dependencies.json'), dependencyVersions);
    symlinkSync(
      join(candidate.root, 'node_modules'),
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
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
    privateDirectory(profile.profilePath);
    writeFileSync(
      join(workspace, '.kite-code/mcp.json'),
      JSON.stringify({
        mcpServers: {
          target: { type: 'http', url: `${peer.url.href}mcp`, auth: { type: 'none' } },
        },
      }),
      { mode: 0o600 },
    );
    privateDirectory(join(profile.profilePath, 'ui'));
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
    // The original MCP journey starts with an established Workspace. Establish
    // its ordinary trust prerequisite through the public API before the PTY
    // wire baseline; this grants no MCP Source admission or Tool permission.
    const trust = await seed.client.getWorkspaceTrust('w', { storeId });
    await seed.client.setWorkspaceTrust('w', {
      expectedStoreId: storeId,
      commandId: randomUUID(),
      trusted: true,
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
      ifRevision: trust.revision,
    });
    expect((await seed.client.getWorkspaceTrust('w', { storeId })).trusted).toBe(true);
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
    captureSessionOwner();
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
          captureSessionOwner();
          settings();
          selectedBaseline = 0;
          return Response.json({ phase });
        }
        if (action === 'cold-foreign') {
          observer?.disposeNetwork();
          observer = undefined;
          maintenanceStage = 'prior_services_close';
          // The previous PTY host has been reaped; require every owned Service's own close receipt
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
          expect(backup.manifest.version).toBe(16);
          expect(backup.manifest.assets.mcpApprovals?.present).toBe(true);
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
          captureSessionOwner();
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
          assertSessionPosts();
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
              businessPosts: 0,
              reconciliationPosts: 0,
              journalHash,
            });
          return Response.json({ checked: true });
        }
        if (action === 'selection-baseline') {
          selectedBaseline = sourceGets();
          return Response.json({ checked: true });
        }
        if (action === 'cold-selected') {
          assertSessionPosts();
          expect(sourceGets()).toBe(selectedBaseline);
          return Response.json({ checked: true });
        }
        if (action === 'cold-lookup') {
          const id = identities[n - 1]!,
            fact = await query(id.commandId);
          expect(fact).toEqual(id.fact);
          assertSessionPosts();
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
    driver = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        join(import.meta.dir, '../fixtures/tui-mcp-source-approval-driver.ts'),
        control.url.href,
        process.execPath,
        join(root, 'host.js'),
        root,
        evidence,
        storeId,
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        ...(process.platform === 'win32' ? { ipc() {} } : {}),
      },
    );
    const [ptyOut, ptyErr, ptyCode] = await Promise.all([
      new Response(driver.stdout).text(),
      new Response(driver.stderr).text(),
      driver.exited,
    ]);
    writeFileSync(join(evidence, 'pty.log'), ptyOut + ptyErr, { mode: 0o600, flag: 'wx' });
    expect(ptyCode).toBe(0);
    expect(ptyOut).toContain('SOURCE_APPROVAL_WARM_COLD_COMPLETE');
    expect(sourcePosts()).toHaveLength(3);
    expect(new Set(sourcePosts().map((row) => row.body!.commandId)).size).toBe(3);
    expect(answers()).toHaveLength(6);
    assertSessionPosts('warm');
    expect(answers().filter((row) => row.body!.answerKind === 'approval')).toHaveLength(3);
    expect(
      answers()
        .filter((row) => row.body!.answerKind === 'question')
        .map((row) => row.body!.decision),
    ).toEqual(['approved', 'rejected', 'cancel']);
    for (const coldPhase of ['cold-removed', 'cold-missing', 'cold-foreign'])
      assertSessionPosts(coldPhase);
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
        if (driver?.exitCode === null) {
          if (process.platform === 'win32') driver.send('owned-source-approval-driver-stop');
          else driver.kill('SIGINT');
          await bounded(driver.exited, 9000);
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
        (driver === undefined || driver.exitCode !== null) &&
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
              'Public current-schema A→B (this original case asserts v16); terminal original ID lookup rejects foreign Store before original lookup HTTP',
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
  if (cleanupErrors.length)
    throw new AggregateError(
      failure ? [failure, ...cleanupErrors] : cleanupErrors,
      'owned_source_cleanup_failed',
    );
  if (failure) throw failure;
}, 180000);

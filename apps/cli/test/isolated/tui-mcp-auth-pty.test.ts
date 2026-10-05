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
import { selectProfile } from '@kite-ai/agent/profile';
import { getLoadedSqliteEngine, initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { ClientError, createClient } from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';
import type { CLIServiceArtifact } from '../../host';
import { verifyTerminalBundle } from '../../host/terminal-artifact';
import { decodeMcpAuthFact } from '../../host/tui-mcp-auth';
import { decodeMcpSourcePage } from '../../host/tui-mcp-source-approval';

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

test('80x24 real OAuth Auth Actions preserve original IDs and cold removed source history is explicit GET-only', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-tui-mcp-auth-'));
  const evidence = `/private/tmp/kite-tui-mcp-auth-evidence-${randomUUID()}`;
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
        row.body.actionId?.startsWith('mcp.auth.'),
    );
  const protocol = { metadata: 0, register: 0, authorize: 0, token: 0, refresh: 0, revoke: 0 };
  const facts: unknown[] = [],
    identities: { commandId: string; executionId: string }[] = [];
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
    const codes = new Map<string, { challenge: string; redirect: string }>();
    peer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url),
          origin = url.origin;
        if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
          protocol.metadata++;
          return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
        }
        if (url.pathname.startsWith('/.well-known/')) {
          protocol.metadata++;
          return Response.json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            revocation_endpoint: `${origin}/revoke`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['none'],
            code_challenge_methods_supported: ['S256'],
          });
        }
        if (url.pathname === '/register') {
          protocol.register++;
          return Response.json({
            ...((await request.json()) as object),
            client_id: 'owned-client',
          });
        }
        if (url.pathname === '/authorize') {
          protocol.authorize++;
          expect(url.searchParams.get('code_challenge_method')).toBe('S256');
          const code = `owned-code-${protocol.authorize}`,
            redirect = url.searchParams.get('redirect_uri')!;
          codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect });
          const callback = new URL(redirect);
          callback.searchParams.set('code', code);
          callback.searchParams.set('state', url.searchParams.get('state')!);
          return new Response(null, { status: 302, headers: { location: callback.href } });
        }
        if (url.pathname === '/token') {
          protocol.token++;
          const body = new URLSearchParams(await request.text());
          if (body.get('grant_type') === 'refresh_token') {
            protocol.refresh++;
            expect(body.get('refresh_token')).toMatch(/^owned-refresh-/);
          } else {
            const code = codes.get(body.get('code')!);
            expect(code).toBeDefined();
            expect(
              createHash('sha256').update(body.get('code_verifier')!).digest('base64url'),
            ).toBe(code!.challenge);
            expect(body.get('redirect_uri')).toBe(code!.redirect);
            codes.delete(body.get('code')!);
          }
          return Response.json({
            access_token: `owned-access-${protocol.token}`,
            refresh_token: `owned-refresh-${protocol.token}`,
            token_type: 'Bearer',
            expires_in: 3600,
          });
        }
        if (url.pathname === '/revoke') {
          protocol.revoke++;
          expect(request.method).toBe('POST');
          return new Response('');
        }
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
      entrypoints: [join(import.meta.dir, '../fixtures/tui-mcp-auth-pty.ts')],
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
      buildId: 'owned-auth',
      apiMajor: 1,
    };
    settings();
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(profile.profilePath, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          target: { type: 'http', url: `${peer.url.href}mcp`, auth: { type: 'oauth' } },
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
    expect(directory.items[0]!.admitted).toBe(true);
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
    let selectedBaseline = 0;
    let warmProtocol = { ...protocol };
    let warmVaultOperations = 0;
    const originalGets = () =>
      wire().filter(
        (row) =>
          row.phase === phase &&
          (row.path.includes('mcp.auth.result') ||
            identities.some((id) => row.path.includes(id.commandId))),
      );
    async function controlRequest(request: Request): Promise<Response> {
      const [action, number] = new URL(request.url).pathname.split('/').filter(Boolean),
        n = Number(number);
      if (action === 'before-confirm') {
        expect(sourcePosts()).toHaveLength(n - 1);
        return Response.json({ checked: true });
      }
      if (action === 'finish') {
        const post = await until('original-post', async () => sourcePosts()[n - 1], closing.signal);
        expect(sourcePosts()).toHaveLength(n);
        const commandId = post.body!.commandId!;
        const command = await until(
          'original-command',
          async () => {
            try {
              const c = await (await connected()).getCommand(commandId);
              return (c.receipt as { executionId?: string }).executionId ? c : undefined;
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
        const executionId = (command.receipt as { executionId: string }).executionId;
        const card = await until(
          'ordinary-ask',
          async () =>
            (
              await (await connected()).listInteractions('a', { storeId, state: 'pending' })
            ).interactions.find(
              (row) => row.executionId === executionId && row.kind === 'approval',
            ),
          closing.signal,
        );
        expect(card.definitionId).toBe(
          post.body!.actionId!.replace('mcp.auth.', 'builtin.mcp.sources/mcp.auth.'),
        );
        expect(card.runId).toBeNull();
        if (n === 1) expect(protocol.token).toBe(0);
        await (await connected()).answerInteraction('a', card.id, {
          expectedStoreId: storeId,
          commandId: `allow-auth-${n}`,
          expectedRevision: card.revision,
          answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
        });
        const fact = await until(
          'completed-auth',
          async () => {
            const value = decodeMcpAuthFact(
              await (await connected()).queryExtension(
                'a',
                'builtin.mcp.sources',
                'mcp.auth.result',
                { commandId },
              ),
            );
            return value.phase === 'completed' ? value : undefined;
          },
          closing.signal,
        );
        expect(fact.command!.id).toBe(commandId);
        expect(fact.execution!.id).toBe(executionId);
        expect(fact.command!.subjectId).toBe(subjectId!);
        expect(fact.binding!.serverId).toBe(sourceId);
        expect(fact.authStatus).toBe(n === 3 || n === 5 ? 'revoked' : 'authenticated');
        identities.push({ commandId, executionId });
        facts.push({ stage: 'auth', fact });
        return Response.json({ commandId, executionId });
      }
      if (action === 'warm-complete') {
        expect(sourcePosts()).toHaveLength(5);
        expect(new Set(identities.map((id) => id.commandId)).size).toBe(5);
        expect(protocol).toMatchObject({ authorize: 2, token: 3, refresh: 1 });
        expect(protocol.metadata).toBeGreaterThan(0);
        expect(protocol.register).toBe(2);
        warmProtocol = { ...protocol };
        warmVaultOperations = ledger('credentials.jsonl').length;
        expect(warmVaultOperations).toBeGreaterThan(0);
        expect(new Set(ledger('credentials.jsonl').map((row) => row.pid)).size).toBe(1);
        expect(protocol.revoke).toBeGreaterThan(0);
        expect(peerCalls).toBe(0);
        expect(modelCalls).toBe(0);
        return Response.json({ checked: true });
      }
      if (action === 'cold-removed') {
        observer?.disposeNetwork();
        observer = undefined;
        rmSync(join(root, 'observer-private.json'));
        rmSync(join(profile.profilePath, 'mcp.json'));
        renameSync(workspace, join(root, 'removed-workspace'));
        phase = 'cold-removed';
        settings();
        return Response.json({ checked: true });
      }
      if (action === 'selection-baseline') {
        selectedBaseline = originalGets().length;
        return Response.json({ commandId: identities[1]!.commandId });
      }
      if (action === 'cold-selected') {
        expect(originalGets()).toHaveLength(selectedBaseline);
        return Response.json({ checked: true });
      }
      if (action === 'cold-lookup') {
        const rows = originalGets().slice(selectedBaseline);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.method === 'GET')).toBe(true);
        expect(rows.some((row) => row.path.includes(identities[1]!.commandId))).toBe(true);
        expect(rows.some((row) => row.path.includes('mcp.auth.result'))).toBe(true);
        expect(
          rows
            .filter((row) => !row.path.includes('mcp.auth.result'))
            .every((row) => row.path.includes(identities[1]!.commandId)),
        ).toBe(true);
        expect(protocol).toEqual(warmProtocol);
        expect(ledger('credentials.jsonl')).toHaveLength(warmVaultOperations);
        expect(wire().filter((row) => row.phase === phase && row.method === 'POST')).toHaveLength(
          0,
        );
        return Response.json({ checked: true });
      }
      throw Error('owned_auth_control_unknown');
    }
    control = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const work = controlRequest(request).catch((error) => {
          failure ??= error;
          return new Response('owned_auth_control_failed', { status: 500 });
        });
        controlWork.add(work);
        void work.finally(() => controlWork.delete(work));
        return work;
      },
    });
    python = Bun.spawn(
      [
        'python3',
        join(import.meta.dir, '../fixtures/tui-mcp-auth-pty.py'),
        control.url.href,
        artifact.executable,
        artifact.entrypoint,
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
    expect(ptyOut).toContain('AUTH_WARM_COLD_COMPLETE');
    expect(sourcePosts().map((row) => row.body!.actionId)).toEqual([
      'mcp.auth.login',
      'mcp.auth.refresh',
      'mcp.auth.revoke',
      'mcp.auth.login',
      'mcp.auth.clear',
    ]);
    expect(peerCalls).toBe(0);
    expect(modelCalls).toBe(0);
    expect(wire().filter((row) => row.method === 'POST')).toHaveLength(5);
    expect(
      ledger('permissions.jsonl')
        .filter((row) => row.kind === 'job')
        .every(
          (row) =>
            typeof row.definitionId === 'string' &&
            row.definitionId.startsWith('builtin.mcp.sources/mcp.auth.'),
        ),
    ).toBe(true);
    expect(ledger('browser.jsonl')).toHaveLength(2);
    const exits = JSON.parse(readFileSync(join(evidence, 'pty-exits.json'), 'utf8'));
    expect(exits.normalComplete).toBe(true);
    expect(exits.exits).toHaveLength(2);
    expect(
      exits.exits.every(
        (row: { exitCode: number; normalCtrlQ: boolean }) => row.exitCode === 0 && row.normalCtrlQ,
      ),
    ).toBe(true);
    success = true;
  } catch (error) {
    failure = error;
  } finally {
    closing.abort(Error('owned_auth_pty_closing'));
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
            timer = setTimeout(() => reject(Error('owned_auth_cleanup_unconfirmed')), ms);
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
        'browser.jsonl',
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
          protocol,
          deadlines: {
            stepMs: 10000,
            controlMs: 12000,
            normalExitMs: 6000,
            exitWaitMs: 3000,
            testMs: 180000,
          },
          limits: {
            browser: 'Fixture fetch callback only; system browser and native Vault unqualified',
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
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'owned_auth_cleanup_failed');
  if (failure) throw failure;
}, 180000);

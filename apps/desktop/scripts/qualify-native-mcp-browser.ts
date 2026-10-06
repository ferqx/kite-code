import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import {
  createCredentialVault,
  createOsCredentialBackend,
  mcpCanonical,
  type OwnedCredentialScope,
  readMcpSources,
} from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { buildNativeCandidate } from './build-native';

/** Explicit local qualification, outside automated default: the human handles any browser TLS warning. */
if (process.platform !== 'darwin') throw Error('native_mcp_browser_qualification_macos_only');
const root = realpathSync(mkdtempSync('/private/tmp/kite-native-mcp-browser-')),
  home = join(root, 'home'),
  moved = join(root, 'relocated'),
  profile = selectProfile({ dataRoot: join(home, '.kite-code/unified-agent'), profile: 'default' });
mkdirSync(home, { mode: 0o700 });
mkdirSync(join(home, 'workspace'), { mode: 0o700 });
const require = createRequire(import.meta.url),
  counts = {
    metadata: 0,
    register: 0,
    authorize: 0,
    codeExchange: 0,
    refresh: 0,
    revoke: 0,
    initialize: 0,
    list: 0,
    unauthorized: 0,
    held: 0,
  },
  navigation: { userAgent: string; destination: string; mode: string; held: boolean }[] = [],
  codes = new Map<string, { challenge: string; redirect: string }>(),
  tokens = new Set<string>(),
  refreshTokens = new Set<string>(),
  failures: string[] = [],
  leases: ReturnType<typeof acquireArtifactAccess>[] = [];
let server: ReturnType<typeof Bun.serve> | undefined,
  control: ReturnType<typeof Bun.serve> | undefined,
  driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined,
  output: Promise<string> | undefined,
  errors: Promise<string> | undefined,
  ownedScope: OwnedCredentialScope | undefined,
  holdAuthorization = false,
  result: Record<string, unknown> | undefined,
  failure: unknown;
let freshOwnedAbsenceAfterCleanup: boolean | null = null;
let browserReady = false;
const backendOptions = {
    service: 'kite-agent',
    accountNamespace: `profile-${profile.profileAccessKey}`,
  },
  vault = () => createCredentialVault({ backend: createOsCredentialBackend(backendOptions) });
const hash = (value: unknown) => createHash('sha256').update(mcpCanonical(value)).digest('hex');
const emit = (stage: string, facts = {}) => console.log(JSON.stringify({ stage, root, ...facts }));
async function ownedCleanup() {
  const rows = () =>
    String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
      .trim()
      .split('\n')
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return {
          pid: Number(parts[0]),
          parent: Number(parts[1]),
          command: parts.slice(2).join(' '),
        };
      });
  const observed = rows(),
    owned = new Set(
      observed.filter((row) => row.command.startsWith(`${moved}/`)).map((row) => row.pid),
    );
  for (let i = 0; i < observed.length; i++)
    for (const row of observed) if (owned.has(row.parent)) owned.add(row.pid);
  for (const pid of owned)
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  const live = () =>
    rows().filter(
      (row) =>
        owned.has(row.pid) &&
        observed.some((old) => old.pid === row.pid && old.command === row.command),
    );
  let deadline = Date.now() + 2000;
  while (live().length && Date.now() < deadline) await Bun.sleep(25);
  const forced = live().map((row) => row.pid);
  for (const pid of forced)
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  deadline = Date.now() + 5000;
  while (live().length && Date.now() < deadline) await Bun.sleep(25);
  const remaining = live().map((row) => row.pid),
    facts = { observed: [...owned], forced, remaining, confirmed: remaining.length === 0 };
  writeFileSync(join(root, 'owned-cleanup.json'), JSON.stringify(facts));
  assert.equal(remaining.length, 0, 'owned native browser qualification processes remain');
  return facts;
}
try {
  const key = join(root, 'key.pem'),
    cert = join(root, 'cert.pem'),
    config = join(root, 'certificate.cnf');
  writeFileSync(
    config,
    '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n',
    { mode: 0o600 },
  );
  const certificate = Bun.spawn(
    [
      '/usr/bin/openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-config',
      config,
    ],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
  );
  const certificateError = new Response(certificate.stderr).text();
  assert.equal(await certificate.exited, 0);
  await certificateError;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { key: readFileSync(key), cert: readFileSync(cert) },
    async fetch(request) {
      try {
        const url = new URL(request.url),
          base = url.origin;
        if (url.pathname === '/qualification-ready') {
          assert.equal(request.headers.get('sec-fetch-dest'), 'document');
          assert.match(request.headers.get('user-agent') ?? '', /Chrome\//);
          browserReady = true;
          return new Response(
            'Owned local Native MCP HTTPS qualification is ready. The Native window will now run ordinary OAuth approvals; no external account is used.',
            { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } },
          );
        }
        if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
          counts.metadata++;
          return Response.json({
            resource: `${base}/mcp`,
            authorization_servers: [base],
            scopes_supported: ['tools'],
          });
        }
        if (url.pathname.startsWith('/.well-known/')) {
          counts.metadata++;
          return Response.json({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`,
            revocation_endpoint: `${base}/revoke`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['none'],
            code_challenge_methods_supported: ['S256'],
          });
        }
        if (url.pathname === '/register') {
          assert.equal(request.method, 'POST');
          counts.register++;
          const body = (await request.json()) as Record<string, unknown>;
          return Response.json({ ...body, client_id: `owned-client-${counts.register}` });
        }
        if (url.pathname === '/authorize') {
          assert.equal(request.method, 'GET');
          assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
          assert.equal(request.headers.get('sec-fetch-dest'), 'document');
          assert.match(request.headers.get('user-agent') ?? '', /Chrome\//);
          counts.authorize++;
          navigation.push({
            userAgent: request.headers.get('user-agent')!,
            destination: request.headers.get('sec-fetch-dest')!,
            mode: request.headers.get('sec-fetch-mode') ?? '',
            held: holdAuthorization,
          });
          if (holdAuthorization) {
            counts.held++;
            return new Response(
              'Owned Native MCP cancellation qualification. Cancel the exact original operation in the Native window.',
              { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } },
            );
          }
          const code = randomUUID(),
            redirect = url.searchParams.get('redirect_uri')!;
          assert.ok(redirect.startsWith('http://127.0.0.1:'));
          assert.equal(new URL(redirect).pathname, '/oauth/callback');
          codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect });
          const callback = new URL(redirect);
          callback.searchParams.set('code', code);
          callback.searchParams.set('state', url.searchParams.get('state')!);
          return new Response(null, {
            status: 302,
            headers: { location: callback.href, 'cache-control': 'no-store' },
          });
        }
        if (url.pathname === '/token') {
          assert.equal(request.method, 'POST');
          const body = new URLSearchParams(await request.text());
          if (body.get('grant_type') === 'refresh_token') {
            assert.ok(refreshTokens.has(body.get('refresh_token')!));
            counts.refresh++;
          } else {
            assert.equal(body.get('grant_type'), 'authorization_code');
            const code = codes.get(body.get('code')!);
            assert.ok(code);
            assert.equal(
              createHash('sha256').update(body.get('code_verifier')!).digest('base64url'),
              code.challenge,
            );
            assert.equal(body.get('redirect_uri'), code.redirect);
            codes.delete(body.get('code')!);
            counts.codeExchange++;
          }
          const access = randomUUID(),
            refresh = randomUUID();
          tokens.clear();
          tokens.add(access);
          refreshTokens.clear();
          refreshTokens.add(refresh);
          return Response.json({
            access_token: access,
            refresh_token: refresh,
            token_type: 'Bearer',
            expires_in: 600,
          });
        }
        if (url.pathname === '/revoke') {
          assert.equal(request.method, 'POST');
          const body = new URLSearchParams(await request.text());
          assert.ok(refreshTokens.has(body.get('token')!));
          counts.revoke++;
          tokens.clear();
          refreshTokens.clear();
          return new Response('');
        }
        if (url.pathname !== '/mcp') return new Response(null, { status: 404 });
        if (!tokens.has((request.headers.get('authorization') ?? '').replace(/^Bearer /, ''))) {
          counts.unauthorized++;
          return new Response(null, {
            status: 401,
            headers: {
              'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
            },
          });
        }
        if (request.method !== 'POST') return new Response(null, { status: 405 });
        const rpc = (await request.json()) as {
          id?: number;
          method: string;
          params?: { protocolVersion?: string };
        };
        if (rpc.id === undefined) return new Response(null, { status: 202 });
        let value: unknown;
        if (rpc.method === 'initialize') {
          counts.initialize++;
          value = {
            protocolVersion: rpc.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'owned-browser-mcp', version: '1' },
          };
        } else {
          assert.equal(rpc.method, 'tools/list');
          counts.list++;
          value = {
            tools: [
              {
                name: 'owned_browser_tool',
                inputSchema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { value: { type: 'string' } },
                  required: ['value'],
                },
              },
            ],
          };
        }
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: value });
      } catch (error) {
        failures.push(String(error));
        return new Response('Owned fixture validation failed', { status: 422 });
      }
    },
  });
  control = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/counts' && request.method === 'GET') return Response.json(counts);
      if (url.pathname === '/hold' && request.method === 'POST') {
        holdAuthorization = true;
        return new Response('');
      }
      return new Response(null, { status: 404 });
    },
  });
  const { buildTerminalBundle } = await import(
    resolve(import.meta.dir, '../../../scripts/release/terminal-bundle.ts')
  );
  const terminal = await buildTerminalBundle({
    destination: join(root, 'terminal-build'),
    processHostFixture: 'native-mcp-loopback',
    processHostFixtureCertificate: readFileSync(cert, 'utf8'),
  });
  const built = await buildNativeCandidate({
    terminalRoot: terminal.root,
    electronDist: resolve(dirname(dirname(require('electron') as string)), '../..'),
    outdir: join(root, 'source'),
  });
  renameSync(join(root, 'source'), moved);
  rmSync(terminal.root, { recursive: true, force: true });
  const candidate = verifyNativeRuntimeBundle(moved);
  assert.equal(candidate.digest, built.digest);
  leases.push(
    acquireArtifactAccess({ root: moved, mode: 'shared' }),
    acquireArtifactAccess({ root: candidate.terminal.root, mode: 'shared' }),
  );
  initializeSqliteEngine({
    root: join(candidate.terminal.root, 'node_modules/@kite-ai/agent/storage/engine'),
    manifestSha256: candidate.terminal.manifest.sqlite.manifestSha256,
  });
  const seed = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  let storeId: string;
  try {
    storeId = (await seed.getMetadata()).storeId;
    await seed.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'MCP Browser',
      rootUri: new URL(`file://${join(home, 'workspace')}`).href,
    });
    await seed.createSession({
      expectedStoreId: storeId,
      subjectId: 'local-user',
      commandId: 'create-browser-mcp',
      sessionId: 'mcp-browser',
      workspaceId: 'w',
      title: 'MCP Browser',
    });
  } finally {
    await seed.close();
  }
  writeFileSync(
    join(profile.profilePath, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'window-oauth': {
          type: 'http',
          url: `${server.url.origin}/mcp`,
          auth: { type: 'oauth', credentialRef: 'owned-native-browser', scopes: ['tools'] },
        },
      },
    }),
    { mode: 0o600 },
  );
  const entry = readMcpSources({
    profilePath: profile.profilePath,
    workspacePath: join(home, 'workspace'),
    scope: {
      profileId: profile.profileAccessKey,
      storeId: storeId!,
      sessionId: 'mcp-browser',
      workspaceId: 'w',
    },
  }).entries.find((value) => value.server.name === 'window-oauth');
  assert.ok(entry);
  const stat = lstatSync(join(home, 'workspace'));
  ownedScope = {
    namespace: 'mcp.oauth',
    ownerDigest: hash({
      domain: 'kite-mcp-oauth-owner-v1',
      profile: profile.profileAccessKey,
      originalStoreId: storeId!,
      workspaceId: 'w',
      workspaceIdentity: hash({
        root: realpathSync(join(home, 'workspace')),
        dev: stat.dev,
        ino: stat.ino,
      }),
      source: entry.server.source,
      serverId: entry.server.id,
      rawEntryDigest: entry.server.rawEntryDigest,
      transportDigest: entry.server.transportDigest,
      authProfile: 'owned-native-browser',
    }),
  };
  assert.equal(await vault().readOwned(ownedScope), null);
  const fixture = join(root, 'driver.ts');
  writeFileSync(
    fixture,
    readFileSync(
      resolve(import.meta.dir, '../test/native-mcp-browser-electron.fixture.ts'),
      'utf8',
    ).replace(
      "import { _electron } from 'playwright';",
      `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../package.json'))})('playwright');`,
    ),
  );
  const driverBuild = await Bun.build({
    entrypoints: [fixture],
    target: 'node',
    format: 'esm',
    packages: 'external',
    outdir: root,
    naming: 'driver.js',
  });
  assert.ok(driverBuild.success, 'native_browser_driver_build_failed');
  writeFileSync(
    join(root, 'candidate-evidence.json'),
    JSON.stringify({
      nativeDigest: candidate.digest,
      terminalDigest: candidate.terminal.digest,
      sourceFree: true,
      defaultBrowser: true,
      defaultVault: true,
      productionDefaultNetwork: false,
      processHostFixture: 'native-mcp-loopback',
      certificateSha256: createHash('sha256').update(readFileSync(cert)).digest('hex'),
      storeId: storeId!,
      ownedScope,
      asUrl: server.url.origin,
      home,
    }),
  );
  emit('candidate_ready', {
    nativeDigest: candidate.digest,
    terminalDigest: candidate.terminal.digest,
    asUrl: server.url.origin,
    certificateSha256: createHash('sha256').update(readFileSync(cert)).digest('hex'),
  });
  const readyUrl = new URL(`${server.url.origin}/qualification-ready`);
  emit('browser_certificate_handoff', { url: readyUrl.href });
  const { openMcpOAuthBrowser } = await import(
    resolve(import.meta.dir, '../../service/src/mcp-oauth-browser.ts')
  );
  await openMcpOAuthBrowser(readyUrl, new AbortController().signal);
  const readyDeadline = Date.now() + 300000;
  while (!browserReady) {
    assert.ok(Date.now() < readyDeadline, 'browser_certificate_handoff_not_completed');
    await Bun.sleep(100);
  }
  emit('browser_certificate_ready');
  driver = Bun.spawn(
    [
      realpathSync(Bun.which('node')!),
      join(root, 'driver.js'),
      moved,
      home,
      control.url.href.replace(/\/$/, ''),
      storeId!,
      entry.server.id,
    ],
    {
      cwd: home,
      env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  output = (async () => {
    const decoder = new TextDecoder(),
      parts: string[] = [];
    for await (const chunk of driver!.stdout) {
      const value = decoder.decode(chunk, { stream: true });
      parts.push(value);
      process.stdout.write(value);
    }
    parts.push(decoder.decode());
    return parts.join('');
  })();
  errors = new Response(driver.stderr).text();
  const timer = setTimeout(() => driver!.kill('SIGKILL'), 420000);
  let code: number;
  try {
    code = await driver.exited;
  } finally {
    clearTimeout(timer);
  }
  writeFileSync(join(root, 'driver.stdout.log'), await output);
  writeFileSync(join(root, 'driver.stderr.log'), await errors);
  assert.equal(code, 0, 'native_browser_driver_failed');
  assert.deepEqual(failures, []);
  assert.equal(await vault().readOwned(ownedScope), null);
  const report = JSON.parse(readFileSync(join(home, 'browser-report.json'), 'utf8')) as {
    pids: number[];
  };
  for (const pid of report.pids) assert.throws(() => process.kill(pid, 0));
  assert.equal(navigation.length, 3);
  assert.equal(counts.codeExchange, 2);
  assert.equal(counts.refresh, 1);
  assert.equal(counts.revoke, 1);
  assert.equal(counts.held, 1);
  result = {
    status: 'passed',
    nativeDigest: candidate.digest,
    terminalDigest: candidate.terminal.digest,
    sourceFree: true,
    defaultBrowser: true,
    defaultVault: true,
    productionDefaultNetwork: false,
    counts,
    navigation,
    ownedServicePids: report.pids,
    freshOwnedAbsenceBeforeCleanup: true,
  };
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors: unknown[] = [];
  if (driver && driver.exitCode === null) {
    driver.kill('SIGKILL');
    await driver.exited;
  }
  if (output) writeFileSync(join(root, 'driver.stdout.log'), await output);
  if (errors) writeFileSync(join(root, 'driver.stderr.log'), await errors);
  try {
    await ownedCleanup();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (ownedScope)
    try {
      await vault().removeOwned(ownedScope);
      freshOwnedAbsenceAfterCleanup = (await vault().readOwned(ownedScope)) === null;
      assert.equal(freshOwnedAbsenceAfterCleanup, true);
    } catch (error) {
      cleanupErrors.push(error);
    }
  try {
    for (const lease of leases.splice(0)) lease.release();
    if (existsSync(moved))
      for (const path of [moved, join(moved, 'terminal')]) {
        const exclusive = acquireArtifactAccess({ root: path, mode: 'exclusive' });
        exclusive.release();
      }
  } catch (error) {
    cleanupErrors.push(error);
  }
  server?.stop(true);
  control?.stop(true);
  tokens.clear();
  refreshTokens.clear();
  codes.clear();
  writeFileSync(join(root, 'wire-evidence.json'), JSON.stringify({ counts, navigation, failures }));
  writeFileSync(
    join(root, 'qualification.json'),
    JSON.stringify({
      ...result,
      status: failure || cleanupErrors.length ? 'failed' : 'passed',
      failure: failure ? String(failure) : null,
      cleanupErrors: cleanupErrors.map(String),
      freshOwnedAbsenceAfterCleanup,
    }),
  );
  if (cleanupErrors.length)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      'native_browser_cleanup_unconfirmed',
    );
}
if (failure) {
  emit('failed', { error: String(failure) });
  throw failure;
}
emit('complete', result);

import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { createMcpAdapter } from '@kite-ai/agent/mcp';
import {
  discoverAuthorizationServerMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpHttpTransportPort } from '../../src/mcp-http-port';
import { createMcpOAuthNetwork } from '../../src/mcp-oauth-network';

async function fixture() {
  const sockets = new Set<Socket>();
  const seen: {
    path: string;
    method: string;
    authorization?: string;
    host?: string;
    proxyAuthorization?: string | string[];
    body: string;
  }[] = [];
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    seen.push({
      path: request.url!,
      method: request.method!,
      authorization: request.headers.authorization,
      host: request.headers.host,
      proxyAuthorization: request.headers['proxy-authorization'],
      body: Buffer.concat(parts).toString(),
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (request.url === '/redirect') {
      response.writeHead(302, { location: `${base}/never` }).end();
      return;
    }
    if (request.url === '/large') {
      response.end('x'.repeat(1024));
      return;
    }
    if (request.url === '/held') return;
    const value = request.url?.includes('.well-known')
      ? {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        }
      : request.url === '/register'
        ? {
            client_id: 'owned-client',
            client_secret: 'owned-client-secret',
            redirect_uris: ['http://127.0.0.1/callback'],
          }
        : request.url === '/token'
          ? { access_token: 'owned-access', token_type: 'Bearer', refresh_token: 'owned-refresh' }
          : { ok: true };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    seen,
    sockets,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
function options(signal = new AbortController().signal) {
  return { signal, assertFresh() {}, allowLoopbackForTests: true };
}
async function until(read: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!read()) {
    if (Date.now() > deadline) throw Error('oauth_network_test_deadline');
    await Bun.sleep(5);
  }
}

test('actual SDK discovery, registration, code exchange, refresh and POST revocation use only the owned pinned port', async () => {
  const f = await fixture(),
    network = createMcpOAuthNetwork(options());
  try {
    const metadata = await discoverAuthorizationServerMetadata(f.url, { fetchFn: network.fetch });
    expect(metadata?.issuer).toBe(f.url);
    const client = await registerClient(f.url, {
      metadata,
      clientMetadata: { redirect_uris: ['http://127.0.0.1/callback'] },
      fetchFn: network.fetch,
    });
    expect(client.client_id).toBe('owned-client');
    const token = await exchangeAuthorization(f.url, {
      metadata,
      clientInformation: client,
      authorizationCode: 'owned-code',
      codeVerifier: 'owned-verifier',
      redirectUri: 'http://127.0.0.1/callback',
      fetchFn: network.fetch,
    });
    expect(token.access_token).toBe('owned-access');
    expect(
      (
        await refreshAuthorization(f.url, {
          metadata,
          clientInformation: client,
          refreshToken: 'owned-refresh',
          fetchFn: network.fetch,
        })
      ).access_token,
    ).toBe('owned-access');
    expect(
      (
        await network.fetch(`${f.url}/revoke`, {
          method: 'POST',
          body: new URLSearchParams({ token: 'owned-refresh', token_type_hint: 'refresh_token' }),
        })
      ).status,
    ).toBe(200);
    expect(f.seen).toHaveLength(5);
    expect(f.seen[0]!.method).toBe('GET');
    expect(f.seen[1]!.body).toContain('redirect_uris');
    expect(f.seen[2]!.authorization).toStartWith('Basic ');
    expect(f.seen[2]!.body).toContain('code_verifier=owned-verifier');
    expect(f.seen[3]!.body).toContain('refresh_token=owned-refresh');
    expect(f.seen[4]!.body).toContain('token=owned-refresh');
    expect(f.seen.every((row) => !row.path.includes('owned-'))).toBe(true);
  } finally {
    await network.close();
    await f.close();
  }
}, 10000);

test('freshness after held DNS rejects before any socket, without resampling a caller-mutated request', async () => {
  const f = await fixture();
  let fresh = true,
    started = false;
  let release!: (value: { address: string; family: number }[]) => void;
  const network = createMcpOAuthNetwork({
    ...options(),
    assertFresh() {
      if (!fresh) throw Error('owned_source_changed');
    },
    resolveAddresses: async () => {
      started = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    const request = network.fetch(`${f.url.replace('127.0.0.1', 'owned.invalid')}/token`, {
      method: 'POST',
      body: new URLSearchParams({ token: 'owned' }),
    });
    const rejected = request.catch((error) => error);
    await until(() => started);
    fresh = false;
    release([{ address: '127.0.0.1', family: 4 }]);
    expect((await rejected).message).toBe('owned_source_changed');
    expect(f.seen).toHaveLength(0);
    expect(f.sockets.size).toBe(0);
  } finally {
    await network.close();
    await f.close();
  }
}, 10000);

test('close and original/request abort terminate held DNS and held response with no late socket', async () => {
  const f = await fixture();
  let started = false;
  let release!: (value: { address: string; family: number }[]) => void;
  const lifetime = new AbortController();
  const network = createMcpOAuthNetwork({
    ...options(lifetime.signal),
    resolveAddresses: async () => {
      started = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    const pending = network.fetch(`${f.url.replace('127.0.0.1', 'owned.invalid')}/token`);
    const rejected = pending.catch((error) => error);
    await until(() => started);
    await network.close();
    expect((await rejected).code).toBe('mcp_oauth_request_aborted');
    release([{ address: '127.0.0.1', family: 4 }]);
    await Bun.sleep(0);
    expect(f.seen).toHaveLength(0);
    const active = createMcpOAuthNetwork(options(lifetime.signal));
    const caller = new AbortController();
    try {
      const held = active.fetch(`${f.url}/held`, { signal: caller.signal });
      const stopped = held.catch((error) => error);
      await until(() => f.seen.length === 1);
      caller.abort();
      expect((await stopped).code).toBe('mcp_oauth_request_aborted');
      await active.close();
      await until(() => f.sockets.size === 0);
      expect(f.sockets.size).toBe(0);
    } finally {
      await active.close();
    }
    const original = createMcpOAuthNetwork(options(lifetime.signal));
    try {
      const held = original.fetch(`${f.url}/held`),
        rejected = held.catch((error) => error);
      await until(() => f.seen.length === 2);
      lifetime.abort();
      expect((await rejected).code).toBe('mcp_oauth_request_aborted');
      await original.close();
      await until(() => f.sockets.size === 0);
      expect(f.sockets.size).toBe(0);
    } finally {
      await original.close();
    }
  } finally {
    await network.close();
    await f.close();
  }
}, 10000);

test('redirect never forwards sensitive header and request/response/cumulative budgets remain bounded', async () => {
  const f = await fixture(),
    network = createMcpOAuthNetwork({
      ...options(),
      limits: { requestBytes: 64, responseBytes: 64, requests: 4, timeoutMs: 1000 },
    });
  try {
    await expect(
      network.fetch(`${f.url}/redirect`, {
        method: 'POST',
        headers: { authorization: 'Basic owned' },
        body: 'x',
      }),
    ).rejects.toThrow('mcp_oauth_redirect_denied');
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]!.authorization).toBe('Basic owned');
    expect(f.seen.some((row) => row.path === '/never')).toBe(false);
    await expect(
      network.fetch(`${f.url}/token`, { method: 'POST', body: 'x'.repeat(65) }),
    ).rejects.toThrow('mcp_oauth_request_too_large');
    expect(f.seen).toHaveLength(1);
    await expect(network.fetch(`${f.url}/large`)).rejects.toThrow('mcp_oauth_response_too_large');
    expect((await network.fetch(`${f.url}/ok`)).status).toBe(200);
    await expect(network.fetch(`${f.url}/ok`)).rejects.toThrow('mcp_oauth_request_budget');
    expect(f.seen).toHaveLength(3);
  } finally {
    await network.close();
    await f.close();
  }
}, 10000);

test('HTTPS-only, URL secrets, mixed/private/metadata and invalid-family DNS deny before network', async () => {
  const f = await fixture();
  try {
    const production = createMcpOAuthNetwork({
      signal: new AbortController().signal,
      assertFresh() {},
    });
    try {
      await expect(production.fetch(f.url)).rejects.toThrow('mcp_oauth_https_required');
    } finally {
      await production.close();
    }
    const local = createMcpOAuthNetwork(options());
    try {
      for (const url of [
        `${f.url}/#`,
        `${f.url}/?token=secret`,
        f.url.replace('://', '://user:password@'),
        `${f.url}/\n`,
      ])
        await expect(local.fetch(url)).rejects.toThrow();
      await expect(
        local.fetch(`${f.url}/metadata`, { headers: { authorization: 'Basic private' } }),
      ).rejects.toThrow('mcp_oauth_sensitive_header_denied');
    } finally {
      await local.close();
    }
    for (const addresses of [
      [{ address: '169.254.169.254', family: 4 }],
      [{ address: '10.0.0.1', family: 4 }],
      [{ address: '127.0.0.1', family: 6 }],
      [
        { address: '8.8.8.8', family: 4 },
        { address: '192.168.0.1', family: 4 },
      ],
      [{ address: '::ffff:127.0.0.1', family: 6 }],
    ]) {
      const denied = createMcpOAuthNetwork({
        ...options(),
        resolveAddresses: async () => addresses,
      });
      try {
        await expect(denied.fetch('https://owned.invalid/metadata')).rejects.toThrow(
          'mcp_oauth_destination_denied',
        );
      } finally {
        await denied.close();
      }
    }
    expect(f.seen).toHaveLength(0);
    expect(f.sockets.size).toBe(0);
  } finally {
    await f.close();
  }
}, 10000);

test('real pinned TLS uses original servername and rejects an untrusted certificate before HTTP', async () => {
  const root = mkdtempSync('/private/tmp/kite-oauth-network-tls-');
  const key = join(root, 'key.pem'),
    cert = join(root, 'cert.pem');
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
      '-subj',
      '/CN=owned.invalid',
    ],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
  );
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let reader: Promise<void> | undefined;
  let network: ReturnType<typeof createMcpOAuthNetwork> | undefined;
  let port: number | undefined,
    sni: string | undefined,
    closed: { http: number; tlsErrors: number; sockets: number } | undefined;
  try {
    const certificateOutput = new Response(certificate.stderr).text();
    expect(await certificate.exited).toBe(0);
    await certificateOutput;
    const node = Bun.which('node');
    if (!node) throw new Error('owned_node_tls_fixture_unavailable');
    const source = `const fs=require('node:fs'), https=require('node:https'), tls=require('node:tls');
const options={key:fs.readFileSync(process.argv[1]),cert:fs.readFileSync(process.argv[2])}, context=tls.createSecureContext(options), sockets=new Set();let http=0,tlsErrors=0;
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const server=https.createServer({...options,SNICallback(name,cb){emit({sni:name});cb(null,context)}},(q,r)=>{http++;r.end('{}')});
let stopped=false,reported=false;const finish=()=>{if(stopped&&!sockets.size&&!reported){reported=true;emit({closed:{http,tlsErrors,sockets:sockets.size}})}};
server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>{sockets.delete(socket);finish()})});server.on('tlsClientError',()=>tlsErrors++);
server.listen(0,'127.0.0.1',()=>emit({port:server.address().port}));process.stdin.resume();process.stdin.once('end',()=>{for(const socket of sockets)socket.destroy();server.close(()=>{stopped=true;finish()})});`;
    child = Bun.spawn([node, '-e', source, key, cert], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const processOutput = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    const stream = child.stdout as ReadableStream<Uint8Array>;
    reader = (async () => {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let pending = '';
      for await (const chunk of stream) {
        pending += decoder.decode(chunk, { stream: true });
        let end = pending.indexOf('\n');
        while (end >= 0) {
          const fact = JSON.parse(pending.slice(0, end));
          pending = pending.slice(end + 1);
          if (fact.port !== undefined) port = fact.port;
          if (fact.sni !== undefined) sni = fact.sni;
          if (fact.closed !== undefined) closed = fact.closed;
          end = pending.indexOf('\n');
        }
        if (pending.length > 4096) throw new Error('owned_tls_fixture_frame_limit');
      }
      pending += decoder.decode();
      if (pending) throw new Error('owned_tls_fixture_partial_frame');
    })();
    await until(() => port !== undefined);
    network = createMcpOAuthNetwork({
      ...options(),
      resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    const failure = await network
      .fetch(`https://owned.invalid:${port}/metadata`)
      .catch((error) => error);
    expect(failure.code).toBe('mcp_oauth_request_failed');
    expect(failure.cause).toEqual({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    await network.close();
    network = createMcpOAuthNetwork({
      ...options(),
      trustedTestCertificate: readFileSync(cert, 'utf8'),
    });
    const literalFailure = await network
      .fetch(`https://127.0.0.1:${port}/metadata`)
      .catch((error) => error);
    expect(literalFailure.code).toBe('mcp_oauth_request_failed');
    expect(literalFailure.cause).toEqual({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    await network.close();
    (child.stdin as import('bun').FileSink).end();
    await until(() => closed !== undefined && child!.exitCode !== null);
    await reader;
    await processOutput;
    expect(sni).toBe('owned.invalid');
    expect(closed!.http).toBe(0);
    expect(closed!.tlsErrors).toBeGreaterThan(0);
    expect(closed!.sockets).toBe(0);
    expect(child.exitCode).toBe(0);
  } finally {
    try {
      await network?.close();
    } finally {
      if (child) {
        if (child.exitCode === null) child.kill();
        await child.exited;
        await reader;
      }
      if (certificate.exitCode === null) certificate.kill();
      await certificate.exited;
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 10000);

test('baked fixture certificate permits actual OAuth and MCP TLS while retaining hostname verification and owned shutdown', async () => {
  const root = mkdtempSync('/private/tmp/kite-mcp-trusted-fixture-tls-');
  const key = join(root, 'key.pem'),
    cert = join(root, 'cert.pem'),
    config = join(root, 'certificate.cnf');
  writeFileSync(
    config,
    '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=owned.invalid\n[ext]\nsubjectAltName=DNS:owned.invalid,IP:127.0.0.1\n',
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
  let child: ReturnType<typeof Bun.spawn> | undefined,
    reader: Promise<void> | undefined,
    network: ReturnType<typeof createMcpOAuthNetwork> | undefined,
    owned: Awaited<ReturnType<ReturnType<typeof createMcpHttpTransportPort>['open']>> | undefined;
  let port: number | undefined, closed: { sockets: number } | undefined;
  const requests: string[] = [];
  try {
    const certificateOutput = new Response(certificate.stderr).text();
    expect(await certificate.exited).toBe(0);
    await certificateOutput;
    const trustedTestCertificate = readFileSync(cert, 'utf8');
    expect(() =>
      createMcpOAuthNetwork({
        signal: new AbortController().signal,
        assertFresh() {},
        trustedTestCertificate,
      }),
    ).toThrow('mcp_test_certificate_invalid');
    expect(() =>
      createMcpHttpTransportPort({ servers: [], admit: async () => {}, trustedTestCertificate }),
    ).toThrow('mcp_test_certificate_invalid');
    const node = Bun.which('node');
    if (!node) throw Error('owned_node_tls_fixture_unavailable');
    const source = `const fs=require('node:fs'),https=require('node:https'),sockets=new Set();
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const server=https.createServer({key:fs.readFileSync(process.argv[1]),cert:fs.readFileSync(process.argv[2])},async(q,r)=>{
if(q.url==='/metadata'){emit({request:'metadata'});r.writeHead(200,{'content-type':'application/json'}).end('{"owned":true}');return}
if(q.url!=='/mcp'||q.method!=='POST'){r.writeHead(405).end();return}
const parts=[];for await(const part of q)parts.push(part);const rpc=JSON.parse(Buffer.concat(parts).toString());emit({request:rpc.method});
if(rpc.id===undefined){r.writeHead(202).end();return}
const result=rpc.method==='initialize'?{protocolVersion:rpc.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'owned-tls',version:'1'}}:{tools:[{name:'owned_tls_tool',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}}]};
r.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}))});
let stopped=false,reported=false;const finish=()=>{if(stopped&&!sockets.size&&!reported){reported=true;emit({closed:{sockets:sockets.size}})}};
server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>{sockets.delete(socket);finish()})});server.on('tlsClientError',()=>{});
server.listen(0,'127.0.0.1',()=>emit({port:server.address().port}));process.stdin.resume();process.stdin.once('end',()=>{for(const socket of sockets)socket.destroy();server.close(()=>{stopped=true;finish()})});`;
    child = Bun.spawn([node, '-e', source, key, cert], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const processOutput = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    reader = (async () => {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let pending = '';
      for await (const chunk of child!.stdout as ReadableStream<Uint8Array>) {
        pending += decoder.decode(chunk, { stream: true });
        let end = pending.indexOf('\n');
        while (end >= 0) {
          const fact = JSON.parse(pending.slice(0, end));
          pending = pending.slice(end + 1);
          if (fact.port !== undefined) port = fact.port;
          if (fact.request !== undefined) requests.push(fact.request);
          if (fact.closed !== undefined) closed = fact.closed;
          end = pending.indexOf('\n');
        }
        if (pending.length > 4096) throw Error('owned_tls_fixture_frame_limit');
      }
      pending += decoder.decode();
      if (pending) throw Error('owned_tls_fixture_partial_frame');
    })();
    await until(() => port !== undefined);
    const resolveAddresses = async () => [{ address: '127.0.0.1', family: 4 as const }];
    network = createMcpOAuthNetwork({ ...options(), trustedTestCertificate, resolveAddresses });
    const response = await network.fetch(`https://owned.invalid:${port}/metadata`);
    expect(await response.json()).toEqual({ owned: true });
    await until(() => requests.length === 1);
    const literal = await network.fetch(`https://127.0.0.1:${port}/metadata`);
    expect(await literal.json()).toEqual({ owned: true });
    await until(() => requests.length === 2);
    const mismatch = await network
      .fetch(`https://wrong.invalid:${port}/metadata`)
      .catch((error) => error);
    expect(mismatch.code).toBe('mcp_oauth_request_failed');
    expect(mismatch.cause).toEqual({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    expect(requests).toEqual(['metadata', 'metadata']);
    const url = `https://127.0.0.1:${port}/mcp`;
    const transport = createMcpHttpTransportPort({
      servers: [{ id: 'owned', url }],
      allowLoopbackForTests: true,
      trustedTestCertificate,
      resolveAddresses,
      admit: async () => {},
    });
    owned = await transport.open(
      {
        serverId: 'owned',
        scopeId: JSON.stringify(['store', 's', 'owned']),
        sessionId: 's',
        executionId: 'owned-connection',
        originalStoreId: 'store',
        configuration: { type: 'http', url },
        configDigest: createMcpAdapter({
          id: 'owned',
          transport: { type: 'http', url },
        }).getCatalogue().configDigest,
      },
      { signal: new AbortController().signal },
    );
    expect(requests).toEqual(['metadata', 'metadata']);
    const client = new Client({ name: 'owned', version: '1' });
    await client.connect(owned.transport);
    expect((await client.listTools()).tools[0]?.inputSchema.required).toEqual(['value']);
    expect(await owned.stop()).toEqual({ status: 'stopped' });
    expect(await owned.stopped).toEqual({ supervision: 'ended' });
    await network.close();
    (child.stdin as import('bun').FileSink).end();
    await until(() => closed !== undefined && child!.exitCode !== null);
    await reader;
    await processOutput;
    expect(requests).toEqual([
      'metadata',
      'metadata',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
    expect(closed!.sockets).toBe(0);
    expect(child.exitCode).toBe(0);
  } finally {
    await owned?.stop();
    await network?.close();
    if (child) {
      if (child.exitCode === null) child.kill();
      await child.exited;
      await reader;
    }
    if (certificate.exitCode === null) certificate.kill();
    await certificate.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('request endpoint/body/header snapshots survive held DNS and ambient proxies cannot route credentials', async () => {
  const f = await fixture(),
    proxy = await fixture();
  const previous = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    ALL_PROXY: process.env.ALL_PROXY,
  };
  for (const name of Object.keys(previous)) process.env[name] = proxy.url;
  let started = false;
  let release!: (value: { address: string; family: number }[]) => void;
  const network = createMcpOAuthNetwork({
    ...options(),
    resolveAddresses: async () => {
      started = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    const target = new URL(`${f.url.replace('127.0.0.1', 'owned.invalid')}/token`);
    const headers = new Headers({
      authorization: 'Basic original-owned',
      host: 'evil.invalid',
      'proxy-authorization': 'Basic proxy-owned',
    });
    const body = new URLSearchParams({ token: 'original-owned' });
    const result = network.fetch(target, { method: 'POST', headers, body });
    await until(() => started);
    target.pathname = '/changed';
    headers.set('authorization', 'Basic changed');
    body.set('token', 'changed');
    release([{ address: '127.0.0.1', family: 4 }]);
    expect((await result).status).toBe(200);
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]!.path).toBe('/token');
    expect(f.seen[0]!.authorization).toBe('Basic original-owned');
    expect(f.seen[0]!.body).toBe('token=original-owned');
    expect(f.seen[0]!.host).toBe(target.host);
    expect(f.seen[0]!.proxyAuthorization).toBeUndefined();
    expect(proxy.seen).toHaveLength(0);
  } finally {
    await network.close();
    await f.close();
    await proxy.close();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}, 10000);

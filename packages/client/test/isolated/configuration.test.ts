import { expect, test } from 'bun:test';
import { createClient, type HostMutation } from '../../src';
import { createBrowserClient } from '../../src/browser';

test('Native configuration capability, diagnostic read and closed intent never invent authority; bad receipts remain original lookup only', async () => {
  const profile = { dataRoot: '/private-fixture', name: 'new', accessKey: 'fixed' };
  let available = true,
    capability = false,
    writes = 0,
    reads = 0,
    lookups = 0,
    tamper = '';
  const saved = new Map<string, HostMutation>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/v1/server')
        return Response.json({
          instanceId: 'fixture',
          buildId: 'fixture',
          apiMajor: 1,
          profile,
          capabilities: capability ? ['configuration_management'] : [],
          dataAvailability: available ? 'available' : 'unavailable',
          ...(available ? { storeId: 'store' } : {}),
        });
      if (request.method === 'GET') {
        if (url.pathname.startsWith('/v1/host-mutations/')) {
          lookups++;
          expect(url.searchParams.get('storeId')).toBe('store');
          return Response.json(saved.get(url.pathname.split('/').at(-1)!));
        }
        reads++;
        expect(url.searchParams.has('path')).toBe(false);
        return Response.json({
          scope: 'user',
          ...(available ? { storeId: 'store' } : {}),
          etag: 'a'.repeat(64),
          raw: null,
          effective: null,
          snapshot: null,
          errors: ['invalid_jsonc'],
        });
      }
      writes++;
      const body = (await request.json()) as {
        commandId: string;
        expectedStoreId: string;
        ifMatch: string;
        secret?: string;
      };
      const result: HostMutation = {
        commandId: body.commandId,
        originStoreId: 'store',
        scope: 'user',
        ifMatch: body.ifMatch,
        kind: 'config.patch',
        state: 'applied',
        receipt: { status: 'applied', etag: 'b'.repeat(64) },
      };
      saved.set(body.commandId, structuredClone(result));
      if (tamper === 'store') result.originStoreId = 'foreign';
      if (tamper === 'scope') {
        result.scope = 'workspace';
        result.workspaceId = 'other';
      }
      if (tamper === 'etag') result.ifMatch = 'c'.repeat(64);
      if (tamper === 'kind') result.kind = 'config.repair';
      if (tamper === 'receipt')
        result.receipt = {
          status: 'applied',
          opaqueRef: 'credential:11111111-1111-4111-8111-111111111111',
          persistence: 'temporary',
        };
      if (tamper === 'secret')
        (result.receipt as Record<string, unknown>).secret = 'DO_NOT_ECHO_BODY';
      return Response.json(result);
    },
  });
  const client = createClient({
    endpoint: server.url.href,
    token: 'private',
    expected: { profile, apiMajor: 1, requiredCapabilities: [] },
  });
  const failure = async (work: Promise<unknown>, code: string) => {
    const error = await work.catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe(code);
    expect(String(error)).not.toContain('DO_NOT_ECHO_BODY');
  };
  try {
    await failure(client.getConfiguration('user', { storeId: 'store' }), 'connection_not_admitted');
    await client.connect();
    await failure(client.getConfiguration('user', { storeId: 'store' }), 'capability_unavailable');
    expect(reads).toBe(0);
    capability = true;
    await client.connect();
    await failure(
      client.getConfiguration('user', { storeId: 'foreign' }),
      'store_identity_mismatch',
    );
    await failure(
      client.getConfiguration('user', { storeId: 'store', path: '/tmp/owned' } as Parameters<
        typeof client.getConfiguration
      >[1]),
      'invalid_request',
    );
    await failure(client.getConfiguration('workspace', { storeId: 'store' }), 'invalid_request');
    expect(reads).toBe(0);
    const view = await client.getConfiguration('user', { storeId: 'store' });
    expect(view.effective).toBeNull();
    expect(view.errors).toEqual(['invalid_jsonc']);
    for (const variant of ['store', 'scope', 'etag', 'kind', 'receipt', 'secret']) {
      tamper = variant;
      const commandId = `original-${variant}`;
      await failure(
        client.patchConfiguration('user', {
          expectedStoreId: 'store',
          commandId,
          ifMatch: view.etag,
          operations: [{ kind: 'set', path: ['modelId'], value: null }],
        }),
        'network_outcome_unknown',
      );
      expect(lookups).toBe(
        ['store', 'scope', 'etag', 'kind', 'receipt', 'secret'].indexOf(variant),
      );
      expect((await client.getHostMutation(commandId, { storeId: 'store' })).commandId).toBe(
        commandId,
      );
    }
    expect(writes).toBe(6);
    expect(lookups).toBe(6);
    await failure(
      client.putCredential({
        expectedStoreId: 'store',
        commandId: 'hidden',
        secret: 'private',
        safeRequest: {},
      } as Parameters<typeof client.putCredential>[0]),
      'invalid_request',
    );
    expect(writes).toBe(6);
    await failure(
      client.patchConfiguration('user', {
        expectedStoreId: 'store',
        commandId: 'bad-path',
        ifMatch: view.etag,
        operations: [{ kind: 'set', path: ['models', '__proto__'], value: null }],
      }),
      'invalid_request',
    );
    expect(writes).toBe(6);
    available = false;
    await client.connect();
    const diagnostic = await client.getConfiguration('user', {});
    expect(diagnostic.storeId).toBeUndefined();
    expect(diagnostic.raw).toBeNull();
    expect(diagnostic.effective).toBeNull();
    await failure(
      client.getHostMutation('original-store', { storeId: 'store' }),
      'data_unavailable',
    );
    await failure(
      client.putCredential({ expectedStoreId: 'store', commandId: 'offline', secret: 'private' }),
      'data_unavailable',
    );
    expect(writes).toBe(6);
    const browser = createBrowserClient({
      origin: server.url.origin,
      pageIdentity: 'b'.repeat(64),
    });
    expect('getConfiguration' in browser).toBe(false);
    expect('patchConfiguration' in browser).toBe(false);
    expect('putCredential' in browser).toBe(false);
  } finally {
    client.disposeNetwork();
    server.stop(true);
  }
});

test('Settings SDK freezes original read-set and operation; altered committed marker is unknown and only original lookup recovers', async () => {
  const profile = { dataRoot: '/private-fixture', name: 'settings', accessKey: 'fixed' };
  const readSet = {
    userEtag: 'a'.repeat(64),
    workspaceEtag: null,
    explicitDigest: 'b'.repeat(64),
    effectiveDigest: 'c'.repeat(64),
  };
  const saved = new Map<string, HostMutation>();
  let posts = 0,
    lookups = 0,
    tamper = 'operation';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/v1/server')
        return Response.json({
          instanceId: 'owned',
          buildId: 'owned',
          apiMajor: 1,
          profile,
          capabilities: ['configuration_management'],
          dataAvailability: 'available',
          storeId: 'store',
        });
      if (request.method === 'GET') {
        if (url.pathname.startsWith('/v1/host-mutations/')) {
          lookups++;
          expect(url.searchParams.get('storeId')).toBe('store');
          return Response.json(saved.get(url.pathname.split('/').at(-1)!));
        }
        return Response.json({
          storeId: 'store',
          scope: 'user',
          readSet,
          defaultModelId: 'a',
          models: [
            { id: 'a', enabled: true, configured: true, diagnostics: [] },
            { id: 'b', enabled: true, configured: true, diagnostics: [] },
          ],
          errors: [],
        });
      }
      posts++;
      const body = (await request.json()) as {
        commandId: string;
        expectedReadSet: typeof readSet;
        operation: { kind: 'effort'; modelId: string; reasoningEffort: 'high' };
      };
      const original: HostMutation = {
        originStoreId: 'store',
        commandId: body.commandId,
        scope: 'user',
        ifMatch: body.expectedReadSet.userEtag,
        kind: 'model_settings.update',
        modelSettings: { expectedReadSet: body.expectedReadSet, operation: body.operation },
        state: 'applied',
        receipt: { status: 'applied', etag: 'd'.repeat(64) },
      };
      saved.set(body.commandId, structuredClone(original));
      if (tamper === 'operation') original.modelSettings!.operation.modelId = 'other';
      else original.modelSettings!.expectedReadSet.effectiveDigest = 'e'.repeat(64);
      return Response.json(original);
    },
  });
  const client = createClient({
    endpoint: server.url.href,
    token: 'private',
    expected: { profile, apiMajor: 1, requiredCapabilities: ['configuration_management'] },
  });
  const failed = async (work: Promise<unknown>, code: string) => {
    const error = await work.catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe(code);
  };
  try {
    await client.connect();
    const observed = await client.getModelSettings('user', { storeId: 'store' });
    const input = {
      expectedStoreId: 'store',
      commandId: 'original',
      expectedReadSet: observed.readSet!,
      operation: { kind: 'effort' as const, modelId: 'b', reasoningEffort: 'high' as const },
    };
    const original = structuredClone(input);
    const sent = client.updateModelSettings('user', input);
    input.operation.modelId = 'caller-alias';
    input.expectedReadSet.userEtag = 'f'.repeat(64);
    await failed(sent, 'network_outcome_unknown');
    expect(posts).toBe(1);
    expect(lookups).toBe(0);
    const receipt = await client.getHostMutation('original', { storeId: 'store' });
    expect(receipt.modelSettings).toEqual({
      expectedReadSet: original.expectedReadSet,
      operation: original.operation,
    });
    expect(posts).toBe(1);
    tamper = 'digest';
    await failed(
      client.updateModelSettings('user', { ...original, commandId: 'second' }),
      'network_outcome_unknown',
    );
    expect(posts).toBe(2);
    expect(lookups).toBe(1);
    expect(
      (await client.getHostMutation('second', { storeId: 'store' })).modelSettings?.expectedReadSet,
    ).toEqual(original.expectedReadSet);
    await failed(
      client.updateModelSettings('user', {
        ...original,
        commandId: 'bad-scope',
        expectedReadSet: { ...original.expectedReadSet, workspaceEtag: 'a'.repeat(64) },
      }),
      'invalid_request',
    );
    expect(posts).toBe(2);
  } finally {
    client.disposeNetwork();
    server.stop(true);
  }
});

import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { candidate, probe } from '../../fixtures/formal-optional-capabilities/candidate';

const gated =
  process.env.KITE_RUN_UNIFIED_KEYRING_SMOKE === '1' && process.env.GITHUB_ACTIONS === 'true';
test('native credential qualification requires both explicit smoke opt-in and CI authority', () => {
  const gate = (smoke: string | undefined, ci: string | undefined) =>
    smoke === '1' && ci === 'true';
  expect(gate(undefined, undefined)).toBe(false);
  expect(gate('1', undefined)).toBe(false);
  expect(gate(undefined, 'true')).toBe(false);
  expect(gate('1', 'false')).toBe(false);
  expect(gate('1', 'true')).toBe(true);
  expect(gated).toBe(gate(process.env.KITE_RUN_UNIFIED_KEYRING_SMOKE, process.env.GITHUB_ACTIONS));
});
test.skipIf(!gated)(
  'CI-only actual OS namespace survives independent processes and default public credential management supplies only private Provider authorization',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-unified-keyring-'))),
      home = join(root, 'home');
    mkdirSync(home, { mode: 0o700 });
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    const identityPath = join(root, 'identity.json'),
      secret = `synthetic-${randomUUID()}`;
    writeFileSync(
      identityPath,
      JSON.stringify({
        service: `kite-unified-ci-${randomUUID()}`,
        namespace: randomUUID(),
        secret,
      }),
      { mode: 0o600 },
    );
    let built: Awaited<ReturnType<typeof candidate>> | undefined,
      service: Awaited<ReturnType<typeof launchPairedService>> | undefined,
      opaqueRef: string | undefined;
    let namespaceRemoved = false;
    let requests = 0;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        expect(request.headers.get('authorization') === `Bearer ${secret}`).toBe(true);
        const body = await request.text();
        expect(body.includes(secret)).toBe(false);
        requests++;
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'credential-ci', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          frame({ content: 'credential delivered privately' }, null) +
            frame({}, 'stop') +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    try {
      built = await candidate(root);
      for (const mode of ['put', 'resolve', 'remove', 'missing']) {
        const result = await probe(built, mode, home, identityPath, true);
        expect(result.stderr).toBe('');
        expect(result.exit).toBe(0);
        expect(result.stdout.includes(secret)).toBe(false);
        expect(JSON.parse(result.stdout)).toEqual({ mode, passed: true });
        if (mode === 'remove') namespaceRemoved = true;
      }
      const b = built.bundle;
      service = await launchPairedService({
        profile,
        entrypoint: join(b.root, b.manifest.entries.service),
        executable: join(b.root, b.manifest.entries.runtime),
        instanceId: 'native-vault-ci',
        buildId: `terminal-${b.digest}`,
        apiMajor: 1,
        runtimeProtection: { kind: 'terminal.candidate', root: b.root, manifestSha256: b.digest },
        requiredCapabilities: [
          'configuration_management',
          'sessions',
          'commands',
          'permission_controls',
        ],
      });
      const client = service.client,
        storeId = service.bootstrap.storeId!;
      const mutation = await client.putCredential({
        commandId: 'put-secret',
        expectedStoreId: storeId,
        secret,
      });
      expect(mutation.state).toBe('applied');
      expect(JSON.stringify(mutation).includes(secret)).toBe(false);
      const receipt = mutation.receipt;
      if (
        !receipt ||
        typeof receipt !== 'object' ||
        Array.isArray(receipt) ||
        !('opaqueRef' in receipt) ||
        !('persistence' in receipt) ||
        typeof receipt.opaqueRef !== 'string' ||
        receipt.persistence !== 'os'
      )
        throw Error('credential_receipt_invalid');
      const reference = receipt.opaqueRef;
      opaqueRef = reference;
      expect(
        await client.putCredential({ commandId: 'put-secret', expectedStoreId: storeId, secret }),
      ).toEqual(mutation);
      writeFileSync(
        join(profile.profilePath, 'config.jsonc'),
        JSON.stringify({
          modelId: 'fixed',
          models: [
            {
              id: 'fixed',
              provider: 'compatible',
              model: 'fixed',
              baseURL: `${provider.url.href}v1`,
              credentialRef: opaqueRef,
            },
          ],
          tools: [],
        }),
        { mode: 0o600 },
      );
      await client.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'CI private',
        rootUri: pathToFileURL(root).href,
      });
      await client.createSession({
        expectedStoreId: storeId,
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 'CI vault',
      });
      const trust = await client.getWorkspaceTrust('w', { storeId });
      await client.setWorkspaceTrust('w', {
        expectedStoreId: storeId,
        commandId: 'trust',
        trusted: true,
        canonicalIdentity: trust.canonicalIdentity,
        externalReadScopeDigest: trust.externalReadScopeDigest,
        ifRevision: trust.revision,
      });
      const control = await client.getPermissionMode('s', { storeId });
      await client.setPermissionMode('s', {
        expectedStoreId: storeId,
        commandId: 'full',
        mode: 'full',
        makeDefault: false,
        ifRevision: control.revision,
        ifDefaultRevision: control.defaultRevision,
      });
      await client.startRun('s', {
        kind: 'run.start',
        expectedStoreId: storeId,
        commandId: 'work',
        content: 'Check private credential delivery',
      });
      const deadline = Date.now() + 15000;
      let view = await client.getView('s');
      while (
        !view.runs.some((run) => run.originCommandId === 'work' && run.status === 'completed')
      ) {
        if (Date.now() > deadline) throw Error('credential_run_deadline');
        await Bun.sleep(10);
        view = await client.getView('s');
      }
      expect(requests).toBe(1);
      expect(JSON.stringify(view).includes(secret)).toBe(false);
      expect(
        JSON.stringify(await client.getConfiguration('user', { storeId })).includes(secret),
      ).toBe(false);
      expect(JSON.stringify(await client.getCommand('work')).includes(secret)).toBe(false);
      expect(
        JSON.stringify(await client.getHostMutation('put-secret', { storeId })).includes(secret),
      ).toBe(false);
      expect(
        JSON.stringify(await client.listSessionLogs('s', { afterCursor: '0' })).includes(secret),
      ).toBe(false);
      const revoked = await client.revokeCredential(reference, {
        expectedStoreId: storeId,
        commandId: 'revoke',
      });
      expect(revoked.state).toBe('applied');
      opaqueRef = undefined;
      expect(readFileSync(identityPath, 'utf8')).toContain('credential:');
      console.log(
        JSON.stringify({
          platform: process.platform,
          arch: process.arch,
          terminalDigest: b.digest,
          nativeRoundtrip: true,
          defaultPublicCredential: true,
          provider: requests,
        }),
      );
    } finally {
      if (service && opaqueRef)
        await service.client.revokeCredential(opaqueRef, {
          expectedStoreId: service.bootstrap.storeId!,
          commandId: 'cleanup-revoke',
        });
      await service?.close();
      provider.stop(true);
      if (built) {
        const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
        if (identity.reference && !namespaceRemoved) {
          const cleanup = await probe(built, 'remove', home, identityPath, true);
          expect(cleanup.exit).toBe(0);
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);

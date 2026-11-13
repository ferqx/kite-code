import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as fixtureDelay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { expect, test } from '#kite-test';
import { ownedUserConfiguration } from '../../../apps/service/test/fixtures/user-configuration-fixture';
import { serve as serveFixture } from '../../../scripts/tooling/http';
import { candidate, probe } from '../../fixtures/formal-optional-capabilities/candidate';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../fixtures/test-filesystem';

const gated =
  process.env.KITE_RUN_UNIFIED_KEYRING_SMOKE === '1' && process.env.GITHUB_ACTIONS === 'true';

async function removeWrappingKey(
  built: Awaited<ReturnType<typeof candidate>>,
  home: string,
  identityPath: string,
) {
  const metadataPath = join(home, '.kite-code', 'model-credentials', 'key');
  if (!existsSync(metadataPath)) return;
  const metadata = readFileSync(metadataPath, 'utf8');
  const keyId = /^1:(?:pending|ready):([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/u.exec(
    metadata,
  )?.[1];
  if (!keyId) throw Error('credential_key_identity_invalid');
  writeFileSync(
    identityPath,
    JSON.stringify({
      service: 'kite-agent',
      namespace: 'model-vault',
      reference: { id: `credential:${keyId}`, persistence: 'os' },
    }),
    { mode: 0o600 },
  );
  const cleanup = await probe(built, 'remove', home, identityPath, true);
  expect(cleanup.exit).toBe(0);
  const missing = await probe(built, 'missing', home, identityPath, true);
  expect(missing.exit).toBe(0);
}

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
  'native credential storage and the bundled encrypted model vault survive independent processes and revoke the exact reference',
  async () => {
    const root = temporaryDirectory('kite-unified-keyring-'),
      home = join(root, 'home');
    privateDirectory(home);
    const userConfiguration = ownedUserConfiguration(home);
    const keychain = join(home, 'Library', 'Keychains', 'login.keychain-db');
    const security = (args: string[]) =>
      execFileSync('/usr/bin/security', args, {
        env: { ...userConfiguration.homeEnvironment, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim();
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    privateDirectory(profile.profilePath);
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
      opaqueRef: string | undefined,
      keychainCreated = false;
    let namespaceRemoved = false;
    let requests = 0;
    const provider = await serveFixture({
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
      if (process.platform === 'darwin') {
        privateDirectory(join(home, 'Library', 'Keychains'));
        security(['create-keychain', '-p', randomUUID(), keychain]);
        keychainCreated = true;
        expect(JSON.parse(security(['default-keychain', '-d', 'user']))).toBe(keychain);
      }
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
      const launch = (instanceId: string) =>
        launchPairedService({
          profile,
          entrypoint: join(b.root, b.manifest.entries.service),
          executable: join(b.root, b.manifest.entries.runtime),
          instanceId,
          buildId: `terminal-${b.digest}`,
          apiMajor: 1,
          spawnChild: userConfiguration.spawnChild,
          runtimeProtection: { kind: 'terminal.candidate', root: b.root, manifestSha256: b.digest },
          requiredCapabilities: [
            'configuration_management',
            'sessions',
            'commands',
            'permission_controls',
          ],
        });
      service = await launch('native-vault-write');
      const storeId = service.bootstrap.storeId!;
      let client = service.client;
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
        userConfiguration.path,
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
      const credentialFiles = join(home, '.kite-code', 'model-credentials');
      const record = `${reference.slice('credential:'.length)}.credential`;
      expect(readdirSync(credentialFiles)).toContain(record);
      const stored = readFileSync(join(credentialFiles, record));
      expect(stored.length).toBeGreaterThan(Buffer.byteLength(secret));
      expect(stored.includes(secret)).toBe(false);
      expect(readFileSync(userConfiguration.path, 'utf8')).not.toContain(secret);

      await service.close();
      service = undefined;
      service = await launch('native-vault-read');
      expect(service.bootstrap.storeId).toBe(storeId);
      client = service.client;
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
        await fixtureDelay(10);
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
      await service.close();
      service = undefined;
      service = await launch('native-vault-revoked');
      expect(service.bootstrap.storeId).toBe(storeId);
      client = service.client;
      const rejected = await client.startRun('s', {
        kind: 'run.start',
        expectedStoreId: storeId,
        commandId: 'after-revoke',
        content: 'A revoked key must not be sent',
      });
      const rejectionDeadline = Date.now() + 5000;
      let decision = rejected;
      while (decision.status === 'accepted') {
        if (Date.now() > rejectionDeadline) throw Error('credential_revocation_deadline');
        await fixtureDelay(10);
        decision = await client.getCommand('after-revoke');
      }
      expect(decision).toMatchObject({
        status: 'rejected',
        receipt: { reason: 'credential_unavailable' },
      });
      expect(requests).toBe(1);
      expect(JSON.stringify(service.diagnostics)).not.toContain(secret);
      console.log(
        JSON.stringify({
          platform: process.platform,
          arch: process.arch,
          terminalDigest: b.digest,
          nativeRoundtrip: true,
          defaultPublicCredential: true,
          persistedAcrossRestart: true,
          revokedAcrossRestart: true,
          provider: requests,
        }),
      );
    } finally {
      try {
        try {
          if (service && opaqueRef)
            await service.client.revokeCredential(opaqueRef, {
              expectedStoreId: service.bootstrap.storeId!,
              commandId: 'cleanup-revoke',
            });
        } finally {
          await service?.close();
        }
      } finally {
        try {
          await provider.stop(true);
          if (keychainCreated) security(['delete-keychain', keychain]);
          else if (built) {
            const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
            if (identity.reference && !namespaceRemoved) {
              const cleanup = await probe(built, 'remove', home, identityPath, true);
              expect(cleanup.exit).toBe(0);
            }
            await removeWrappingKey(built, home, identityPath);
          }
        } finally {
          removeTemporaryDirectory(root);
        }
      }
    }
  },
  120000,
);

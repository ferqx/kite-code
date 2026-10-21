import { strict as assert } from 'node:assert';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { createClient } from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';
import type { TuiMcpIntent } from '@kite-ai/ui/tui';
import type { CLIServiceArtifact } from '../../host';
import { createMcpSelectionRecord } from '../../host/mcp-selection-intents';
import { openMcpSelectionJournal } from '../../host/mcp-selection-journal';
import { createTuiMcpPort } from '../../host/tui-mcp';

const settings = JSON.parse(readFileSync(join(import.meta.dir, 'settings.json'), 'utf8')) as {
  root: string;
  dataRoot: string;
  mcpUrl: string;
  artifact: CLIServiceArtifact;
  endpoint: string;
  token: string;
  intent: TuiMcpIntent;
  mode: 'prepared' | 'post' | 'lookup' | 'paired';
  seed?: { storeId: string; subjectId: string };
};
if (process.argv[2] === 'seed-controls') {
  // This isolated artifact prepares current controls while the tested Service is stopped.
  const { createRuntime } = await import('@kite-ai/agent');
  const { openSqliteStore } = await import('@kite-ai/agent/sqlite');
  const { createDefaultProcessConfiguration } = await import('@kite-ai/service/configuration');
  const profile = selectProfile({ dataRoot: settings.dataRoot, profile: 'owned' });
  assert.ok(settings.seed);
  const store = await openSqliteStore(profile);
  const runtime = createRuntime({
    store,
    permissions: {
      async authorize() {
        throw Error('seed_must_not_execute');
      },
    },
  });
  try {
    assert.equal((await store.getMetadata()).storeId, settings.seed.storeId);
    const executions = await store.listExecutions('s');
    assert.equal(executions.length, 0);
    const configuration = createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: join(profile.profilePath, 'config.jsonc'),
      credentialBackend: {
        kind: 'temporary',
        async put() {
          throw Error('seed_credential_forbidden');
        },
        async resolve() {
          throw Error('seed_credential_forbidden');
        },
        async remove() {
          throw Error('seed_credential_forbidden');
        },
      },
    });
    const controls = configuration.permissionManagement!(runtime);
    const identity = { expectedStoreId: settings.seed.storeId, subjectId: settings.seed.subjectId };
    const mode = await controls.readMode({ ...identity, sessionId: 's' });
    assert.equal(
      (
        await controls.setMode({
          ...identity,
          sessionId: 's',
          commandId: 'fixture-current-mode',
          mode: 'full',
          makeDefault: false,
          ifRevision: mode.revision,
          ifDefaultRevision: mode.defaultRevision,
        })
      ).state,
      'applied',
    );
    const trust = await controls.readTrust({ ...identity, workspaceId: 'w' });
    assert.equal(
      (
        await controls.setTrust({
          ...identity,
          workspaceId: 'w',
          commandId: 'fixture-current-trust',
          trusted: true,
          ifRevision: trust.revision,
          canonicalIdentity: trust.canonicalIdentity,
          externalReadScopeDigest: trust.externalReadScopeDigest,
        })
      ).state,
      'applied',
    );
    const [modeControl, trustControl] = await Promise.all([
      store.readHostControl({ ...identity, kind: 'permission.mode', scope: 'session:s' }),
      store.readHostControl({ ...identity, kind: 'workspace.trust', scope: 'workspace:w' }),
    ]);
    const currentMode = await controls.readMode({ ...identity, sessionId: 's' });
    const currentTrust = await controls.readTrust({ ...identity, workspaceId: 'w' });
    assert.equal(modeControl.record?.id, 'fixture-current-mode');
    assert.equal(modeControl.record?.state, 'applied');
    assert.equal(trustControl.record?.id, 'fixture-current-trust');
    assert.equal(trustControl.record?.state, 'applied');
    assert.ok(BigInt(modeControl.revision) > BigInt(mode.revision));
    assert.ok(BigInt(trustControl.revision) > BigInt(trust.revision));
    assert.equal(currentMode.mode, 'full');
    assert.equal(currentMode.scopeSessionId, 's');
    assert.equal(currentMode.revision, modeControl.revision);
    assert.equal(currentMode.defaultRevision, mode.defaultRevision);
    assert.equal(currentTrust.trusted, true);
    assert.equal(currentTrust.revision, trustControl.revision);
    assert.equal(currentTrust.canonicalIdentity, trust.canonicalIdentity);
    assert.equal(currentTrust.externalReadScopeDigest, trust.externalReadScopeDigest);
    assert.deepEqual(await store.listExecutions('s'), executions);
    console.log(
      JSON.stringify({
        storeId: settings.seed.storeId,
        subjectId: settings.seed.subjectId,
        mode: currentMode,
        trust: currentTrust,
        executions: executions.length,
      }),
    );
  } finally {
    await runtime.close();
    await store.close();
  }
} else if (process.argv[2] !== 'caller') {
  const { runServiceProcess } = await import('@kite-ai/service/main');
  const { createDefaultProcessConfiguration } = await import('@kite-ai/service/configuration');
  const { createMcpHttpTransportPort } = await import('@kite-ai/service/mcp-http-port');
  await runServiceProcess({
    configure(startup) {
      return createDefaultProcessConfiguration({
        userConfigurationPath: selectProfile(startup.profile).profilePath + '/config.jsonc',
        profile: selectProfile(startup.profile),
        hostConfiguration: startup.hostConfiguration,
        permissions: {
          async authorize() {
            return { allowed: true, revision: 'explicit-owned-selection-policy' };
          },
        },
        credentialBackend: {
          kind: 'temporary',
          async put() {
            appendFileSync(join(settings.root, 'credential-io'), 'put\n');
            throw Error('forbidden');
          },
          async resolve() {
            appendFileSync(join(settings.root, 'credential-io'), 'resolve\n');
            throw Error('forbidden');
          },
          async remove() {
            appendFileSync(join(settings.root, 'credential-io'), 'remove\n');
            throw Error('forbidden');
          },
        },
        mcp: {
          servers: [{ id: 'owned-server', transport: { type: 'http', url: settings.mcpUrl } }],
          transportPort: createMcpHttpTransportPort({
            servers: [{ id: 'owned-server', url: settings.mcpUrl }],
            allowLoopbackForTests: true,
            async admit() {
              appendFileSync(join(settings.root, 'mcp-admit'), 'admit\n');
              throw Error('forbidden');
            },
          }),
        },
      });
    },
  });
} else {
  appendFileSync(join(settings.root, 'caller-startup'), `${process.pid} role ${settings.mode}\n`);
  const access = acquireProfileAccess({ dataRoot: settings.dataRoot, profile: 'owned' });
  const journal = openMcpSelectionJournal({
    access,
    acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
  });
  let paired: Awaited<ReturnType<typeof launchPairedService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  try {
    if (settings.mode === 'paired') {
      paired = await launchPairedService({
        profile: selectProfile({ dataRoot: settings.dataRoot, profile: 'owned' }),
        ...settings.artifact,
        instanceId: crypto.randomUUID(),
        requiredCapabilities: ['sessions', 'commands'],
      });
      client = paired.client;
      writeFileSync(join(settings.root, 'paired-service-pid'), String(paired.pid));
    } else {
      client = createClient({
        endpoint: settings.endpoint,
        token: settings.token,
        expected: {
          profile: {
            dataRoot: access.dataRoot,
            name: access.profile,
            accessKey: access.profileAccessKey,
          },
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'commands'],
        },
      });
      appendFileSync(join(settings.root, 'caller-startup'), `${process.pid} before connect\n`);
      await client.connect();
      appendFileSync(join(settings.root, 'caller-startup'), `${process.pid} connected\n`);
    }
    const actual = globalThis.fetch;
    globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
      const url = new URL(String(args[0]));
      appendFileSync(
        join(settings.root, 'caller-http.jsonl'),
        JSON.stringify({ pid: process.pid, method: args[1]?.method ?? 'GET', path: url.pathname }) +
          '\n',
      );
      return actual(...args);
    }, actual);
    const port = createTuiMcpPort(client, settings.intent.request.expectedStoreId, journal);
    if (settings.mode === 'prepared' || settings.mode === 'paired') {
      journal.prepare(createMcpSelectionRecord(settings.intent, client.serverInfo!.subjectId!));
      writeFileSync(
        join(settings.root, 'caller-stage'),
        JSON.stringify({ stage: 'prepared', pid: process.pid }),
      );
    } else if (settings.mode === 'post') {
      const result = await port.submit(settings.intent);
      writeFileSync(
        join(settings.root, 'caller-stage'),
        JSON.stringify({ stage: 'post', pid: process.pid, phase: result.phase }),
      );
    } else {
      const rows = await port.list!();
      const original = rows.find(
        (row) => row.intent.request.commandId === settings.intent.request.commandId,
      );
      if (!original) throw Error('original_missing');
      const result = await port.lookup(original.intent, new AbortController().signal);
      writeFileSync(join(settings.root, 'cold-result.json'), JSON.stringify(result));
      process.exitCode = 0;
    }
    if (settings.mode !== 'lookup')
      await new Promise(() => {
        setInterval(() => {}, 1000);
      });
  } finally {
    client?.disposeNetwork();
    await paired?.close();
    journal.close();
    access.lock.release();
  }
}

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
};
if (process.argv[2] !== 'caller') {
  const { runServiceProcess } = await import('@kite-ai/service/main');
  const { createDefaultProcessConfiguration } = await import('@kite-ai/service/configuration');
  const { createMcpHttpTransportPort } = await import('@kite-ai/service/mcp-http-port');
  await runServiceProcess({
    configure(startup) {
      return createDefaultProcessConfiguration({
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

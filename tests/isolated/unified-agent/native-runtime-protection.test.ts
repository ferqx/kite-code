import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { launchPairedService } from '@kite-ai/service/paired';
import { terminalSqliteEngineRoot } from '@kite-ai/service/sqlite-release-assets';
import { buildNativeCandidate } from '../../../apps/desktop/scripts/build-native';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Message = { role: string; content: string };
function receiptRunId(receipt: unknown): string | null {
  return receipt &&
    typeof receipt === 'object' &&
    !Array.isArray(receipt) &&
    'runId' in receipt &&
    typeof receipt.runId === 'string'
    ? receipt.runId
    : null;
}
test.skipIf(process.platform !== 'darwin')(
  'actual Native default paired proof protects outer and inner assets inside the Workspace while ordinary neighboring Files work and cold reads do not repeat effects',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-runtime-protection-')),
      home = join(root, 'home');
    mkdirSync(home, { mode: 0o700 });
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    let service: Awaited<ReturnType<typeof launchPairedService>> | undefined,
      reader: Awaited<ReturnType<typeof openSqliteStore>> | undefined,
      provider: ReturnType<typeof Bun.serve> | undefined;
    const requests: Message[][] = [];
    const coldAssets: ReturnType<typeof acquireArtifactAccess>[] = [];
    try {
      const terminal = await buildTerminalBundle({ destination: join(root, 'terminal-build') });
      const electron = createRequire(
        resolve(import.meta.dir, '../../../apps/desktop/package.json'),
      )('electron') as string;
      const built = await buildNativeCandidate({
        terminalRoot: terminal.root,
        electronDist: resolve(dirname(electron), '../../..'),
        outdir: join(root, 'native'),
      });
      rmSync(terminal.root, { recursive: true, force: true });
      const protectedPaths = [
        built.manifest.entries.renderer,
        built.manifest.entries.artifactHelper,
        built.manifest.entries.electron,
        'electron/Electron.app/Contents/Resources/default_app.asar',
        'terminal/node_modules/@kite-ai/agent/storage/worker/main.js',
        `terminal/${built.terminal.manifest.entries.service}`,
      ].map((path) => join(built.root, path));
      const originals = new Map(protectedPaths.map((path) => [path, readFileSync(path)]));
      const manifests = new Map(
        [
          join(built.root, 'native-manifest.json'),
          join(built.terminal.root, 'terminal-manifest.json'),
        ].map((path) => [path, readFileSync(path)]),
      );
      const paths = protectedPaths.map((path) => relative(root, path));
      expect(paths.every((path) => !path.startsWith('../'))).toBe(true);
      const calls = [
        {
          name: 'files.write',
          input: { path: 'neighbor.txt', base: null, content: '实际邻居 UTF8 😀\r\n' },
        },
        { name: 'files.read', input: { path: 'neighbor.txt' } },
        ...paths.flatMap((path) => [
          { name: 'files.read', input: { path } },
          { name: 'files.write', input: { path, base: null, content: 'MUST NEVER REPLACE ASSET' } },
        ]),
      ];
      provider = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as { messages: Message[] };
          requests.push(body.messages);
          const call = calls[requests.length - 1];
          const frame = (delta: unknown, finish_reason: string | null) =>
            `data: ${JSON.stringify({ id: `native-protection-${requests.length}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
          const delta = call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${requests.length}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  },
                ],
              }
            : { content: 'NATIVE RUNTIME PROTECTION COMPLETE' };
          return new Response(
            `${frame(delta, null)}${frame({}, call ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      });
      const config = JSON.stringify({
        modelId: 'fixed',
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `${provider.url.href}v1`,
          },
        ],
        tools: [
          { id: 'files.read', definitionVersion: '3' },
          { id: 'files.write', definitionVersion: '2' },
        ],
      });
      writeFileSync(join(profile.profilePath, 'config.jsonc'), config, { mode: 0o600 });
      const free = () => {
        for (const path of [built.root, built.terminal.root])
          acquireArtifactAccess({ root: path, mode: 'exclusive' }).release();
      };
      const busy = () => {
        for (const path of [built.root, built.terminal.root])
          expect(() => acquireArtifactAccess({ root: path, mode: 'exclusive' })).toThrow(
            'Lock is busy',
          );
      };
      free();
      service = await launchPairedService({
        profile,
        entrypoint: join(built.terminal.root, built.terminal.manifest.entries.service),
        executable: join(built.terminal.root, built.terminal.manifest.entries.runtime),
        instanceId: 'native-runtime-protection',
        buildId: `native-${built.digest}`,
        apiMajor: 1,
        runtimeProtection: {
          kind: 'native.candidate',
          root: built.root,
          manifestSha256: built.digest,
        },
        requiredCapabilities: ['sessions', 'commands', 'history', 'permission_controls'],
      });
      const client = service.client,
        storeId = service.bootstrap.storeId!;
      busy();
      await client.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'Native candidate parent Workspace',
        rootUri: pathToFileURL(root).href,
      });
      await client.createSession({
        expectedStoreId: storeId,
        commandId: 'create-s',
        sessionId: 's',
        workspaceId: 'w',
        title: 'Actual protected root',
      });
      const trust = await client.getWorkspaceTrust('w', { storeId });
      await client.setWorkspaceTrust('w', {
        expectedStoreId: storeId,
        commandId: 'trust',
        canonicalIdentity: trust.canonicalIdentity,
        externalReadScopeDigest: trust.externalReadScopeDigest,
        trusted: true,
        ifRevision: trust.revision,
      });
      const mode = await client.getPermissionMode('s', { storeId });
      await client.setPermissionMode('s', {
        expectedStoreId: storeId,
        commandId: 'mode',
        mode: 'full',
        makeDefault: false,
        ifRevision: mode.revision,
        ifDefaultRevision: mode.defaultRevision,
      });
      await client.startRun('s', {
        kind: 'run.start',
        expectedStoreId: storeId,
        commandId: 'protected-work',
        content:
          'Read and write only the normal neighbor; report each protected asset refusal accurately.',
      });
      const deadline = Date.now() + 15000;
      let command = await client.getCommand('protected-work');
      let runId = receiptRunId(command.receipt),
        run = runId ? await client.getRun(runId) : null;
      while (!run || run.isActive) {
        if (Date.now() > deadline) throw Error('native_protection_run_deadline');
        await Bun.sleep(10);
        command = await client.getCommand('protected-work');
        runId = receiptRunId(command.receipt);
        run = runId ? await client.getRun(runId) : null;
      }
      expect(command.status).toBe('applied');
      expect(command.originStoreId).toBe(storeId);
      expect(run.status).toBe('completed');
      expect(run.originCommandId).toBe('protected-work');
      expect(run.originStoreId).toBe(storeId);
      expect(requests).toHaveLength(calls.length + 1);
      const toolMessages = requests.at(-1)!.filter((message) => message.role === 'tool');
      expect(toolMessages).toHaveLength(calls.length);
      expect(toolMessages[0]!.content).not.toContain('file_path_protected');
      expect(toolMessages[1]!.content).toContain('实际邻居');
      for (const message of toolMessages.slice(2))
        expect(message.content).toBe('file_path_protected');
      const view = await client.getView('s'),
        tools = view.executions.filter((execution) => execution.kind === 'tool');
      expect(tools).toHaveLength(calls.length);
      expect(tools.filter((execution) => execution.status === 'succeeded')).toHaveLength(2);
      expect(tools.filter((execution) => execution.status === 'failed')).toHaveLength(
        protectedPaths.length * 2,
      );
      for (const [path, bytes] of originals) expect(readFileSync(path)).toEqual(bytes);
      for (const [path, bytes] of manifests) expect(readFileSync(path)).toEqual(bytes);
      expect(readFileSync(join(root, 'neighbor.txt'), 'utf8')).toBe('实际邻居 UTF8 😀\r\n');
      expect(readFileSync(join(profile.profilePath, 'config.jsonc'), 'utf8')).toBe(config);
      const after = verifyNativeRuntimeBundle(built.root);
      expect(after.digest).toBe(built.digest);
      expect(after.terminal.digest).toBe(built.terminal.digest);
      busy();
      await service.close();
      service = undefined;
      free();
      // Cold source Store must use the same pinned engine as the candidate Service,
      // rather than the source host's unqualified embedded SQLite implementation.
      for (const candidate of [built.root, built.terminal.root])
        coldAssets.push(acquireArtifactAccess({ root: candidate, mode: 'shared' }));
      const coldEngine = initializeSqliteEngine({
        root: join(built.terminal.root, terminalSqliteEngineRoot),
        manifestSha256: built.terminal.manifest.sqlite.manifestSha256,
      });
      expect(coldEngine.version).toBe(built.terminal.manifest.sqlite.version);
      expect(coldEngine.sourceId).toBe(built.terminal.manifest.sqlite.sourceId);
      reader = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      const metadata = await reader.getMetadata(),
        coldCommand = await reader.getCommand(command.id),
        coldRun = await reader.getRun(run.id),
        coldTools = (await reader.listExecutions('s')).filter(
          (execution) => execution.kind === 'tool',
        );
      expect(coldCommand?.id).toBe(command.id);
      expect(coldCommand?.originStoreId).toBe(storeId);
      expect(coldCommand?.receipt).toEqual(command.receipt);
      expect(coldRun?.status).toBe('completed');
      expect(coldRun?.originCommandId).toBe(command.id);
      expect(
        coldTools.map((execution) => [execution.id, execution.definitionId, execution.status]),
      ).toEqual(tools.map((execution) => [execution.id, execution.definitionId, execution.status]));
      for (const execution of coldTools.filter((execution) => execution.status === 'failed'))
        expect(execution.result).toMatchObject({
          content: 'file_path_protected',
          details: { code: 'file_path_protected' },
        });
      const providerCount = requests.length;
      for (let i = 0; i < 2; i++) {
        await reader.getCommand(command.id);
        await reader.getRun(run.id);
        await reader.getView('s');
      }
      expect((await reader.getMetadata()).lastChangeCursor).toBe(metadata.lastChangeCursor);
      expect(requests.length).toBe(providerCount);
      expect(readFileSync(join(root, 'neighbor.txt'), 'utf8')).toBe('实际邻居 UTF8 😀\r\n');
      for (const [path, bytes] of originals) expect(hash(readFileSync(path))).toBe(hash(bytes));
      console.log(
        JSON.stringify({
          nativeDigest: built.digest,
          terminalDigest: built.terminal.digest,
          storeId,
          commandId: command.id,
          runId: run.id,
          provider: providerCount,
          protected: paths.map((path) => ({
            path,
            read: 'file_path_protected',
            write: 'file_path_protected',
            hash: hash(originals.get(join(root, path))!),
          })),
          cursor: metadata.lastChangeCursor,
          coldReadonly: true,
          coldEngine: {
            version: coldEngine.version,
            sourceId: coldEngine.sourceId,
            manifestSha256: coldEngine.selection.manifestSha256,
          },
          platform: process.platform,
          arch: process.arch,
        }),
      );
    } finally {
      if (reader) await reader.close();
      if (service) await service.close();
      for (const access of coldAssets.reverse()) access.release();
      provider?.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);

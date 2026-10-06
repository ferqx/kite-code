import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
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
import { pathToFileURL } from 'node:url';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { buildNativeCandidate } from '../../scripts/build-native';
import type { NativeMcpSubmission } from '../../src/native-bridge';

const require = createRequire(import.meta.url);
test.skipIf(process.platform !== 'darwin')(
  'source-free relocated trusted-loopback Native MCP formal window source operations, independent reviews, immutable tools and cold original GET',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-mcp-bundle-')),
      home = join(root, 'home'),
      moved = join(root, 'relocated');
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(join(home, 'workspace'));
    mkdirSync(join(home, 'workspace', '.kite-code'), { mode: 0o700 });
    const profile = selectProfile({
        dataRoot: join(home, '.kite-code/unified-agent'),
        profile: 'default',
      }),
      wire: Record<string, unknown>[] = [];
    let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined,
      server: ReturnType<typeof Bun.serve> | undefined,
      completed = false;
    let out: Promise<string> | undefined, err: Promise<string> | undefined;
    let cleanupUnconfirmed = false,
      failure: unknown;
    const leases: ReturnType<typeof acquireArtifactAccess>[] = [];
    const candidatePaths: string[] = [];
    const backendOptions = {
      service: 'kite-agent',
      accountNamespace: `profile-${profile.profileAccessKey}`,
    };
    const credential = { id: `credential:${crypto.randomUUID()}`, persistence: 'os' as const };
    const cleanupFailures: unknown[] = [];
    let credentialAttempted = false;
    let credentialHost:
      | ((operation: 'put' | 'remove' | 'absence') => { freshAbsent?: boolean })
      | undefined;
    try {
      const { buildTerminalBundle } = await import(
        resolve(import.meta.dir, '../../../../scripts/release/terminal-bundle.ts')
      );
      const terminal = await buildTerminalBundle({
        destination: join(root, 'terminal-build'),
        processHostFixture: 'native-mcp-loopback',
      });
      const built = await buildNativeCandidate({
        terminalRoot: terminal.root,
        electronDist: resolve(dirname(dirname(require('electron') as string)), '../..'),
        outdir: join(root, 'source'),
      });
      renameSync(join(root, 'source'), moved);
      rmSync(terminal.root, { recursive: true, force: true });
      expect(verifyNativeRuntimeBundle(moved).digest).toBe(built.digest);
      const candidate = verifyNativeRuntimeBundle(moved);
      leases.push(
        acquireArtifactAccess({ root: moved, mode: 'shared' }),
        acquireArtifactAccess({ root: candidate.terminal.root, mode: 'shared' }),
      );
      candidatePaths.push(moved, candidate.terminal.root);
      // Match launchPairedService's finite environment. The isolated parent HOME
      // has no default OS keychain; neither parent nor Native driver HOME changes.
      const credentialHelper = join(root, 'owned-credential-host.mjs');
      writeFileSync(
        credentialHelper,
        `import {createOsCredentialBackend} from ${JSON.stringify(pathToFileURL(join(candidate.terminal.root, 'node_modules/@kite-ai/agent/config/index.js')).href)};
const backend=createOsCredentialBackend(${JSON.stringify(backendOptions)});
const id=${JSON.stringify(credential.id)};
const operation=process.argv[2];
if(operation==='put') { await backend.put(id,'owned-native-mcp-synthetic-not-paid'); console.log(JSON.stringify({persistence:backend.kind})); }
else if(operation==='remove') { await backend.remove(id); console.log(JSON.stringify({removed:true})); }
else if(operation==='absence') { console.log(JSON.stringify({freshAbsent:(await backend.resolve(id))===null})); }
else throw Error('owned_credential_operation_invalid');
`,
        { mode: 0o600 },
      );
      credentialHost = (operation) => {
        try {
          const stdout = String(
            execFileSync(
              join(candidate.terminal.root, 'runtime/bun'),
              [credentialHelper, operation],
              {
                cwd: home,
                env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
                timeout: 30000,
                encoding: 'utf8',
              },
            ),
          );
          writeFileSync(join(root, `credential-${operation}.log`), stdout);
          return JSON.parse(stdout);
        } catch (cause) {
          const error = cause as { stdout?: unknown; stderr?: unknown; message?: string };
          writeFileSync(
            join(root, `credential-${operation}.log`),
            JSON.stringify({
              message: error.message,
              stdout: String(error.stdout ?? ''),
              stderr: String(error.stderr ?? ''),
            }),
          );
          throw cause;
        }
      };
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
          name: 'MCP',
          rootUri: new URL(`file://${join(home, 'workspace')}`).href,
        });
        await seed.createSession({
          expectedStoreId: storeId,
          subjectId: 'local-user',
          commandId: 'create-mcp',
          sessionId: 'mcp-window',
          workspaceId: 'w',
          title: 'MCP Window',
        });
      } finally {
        await seed.close();
      }
      const description = `${'完整Unicode原始工具说明'.repeat(8000)}UNICODE_FULL_TAIL`,
        tools = [
          {
            name: 'owned_effect',
            description,
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              properties: { value: { type: 'string' } },
              required: ['value'],
            },
          },
        ];
      writeFileSync(join(home, 'stdio-effects'), '');
      writeFileSync(
        join(home, 'mcp-stdio'),
        `#!/usr/bin/python3\n# coding: utf-8\nimport sys,json\nTOOLS=json.loads(${JSON.stringify(JSON.stringify(tools))})\nfor line in sys.stdin:\n try:\n  r=json.loads(line)\n  with open(${JSON.stringify(join(home, 'stdio-wire.jsonl'))},'a') as f: f.write(json.dumps(r)+'\\n')\n  if 'id' not in r: continue\n  m=r.get('method')\n  result={'protocolVersion':'2025-03-26','capabilities':{'tools':{}},'serverInfo':{'name':'owned-window-stdio','version':'1'}} if m=='initialize' else {'tools':TOOLS} if m=='tools/list' else {'content':[{'type':'text','text':'effect saved'}]} if m=='tools/call' else {}\n  if m=='tools/call':\n   with open(${JSON.stringify(join(home, 'stdio-effects'))},'a') as f: f.write(json.dumps(r)+'\\n')\n  print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':result}),flush=True)\n except Exception as e:\n  print(str(e),file=sys.stderr)\n`,
        { mode: 0o700 },
      );
      server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname === '/count') return new Response(String(wire.length));
          if (request.method === 'GET' || request.method === 'DELETE')
            return new Response(null, { status: 405 });
          if (new URL(request.url).pathname === '/model/v1/chat/completions') {
            const body = await request.json();
            wire.push({ kind: 'model', body });
            const remote = body.tools?.find(
              (value: {
                function: {
                  name: string;
                  parameters: { properties?: { value?: { type?: string } } };
                };
              }) =>
                value.function.name.startsWith('mcp.mcp-') &&
                value.function.parameters?.properties?.value?.type === 'string',
            );
            if (!remote?.function.parameters?.required?.includes('value'))
              return Response.json(
                { error: 'owned_registered_tool_schema_missing' },
                { status: 422 },
              );
            const done = body.messages.some((value: { role: string }) => value.role === 'tool');
            const delta = done
              ? { content: 'Owned MCP effect confirmed' }
              : {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'owned-mcp-call',
                      type: 'function',
                      function: {
                        name: remote.function.name,
                        arguments: JSON.stringify({ value: 'EXACT_OWNED_EFFECT' }),
                      },
                    },
                  ],
                };
            const frame = (delta: unknown, finish_reason: string | null) =>
              `data: ${JSON.stringify({ id: 'owned-model', object: 'chat.completion.chunk', model: 'owned-mcp-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
            return new Response(
              `${frame(delta, null)}${frame({}, done ? 'stop' : 'tool_calls')}data: [DONE]\n\n`,
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }
          const row = await request.json();
          wire.push(row);
          if (!Object.hasOwn(row, 'id')) return new Response(null, { status: 202 });
          const result =
            row.method === 'initialize'
              ? {
                  protocolVersion: '2025-03-26',
                  capabilities: { tools: {} },
                  serverInfo: { name: 'owned-window-http', version: '1' },
                }
              : row.method === 'tools/list'
                ? { tools }
                : row.method === 'tools/call'
                  ? { content: [{ type: 'text', text: 'owned effect' }] }
                  : {};
          return Response.json({ jsonrpc: '2.0', id: row.id, result });
        },
      });
      writeFileSync(join(profile.profilePath, 'config.jsonc'), JSON.stringify({ models: [] }));
      // Persist the exact owned identity before writing, including failed/partial puts.
      writeFileSync(
        join(root, 'credential-owned.json'),
        JSON.stringify({ ...backendOptions, ...credential }),
        { mode: 0o600 },
      );
      credentialAttempted = true;
      const prepared = credentialHost('put') as { persistence: string };
      expect(prepared.persistence).toBe('os');
      writeFileSync(
        join(profile.profilePath, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            'window-manual': {
              type: 'http',
              url: `${server.url.href.replace(/\/$/, '')}/mcp`,
              auth: { type: 'credential', profile: 'owned-manual', credentialRef: credential.id },
            },
          },
        }),
        {
          mode: 0o600,
        },
      );
      writeFileSync(
        join(home, 'workspace', '.kite-code', 'mcp.json'),
        JSON.stringify({ mcpServers: {} }),
        { mode: 0o600 },
      );
      const fixture = join(root, 'driver.ts');
      writeFileSync(
        fixture,
        readFileSync(resolve(import.meta.dir, '../native-mcp-electron.fixture.ts'), 'utf8').replace(
          "import { _electron } from 'playwright';",
          `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../../package.json'))})('playwright');`,
        ),
      );
      expect(
        (
          await Bun.build({
            entrypoints: [fixture],
            target: 'node',
            format: 'esm',
            packages: 'external',
            outdir: root,
            naming: 'driver.js',
          })
        ).success,
      ).toBe(true);
      writeFileSync(
        join(root, 'candidate-evidence.json'),
        JSON.stringify({
          nativeDigest: built.digest,
          terminalDigest: candidate.terminal.digest,
          sourceFree: true,
          defaultVault: true,
          processHostFixture: 'native-mcp-loopback',
          productionDefaultNetwork: false,
          home,
          storeId: storeId!,
        }),
      );
      driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'driver.js'),
          moved,
          home,
          server.url.href.replace(/\/$/, ''),
          storeId!,
        ],
        {
          cwd: home,
          env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      out = new Response(driver.stdout).text();
      err = new Response(driver.stderr).text();
      const timer = setTimeout(() => driver!.kill('SIGKILL'), 150000);
      try {
        const code = await driver.exited,
          stdout = await out,
          stderr = await err;
        writeFileSync(join(root, 'driver.stdout.log'), stdout);
        writeFileSync(join(root, 'driver.stderr.log'), stderr);
        writeFileSync(join(root, 'http-wire.json'), JSON.stringify(wire));
        console.log(stdout);
        if (code) console.error({ root, stderr, wire });
        expect(code).toBe(0);
      } finally {
        clearTimeout(timer);
      }
      const report = JSON.parse(readFileSync(join(home, 'mcp-report.json'), 'utf8')) as {
        pids: number[];
        persisted: { version: number };
        submissions: NativeMcpSubmission[];
        after: { method: string }[];
      };
      for (const pid of report.pids) expect(() => process.kill(pid, 0)).toThrow();
      expect(report.persisted.version).toBe(7);
      expect(
        report.submissions.some(
          (row) =>
            row.actionId === 'mcp.reconnect' &&
            row.fact &&
            'oldStop' in row.fact &&
            row.fact.oldStop.confirmed,
        ),
      ).toBe(true);
      expect(report.after.filter((row) => row.method === 'POST')).toHaveLength(0);
      expect(wire.some((row) => row.method === 'initialize')).toBe(true);
      const models = wire.filter((value) => value.kind === 'model') as {
        body: {
          tools: {
            function: {
              name: string;
              parameters: { required?: string[]; properties?: { value?: { type?: string } } };
            };
          }[];
        };
      }[];
      expect(models).toHaveLength(2);
      for (const model of models)
        expect(
          model.body.tools.find(
            (value) =>
              value.function.name.startsWith('mcp.mcp-') &&
              value.function.parameters.properties?.value?.type === 'string',
          )?.function.parameters.required,
        ).toEqual(['value']);
      const stdioWire = readFileSync(join(home, 'stdio-wire.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(stdioWire.filter((row) => row.method === 'initialize').length).toBeGreaterThanOrEqual(
        2,
      );
      expect(stdioWire.some((row) => row.method === 'tools/list')).toBe(true);
      const effects = readFileSync(join(home, 'stdio-effects'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(effects).toHaveLength(1);
      expect(effects[0].params).toEqual({
        name: 'owned_effect',
        arguments: { value: 'EXACT_OWNED_EFFECT' },
      });
      console.log(
        JSON.stringify({
          root,
          nativeDigest: built.digest,
          terminalDigest: candidate.terminal.digest,
          sourceFree: true,
          defaultVault: true,
          processHostFixture: 'native-mcp-loopback',
          productionDefaultNetwork: false,
          ownedServicePids: report.pids,
        }),
      );
      completed = true;
    } catch (cause) {
      failure = cause;
    } finally {
      if (driver && driver.exitCode === null) {
        driver.kill('SIGKILL');
        await driver.exited;
      }
      if (out) writeFileSync(join(root, 'driver.stdout.log'), await out);
      if (err) writeFileSync(join(root, 'driver.stderr.log'), await err);
      writeFileSync(join(root, 'http-wire.json'), JSON.stringify(wire));
      if (driver) {
        const readRows = () =>
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
        const rows = readRows();
        const originalIdentity = new Map(rows.map((row) => [row.pid, row.command]));
        const owned = new Set(
          rows.filter((row) => row.command.startsWith(`${moved}/`)).map((row) => row.pid),
        );
        for (let count = 0; count < rows.length; count++)
          for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
        for (const pid of owned)
          try {
            process.kill(pid, 'SIGTERM');
          } catch {}
        const until = Date.now() + 2000;
        while (
          Date.now() < until &&
          [...owned].some((pid) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          })
        )
          await Bun.sleep(20);
        const forced: number[] = [];
        for (const pid of owned)
          try {
            process.kill(pid, 0);
            process.kill(pid, 'SIGKILL');
            forced.push(pid);
          } catch {}
        const remainingOwned = () => {
          const current = readRows(),
            targets = new Set(
              current
                .filter(
                  (row) =>
                    row.command.startsWith(`${moved}/`) ||
                    (owned.has(row.pid) && originalIdentity.get(row.pid) === row.command),
                )
                .map((row) => row.pid),
            );
          for (let count = 0; count < current.length; count++)
            for (const row of current) if (targets.has(row.parent)) targets.add(row.pid);
          return [...targets];
        };
        const disappearanceDeadline = Date.now() + 5000;
        let remaining = remainingOwned();
        while (remaining.length && Date.now() < disappearanceDeadline) {
          await Bun.sleep(50);
          remaining = remainingOwned();
        }
        cleanupUnconfirmed = remaining.length > 0;
        const cleanup = { observed: [...owned], forced, remaining, confirmed: !cleanupUnconfirmed };
        writeFileSync(join(root, 'owned-cleanup.json'), JSON.stringify(cleanup));
        console.log(JSON.stringify({ stage: 'owned_process_tree_cleanup', root, ...cleanup }));
      }
      server?.stop(true);
      if (credentialAttempted && credentialHost) {
        let freshAbsent = false;
        try {
          credentialHost('remove');
        } catch (cause) {
          cleanupFailures.push(cause);
        }
        try {
          // A separate process and fresh default backend prove absence of this ID only.
          freshAbsent = credentialHost('absence').freshAbsent === true;
          expect(freshAbsent).toBe(true);
        } catch (cause) {
          cleanupFailures.push(cause);
        }
        writeFileSync(
          join(root, 'credential-cleanup.json'),
          JSON.stringify({
            defaultVault: true,
            freshAbsent,
            cleanupFailures: cleanupFailures.map(String),
          }),
        );
        console.log(
          JSON.stringify({ stage: 'exact_owned_default_vault_cleanup', root, freshAbsent }),
        );
      }

      for (const lease of leases.splice(0)) lease.release();
      if (completed) {
        for (const path of candidatePaths) {
          try {
            const exclusive = acquireArtifactAccess({ root: path, mode: 'exclusive' });
            exclusive.release();
          } catch (cause) {
            cleanupFailures.push(cause);
          }
        }
      }
      if (completed && !cleanupUnconfirmed && !cleanupFailures.length)
        rmSync(root, { recursive: true, force: true });
      else console.error('mcp_failed_candidate_retained', root);
    }
    if (cleanupUnconfirmed || cleanupFailures.length)
      throw new AggregateError(
        [
          failure,
          ...cleanupFailures,
          ...(cleanupUnconfirmed ? [Error(`native_owned_cleanup_unconfirmed:${root}`)] : []),
        ].filter(Boolean),
        'Native fixture cleanup failed',
      );
    if (failure) throw failure;
  },
  240000,
);

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createCredentialVault, createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import { expect, test } from '#kite-test';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import type { UserMcpSettingsOperation } from '../../src/http/schema/user-mcp';
import { createUserMcpManagement } from '../../src/user-mcp-management';

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-user-mcp-stdio-')));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'custom' });
  privateDirectory(profile.profilePath);
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const runtime = createRuntime({
    store,
    permissions: { authorize: async () => ({ allowed: false, revision: 'stdio-settings-only' }) },
  });
  const identity = { expectedStoreId: (await store.getMetadata()).storeId, subjectId: 'owner' };
  const path = join(profile.profilePath, 'mcp.json'),
    userConfigurationPath = join(profile.profilePath, 'config.jsonc');
  writeFileSync(path, '{"mcpServers":{}}');
  writeFileSync(userConfigurationPath, '{}');
  const manager = createUserMcpManagement({
    profile,
    runtime: () => runtime,
    credentialVault: createCredentialVault({ backend: createTemporaryCredentialBackend() }),
    userConfigurationPath,
    environment: (name) =>
      name === 'SERVICE_TOKEN' ? 'synthetic-stdio-private' : process.env[name],
    stdio: {
      guardianPath: fileURLToPath(
        new URL('../../../../packages/agent/dist/mcp/windows-stdio-guardian.js', import.meta.url),
      ),
      runtimeExecutable: process.execPath,
    },
  });
  let sequence = 0;
  async function mutate(operation: UserMcpSettingsOperation) {
    const commandId = `stdio-${++sequence}`,
      view = await manager.read(identity);
    let result = await manager.mutate({
      ...identity,
      commandId,
      expectedReadSet: view.readSet!,
      operation,
    });
    const deadline = Date.now() + 70000;
    while (result.state === 'pending') {
      if (Date.now() > deadline) throw Error('windows_mcp_stdio_deadline');
      await sleepTimer(20);
      result = await manager.lookup({ ...identity, commandId });
    }
    return result;
  }
  return {
    root,
    path,
    identity,
    manager,
    runtime,
    mutate,
    async close() {
      await manager.close();
      await runtime.close();
      if (realpathSync(root) !== root) throw Error('stdio_fixture_root_changed');
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test.skipIf(process.platform !== 'win32')(
  'Windows user STDIO preserves argv, cwd and explicit private environment through ready and disconnect',
  async () => {
    const f = await fixture();
    try {
      const script = join(f.root, 'probe.mjs');
      writeFileSync(
        script,
        `import readline from 'node:readline';
const rl=readline.createInterface({input:process.stdin});
rl.on('line',line=>{const message=JSON.parse(line);if(message.id===undefined)return;
const result=message.method==='initialize'?{protocolVersion:'2024-11-05',serverInfo:{name:'launch-probe',version:'1'},capabilities:{tools:{}}}:message.method==='tools/list'?{tools:[{name:'launch_probe',description:JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),literal:process.env.VISIBLE_VALUE,privatePresent:process.env.SERVICE_TOKEN==='synthetic-stdio-private'}),inputSchema:{type:'object'}}]}:{};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');});`,
      );
      expect(
        (
          await f.mutate({
            kind: 'add',
            name: 'probe',
            entry: {
              type: 'stdio',
              command: 'node',
              args: [script, 'two words', 'quote"value', '--flag=value'],
              env: { VISIBLE_VALUE: 'configured' },
              envPassthrough: ['SERVICE_TOKEN'],
              cwd: f.root,
            },
          })
        ).state,
      ).toBe('applied');
      const source = (await f.manager.read(f.identity)).sources[0]!;
      const connected = await f.mutate({ kind: 'connect', serverId: source.id });
      expect(connected).toMatchObject({
        state: 'applied',
        receipt: { connection: { state: 'ready' } },
      });
      const ready = (await f.manager.read(f.identity)).sources[0]!;
      const tools = await f.manager.tools({
        ...f.identity,
        serverId: source.id,
        generation: ready.connection.generation!,
      });
      expect(JSON.parse(ToolSchema.parse(tools.entries[0]!.descriptor).description!)).toEqual({
        args: ['two words', 'quote"value', '--flag=value'],
        cwd: f.root,
        literal: 'configured',
        privatePresent: true,
      });
      expect(readFileSync(f.path, 'utf8')).not.toContain('synthetic-stdio-private');
      expect((await f.mutate({ kind: 'disconnect', serverId: source.id })).state).toBe('applied');
      expect((await f.manager.read(f.identity)).sources[0]!.connection.state).toBe('disconnected');
    } finally {
      await f.close();
    }
  },
  90000,
);

test.skipIf(process.platform !== 'win32')(
  'Windows npx launcher connects the official memory MCP and releases its owned connection',
  async () => {
    const f = await fixture();
    try {
      const saved = await f.mutate({
        kind: 'add',
        name: 'server-memory',
        entry: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
          env: {
            MEMORY_FILE_PATH: join(f.root, 'memory.jsonl'),
            NPM_CONFIG_CACHE: join(f.root, 'npm-cache'),
          },
          cwd: f.root,
        },
      });
      expect(saved.state).toBe('applied');
      const declaration = JSON.parse(readFileSync(f.path, 'utf8')).mcpServers['server-memory'];
      expect(declaration.command).toMatch(/node\.exe$/i);
      expect(declaration.args.slice(-2)).toEqual(['-y', '@modelcontextprotocol/server-memory']);
      const source = (await f.manager.read(f.identity)).sources[0]!;
      const connected = await f.mutate({ kind: 'connect', serverId: source.id });
      expect(connected).toMatchObject({
        state: 'applied',
        receipt: { connection: { state: 'ready' } },
      });
      const ready = (await f.manager.read(f.identity)).sources[0]!;
      const tools = await f.manager.tools({
        ...f.identity,
        serverId: source.id,
        generation: ready.connection.generation!,
      });
      expect(tools.entries.map((row) => ToolSchema.parse(row.descriptor).name)).toContain(
        'read_graph',
      );
      expect((await f.mutate({ kind: 'disconnect', serverId: source.id })).state).toBe('applied');
      expect((await f.manager.read(f.identity)).sources[0]!.connection.state).toBe('disconnected');
    } finally {
      await f.close();
    }
  },
  90000,
);

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../../src/json';
import {
  createProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from '../../../src/maintenance';
import { verifyDesktopMcpRecord, verifyDesktopMcpRows } from '../../../src/maintenance/desktop-mcp';
import { selectProfile } from '../../../src/platform/profile';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage/types';
import { nodeConfigurationAssets } from './desktop-configurations-fixture';

const hash = 'a'.repeat(64);
const serverId = `mcp-${hash}`;
const reads = {
  scopeDigest: hash,
  user: {
    identity: { kind: 'user', pathDigest: hash, rootIdentity: hash },
    etag: hash,
    error: null,
  },
  workspace: null,
  approvalEtag: null,
  bindingEtag: null,
  variablesDigest: hash,
};
const target = {
  carrierExecutionId: 'carrier',
  carrierKey: 'old',
  operationRef: {
    commandId: 'initial',
    sessionId: 'session',
    originStoreId: 'store',
    extensionId: 'builtin.mcp',
    key: `connection/${serverId}/initialkey`,
    executionId: 'connection',
  },
  connectionExecutionId: 'connection',
  configDigest: hash,
  currentGeneration: 1,
};
const actions: [string, string, Record<string, unknown>][] = [
  [
    'builtin.mcp.management',
    'mcp.server.select',
    {
      serverId,
      enabled: true,
      scope: 'user',
      expectedReadSet: {
        userEtag: hash,
        workspaceEtag: null,
        explicitDigest: hash,
        registryDigest: hash,
        registryRevision: 'revision',
        scopeDigest: hash,
      },
    },
  ],
  ['builtin.mcp', 'mcp.connect', { serverId, key: 'old' }],
  [
    'builtin.mcp',
    'mcp.catalogue.refresh',
    {
      serverId,
      connectionKey: 'old',
      connectionExecutionId: 'connection',
      configDigest: hash,
      generation: 1,
    },
  ],
  [
    'builtin.mcp',
    'mcp.reconnect',
    { serverId, key: 'new', target, replacement: { kind: 'static', expectedConfigDigest: hash } },
  ],
  ...[
    'mcp.source.approve',
    'mcp.auth.login',
    'mcp.auth.refresh',
    'mcp.auth.clear',
    'mcp.auth.revoke',
  ].map(
    (action) =>
      ['builtin.mcp.sources', action, { serverId, expectedReadSet: reads }] as [
        string,
        string,
        Record<string, unknown>,
      ],
  ),
  [
    'builtin.mcp.sources',
    'mcp.credential.bind',
    { serverId, expectedReadSet: reads, expiresAt: 100 },
  ],
  [
    'builtin.mcp.sources',
    'mcp.source.add',
    {
      scope: 'user',
      name: 'Original',
      entry: { type: 'http', url: 'https://original.invalid/mcp' },
      expectedReadSet: reads,
    },
  ],
  [
    'builtin.mcp.sources',
    'mcp.source.remove',
    { scope: 'user', serverId, expectedRawEntryDigest: hash, expectedReadSet: reads },
  ],
];
const sha = (value: unknown) =>
  createHash('sha256')
    .update(canonicalJson(value as Json))
    .digest('hex');
function record(index: number, storeId = 'store') {
  const [extensionId, actionId, input] = structuredClone(actions[index]!);
  if (actionId === 'mcp.reconnect')
    (input.target as typeof target).operationRef.originStoreId = storeId;
  const request = {
    expectedStoreId: storeId,
    commandId: `original-${index}`,
    kind: 'extension.invoke',
    extensionId,
    actionId,
    definitionVersion: '1',
    input,
  };
  const { expectedStoreId: _s, commandId: _c, ...body } = request;
  const targetRequest: typeof request | null =
    actionId === 'mcp.reconnect'
      ? {
          ...request,
          commandId: 'previous-carrier',
          actionId: 'mcp.connect',
          input: { serverId, key: 'old' },
        }
      : null;
  return {
    version: 1,
    sessionId: 'session',
    workspaceId: 'workspace',
    workspaceIdentity: hash,
    subjectId: 'subject',
    request,
    targetRequest,
    bodySha256: sha(request),
    requestSha256: sha(body),
    phase: 'outcome_unknown',
  };
}
function dbRows(records: unknown[]) {
  const db = new Database(':memory:');
  db.run('CREATE TABLE mcp_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL)');
  for (let i = 0; i < records.length; i++)
    db.query('INSERT INTO mcp_intents VALUES (?,?)').run(
      `original-${i}`,
      JSON.stringify(records[i]),
    );
  return db;
}
test('frozen Native MCP grammar admits all twelve original actions and preserves a carrier distinct from initial connection Command', () => {
  expect(actions).toHaveLength(12);
  const values = actions.map((_, i) => record(i));
  const db = dbRows(values);
  try {
    expect(() => verifyDesktopMcpRows(db)).not.toThrow();
  } finally {
    db.close();
  }
  const chained = record(3);
  chained.targetRequest = {
    ...chained.request,
    commandId: 'previous-carrier',
    input: {
      ...chained.request.input,
      key: 'old',
      target: { ...target, carrierKey: 'older' },
      replacement: { kind: 'static', expectedConfigDigest: hash },
    },
  };
  expect(() => verifyDesktopMcpRecord(chained, 'original-3')).not.toThrow();
});
test('Native MCP rejects unknown fields, secrets, enum coercion, forged digests, prior history, mismatched PK and invalid original UTF8', () => {
  const changes = [
    (v: ReturnType<typeof record>) => {
      v.phase = ['pending'] as unknown as string;
    },
    (v: ReturnType<typeof record>) => {
      v.request.input.secret = 'forbidden';
    },
    (v: ReturnType<typeof record>) => {
      v.bodySha256 = 'b'.repeat(64);
    },
    (v: ReturnType<typeof record>) => {
      v.workspaceIdentity = 'path';
    },
    (v: ReturnType<typeof record>) => {
      v.targetRequest = v.request;
    },
    (v: ReturnType<typeof record>) => {
      v.request.definitionVersion = ['1'] as unknown as string;
    },
  ];
  for (const change of changes) {
    const v = record(1);
    change(v);
    expect(() => verifyDesktopMcpRecord(v, 'original-1')).toThrow();
  }
  expect(() => verifyDesktopMcpRecord(record(1), 'wrong')).toThrow();
  const db = dbRows([record(0)]);
  try {
    db.run("UPDATE mcp_intents SET state=CAST(X'80' AS TEXT)");
    expect(() => verifyDesktopMcpRows(db)).toThrow('backup_ui_invalid');
  } finally {
    db.close();
  }
});
test('Native MCP refuses row and byte limits without evicting unknown original requests', () => {
  const values = Array.from({ length: 129 }, (_, i) => {
    const v = record(1);
    v.request.commandId = `original-${i}`;
    v.bodySha256 = sha(v.request);
    return v;
  });
  const db = dbRows(values);
  try {
    expect(() => verifyDesktopMcpRows(db)).toThrow('backup_ui_invalid');
    expect(
      db.query<{ count: number }, []>('SELECT count(*) AS count FROM mcp_intents').get()?.count,
    ).toBe(129);
  } finally {
    db.close();
  }
  const oversized = record(4);
  (oversized.request.input.expectedReadSet as { user: Record<string, unknown> }).user.error =
    'x'.repeat(16777216);
  oversized.request.commandId = 'original-0';
  oversized.bodySha256 = sha(oversized.request);
  const { expectedStoreId: _s, commandId: _c, ...body } = oversized.request;
  oversized.requestSha256 = sha(body);
  const big = dbRows([oversized]);
  try {
    expect(() => verifyDesktopMcpRows(big)).toThrow('backup_ui_invalid');
  } finally {
    big.close();
  }
});
test('actual Node DB7 backup v15 inspect and restore preserve all original requests and reject relabeling or damaged bytes', async () => {
  const root = mkdtempSync('/private/tmp/kite-db7-maintenance-');
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  try {
    const store = await openSqliteStore(profile);
    const storeId = (await store.getMetadata()).storeId;
    await store.close();
    await nodeConfigurationAssets(root, profile, storeId);
    const path = join(selectProfile(profile).profilePath, 'desktop-private/data.sqlite');
    const original = actions.map((_, i) => record(i, storeId));
    const node = Bun.which('node');
    if (!node) throw Error('owned_node_unavailable');
    const repository = new URL('../../../../../', import.meta.url).pathname;
    const source = join(root, 'mcp-driver.ts');
    const helper = join(root, 'node-ui-fixture/profile-access-helper.js');
    writeFileSync(
      source,
      `
import {acquireDesktopProfileAccess} from ${JSON.stringify(join(repository, 'apps/desktop/electron/profile-access.ts'))};
import {openPrivateData} from ${JSON.stringify(join(repository, 'apps/desktop/electron/private-data.ts'))};
import http from 'node:http'; import https from 'node:https';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
const input=JSON.parse(process.argv[2]);let httpRequests=0;
const denied=()=>{httpRequests++;throw Error('mcp_fixture_http_forbidden');};
globalThis.fetch=async()=>denied();for(const protocol of [http,https])for(const method of ['get','request'])protocol[method]=denied;
const lease=await acquireDesktopProfileAccess(input.access);let data;
try {data=openPrivateData(input.profilePath,lease);
 if(input.action==='seed')for(const record of input.records){
  data.beginMcp({...record,phase:'submitting'});
  data.finishMcp(record.request.commandId,record.phase);
 }
 let terminalChecks;
 if(input.action==='terminal'){
  terminalChecks=[];
  for(const [index,phase] of [[0,'completed'],[1,'failed'],[2,'cancelled']]){
   const id=input.records[index].request.commandId;
   data.finishMcp(id,phase);
   const raw=new DatabaseSync(input.profilePath+'/desktop-private/data.sqlite',{readOnly:true});
   try {
    const before=raw.prepare('SELECT hex(CAST(state AS BLOB)) AS bytes FROM mcp_intents WHERE command_id=?').get(id).bytes;
    for(const downgrade of ['outcome_unknown','pending']){
     let rejected=false;try{data.finishMcp(id,downgrade);}catch{rejected=true;}
     const after=raw.prepare('SELECT hex(CAST(state AS BLOB)) AS bytes FROM mcp_intents WHERE command_id=?').get(id).bytes;
     terminalChecks.push({phase,downgrade,rejected,unchanged:before===after});
    }
   }finally{raw.close();}
  }
 }
 let capacity;
 if(input.action==='capacity'){
  let rejected=null;try{data.beginMcp(input.extra);}catch(error){rejected=error.message;}
  const raw=new DatabaseSync(input.profilePath+'/desktop-private/data.sqlite',{readOnly:true});
  try {capacity={rejected,...raw.prepare('SELECT count(*) AS count,sum(length(CAST(state AS BLOB))) AS bytes FROM mcp_intents').get()};}finally{raw.close();}
 }
 console.log(JSON.stringify({records:data.mcps(),httpRequests,...(terminalChecks?{terminalChecks}:{}),...(capacity?{capacity}: {})}));
}finally{if(data)data.close();else lease.close();}
`,
      { mode: 0o600 },
    );
    const built = await Bun.build({
      entrypoints: [source],
      target: 'node',
      packages: 'bundle',
      outdir: root,
      naming: 'mcp-driver.mjs',
    });
    if (!built.success) throw new AggregateError(built.logs, 'owned Node DB7 MCP fixture build');
    const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const owner = async (action: 'seed' | 'read' | 'terminal' | 'capacity') => {
      const extra = record(1, storeId);
      extra.request.commandId = 'additional-command';
      extra.phase = 'submitting';
      extra.bodySha256 = sha(extra.request);
      const { expectedStoreId: _store, commandId: _command, ...body } = extra.request;
      extra.requestSha256 = sha(body);
      const child = Bun.spawn(
        [
          node,
          join(root, 'mcp-driver.mjs'),
          JSON.stringify({
            action,
            extra,
            records: original,
            profilePath: selectProfile(profile).profilePath,
            access: {
              profile,
              bunExecutable: process.execPath,
              bunSha256: digest(process.execPath),
              helperPath: helper,
              helperSha256: digest(helper),
            },
          }),
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exit !== 0) throw Error(stderr);
      return JSON.parse(stdout) as {
        records: ReturnType<typeof record>[];
        httpRequests: number;
        terminalChecks?: {
          phase: string;
          downgrade: string;
          rejected: boolean;
          unchanged: boolean;
        }[];
        capacity?: { rejected: string; count: number; bytes: number };
      };
    };
    const produced = await owner('seed');
    const ordered = [...original].sort((a, b) =>
      a.request.commandId.localeCompare(b.request.commandId),
    );
    expect(produced).toEqual({ records: ordered, httpRequests: 0 });
    const terminal = await owner('terminal');
    expect(terminal.terminalChecks).toHaveLength(6);
    expect(terminal.terminalChecks?.every((check) => check.rejected && check.unchanged)).toBe(true);
    original[0]!.phase = 'completed';
    original[1]!.phase = 'failed';
    original[2]!.phase = 'cancelled';
    produced.records = terminal.records;
    const pad = Bun.spawn(
      [
        node,
        '--input-type=module',
        '-e',
        `
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(process.argv[1]);
try {
 const total=db.prepare('SELECT sum(length(CAST(state AS BLOB))) AS bytes FROM mcp_intents').get().bytes;
 db.prepare("UPDATE mcp_intents SET state=state||? WHERE command_id='original-0'").run(' '.repeat(16777216-total));
}finally{db.close();}
`,
        path,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [padExit, padError] = await Promise.all([pad.exited, new Response(pad.stderr).text()]);
    if (padExit !== 0) throw Error(padError);
    const rawState = () => {
      const db = new Database(path, { readonly: true });
      try {
        return db
          .query<{ command_id: string; state: string }, []>(
            'SELECT command_id,state FROM mcp_intents ORDER BY command_id',
          )
          .all();
      } finally {
        db.close(true);
      }
    };
    const padded = rawState();
    expect(padded.reduce((sum, row) => sum + Buffer.byteLength(row.state), 0)).toBe(16777216);
    expect(await owner('read')).toEqual(produced);
    const full = await owner('capacity');
    expect(full.capacity).toEqual({
      rejected: 'mcp_capacity_exceeded',
      count: 12,
      bytes: 16777216,
    });
    expect(rawState()).toEqual(padded);

    const before = readFileSync(path);
    const backup = await createProfileBackup({ profile, destinationRoot: join(root, 'backups') });
    expect(backup.manifest.version).toBe(15);
    expect(backup.manifest.assets.desktopUi.format?.userVersion).toBe(7);
    expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
    expect(readFileSync(path)).toEqual(before);
    const restored = await restoreProfileBackup({
      profile,
      expectedStoreId: storeId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(storeId);
    expect(await owner('read')).toEqual(produced);
    expect(rawState()).toEqual(padded);
    const mcpPath = join(selectProfile(profile).profilePath, 'mcp.json'),
      mcpBytes = Buffer.from('// exact raw Profile MCP source\n{"mcpServers":{}}\n');
    writeFileSync(mcpPath, mcpBytes, { mode: 0o600 });
    const currentBackup = await createProfileBackup({
      profile,
      destinationRoot: join(root, 'backups'),
    });
    expect(currentBackup.manifest.version).toBe(16);
    expect(currentBackup.manifest.assets.desktopUi.format?.userVersion).toBe(7);
    expect(currentBackup.manifest.assets.mcpConfiguration?.proof).toEqual({
      sha256: createHash('sha256').update(mcpBytes).digest('hex'),
      byteLength: String(mcpBytes.length),
    });
    expect((await inspectProfileBackup(currentBackup)).manifest).toEqual(currentBackup.manifest);
    const currentRestored = await restoreProfileBackup({
      profile,
      expectedStoreId: restored.storeId,
      backup: currentBackup,
      intent: 'replace_with_selected_backup',
    });
    expect(currentRestored.storeId).not.toBe(restored.storeId);
    expect(readFileSync(mcpPath)).toEqual(mcpBytes);
    expect(await owner('read')).toEqual(produced);
    expect(rawState()).toEqual(padded);
    const db = new Database(path);
    try {
      expect(
        db
          .query<{ state: string }, []>('SELECT state FROM mcp_intents ORDER BY command_id')
          .all()
          .map((r) => JSON.parse(r.state)),
      ).toEqual(
        [...original].sort((a, b) => a.request.commandId.localeCompare(b.request.commandId)),
      );
    } finally {
      db.close(true);
    }
    const ready = join(backup.directory, 'ready.json');
    writeFileSync(ready, JSON.stringify({ ...backup.manifest, version: 14 }), { mode: 0o600 });
    await expect(inspectProfileBackup(backup)).rejects.toMatchObject({
      code: 'backup_invalid_manifest',
    });
    const damaged = new Database(path);
    try {
      damaged.run("UPDATE mcp_intents SET state=CAST(X'80' AS TEXT) WHERE command_id='original-1'");
    } finally {
      damaged.close(true);
    }
    const damagedBytes = readFileSync(path);
    await expect(
      createProfileBackup({ profile, destinationRoot: join(root, 'damaged-backups') }),
    ).rejects.toMatchObject({ code: 'backup_ui_invalid' });
    expect(readFileSync(path)).toEqual(damagedBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

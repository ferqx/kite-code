import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpAdapter } from '../../../src/mcp';
import { createMcpStdioTransportPort } from '../../../src/mcp/stdio-port';
import {
  decodeMcpStdioProcessEvidence,
  type McpStdioWindowsEvidence,
} from '../../../src/mcp/stdio-process-evidence';

const binding = {
  originalStoreId: 'store',
  sessionId: 'session',
  executionId: 'execution',
  serverId: 'server',
  scopeId: JSON.stringify(['store', 'session', 'server']),
  configDigest: 'digest',
};
function receipt(): McpStdioWindowsEvidence {
  return {
    version: 3,
    coverage: 'windows-job-members',
    binding,
    ownerPid: 100,
    guardian: {
      pid: 101,
      parentPid: 100,
      creationTime: '132000000000000001',
      exit: { code: 0, signal: null, reaped: true },
      kernelState: 'dead',
      observationClosed: true,
    },
    server: { pid: 102, creationTime: '132000000000000002', exitCode: 0, waitConfirmed: true },
    job: { activeProcesses: 0, treeStopped: true },
    closed: true,
    closeUnknown: false,
  };
}
test('Windows cold receipts bind the complete original scope and reject false tree/reap or Darwin roles', () => {
  const original = receipt();
  const decoded = decodeMcpStdioProcessEvidence(original, binding, 100);
  expect(decoded).toEqual(original);
  expect(Object.isFrozen(decoded)).toBe(true);
  expect(
    decodeMcpStdioProcessEvidence(original, { ...binding, originalStoreId: 'restored' }, 100),
  ).toBeUndefined();
  expect(
    decodeMcpStdioProcessEvidence(
      { ...original, guardian: { ...original.guardian, parentPid: 1 } },
      binding,
      100,
    ),
  ).toBeUndefined();
  expect(
    decodeMcpStdioProcessEvidence(
      { ...original, guardian: { ...original.guardian, kernelState: 'alive' } },
      binding,
      100,
    ),
  ).toBeUndefined();
  expect(
    decodeMcpStdioProcessEvidence(
      { ...original, job: { activeProcesses: 1, treeStopped: true } },
      binding,
      100,
    ),
  ).toBeUndefined();
  expect(
    decodeMcpStdioProcessEvidence(
      { ...original, server: { ...original.server, waitConfirmed: false } },
      binding,
      100,
    ),
  ).toBeUndefined();
  expect(
    decodeMcpStdioProcessEvidence({ ...original, closed: true, closeUnknown: true }, binding, 100),
  ).toBeUndefined();
  expect(
    decodeMcpStdioProcessEvidence({ ...original, coalition: {} }, binding, 100),
  ).toBeUndefined();
  expect(decodeMcpStdioProcessEvidence({ ...original, version: 2 }, binding, 100)).toBeUndefined();
  expect(
    decodeMcpStdioProcessEvidence(
      { ...original, server: { ...original.server, pid: 0x100000000 } },
      binding,
      100,
    ),
  ).toBeUndefined();
  expect(
    decodeMcpStdioProcessEvidence(
      { ...original, guardian: { ...original.guardian, creationTime: '18446744073709551616' } },
      binding,
      100,
    ),
  ).toBeUndefined();
  const unstarted = { ...original, guardian: null, server: null, job: null, closed: false };
  expect(decodeMcpStdioProcessEvidence(unstarted, binding, 100)).toEqual(unstarted);
  for (const malformed of [false, 0, '', undefined, []]) {
    expect(
      decodeMcpStdioProcessEvidence(
        { ...unstarted, guardian: malformed, server: malformed, job: malformed },
        binding,
        100,
      ),
    ).toBeUndefined();
  }
});

test('Windows port mock uses the actual spawned child, preserves full RPC, and never upgrades unknown after late terminal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-windows-stdio-port-'));
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let failure: unknown;
  try {
    const guardian = join(root, 'guardian.js'),
      runner = join(root, 'runner.ts');
    writeFileSync(
      guardian,
      `
let nonce,sequence=0,mode;const send=v=>process.stdout.write(JSON.stringify({...v,nonce,sequence:++sequence})+'\\n');
const self=()=>({pid:process.pid,parentPid:process.ppid,creationTime:String(process.pid*1000)});
const proof=terminal=>({version:1,coverage:'windows-job-members',root:{pid:process.pid+100000,creationTime:'132000000000000001',exitCode:terminal?0:null,waitConfirmed:terminal},job:{activeProcesses:terminal?0:1,treeStopped:terminal},closed:terminal,closeUnknown:false});
let buf='';for await(const chunk of process.stdin){buf+=chunk.toString();while(buf.includes('\\n')){const at=buf.indexOf('\\n'),f=JSON.parse(buf.slice(0,at));buf=buf.slice(at+1);
if(f.type==='start'){nonce=f.nonce;mode=f.args[0];send({type:'ready',guardian:self(),evidence:proof(false)});}
else if(f.type==='rpc'){const m=JSON.parse(f.content);
const bytes=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{text:'完整输出🙂'+('x'.repeat(40000))}})+'\\n');for(let i=0;i<bytes.length;i+=16384)send({type:'rpc',content:bytes.subarray(i,i+16384).toString('base64')});}
else if(f.type==='cancel'){if(mode==='unknown'){const e=proof(false);e.closeUnknown=true;send({type:'terminal',guardian:self(),evidence:e,treeStopped:false});await Bun.sleep(20);}
send({type:'terminal',guardian:self(),evidence:proof(true),treeStopped:true});process.exit(0);}}}
`,
    );
    // Subprocess mock changes only the OS observation; the guardian is a real owned Bun child.
    writeFileSync(
      runner,
      `
import {mock} from 'bun:test';import assert from 'node:assert/strict';
Object.defineProperty(process,'platform',{value:'win32'});
let closes=0;mock.module(${JSON.stringify(join(import.meta.dir, '../../../src/platform/process/windows-owned-child.ts'))},()=>({retainWindowsOwnedProcessObservation(pid){return {pid,creationTime:String(pid*1000),verify:()=>true,inspect(){try{process.kill(pid,0);return 'alive'}catch{return 'dead'}},close(){closes++}}}}));
const {createMcpStdioTransportPort}=await import(${JSON.stringify(join(import.meta.dir, '../../../src/mcp/stdio-port.ts'))});
const {createMcpAdapter}=await import(${JSON.stringify(join(import.meta.dir, '../../../src/mcp/index.ts'))});
const {decodeMcpStdioProcessEvidence}=await import(${JSON.stringify(join(import.meta.dir, '../../../src/mcp/stdio-process-evidence.ts'))});
for(const mode of ['known','unknown']){
const configuration={type:'stdio',command:${JSON.stringify(join(root, 'server.exe'))},args:[mode],cwd:${JSON.stringify(root)},env:{}};
const digest=createMcpAdapter({id:'server',transport:configuration}).getCatalogue().configDigest;
const binding={originalStoreId:'store',sessionId:'session',executionId:mode,serverId:'server',scopeId:JSON.stringify(['store','session','server']),configDigest:digest,configuration};
const controller=new AbortController();const port=createMcpStdioTransportPort({servers:[{id:'server',configuration}],guardianPath:${JSON.stringify(guardian)},bunExecutable:process.execPath,allowedEnvNames:[],admit:async()=>{}});
const owned=await port.open(binding,{signal:controller.signal});let result;owned.transport.onmessage=m=>{result=m};
await owned.transport.start();await owned.transport.send({jsonrpc:'2.0',id:1,method:'fixture'});
const until=async f=>{const end=performance.now()+1000;while(!f()){if(performance.now()>end)throw Error('fixture_deadline');await Bun.sleep(2)}};
await until(()=>result);assert.equal(result.result.text,'完整输出🙂'+('x'.repeat(40000)));
const ready=owned.readProcessEvidence();assert.equal(ready.version,3);assert.equal(ready.guardian.kernelState,'alive');assert.equal(ready.guardian.parentPid,process.pid);
assert.equal((await owned.stop()).status,mode==='known'?'stopped':'unknown');assert.equal((await owned.stopped).supervision,mode==='known'?'ended':'unknown');
await until(()=>closes=== (mode==='known'?1:2));
const terminal=owned.readProcessEvidence();assert.equal(terminal.guardian.exit.reaped,true);assert.equal(terminal.guardian.kernelState,'dead');assert.ok(decodeMcpStdioProcessEvidence(terminal,binding,process.pid));
assert.equal((await owned.stop()).status,mode==='known'?'stopped':'unknown');}
console.log('windows_stdio_mock_complete');
`,
    );
    writeFileSync(join(root, 'server.exe'), 'fixture');
    child = Bun.spawn([process.execPath, runner], { stdout: 'pipe', stderr: 'pipe', env: {} });
    const stdout = new Response(child.stdout).text(),
      stderr = new Response(child.stderr).text();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let code: number;
    try {
      code = await Promise.race([
        child.exited,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(Error('windows_stdio_mock_deadline')), 3500);
        }),
      ]);
    } finally {
      if (deadline) clearTimeout(deadline);
    }
    const error = await stderr;
    if (code !== 0) throw Error(`windows_stdio_mock_exit:${code}\n${error}`);
    expect(code).toBe(0);
    expect(await stdout).toContain('windows_stdio_mock_complete');
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (child && child.exitCode === null) {
        child.kill();
        let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            child.exited,
            new Promise<never>((_, reject) => {
              cleanupDeadline = setTimeout(
                () => reject(Error('windows_stdio_mock_reap_unconfirmed')),
                500,
              );
            }),
          ]);
        } finally {
          if (cleanupDeadline) clearTimeout(cleanupDeadline);
        }
      }
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], 'windows_stdio_mock_cleanup_failed')
        : error;
    }
  }
  if (failure) throw failure;
});

const winTest = process.platform === 'win32' ? test : test.skip;
winTest(
  'native Windows stdio connects, reads complete original Tool output and closes the original Job tree',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-windows-native-mcp-'));
    let owned:
      | Awaited<ReturnType<ReturnType<typeof createMcpStdioTransportPort>['open']>>
      | undefined;
    let client: Client | undefined,
      confirmed = false;
    let failure: unknown;
    try {
      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, '../../../src/mcp/windows-stdio-guardian.ts')],
        outdir: root,
        target: 'bun',
        naming: 'windows-stdio-guardian.js',
      });
      expect(build.success).toBe(true);
      const server = join(root, 'server.js');
      writeFileSync(
        server,
        `let b='';for await(const c of process.stdin){b+=c.toString();while(b.includes('\\n')){const i=b.indexOf('\\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:'2024-11-05',serverInfo:{name:'owned',version:'1'},capabilities:{tools:{}}}:m.method==='tools/list'?{tools:[{name:'read',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'完整🙂'+('x'.repeat(40000))}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')}}`,
      );
      const configuration = {
        type: 'stdio' as const,
        command: process.execPath,
        args: [server],
        cwd: root,
        env: {},
      };
      const digest = createMcpAdapter({ id: 'server', transport: configuration }).getCatalogue()
        .configDigest;
      const actual = { ...binding, configDigest: digest, configuration };
      owned = await createMcpStdioTransportPort({
        servers: [{ id: 'server', configuration }],
        guardianPath: join(root, 'windows-stdio-guardian.js'),
        bunExecutable: process.execPath,
        allowedEnvNames: [],
        admit: async () => {},
      }).open(actual, { signal: new AbortController().signal });
      client = new Client({ name: 'fixture', version: '1' });
      await client.connect(owned.transport);
      expect((await client.listTools()).tools[0]?.name).toBe('read');
      expect((await client.callTool({ name: 'read', arguments: {} })).content).toEqual([
        { type: 'text', text: `完整🙂${'x'.repeat(40000)}` },
      ]);
      expect((await owned.stop()).status).toBe('stopped');
      confirmed = true;
      expect((await owned.stopped).supervision).toBe('ended');
      if (!owned.readProcessEvidence) throw Error('windows_mcp_receipt_missing');
      const original = decodeMcpStdioProcessEvidence(
        owned.readProcessEvidence(),
        actual,
        process.pid,
      );
      expect(original?.version).toBe(3);
      if (original?.version !== 3) throw Error('windows_mcp_receipt_missing');
      expect(original.guardian?.exit?.reaped).toBe(true);
      expect(original.guardian?.kernelState).toBe('dead');
      expect(original.job?.activeProcesses).toBe(0);
      expect(original.closed).toBe(true);
    } catch (error) {
      failure = error;
    } finally {
      const cleanup: unknown[] = [];
      try {
        await client?.close();
      } catch (error) {
        cleanup.push(error);
      }
      try {
        if (owned && !confirmed) confirmed = (await owned.stop()).status === 'stopped';
        if (owned && !confirmed) cleanup.push(Error('windows_mcp_cleanup_unconfirmed'));
      } catch (error) {
        cleanup.push(error);
      }
      if (!owned || confirmed) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch (error) {
          cleanup.push(error);
        }
      }
      if (cleanup.length)
        failure = new AggregateError(
          failure ? [failure, ...cleanup] : cleanup,
          'windows_mcp_cleanup_failed',
        );
    }
    if (failure) throw failure;
  },
  15000,
);

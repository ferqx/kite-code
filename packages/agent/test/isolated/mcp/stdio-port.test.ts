import { expect, test } from 'bun:test';
import { execFile, spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel } from '@kite-ai/ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { launchIdentity } from '../../../src/jobs/launch-identity';
import { createMcpAdapter, createMcpLifecycle } from '../../../src/mcp';
import { createMcpStdioTransportPort } from '../../../src/mcp/stdio-port';
import {
  decodeMcpStdioProcessEvidence,
  observeMcpStdioIdentity,
} from '../../../src/mcp/stdio-process-evidence';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

const macTest = process.platform === 'darwin' ? test : test.skip;
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(read: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (!(await read())) {
    if (Date.now() > deadline) throw new Error('stdio_test_deadline');
    await Bun.sleep(10);
  }
}
async function kernelState(pid: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { env: {} }, (error, stdout) => {
      if (error && !stdout.trim()) resolve('');
      else if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}
async function processGroup(pid: number): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { env: {} }, (error, stdout) => {
      if (error) reject(error);
      else resolve(Number(stdout.trim()));
    });
  });
}
function signalGuardian(
  original: ReturnType<typeof observeMcpStdioIdentity>,
  signal: 'SIGSTOP' | 'SIGCONT' | 'SIGKILL',
) {
  const current = observeMcpStdioIdentity(original.pid);
  if (
    !original.birth ||
    !current.birth ||
    current.parentPid !== original.parentPid ||
    JSON.stringify(current.birth) !== JSON.stringify(original.birth)
  )
    throw Error('stdio_fixture_guardian_identity_unconfirmed');
  process.kill(original.pid, signal);
}
async function readRegistration(
  domain: string,
  label: string,
): Promise<{ code: number | null; pid: number | null }> {
  return new Promise((resolve) => {
    execFile(
      '/bin/launchctl',
      ['print', `${domain}/${label}`],
      { env: {}, maxBuffer: 65536 },
      (error, stdout) => {
        const code = error ? (error as Error & { code?: number }).code : 0;
        const pid = stdout.match(/^\tpid = (\d+)$/m)?.[1];
        resolve({ code: typeof code === 'number' ? code : null, pid: pid ? Number(pid) : null });
      },
    );
  });
}
async function registrationAbsent(domain: string, label: string): Promise<boolean> {
  return (await readRegistration(domain, label)).code === 113;
}
async function fixture(mode = 'normal') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-mcp-stdio-')));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, '../../../src/mcp/stdio-guardian.ts')],
    outdir: root,
    target: 'bun',
    naming: 'stdio-guardian.js',
  });
  expect(built.success).toBe(true);
  const script = join(root, 'server.js');
  writeFileSync(
    script,
    `
 import {spawn} from 'node:child_process';import{writeFileSync,existsSync}from'node:fs';import{join}from'node:path';
 const root=process.env.LEDGER;const mode=process.env.MODE;
 process.stderr.write('fixture-sensitive-stderr'+('x'.repeat(mode==='stderr_limit'?8192:4096)));
 const childSource=\`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{});const grand=spawn(process.execPath,['-e',"import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{});writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",process.argv[1]+'.grand.ready'],{env:{},stdio:'ignore',detached:process.argv[2]==='escape'});writeFileSync(process.argv[1],JSON.stringify({child:process.pid,grand:grand.pid}));if(process.argv[2]==='escape')process.exit(0);setInterval(()=>{},1000);\`;
 const tree=join(root,String(process.pid)+'.tree');const child=spawn(process.execPath,['-e',childSource,tree,mode==='exit'?'escape':'normal'],{env:{},stdio:'ignore',detached:mode==='exit'});
 writeFileSync(join(root,String(process.pid)+'.leader'),JSON.stringify({leader:process.pid,guardian:process.ppid,tree,visible:process.env.FIXTURE_VISIBLE??null,ambient:process.env.PORT_SECRET??null,proxy:process.env.HTTP_PROXY??null}));
 let buf='';for await(const chunk of process.stdin){buf+=chunk.toString();while(buf.includes('\\n')){const at=buf.indexOf('\\n'),line=buf.slice(0,at);buf=buf.slice(at+1);const rpc=JSON.parse(line);if(rpc.id===undefined)continue;let result;
 if(rpc.method==='initialize'){while(!existsSync(tree+'.grand.ready'))await Bun.sleep(5);result={protocolVersion:'2024-11-05',serverInfo:{name:'local',version:'1'},capabilities:{tools:{}}};}
 else if(rpc.method==='tools/list')result={tools:[{name:'effect',inputSchema:{type:'object'}}]};
 else {writeFileSync(join(root,String(process.pid)+'.called'),'one');if(mode==='hang')await new Promise(()=>{});if(mode==='large'){process.stdout.write('x'.repeat(4096));continue;}result={content:[{type:'text',text:'actual local response'}]};}
 await new Promise(resolve=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result})+'\\n',resolve));if(mode==='exit'&&rpc.method==='tools/call'){while(!existsSync(join(root,String(process.pid)+'.exit')))await Bun.sleep(5);process.exit(0);}
 }}
 `,
  );
  const configuration = {
    type: 'stdio' as const,
    command: process.execPath,
    args: [script],
    cwd: root,
    env: { LEDGER: root, MODE: mode, FIXTURE_VISIBLE: 'selected' },
  };
  const ownedPorts: Awaited<ReturnType<ReturnType<typeof createMcpStdioTransportPort>['open']>>[] =
    [];
  const makePort = (
    admit: Parameters<typeof createMcpStdioTransportPort>[0]['admit'] = async () => {},
    limits?: Parameters<typeof createMcpStdioTransportPort>[0]['limits'],
    assertFresh?: Parameters<typeof createMcpStdioTransportPort>[0]['assertFresh'],
  ) => {
    const port = createMcpStdioTransportPort({
      servers: [{ id: 'local', configuration }],
      guardianPath: built.outputs[0]!.path,
      controlBase: root,
      bunExecutable: process.execPath,
      allowedEnvNames: ['LEDGER', 'MODE', 'FIXTURE_VISIBLE'],
      admit,
      limits,
      assertFresh,
    });
    return {
      async open(...args: Parameters<typeof port.open>) {
        const owned = await port.open(...args);
        ownedPorts.push(owned);
        return owned;
      },
    };
  };
  const binding = (sessionId = 's') => ({
    serverId: 'local',
    scopeId: JSON.stringify(['store', sessionId, 'local']),
    sessionId,
    executionId: `job-${sessionId}`,
    originalStoreId: 'store',
    configuration,
    configDigest: createMcpAdapter({ id: 'local', transport: configuration }).getCatalogue()
      .configDigest,
  });
  const states = () =>
    readdirSync(root)
      .filter((name) => name.endsWith('.leader'))
      .map(
        (name) =>
          JSON.parse(readFileSync(join(root, name), 'utf8')) as {
            leader: number;
            guardian: number;
            tree: string;
            visible: string;
            ambient: null;
            proxy: null;
          },
      );
  const tree = (state: ReturnType<typeof states>[number]) =>
    JSON.parse(readFileSync(state.tree, 'utf8')) as { child: number; grand: number };
  return {
    root,
    configuration,
    makePort,
    binding,
    states,
    tree,
    async close() {
      for (const owned of ownedPorts) await owned.stop();
      for (const state of states()) {
        const descendants = existsSync(state.tree) ? tree(state) : undefined;
        if (
          [state.leader, state.guardian, descendants?.child, descendants?.grand].some(
            (pid) => pid !== undefined && alive(pid),
          )
        )
          throw Error('stdio_fixture_owned_cleanup_unconfirmed');
      }
      if (
        readdirSync(root).some(
          (name) => name.startsWith('mcp-') && existsSync(join(root, name, 'owner.json')),
        )
      )
        throw Error('stdio_fixture_registration_cleanup_unconfirmed');
      rmSync(root, { recursive: true, force: true });
    },
  };
}

macTest(
  'actual guardian bridges bounded MCP RPC without ambient env; explicit close confirms inherited child/grandchild and guardian exit',
  async () => {
    const f = await fixture();
    const original = process.env.PORT_SECRET;
    process.env.PORT_SECRET = 'ambient-fixture-secret';
    const owned = await f.makePort().open(f.binding(), { signal: new AbortController().signal }),
      client = new Client({ name: 'fixture', version: '1' });
    try {
      await client.connect(owned.transport);
      await client.listTools();
      expect(
        await client.callTool({ name: 'effect', arguments: { value: 'exact' } }),
      ).toMatchObject({ content: [{ text: 'actual local response' }] });
      const state = f.states()[0]!,
        tree = f.tree(state);
      expect(state).toMatchObject({ visible: 'selected', ambient: null, proxy: null });
      expect(alive(tree.grand)).toBe(true);
      const evidence = owned.readProcessEvidence!();
      expect(evidence).toMatchObject({
        version: 2,
        coverage: 'mcp-owned-coalition',
        ownerPid: process.pid,
        broker: { parentPid: process.pid, exit: null },
        guardian: { pid: state.guardian, parentPid: 1, exit: null },
        server: { pid: state.leader, parentPid: state.guardian, exit: null, kernelState: 'alive' },
      });
      if (evidence.version !== 2) throw Error('mcp_coalition_evidence_required');
      expect(evidence.broker!.birth).not.toBeNull();
      expect(evidence.broker!.kernelState).toBe('alive');
      expect(evidence.guardian!.birth).not.toBeNull();
      expect(evidence.coalition).toMatchObject({
        claimTaskCount: 1,
        terminalTaskCount: null,
        processTreeStopped: false,
        registrationRemoved: false,
      });
      expect(evidence.server!.birth).not.toBeNull();
      expect(evidence.binding).toEqual({
        originalStoreId: 'store',
        sessionId: 's',
        executionId: 'job-s',
        serverId: 'local',
        scopeId: f.binding().scopeId,
        configDigest: f.binding().configDigest,
      });
      expect(Object.isFrozen(evidence.server!.birth)).toBe(true);
      expect(decodeMcpStdioProcessEvidence(evidence, evidence.binding, process.pid)).toEqual(
        evidence,
      );
      expect(
        decodeMcpStdioProcessEvidence({ ...evidence, command: 'private' }, evidence.binding),
      ).toBeUndefined();
      expect(
        decodeMcpStdioProcessEvidence(evidence, { ...evidence.binding, sessionId: 'foreign' }),
      ).toBeUndefined();
      expect(await owned.stop()).toMatchObject({ status: 'stopped' });
      expect(await owned.stopped).toEqual({ supervision: 'ended' });
      await until(() => ![state.leader, state.guardian, tree.child, tree.grand].some(alive));
      expect([state.leader, state.guardian, tree.child, tree.grand].some(alive)).toBe(false);
      const terminal = owned.readProcessEvidence!();
      if (terminal.version !== 2) throw Error('mcp_coalition_terminal_required');
      expect(terminal.broker).toMatchObject({
        exit: { code: 0, signal: null, reaped: true },
        kernelState: 'absent',
      });
      expect(terminal.guardian).toMatchObject({ exit: null, kernelState: 'absent' });
      expect(terminal.coalition).toMatchObject({
        id: evidence.coalition!.id,
        guardianUniqueId: evidence.coalition!.guardianUniqueId,
        guardianPidVersion: evidence.coalition!.guardianPidVersion,
        label: evidence.coalition!.label,
        domain: evidence.coalition!.domain,
        claimTaskCount: 1,
        terminalTaskCount: 1,
        processTreeStopped: true,
        registrationRemoved: true,
      });
      expect(terminal.server!.exit!.reaped).toBe(true);
      expect(terminal.server!.exit!.signal).toBe('SIGTERM');
      expect(terminal.server!.kernelState).toBe('absent');
      expect(evidence.server!.exit).toBeNull();
      expect(
        decodeMcpStdioProcessEvidence(
          { ...terminal, server: { ...terminal.server, kernelState: 'alive' } },
          terminal.binding,
        ),
      ).toBeUndefined();
      expect(JSON.stringify(terminal)).not.toContain('ambient-fixture-secret');
      expect(JSON.stringify(terminal)).not.toContain('LEDGER');
      // Compatibility of a historical v1 JSON record; no current-process qualification claim.
      const historical = {
        version: 1 as const,
        coverage: 'guardian-and-server-only' as const,
        binding: evidence.binding,
        ownerPid: 10,
        guardian: {
          pid: 11,
          parentPid: 10,
          birth: { seconds: '1000', microseconds: 1 },
          unavailable: [],
          exit: null,
          kernelState: 'alive' as const,
        },
        server: {
          pid: 12,
          parentPid: 11,
          birth: { seconds: '1000', microseconds: 2 },
          unavailable: [],
          exit: null,
          kernelState: 'alive' as const,
        },
      };
      expect(decodeMcpStdioProcessEvidence(historical, historical.binding, 10)).toEqual(historical);
    } finally {
      await owned.stop();
      if (original === undefined) delete process.env.PORT_SECRET;
      else process.env.PORT_SECRET = original;
      await f.close();
    }
  },
  15000,
);

macTest(
  'leader exit and RPC pipe EOF do not prove ended while TERM-ignoring grandchildren remain; actual guardian cleanup is required',
  async () => {
    const f = await fixture('exit'),
      owned = await f.makePort().open(f.binding(), { signal: new AbortController().signal }),
      client = new Client({ name: 'fixture', version: '1' });
    const foreignLedger = join(f.root, 'foreign-tree.json');
    const unrelated = spawn(
      process.execPath,
      [
        '-e',
        `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{},stdio:'ignore'});
writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:child.pid}));
process.stdin.resume();process.stdin.once('end',()=>{child.once('close',()=>process.exit(0));child.kill('SIGTERM');});`,
        foreignLedger,
      ],
      {
        env: {},
        stdio: ['pipe', 'ignore', 'ignore'],
      },
    );
    let guardianBirth: ReturnType<typeof observeMcpStdioIdentity> | undefined;
    let failure: unknown;
    let ended = false;
    void owned.stopped.then(() => (ended = true));
    try {
      await client.connect(owned.transport);
      await until(() => existsSync(foreignLedger));
      const foreign = JSON.parse(readFileSync(foreignLedger, 'utf8')) as {
        parent: number;
        child: number;
      };
      expect(foreign.parent).toBe(unrelated.pid!);
      const foreignBirth = observeMcpStdioIdentity(foreign.child);
      expect(foreignBirth.birth).not.toBeNull();
      expect(foreignBirth.parentPid).toBe(unrelated.pid!);
      const state = f.states()[0]!,
        tree = f.tree(state);
      await client.callTool({ name: 'effect', arguments: {} });
      await until(() => !alive(tree.child) && observeMcpStdioIdentity(tree.grand).parentPid === 1);
      const escaped = observeMcpStdioIdentity(tree.grand);
      expect(escaped.birth).not.toBeNull();
      expect(escaped.parentPid).toBe(1);
      expect(await processGroup(tree.grand)).toBe(tree.grand);
      expect(await processGroup(tree.grand)).not.toBe(state.leader);
      expect(alive(tree.child)).toBe(false);
      expect(alive(unrelated.pid!)).toBe(true);
      guardianBirth = observeMcpStdioIdentity(state.guardian);
      expect(guardianBirth.birth).not.toBeNull();
      signalGuardian(guardianBirth, 'SIGSTOP');
      await until(async () => (await kernelState(state.guardian)).startsWith('T'));
      writeFileSync(join(f.root, `${state.leader}.exit`), 'release');
      // The stopped guardian cannot reap its exited child. A kernel zombie is
      // evidence of leader exit, while kill(pid, 0) would still report that PID.
      await until(async () => (await kernelState(state.leader)).startsWith('Z'));
      expect(alive(tree.grand)).toBe(true);
      expect(ended).toBe(false);
      signalGuardian(guardianBirth, 'SIGCONT');
      expect(await owned.stopped).toEqual({ supervision: 'ended' });
      await until(() => ![state.guardian, tree.child, tree.grand].some(alive));
      expect(ended).toBe(true);
      expect(alive(unrelated.pid!)).toBe(true);
      expect(alive(foreign.child)).toBe(true);
      expect(observeMcpStdioIdentity(foreign.child).birth).toEqual(foreignBirth.birth);
      expect(owned.readProcessEvidence!()).toMatchObject({
        version: 2,
        coalition: { terminalTaskCount: 1, processTreeStopped: true, registrationRemoved: true },
      });
      expect(owned.readProcessEvidence!().server).toMatchObject({
        exit: { code: 0, signal: null, reaped: true },
        kernelState: 'absent',
      });
    } catch (error) {
      failure = error;
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        const state = f.states()[0];
        if (state && alive(state.guardian)) {
          if (!guardianBirth) cleanupErrors.push(Error('stdio_fixture_guardian_identity_missing'));
          else signalGuardian(guardianBirth, 'SIGCONT');
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await owned.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
      const unrelatedClosed = new Promise<void>((resolve) => {
        if (unrelated.exitCode !== null || unrelated.signalCode !== null) resolve();
        else unrelated.once('close', () => resolve());
      });
      unrelated.stdin!.end();
      await unrelatedClosed;
      if (unrelated.exitCode !== 0)
        cleanupErrors.push(Error('stdio_foreign_tree_cleanup_unconfirmed'));
      try {
        await f.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length)
        failure = new AggregateError(
          failure === undefined ? cleanupErrors : [failure, ...cleanupErrors],
          'stdio_fixture_cleanup_failed',
        );
    }
    if (failure !== undefined) throw failure;
  },
  15000,
);

macTest(
  'SDK remote-call cancellation leaves connection supervision active until exact owned stop; malformed output and stderr budget stop the group',
  async () => {
    const f = await fixture('hang'),
      owned = await f.makePort().open(f.binding(), { signal: new AbortController().signal }),
      client = new Client({ name: 'fixture', version: '1' });
    try {
      await client.connect(owned.transport);
      const state = f.states()[0]!,
        signal = new AbortController();
      const called = client.callTool({ name: 'effect', arguments: {} }, undefined, {
        signal: signal.signal,
      });
      void called.catch(() => {});
      await until(() => existsSync(join(f.root, `${state.leader}.called`)));
      signal.abort();
      await expect(called).rejects.toThrow();
      expect(alive(state.leader)).toBe(true);
      expect(await owned.stop()).toMatchObject({ status: 'stopped' });
      expect(await owned.stopped).toEqual({ supervision: 'ended' });
    } finally {
      await owned.stop();
      await f.close();
    }
    for (const mode of ['large', 'stderr_limit']) {
      const bounded = await fixture(mode),
        handle = await bounded
          .makePort(undefined, {
            frameBytes: 1024,
            stderrBytes: mode === 'stderr_limit' ? 1024 : 1024 * 1024,
          })
          .open(bounded.binding(), { signal: new AbortController().signal });
      try {
        const c = new Client({ name: 'fixture', version: '1' });
        if (mode === 'stderr_limit') await expect(c.connect(handle.transport)).rejects.toThrow();
        else {
          await c.connect(handle.transport);
          await expect(c.callTool({ name: 'effect', arguments: {} })).rejects.toThrow();
        }
        expect(await handle.stopped).toEqual({ supervision: 'ended' });
      } finally {
        await handle.stop();
        await bounded.close();
      }
    }
  },
  20000,
);

macTest(
  'actual Core connection Jobs spawn only after durable admission; Session A cancel stops its tree without closing Session B or replaying records',
  async () => {
    const f = await fixture(),
      store = await openSqliteStore({ dataRoot: join(f.root, 'data'), profile: 'new' }),
      expectedStoreId = (await store.getMetadata()).storeId;
    let admissions = 0;
    const port = f.makePort(async (binding) => {
      const execution = await store.getExecution(binding.executionId);
      expect(execution).toMatchObject({
        kind: 'job',
        status: 'dispatching',
        originStoreId: expectedStoreId,
        sessionId: binding.sessionId,
        definitionVersion: binding.configDigest,
      });
      admissions++;
    });
    const lifecycle = createMcpLifecycle({
      servers: [{ id: 'local', transport: f.configuration }],
      transportPort: port,
    });
    const finish = {
      type: 'finish' as const,
      reason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const model = createFixedModel([
      [
        {
          type: 'tool_call',
          id: 'a',
          name: 'mcp.connect',
          arguments: '{"serverId":"local","key":"first"}',
        },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
      [
        {
          type: 'tool_call',
          id: 'b',
          name: 'mcp.connect',
          arguments: '{"serverId":"local","key":"first"}',
        },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
    ]);
    const runtime = createRuntime({
      store,
      model,
      modelId: 'fixed',
      extensions: [lifecycle.extension],
      permissions: { authorize: async () => ({ allowed: true, revision: 'trusted-fixture' }) },
    });
    try {
      expect(f.states()).toHaveLength(0);
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'private',
        rootUri: `file://${f.root}`,
      });
      const statesBySession = new Map<string, ReturnType<typeof f.states>[number]>();
      for (const sessionId of ['a', 'b']) {
        const before = new Set(f.states().map((x) => x.leader));
        await runtime.createSession({
          expectedStoreId,
          sessionId,
          commandId: `create-${sessionId}`,
          subjectId: 'user',
          workspaceId: 'w',
          title: sessionId,
        });
        await runtime.submitCommand({
          expectedStoreId,
          sessionId,
          subjectId: 'user',
          commandId: `work-${sessionId}`,
          request: { kind: 'run.start', content: sessionId },
        });
        await runtime.waitForCommand(`work-${sessionId}`, { timeoutMs: 5000 });
        const created = f.states().filter((x) => !before.has(x.leader));
        expect(created).toHaveLength(1);
        statesBySession.set(sessionId, created[0]!);
      }
      expect(admissions).toBe(2);
      const a = statesBySession.get('a')!,
        b = statesBySession.get('b')!,
        aTree = f.tree(a!),
        bTree = f.tree(b!);
      expect(alive(aTree.grand)).toBe(true);
      expect(alive(bTree.grand)).toBe(true);
      expect(JSON.stringify(await store.getView('a'))).not.toContain('fixture-sensitive-stderr');
      await runtime.cancelSession({
        expectedStoreId,
        sessionId: 'a',
        subjectId: 'user',
        commandId: 'stop-a',
        includeBackground: true,
      });
      try {
        await until(() => ![a!.leader, a!.guardian, aTree.child, aTree.grand].some(alive));
      } catch {
        throw new Error(
          JSON.stringify({
            states: f.states(),
            aAlive: [a!.leader, a!.guardian, aTree.child, aTree.grand].map(alive),
            bAlive: [b!.leader, b!.guardian, bTree.child, bTree.grand].map(alive),
            exec: (await store.listExecutions('a')).map((x) => ({
              id: x.id,
              definition: x.definitionId,
              status: x.status,
              cancel: x.cancelRequestedAt,
            })),
          }),
        );
      }
      expect([b!.leader, b!.guardian, bTree.child, bTree.grand].every(alive)).toBe(true);
      expect(
        (
          await lifecycle.readStepCapabilities({
            command: { originStoreId: expectedStoreId },
            session: { id: 'b' },
          })
        ).toolIds,
      ).toHaveLength(1);
      const old = await runtime.getCommand('work-b');
      expect(
        await runtime.submitCommand({
          expectedStoreId,
          sessionId: 'b',
          subjectId: 'user',
          commandId: 'work-b',
          request: { kind: 'run.start', content: 'b' },
        }),
      ).toEqual(old!);
      expect(f.states()).toHaveLength(2);
    } finally {
      await runtime.close();
      await lifecycle.close();
      await f.close();
    }
  },
  20000,
);

macTest(
  'blocked original binding/environment and cancellation during actual admission barrier perform zero spawn',
  async () => {
    const f = await fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    const controller = new AbortController();
    try {
      expect(() =>
        createMcpStdioTransportPort({
          servers: [{ id: 'local', configuration: f.configuration }],
          guardianPath: join(f.root, 'stdio-guardian.js'),
          bunExecutable: process.execPath,
          allowedEnvNames: ['HTTP_PROXY'],
          admit: async () => {},
        }),
      ).toThrow();
      await expect(
        f.makePort().open({ ...f.binding(), configDigest: 'wrong' }, { signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'mcp_stdio_binding_invalid' });
      const opening = f
        .makePort(async () => {
          entered = true;
          await barrier;
        })
        .open(f.binding(), { signal: controller.signal });
      void opening.catch(() => {});
      await until(() => entered);
      controller.abort();
      await expect(opening).rejects.toThrow();
      release();
      await barrier;
      expect(f.states()).toHaveLength(0);
    } finally {
      release?.();
      await f.close();
    }
  },
  15000,
);

macTest(
  'actual parent EOF/SIGKILL lets private guardian stop inherited descendants without stopping an unrelated process',
  async () => {
    for (const cause of ['eof', 'kill']) {
      const f = await fixture();
      const script = join(f.root, 'parent.ts');
      writeFileSync(
        script,
        `import{createMcpStdioTransportPort}from${JSON.stringify(join(import.meta.dir, '../../../src/mcp/stdio-port.ts'))};import{Client}from${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};const port=createMcpStdioTransportPort({servers:[{id:'local',configuration:${JSON.stringify(f.configuration)}}],guardianPath:${JSON.stringify(join(f.root, 'stdio-guardian.js'))},controlBase:${JSON.stringify(f.root)},bunExecutable:${JSON.stringify(process.execPath)},allowedEnvNames:['LEDGER','MODE','FIXTURE_VISIBLE'],admit:async()=>{}});const owned=await port.open(${JSON.stringify(f.binding())},{signal:new AbortController().signal});const client=new Client({name:'parent',version:'1'});await client.connect(owned.transport);process.stdout.write('owned-broker '+JSON.stringify(owned.readProcessEvidence().broker)+'\\nready\\n');process.stdin.resume();process.stdin.once('end',()=>process.exit(0));`,
      );
      const parent = spawn(process.execPath, [script], {
          env: {},
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
        unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
          env: {},
          stdio: 'ignore',
        });
      parent.stderr!.resume();
      let announced = false,
        buffer = '';
      let broker: ReturnType<typeof observeMcpStdioIdentity> | undefined;
      parent.stdout!.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > 4096) throw new Error('parent_fixture_frame_limit');
        const line = buffer
          .slice(0, buffer.lastIndexOf('\n') + 1)
          .split('\n')
          .find((value) => value.startsWith('owned-broker '));
        if (line) broker = JSON.parse(line.slice('owned-broker '.length));
        if (buffer.includes('ready\n') && broker) announced = true;
      });
      try {
        await until(() => announced);
        const state = f.states()[0]!,
          tree = f.tree(state);
        expect([state.leader, state.guardian, tree.child, tree.grand].every(alive)).toBe(true);
        expect(broker!.parentPid).toBe(parent.pid!);
        expect(broker!.birth).not.toBeNull();
        expect(observeMcpStdioIdentity(broker!.pid).birth).toEqual(broker!.birth);
        if (cause === 'eof') parent.stdin!.end();
        else parent.kill('SIGKILL');
        await until(
          () => ![parent.pid!, state.leader, state.guardian, tree.child, tree.grand].some(alive),
        );
        await until(() => !alive(broker!.pid));
        expect(alive(broker!.pid)).toBe(false);
        expect(alive(unrelated.pid!)).toBe(true);
      } finally {
        parent.kill('SIGKILL');
        unrelated.kill('SIGKILL');
        await f.close();
      }
    }
    // One actual startup leak boundary: kill the direct broker after launchd bootstrap,
    // while only the fresh launchd guardian is gated before private authentication.
    const bootstrap = await fixture();
    const gate = join(bootstrap.root, 'release-bootstrap');
    const marker = join(bootstrap.root, 'bootstrap-guardian.json');
    const asset = join(bootstrap.root, 'stdio-guardian.js');
    writeFileSync(
      asset,
      `import {writeFileSync as writeBootstrap,existsSync as gateExists} from 'node:fs';
if(process.argv[2]==='--launchd-owned'){writeBootstrap(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,root:process.argv[3]}));while(!gateExists(${JSON.stringify(gate)}))await Bun.sleep(5);}
${readFileSync(asset, 'utf8')}`,
    );
    const pending = await bootstrap
      .makePort()
      .open(bootstrap.binding(), { signal: new AbortController().signal });
    const initial = pending.readProcessEvidence!();
    let originalBroker: ReturnType<typeof observeMcpStdioIdentity> | undefined;
    let bootstrapRoot: string | undefined;
    let registration: { label: string; domain: string } | undefined;
    let originalGuardian: ReturnType<typeof observeMcpStdioIdentity> | undefined;
    let bootstrapFailure: unknown;
    try {
      if (initial.version !== 2 || !initial.broker) throw Error('stdio_bootstrap_broker_missing');
      const brokerPid = initial.broker.pid;
      await until(() => {
        originalBroker = observeMcpStdioIdentity(brokerPid);
        return originalBroker.birth !== null;
      });
      expect(originalBroker!.birth).not.toBeNull();
      expect(originalBroker!.parentPid).toBe(process.pid);
      await until(() => existsSync(marker));
      const boot = JSON.parse(readFileSync(marker, 'utf8')) as { pid: number; root: string };
      originalGuardian = observeMcpStdioIdentity(boot.pid);
      expect(originalGuardian.birth).not.toBeNull();
      expect(originalGuardian.parentPid).toBe(1);
      bootstrapRoot = boot.root;
      const owner = JSON.parse(readFileSync(join(boot.root, 'owner.json'), 'utf8'));
      registration = { label: owner.label, domain: owner.domain };
      expect(registration.label).toMatch(/^com\.kitecode\.mcp\.[a-f0-9-]{36}$/);
      expect(registration.domain).toBe(`user/${process.getuid!()}`);
      expect(launchIdentity(boot.root)).toEqual(owner.root);
      expect(boot.root.startsWith(`${bootstrap.root}/mcp-`)).toBe(true);
      expect(await readRegistration(registration.domain, registration.label)).toEqual({
        code: 0,
        pid: boot.pid,
      });
      expect(bootstrap.states()).toHaveLength(0);
      signalGuardian(originalBroker!, 'SIGKILL');
      writeFileSync(gate, 'release');
      await until(
        async () =>
          !alive(originalBroker!.pid) &&
          !alive(originalGuardian!.pid) &&
          !existsSync(bootstrapRoot!) &&
          (await registrationAbsent(registration!.domain, registration!.label)),
      );
      expect(alive(originalBroker!.pid)).toBe(false);
      expect(alive(originalGuardian.pid)).toBe(false);
      expect(existsSync(boot.root)).toBe(false);
      expect(await registrationAbsent(registration.domain, registration.label)).toBe(true);
      expect(bootstrap.states()).toHaveLength(0);
      expect(await pending.stopped).toEqual({ supervision: 'unknown' });
    } catch (error) {
      bootstrapFailure = error;
    } finally {
      const cleanupErrors: unknown[] = [];
      writeFileSync(gate, 'release');
      try {
        await pending.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        if (bootstrapRoot && registration && originalGuardian)
          await until(
            async () =>
              !alive(originalGuardian!.pid) &&
              !existsSync(bootstrapRoot!) &&
              (await registrationAbsent(registration!.domain, registration!.label)),
          );
        await bootstrap.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length)
        bootstrapFailure = new AggregateError(
          bootstrapFailure === undefined ? cleanupErrors : [bootstrapFailure, ...cleanupErrors],
          'stdio_bootstrap_cleanup_failed',
        );
    }
    if (bootstrapFailure !== undefined) throw bootstrapFailure;
  },
  20000,
);

macTest(
  'source freshness is rechecked after actual Job admission before owned guardian spawn',
  async () => {
    const f = await fixture(),
      store = await openSqliteStore({ dataRoot: join(f.root, 'data'), profile: 'fresh-source' }),
      expectedStoreId = (await store.getMetadata()).storeId;
    const sourcePath = join(f.root, 'private-source.json');
    writeFileSync(sourcePath, 'original');
    const guardianBoot = join(f.root, 'guardian-boot.json'),
      guardianAsset = join(f.root, 'stdio-guardian.js');
    writeFileSync(
      guardianAsset,
      `import {writeFileSync as recordOwnedGuardianBoot} from 'node:fs';recordOwnedGuardianBoot(${JSON.stringify(guardianBoot)},JSON.stringify({pid:process.pid}));\n` +
        readFileSync(guardianAsset, 'utf8'),
    );

    let release!: () => void, entered!: () => void;
    const admissionEntered = new Promise<void>((resolve) => (entered = resolve)),
      admissionRelease = new Promise<void>((resolve) => (release = resolve));
    const port = f.makePort(
      async (binding) => {
        expect(await store.getExecution(binding.executionId)).toMatchObject({
          kind: 'job',
          status: 'dispatching',
          originStoreId: expectedStoreId,
          sessionId: 'a',
        });
        entered();
        await admissionRelease;
      },
      undefined,
      () => {
        if (readFileSync(sourcePath, 'utf8') !== 'original') throw Error('mcp_source_stale');
      },
    );
    const lifecycle = createMcpLifecycle({
      servers: [{ id: 'local', transport: f.configuration }],
      transportPort: port,
    });
    const finish = {
      type: 'finish' as const,
      reason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const runtime = createRuntime({
      store,
      model: createFixedModel([
        [
          {
            type: 'tool_call',
            id: 'connect',
            name: 'mcp.connect',
            arguments: '{"serverId":"local","key":"original"}',
          },
          { ...finish, reason: 'tool_calls' },
        ],
        [finish],
      ]),
      modelId: 'fixed',
      extensions: [lifecycle.extension],
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'actual-host' };
        },
      },
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'owned',
        rootUri: `file://${f.root}`,
      });
      await runtime.createSession({
        expectedStoreId,
        commandId: 'create-a',
        sessionId: 'a',
        workspaceId: 'w',
        subjectId: 'user',
        title: 'owned',
      });
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 'a',
        subjectId: 'user',
        commandId: 'connect-after-admit',
        request: { kind: 'run.start', content: 'Connect exact source' },
      });
      await admissionEntered;
      expect(f.states()).toEqual([]);
      writeFileSync(sourcePath, 'changed');
      release();
      await runtime.waitForCommand('connect-after-admit', { timeoutMs: 5000 });
      expect(f.states()).toEqual([]);
      expect(existsSync(guardianBoot)).toBe(false);
      const unknown = (await store.listExecutions('a')).filter(
        (e) => e.kind === 'job' && e.status === 'outcome_unknown',
      );
      expect(unknown).toHaveLength(1);
      expect(await runtime.close().catch((error: unknown) => error)).toMatchObject({
        code: 'shutdown_cleanup_unconfirmed',
      });
      expect(
        (await store.listExecutions('a')).filter(
          (e) => e.kind === 'job' && e.status === 'outcome_unknown',
        ),
      ).toEqual(unknown);
    } finally {
      release();
      await lifecycle.close();
      await store.close();
      await f.close();
    }
  },
);

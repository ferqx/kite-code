import { expect, test } from 'bun:test';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '../../..');
async function execute(argv: string[], cwd: string, home: string) {
  const child = Bun.spawn(argv, {
    cwd,
    env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code) console.error({ argv, code, stdout, stderr });
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}

test('actual candidate default paired and daemon children protect closure and retain their own artifact lifetime', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-runtime-protection-'));
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  let provider: ReturnType<typeof Bun.serve> | undefined;
  let daemonStarted = false;
  let runtime = '',
    cli = '';
  const socket = join(root, 'owned.sock');
  try {
    const { buildTerminalBundle } = await import('../../../scripts/release/terminal-bundle');
    const { verifyTerminalBundle } = await import('../../../apps/cli/host/terminal-artifact');
    // Only the production builder or an explicitly supplied, fully verified current candidate.
    const reuse = process.env.KITE_TERMINAL_REUSE_VERIFIED_BUNDLE;
    if (reuse) {
      verifyTerminalBundle(reuse);
      cpSync(reuse, join(root, 'candidate'), {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
    }
    const built = reuse
      ? verifyTerminalBundle(join(root, 'candidate'))
      : await buildTerminalBundle({
          destination: join(root, 'candidate'),
          repositoryRoot,
          bunExecutable: process.execPath,
        });
    const proof = built.artifact.runtimeProtection!;
    expect(Object.keys(proof).sort()).toEqual(['kind', 'manifestSha256', 'root']);
    expect(proof).toEqual({
      kind: 'terminal.candidate',
      root: built.root,
      manifestSha256: built.digest,
    });
    expect(built.buildId).toBe(`terminal-${built.digest}`);
    const manifestPath = join(built.root, 'terminal-manifest.json');
    const manifestBytes = readFileSync(manifestPath);
    runtime = join(built.root, built.manifest.entries.runtime);
    cli = join(built.root, built.manifest.entries.cli);
    // The workspace contains the candidate, so denial cannot be explained by outside-workspace access.
    const workspace = root;
    const dataRoot = join(home, '.kite-code', 'unified-agent');
    const setup = join(root, 'setup.mjs');
    writeFileSync(
      setup,
      `import {selectProfile} from ${JSON.stringify(join(built.root, 'node_modules/@kite-ai/agent/profile.js'))};import {mkdirSync} from 'node:fs';const p=selectProfile({dataRoot:${JSON.stringify(dataRoot)},profile:'default'});mkdirSync(p.profilePath,{recursive:true,mode:0o700});console.log(JSON.stringify(p));`,
    );
    const setupResult = await execute([runtime, setup], workspace, home);
    expect(setupResult.code).toBe(0);
    const profile = JSON.parse(setupResult.stdout) as { profilePath: string };
    const normalPath = relative(workspace, join(root, 'neighbor.txt'));
    const protectedPaths = [
      relative(workspace, join(built.root, 'node_modules/@kite-ai/agent/storage/worker/main.js')),
      relative(workspace, join(built.root, built.manifest.entries.cli)),
      relative(workspace, join(profile.profilePath, 'config.jsonc')),
    ];
    expect([normalPath, ...protectedPaths].every((path) => !path.startsWith('../'))).toBe(true);
    const calls = [
      { name: 'files.write', input: { path: normalPath, content: '邻近 UTF8 😀\r\n', base: null } },
      { name: 'files.read', input: { path: normalPath } },
      ...protectedPaths.flatMap((path) => [
        { name: 'files.read', input: { path } },
        { name: 'files.write', input: { path, content: 'MUST NEVER WRITE', base: null } },
      ]),
    ];
    const messages: unknown[][] = [];
    provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { messages: unknown[] };
        messages.push(body.messages);
        const call = calls[messages.length - 1];
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'protection', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        const delta = call
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `call-${messages.length}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.input) },
                },
              ],
            }
          : { content: 'RUNTIME PROTECTION COMPLETE' };
        return new Response(
          `${frame(delta, null) + frame({}, call ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const configPath = join(profile.profilePath, 'config.jsonc');
    const configBytes = JSON.stringify({
      modelId: 'fixed',
      tools: [
        { id: 'files.read', definitionVersion: '3' },
        { id: 'files.write', definitionVersion: '2' },
      ],
      models: [
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
      ],
    });
    writeFileSync(configPath, configBytes, { mode: 0o600 });
    const input = join(root, 'input.json');
    writeFileSync(
      input,
      JSON.stringify({
        artifact: built.artifact,
        profile,
        workspace,
        root: built.root,
      }),
    );
    const driver = join(root, 'native-parent.mjs');
    writeFileSync(
      driver,
      `
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {launchPairedService} from ${JSON.stringify(join(built.root, 'node_modules/@kite-ai/service/paired.js'))};
import {acquireArtifactAccess} from ${JSON.stringify(join(built.root, 'node_modules/@kite-ai/agent/artifact-access.js'))};
const p=JSON.parse(readFileSync(process.argv[2],'utf8'));
const blocked=()=>assert.throws(()=>acquireArtifactAccess({root:p.root,mode:'exclusive'}),e=>e.code==='owner_busy');
const free=()=>acquireArtifactAccess({root:p.root,mode:'exclusive'}).release();
const launch=(instanceId)=>launchPairedService({...p.artifact,profile:p.profile,instanceId,requiredCapabilities:['commands','history','sessions'],shutdownTimeoutMs:5000});
let h;
try {
 free();h=await launch('runtime-paired');blocked();
 const c=h.client,s=h.bootstrap.storeId;
 await c.createWorkspace({expectedStoreId:s,id:'w',name:'owned',rootUri:new URL('file://'+p.workspace).href});
 await c.createSession({expectedStoreId:s,commandId:'create',sessionId:'s',workspaceId:'w',title:'runtime'});
 const trust=await c.getWorkspaceTrust('w',{storeId:s});
 await c.setWorkspaceTrust('w',{expectedStoreId:s,commandId:'trust',canonicalIdentity:trust.canonicalIdentity,externalReadScopeDigest:trust.externalReadScopeDigest,trusted:true,ifRevision:trust.revision});
 const mode=await c.getPermissionMode('s',{storeId:s});
 await c.setPermissionMode('s',{expectedStoreId:s,commandId:'full',mode:'full',ifRevision:mode.revision,makeDefault:false,ifDefaultRevision:mode.defaultRevision});
 await c.startRun('s',{kind:'run.start',expectedStoreId:s,commandId:'work',content:'verify protected runtime assets'});
 const deadline=Date.now()+15000;let command,run;
 while(true){command=await c.getCommand('work');if(command.receipt?.runId){run=await c.getRun(command.receipt.runId);if(!run.isActive)break;}if(Date.now()>deadline)throw Error('runtime_run_deadline');await Bun.sleep(10);}
 assert.equal(run.status,'completed');assert.equal(run.originCommandId,'work');blocked();
 await h.close();h=undefined;free();
 h=await launch('runtime-cold');blocked();const original=await h.client.getCommand('work');assert.equal(original.id,'work');assert.equal(original.originStoreId,s);assert.equal(original.receipt?.runId,run.id);assert.equal((await h.client.getRun(run.id)).status,'completed');
 await h.close();h=undefined;free();console.log(JSON.stringify({paired:true,coldGet:true,runId:run.id,storeId:s}));
}finally{if(h)await h.close();}
`,
    );
    const paired = await execute([runtime, driver, input], workspace, home);
    writeFileSync(join(root, 'paired-proof.json'), JSON.stringify(paired, null, 2));
    writeFileSync(join(root, 'provider-wire.json'), JSON.stringify(messages, null, 2));
    expect(paired.code).toBe(0);
    expect(JSON.parse(paired.stdout).coldGet).toBe(true);
    expect(messages).toHaveLength(calls.length + 1);
    const toolMessages = (messages.at(-1) as { role: string; content: unknown }[]).filter(
      (message) => message.role === 'tool',
    );
    expect(toolMessages).toHaveLength(calls.length);
    expect(
      toolMessages.filter((message) =>
        JSON.stringify(message.content).includes('file_path_protected'),
      ),
    ).toHaveLength(protectedPaths.length * 2);
    expect(JSON.stringify(toolMessages.slice(0, 2))).not.toContain('file_path_protected');
    expect(JSON.stringify(toolMessages[1])).toContain('邻近 UTF8');
    expect(readFileSync(join(root, 'neighbor.txt'), 'utf8')).toBe('邻近 UTF8 😀\r\n');
    expect(readFileSync(configPath, 'utf8')).toBe(configBytes);
    expect(readFileSync(manifestPath)).toEqual(manifestBytes);
    verifyTerminalBundle(built.root);
    daemonStarted = true;
    const started = await execute(
      [runtime, cli, 'server', 'start', '--server', socket, '--workspace', workspace],
      workspace,
      home,
    );
    expect(started.code).toBe(0);
    daemonStarted = true;
    const identity = JSON.parse(started.stdout);
    writeFileSync(join(root, 'daemon-proof.json'), JSON.stringify(identity, null, 2));
    expect(identity.state).toBe('accepting');
    const lockDriver = join(root, 'lock.mjs');
    writeFileSync(
      lockDriver,
      `import {acquireArtifactAccess} from ${JSON.stringify(join(built.root, 'node_modules/@kite-ai/agent/artifact-access.js'))};try{acquireArtifactAccess({root:${JSON.stringify(built.root)},mode:'exclusive'}).release();console.log('released')}catch(e){if(e.code!=='owner_busy')throw e;console.log('owner_busy')}`,
    );
    expect((await execute([runtime, lockDriver], workspace, home)).stdout.trim()).toBe(
      'owner_busy',
    );
    const status = await execute(
      [runtime, cli, 'server', 'status', '--server', socket],
      workspace,
      home,
    );
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout).instanceId).toBe(identity.instanceId);
    const stop = await execute(
      [runtime, cli, 'server', 'stop', '--server', socket],
      workspace,
      home,
    );
    expect(stop.code).toBe(0);
    daemonStarted = false;
    expect((await execute([runtime, lockDriver], workspace, home)).stdout.trim()).toBe('released');
    expect(readFileSync(manifestPath)).toEqual(manifestBytes);
    verifyTerminalBundle(built.root);
  } finally {
    if (daemonStarted) {
      const cleanup = await execute(
        [runtime, cli, 'server', 'stop', '--server', socket],
        root,
        home,
      );
      daemonStarted = cleanup.code !== 0;
    }
    provider?.stop(true);
    if (daemonStarted || process.env.KITE_TERMINAL_TEST_KEEP_BUNDLE === '1')
      console.log(`OWNED_RUNTIME_PROTECTION_ROOT ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
}, 120000);

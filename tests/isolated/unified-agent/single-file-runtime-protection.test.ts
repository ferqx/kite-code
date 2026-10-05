import { expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
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

test('actual single-file default Service protects loader companions without protecting its Workspace parent', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-runtime-protection-'));
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  let provider: ReturnType<typeof Bun.serve> | undefined;
  let runtime = '';
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

    const single = join(root, 'single-file-service.js');
    const output = await Bun.build({
      entrypoints: [join(repositoryRoot, 'apps/service/src/main.ts')],
      outdir: root,
      naming: 'single-file-service.js',
      target: 'bun',
      packages: 'bundle',
    });
    expect(output.success).toBe(true);
    expect(output.outputs[0]?.path).toBe(single);
    const agent = join(built.root, 'node_modules/@kite-ai/agent');
    // These are the actual production standalone Worker and loader-selected companions, not substitutes.
    for (const path of ['storage/worker/main.js', 'storage/migrations/0001-baseline.sql']) {
      mkdirSync(join(root, path.substring(0, path.lastIndexOf('/'))), {
        recursive: true,
        mode: 0o700,
      });
      cpSync(join(agent, path), join(root, path));
    }
    for (const [from, to] of [
      ['tools/web-fetch/extractor-worker.js', 'extractor-worker.js'],
      ['tools/web-fetch/extractor-worker.sha256', 'extractor-worker.sha256'],
      ['mcp/stdio-guardian.js', 'stdio-guardian.js'],
    ])
      cpSync(join(agent, from!), join(root, to!));
    symlinkSync(join(agent, 'node_modules'), join(root, 'node_modules'), 'dir');

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
      'single-file-service.js',
      'storage/worker/main.js',
      'storage/migrations/0001-baseline.sql',
      'extractor-worker.js',
      'extractor-worker.sha256',
      'stdio-guardian.js',
      relative(workspace, runtime),
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
        artifact: {
          entrypoint: single,
          executable: runtime,
          buildId: 'single-file-build',
          apiMajor: 1,
        },
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
import {readFileSync,writeFileSync} from 'node:fs';
import {launchPairedService} from ${JSON.stringify(join(built.root, 'node_modules/@kite-ai/service/paired.js'))};
const p=JSON.parse(readFileSync(process.argv[2],'utf8'));
const launch=(instanceId)=>launchPairedService({...p.artifact,profile:p.profile,instanceId,requiredCapabilities:['commands','history','sessions'],shutdownTimeoutMs:5000,spawnChild(argv,{env}){const child=Bun.spawn(argv,{env,stdin:'pipe',stdout:'pipe',stderr:'pipe'});const [copy,stderr]=child.stderr.tee();void new Response(copy).text().then(text=>{writeFileSync(${JSON.stringify(join(root, 'child-stderr-'))}+instanceId+'.log',text);if(text)console.error(text)});return {stdin:child.stdin,stdout:child.stdout,stderr,pid:child.pid,exited:child.exited,kill:signal=>child.kill(signal)};}});
let h;const ownedPids=[];
try {
 h=await launch('runtime-paired');ownedPids.push(h.pid);
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
 assert.equal(run.status,'completed');assert.equal(run.originCommandId,'work');
 await h.close();h=undefined;
 h=await launch('runtime-cold');ownedPids.push(h.pid);const original=await h.client.getCommand('work');assert.equal(original.id,'work');assert.equal(original.originStoreId,s);assert.equal(original.receipt?.runId,run.id);assert.equal((await h.client.getRun(run.id)).status,'completed');
 await h.close();h=undefined;for(const pid of ownedPids)assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');console.log(JSON.stringify({paired:true,coldGet:true,runId:run.id,storeId:s,ownedPids,exited:true}));
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
    // A trusted custom extractor owns its exact real parser/checksum inventory; the default
    // sibling parser is absent and must not be invented as loaded authority.
    mkdirSync(join(root, 'custom-parser'), { mode: 0o700 });
    for (const name of ['extractor-worker.js', 'extractor-worker.sha256'])
      renameSync(join(root, name), join(root, 'custom-parser', name));
    expect(existsSync(join(root, 'extractor-worker.js'))).toBe(false);
    expect(existsSync(join(root, 'extractor-worker.sha256'))).toBe(false);
    const customSource = join(root, 'custom-runtime-source.ts');
    const customEntry = join(root, 'custom-runtime-service.js');
    writeFileSync(
      customSource,
      `
import {runServiceProcess} from ${JSON.stringify(join(repositoryRoot, 'apps/service/src/main.ts'))};
import {createDefaultProcessConfiguration} from ${JSON.stringify(join(repositoryRoot, 'apps/service/src/configuration.ts'))};
import {selectProfile} from ${JSON.stringify(join(repositoryRoot, 'packages/agent/src/profile.ts'))};
import {createPassiveWebExtractor,webExtractorAssets} from ${JSON.stringify(join(repositoryRoot, 'packages/agent/src/tools/web-fetch/index.ts'))};
import {writeFileSync} from 'node:fs';
const path=${JSON.stringify(join(root, 'custom-parser/extractor-worker.js'))};
await runServiceProcess({async configure(startup){const extractor=createPassiveWebExtractor({workerPath:path});const prepared=await extractor.prepare();const extracted=await extractor.extract({html:'<html><title>Actual custom parser</title><body><article>Original custom parser content.</article></body></html>',url:'https://example.invalid/'},{signal:new AbortController().signal}).catch(error=>{console.error(error);throw error;});writeFileSync(${JSON.stringify(join(root, 'custom-extractor-proof.json'))},JSON.stringify({prepared,extracted}));return createDefaultProcessConfiguration({profile:selectProfile(startup.profile),webFetch:{extractor,network:{policy:{mode:'public'},admitHop:async()=>({allowed:true,revision:'default-public-network-1'})}},runtimeAssets:[process.argv[1],webExtractorAssets(path).worker,webExtractorAssets(path).checksum]});}});
`,
    );
    const customBuild = await Bun.build({
      entrypoints: [customSource],
      outdir: root,
      naming: 'custom-runtime-service.js',
      target: 'bun',
      packages: 'bundle',
    });
    expect(customBuild.success).toBe(true);
    expect(customBuild.outputs[0]?.path).toBe(customEntry);
    const customSetup = join(root, 'custom-setup.mjs');
    writeFileSync(
      customSetup,
      readFileSync(setup, 'utf8').replace(
        JSON.stringify(dataRoot),
        JSON.stringify(join(root, 'custom-data')),
      ),
    );
    const selectedCustom = await execute([runtime, customSetup], workspace, home);
    expect(selectedCustom.code).toBe(0);
    const customProfile = JSON.parse(selectedCustom.stdout);
    writeFileSync(join(customProfile.profilePath, 'config.jsonc'), configBytes, { mode: 0o600 });
    const customProtected = [
      'custom-runtime-service.js',
      'custom-parser/extractor-worker.js',
      'custom-parser/extractor-worker.sha256',
      relative(workspace, runtime),
    ];
    calls.splice(
      0,
      calls.length,
      {
        name: 'files.write',
        input: { path: 'neighbor-custom.txt', content: '邻近 UTF8 😀\r\n', base: null },
      },
      { name: 'files.read', input: { path: 'neighbor-custom.txt' } },
      ...customProtected.flatMap((path) => [
        { name: 'files.read', input: { path } },
        { name: 'files.write', input: { path, content: 'MUST NEVER WRITE', base: null } },
      ]),
    );
    messages.length = 0;
    const customInput = join(root, 'custom-input.json');
    writeFileSync(
      customInput,
      JSON.stringify({
        artifact: {
          entrypoint: customEntry,
          executable: runtime,
          buildId: 'custom-extractor',
          apiMajor: 1,
        },
        profile: customProfile,
        workspace,
        root: built.root,
      }),
    );
    const customResult = await execute([runtime, driver, customInput], workspace, home);
    writeFileSync(join(root, 'custom-paired-proof.json'), JSON.stringify(customResult, null, 2));
    writeFileSync(join(root, 'custom-provider-wire.json'), JSON.stringify(messages, null, 2));
    expect(customResult.code).toBe(0);
    expect(messages).toHaveLength(calls.length + 1);
    const customTools = (messages.at(-1) as { role: string; content: unknown }[]).filter(
      (message) => message.role === 'tool',
    );
    expect(
      customTools.filter((message) =>
        JSON.stringify(message.content).includes('file_path_protected'),
      ),
    ).toHaveLength(customProtected.length * 2);
    expect(readFileSync(join(root, 'neighbor-custom.txt'), 'utf8')).toBe('邻近 UTF8 😀\r\n');
    expect(
      JSON.parse(readFileSync(join(root, 'custom-extractor-proof.json'), 'utf8')).extracted.title,
    ).toBe('Actual custom parser');
    const parserProof = JSON.parse(readFileSync(join(root, 'custom-extractor-proof.json'), 'utf8'));
    expect(parserProof.prepared.hash).toBe(
      readFileSync(join(root, 'custom-parser/extractor-worker.sha256'), 'utf8').trim(),
    );
    expect(parserProof.extracted.content).toContain('Original custom parser content.');
    verifyTerminalBundle(built.root);
    // Explicit trusted-host fault injection: actual HTTP/Runtime shutdown with a real shared artifact lock.
    // This proves failure retention, not an arbitrary default-bundle filesystem failure.
    const failureDriver = join(root, 'resource-close-failure.mjs');
    writeFileSync(
      failureDriver,
      `
import assert from 'node:assert/strict';
import {selectProfile} from ${JSON.stringify(join(built.root, 'node_modules/@kite-ai/agent/profile.js'))};
import {openSqliteStore} from ${JSON.stringify(join(built.root, 'node_modules/@kite-ai/agent/sqlite.js'))};
import {createRuntime} from ${JSON.stringify(join(built.root, 'node_modules/@kite-ai/agent/index.js'))};
import {acquireArtifactAccess} from ${JSON.stringify(join(built.root, 'node_modules/@kite-ai/agent/artifact-access.js'))};
import {startService} from ${JSON.stringify(join(built.root, 'node_modules/@kite-ai/service/index.js'))};
import {createServiceLifecycleClient} from ${JSON.stringify(join(built.root, 'node_modules/@kite-ai/client/index.js'))};
const root=${JSON.stringify(built.root)};
const selected=selectProfile({dataRoot:${JSON.stringify(join(root, 'failure-profile'))},profile:'owned'});
const store=await openSqliteStore(selected),runtime=createRuntime({store,instanceId:'after-resource-failure'});
const lease=acquireArtifactAccess({root,mode:'shared'});
let hookCalls=0;
const profile={dataRoot:selected.dataRoot,name:selected.profile,accessKey:selected.profileAccessKey};
const h=await startService({runtime,profile,instanceId:'after-resource-failure',buildId:'injected-host-error',async afterResourceClose(){hookCalls++;throw Error('injected_after_resource_close_failure');}});
let closed=false;void h.closedPromise.then(()=>{closed=true;});
const c=createServiceLifecycleClient({endpoint:h.endpoint,token:h.bootstrap.token,expected:{profile,instanceId:'after-resource-failure'}});
assert.equal((await c.shutdown('if_idle')).accepted,true);
const deadline=Date.now()+5000;while((await c.getStatus()).state!=='drain_failed'){if(Date.now()>deadline)throw Error('failure_lifecycle_deadline');await Bun.sleep(10);}
await Bun.sleep(25);assert.equal(closed,false);assert.equal(hookCalls,1);
assert.equal((await c.getStatus()).state,'drain_failed');
assert.throws(()=>acquireArtifactAccess({root,mode:'exclusive'}),error=>error.code==='owner_busy');
console.log(JSON.stringify({fault:'trusted_host_afterResourceClose',closedPromise:'pending',listener:'drain_failed',lease:'owner_busy',hookCalls}));
c.disposeNetwork();process.exit(0);
`,
    );
    const failure = await execute([runtime, failureDriver], workspace, home);
    writeFileSync(
      join(root, 'resource-close-failure-proof.json'),
      JSON.stringify(failure, null, 2),
    );
    expect(failure.code).toBe(0);
    expect(JSON.parse(failure.stdout).lease).toBe('owner_busy');
    expect(JSON.parse(failure.stdout).listener).toBe('drain_failed');
    const releaseDriver = join(root, 'after-failure-process-exit.mjs');
    writeFileSync(
      releaseDriver,
      `import {acquireArtifactAccess} from ${JSON.stringify(join(built.root, 'node_modules/@kite-ai/agent/artifact-access.js'))};acquireArtifactAccess({root:${JSON.stringify(built.root)},mode:'exclusive'}).release();console.log('process_exit_released')`,
    );
    const released = await execute([runtime, releaseDriver], workspace, home);
    expect(released.code).toBe(0);
    expect(released.stdout.trim()).toBe('process_exit_released');
  } finally {
    provider?.stop(true);
    if (process.env.KITE_TERMINAL_TEST_KEEP_BUNDLE === '1')
      console.log(`OWNED_SINGLE_FILE_PROTECTION_ROOT ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
}, 120000);

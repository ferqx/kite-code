import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyTerminalBundle } from '../../../apps/cli/host/terminal-artifact';
import { sourceServerArguments } from '../../../scripts/development/ensure-web';
import { sourceTerminalRoot } from '../../../scripts/release/source-terminal';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';

const repositoryRoot = resolve(import.meta.dir, '../../..');
function childEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: process.platform === 'win32' ? process.env.PATH : '/usr/bin:/bin',
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    KITE_CODE_HOME: join(home, '.kite-code'),
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
  };
  // Keep the test runner's orphan policy out of the deliberately detached daemon.
  delete env.BUN_FEATURE_FLAG_NO_ORPHANS;
  return env;
}
function ownedSocket(root: string, name: string) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\kite-daemon-formal-${randomUUID()}`
    : join(root, name);
}

function observation(testCase: 'pure' | 'full') {
  const origin = performance.now();
  let sequence = 0,
    cleanup = false;
  function phase(stage: string, event: string, details: Record<string, unknown> = {}) {
    console.log(
      JSON.stringify({
        observation: 'formal_terminal_entrypoints',
        testCase,
        stage,
        event,
        cleanup,
        elapsedMs: Math.round(performance.now() - origin),
        ...details,
      }),
    );
  }
  return {
    phase,
    cleanup() {
      cleanup = true;
      phase('cleanup', 'begin');
    },
    execute(command: string[], cwd: string, home: string) {
      const entry = basename(command[1] ?? '');
      const step =
        entry === 'PTY.ts'
          ? { entry: 'TUI', action: 'owned_pty' }
          : entry === 'CLI.ts' || entry === 'cli.ts'
            ? {
                entry: 'CLI',
                action:
                  command[2] === 'server' ? `server_${command[3]}` : (command[2] ?? 'default'),
              }
            : entry === 'TUI.ts' || entry === 'tui.ts'
              ? {
                  entry: 'TUI',
                  action:
                    command[2] === '--help'
                      ? 'help'
                      : command[2] === '--version'
                        ? 'version'
                        : command[2]
                          ? 'connect'
                          : 'non_tty',
                }
              : entry === 'Server.ts'
                ? { entry: 'Server', action: command[2] === '--help' ? 'help' : 'start_web' }
                : { entry: 'fixture', action: entry };
      const current = ++sequence;
      return execute(command, cwd, home, (event, details) =>
        phase('execute', event, { sequence: current, ...step, ...details }),
      );
    },
  };
}
async function execute(
  command: string[],
  cwd: string,
  home: string,
  observe: (event: string, details?: Record<string, unknown>) => void,
) {
  const origin = performance.now();
  observe('begin');
  const child = Bun.spawn(command, {
    cwd,
    env: childEnvironment(home),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let forced: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    observe('deadline', { durationMs: Math.round(performance.now() - origin) });
    child.kill('SIGTERM');
    forced = setTimeout(() => child.kill('SIGKILL'), 5000);
  }, 20000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code) console.error({ command, code, stdout, stderr });
    observe('end', { code, durationMs: Math.round(performance.now() - origin) });
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (forced) clearTimeout(forced);
    if (child.exitCode === null) {
      observe('cleanup', { durationMs: Math.round(performance.now() - origin) });
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}
function driver(root: string, kind: 'CLI' | 'TUI' | 'Server', terminal = false) {
  const path = join(root, `${kind}.ts`);
  const source =
    kind === 'Server' ? 'scripts/development/ensure-web.ts' : 'scripts/release/source-terminal.ts';
  const fn = kind === 'Server' ? 'runSourceServer' : `runSourceTerminal${kind}`;
  const tty = terminal
    ? "Object.defineProperty(process.stdin,'isTTY',{value:true});Object.defineProperty(process.stdout,'isTTY',{value:true});\n"
    : '';
  const entry =
    kind === 'Server'
      ? `try{process.exitCode=await ${fn}(process.argv.slice(2),${JSON.stringify(root)});}catch(error){process.stderr.write(String(error?.code??'terminal_host_failed')+'\\n');process.exitCode=1;}\n`
      : `import{terminalEntrypoint}from ${JSON.stringify(pathToFileURL(join(repositoryRoot, 'scripts/release/source-terminal.ts')).href)};\n${tty}await terminalEntrypoint(()=>${fn}(process.argv.slice(2),${JSON.stringify(root)}));\n`;
  writeFileSync(
    path,
    `import {${fn}} from ${JSON.stringify(pathToFileURL(join(repositoryRoot, source)).href)};\n${entry}`,
  );
  return path;
}

test('formal source wrappers pure argv and server finite projection never inspect missing candidates or profiles', async () => {
  const timing = observation('pure'),
    execute = timing.execute;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-formal-pure-'))),
    home = join(root, 'home'),
    socket = ownedSocket(root, 's.sock');
  mkdirSync(home);
  try {
    expect(sourceTerminalRoot(root)).toBe(join(root, 'dist/unified-terminal'));
    const selected = sourceServerArguments([
      '--data-root',
      join(root, 'data'),
      '--server',
      socket,
      '--workspace',
      root,
      '--json',
    ]);
    expect(selected.start).toEqual([
      'server',
      'start',
      '--data-root',
      join(root, 'data'),
      '--server',
      socket,
      '--workspace',
      root,
    ]);
    expect(selected.web).toEqual([
      'web',
      '--data-root',
      join(root, 'data'),
      '--server',
      socket,
      '--json',
    ]);
    for (const argv of [
      ['--task', 'unavailable'],
      ['--workspace'],
      ['--json', '--json'],
      ['--unknown'],
    ])
      expect(() => sourceServerArguments(argv)).toThrow();
    for (const entry of ['cli', 'tui']) {
      for (const flag of ['--help', '--version']) {
        const result = await execute(
          [process.execPath, join(repositoryRoot, `scripts/release/entrypoints/${entry}.ts`), flag],
          root,
          home,
        );
        expect(result.code).toBe(0);
        expect(result.stdout.length).toBeGreaterThan(0);
      }
    }
    const cli = driver(root, 'CLI'),
      tui = driver(root, 'TUI'),
      server = driver(root, 'Server');
    const trace = join(root, 'trace.jsonl');
    writeFileSync(trace, '');
    expect((await execute([process.execPath, cli, 'trace', trace], root, home)).code).toBe(0);
    const nonTTY = await execute([process.execPath, tui], root, home);
    expect(nonTTY.code).toBe(1);
    expect(nonTTY.stderr).toBe('tui_terminal_unavailable\n');
    expect((await execute([process.execPath, server, '--help'], root, home)).code).toBe(0);
    const missing = await execute(
      [process.execPath, cli, 'run', '--task', 'must not start'],
      root,
      home,
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('terminal_bundle_unavailable\n');
    expect(missing.stderr).toContain('npm run release:build');
    expect(missing.stderr).not.toContain(root);
    const missingTUI = await execute([process.execPath, driver(root, 'TUI', true)], root, home);
    expect(missingTUI.code).toBe(1);
    expect(missingTUI.stderr).toBe(missing.stderr);
    expect(existsSync(join(home, '.kite-code'))).toBe(false);
    expect(existsSync(join(root, 'dist'))).toBe(false);
  } finally {
    const cleanupOrigin = performance.now();
    timing.cleanup();
    rmSync(root, { recursive: true, force: true });
    timing.phase('cleanup', 'end', {
      durationMs: Math.round(performance.now() - cleanupOrigin),
    });
  }
}, 15000);

test('fresh full candidate formal wrappers run, reuse daemon Web and shared 80x24 TUI with actual completed Run facts', async () => {
  const timing = observation('full'),
    execute = timing.execute;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-formal-terminal-'))),
    home = join(root, 'home'),
    workspace = join(root, 'workspace'),
    candidate = sourceTerminalRoot(root);
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(workspace);
  const cli = driver(root, 'CLI'),
    tui = driver(root, 'TUI'),
    server = driver(root, 'Server'),
    socket = ownedSocket(root, 'owned.sock');
  let calls = 0,
    started = false,
    stopped = false,
    databasePath = '';
  const directoryObservations: Record<string, unknown>[] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method === 'GET' && new URL(request.url).pathname === '/directory-observation') {
        const db = new Database(databasePath, { readonly: true });
        try {
          directoryObservations.push({
            target: db
              .query(
                "SELECT id,delete_requested,control_revision FROM session WHERE id='resume-delete-target'",
              )
              .get(),
            active: db
              .query(
                "SELECT id,origin_command_id,cancel_requested FROM run WHERE session_id='formal-session' AND is_active=1",
              )
              .get(),
            deletions: db
              .query(
                "SELECT id,session_id,request_json,receipt_json FROM command WHERE kind='session.delete'",
              )
              .all(),
            calls,
          });
          return new Response('observed');
        } finally {
          db.close(true);
        }
      }
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      const user = [...body.messages]
        .reverse()
        .find(
          (m) => m.role === 'user' && ['formal source task', 'formal TUI task'].includes(m.content),
        )?.content;
      if (user === undefined) return new Response('unexpected original work', { status: 500 });
      expect(['formal source task', 'formal TUI task'].includes(user)).toBe(true);
      calls++;
      if (user === 'formal TUI task') {
        writeFileSync(join(root, 'tui-model-started'), 'original model waiting');
        while (!stopped && !existsSync(join(root, 'release-tui-model'))) await Bun.sleep(5);
      }
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: 'formal', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        frame(
          {
            content: user === 'formal source task' ? 'FORMAL CLI COMPLETE' : 'FORMAL TUI COMPLETE',
          },
          null,
        ) +
          frame({}, 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  let runtime = '';
  try {
    const buildOrigin = performance.now();
    timing.phase('candidate_build', 'begin');
    const built = await buildTerminalBundle({
      destination: candidate,
      repositoryRoot,
      bunExecutable: process.execPath,
    });
    timing.phase('candidate_build', 'end', {
      durationMs: Math.round(performance.now() - buildOrigin),
    });
    expect(built.root).toBe(candidate);
    expect(built.buildId).toBe(`terminal-${built.digest}`);
    runtime = join(candidate, built.manifest.entries.runtime);
    const manifest = readFileSync(join(candidate, 'terminal-manifest.json'));
    const manifestPath = join(candidate, 'terminal-manifest.json');
    const wrongTarget = JSON.parse(manifest.toString('utf8'));
    wrongTarget.target.arch = process.arch === 'arm64' ? 'x64' : 'arm64';
    writeFileSync(manifestPath, JSON.stringify(wrongTarget));
    const wrongPlatform = await execute(
      [process.execPath, cli, 'server', 'start', '--server', socket],
      workspace,
      home,
    );
    expect(wrongPlatform.code).toBe(1);
    expect(wrongPlatform.stderr).toBe('terminal_target_mismatch\n');
    expect(existsSync(join(home, '.kite-code'))).toBe(false);
    writeFileSync(manifestPath, manifest);
    const protectedEntry = join(candidate, built.manifest.entries.service),
      entryBytes = readFileSync(protectedEntry);
    writeFileSync(
      protectedEntry,
      Buffer.concat([entryBytes, Buffer.from('\n//before-profile-tamper')]),
    );
    const earlyTamper = await execute(
      [process.execPath, cli, 'run', '--task', 'must not start'],
      workspace,
      home,
    );
    expect(earlyTamper.code).toBe(1);
    expect(earlyTamper.stderr).toContain('terminal_bundle_identity_mismatch');
    expect(existsSync(join(home, '.kite-code'))).toBe(false);
    writeFileSync(protectedEntry, entryBytes);

    const setup = join(root, 'setup.mjs'),
      dataRoot = join(home, '.kite-code', 'unified-agent');
    writeFileSync(
      setup,
      `import {selectProfile} from ${JSON.stringify(pathToFileURL(join(candidate, 'node_modules/@kite-ai/agent/profile.js')).href)};import {mkdirSync} from 'node:fs';const p=selectProfile({dataRoot:${JSON.stringify(dataRoot)},profile:'default'});mkdirSync(p.profilePath,{recursive:true,mode:0o700});console.log(JSON.stringify(p));`,
    );
    const prepared = await execute([runtime, setup], workspace, home);
    expect(prepared.code).toBe(0);
    const profile = JSON.parse(prepared.stdout) as { profilePath: string; databasePath: string };
    databasePath = profile.databasePath;
    mkdirSync(join(profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'fixed',
        tools: [],
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `${provider.url.href}v1`,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const run = await execute(
      [
        process.execPath,
        cli,
        'run',
        '--thread',
        'formal-session',
        '--task',
        'formal source task',
        '--workspace',
        workspace,
        '--trust-workspace',
        '--full',
      ],
      workspace,
      home,
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('FORMAL CLI COMPLETE');
    expect(calls).toBe(1);
    const read = join(root, 'read.mjs');
    writeFileSync(
      read,
      `import {openSqliteStore} from ${JSON.stringify(pathToFileURL(join(candidate, 'node_modules/@kite-ai/agent/sqlite.js')).href)};const s=await openSqliteStore({dataRoot:${JSON.stringify(dataRoot)},profile:'default',mode:'readonly'});try{const executions=await s.listExecutions('formal-session');const runs=await Promise.all([...new Set(executions.map(e=>e.runId))].map(id=>s.getRun(id)));console.log(JSON.stringify({session:await s.getSession('formal-session'),runs,executions,messages:await s.listMessages('formal-session')}));}finally{await s.close();}`,
    );
    const before = await execute([runtime, read], workspace, home);
    expect(before.code).toBe(0);
    const first = JSON.parse(before.stdout);
    expect(first.session.id).toBe('formal-session');
    expect(first.runs).toHaveLength(1);
    expect(first.runs[0].status).toBe('completed');
    expect(first.executions).toHaveLength(1);
    const launched = await execute(
      [process.execPath, server, '--server', socket, '--workspace', workspace, '--json'],
      workspace,
      home,
    );
    expect(launched.code).toBe(0);
    started = true;
    const lines = launched.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    const identity = lines[0];
    expect(identity.state).toBe('accepting');
    expect(identity.runningBuildId).toBe(built.buildId);
    const web = lines[1];
    expect(web.instanceId).toBe(identity.instanceId);
    const webURL = new URL(web.url);
    expect(webURL.hostname).toBe('127.0.0.1');
    expect((await fetch(webURL)).status).toBe(200);
    const reused = await execute(
      [process.execPath, server, '--server', socket, '--workspace', workspace, '--json'],
      workspace,
      home,
    );
    expect(reused.code).toBe(0);
    const reusedLines = reused.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(reusedLines[0].reused).toBe(true);
    expect(reusedLines[0].instanceId).toBe(identity.instanceId);
    expect(reusedLines[1].url).toBe(web.url);
    const status = await execute(
      [process.execPath, cli, 'server', 'status', '--server', socket, '--json'],
      workspace,
      home,
    );
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout).instanceId).toBe(identity.instanceId);
    const seedDirectory = join(root, 'seed-directory.mjs');
    writeFileSync(
      seedDirectory,
      `import {selectProfile} from ${JSON.stringify(pathToFileURL(join(candidate, 'node_modules/@kite-ai/agent/profile.js')).href)};import {requestDaemonBootstrap,selectDaemonEndpoint} from ${JSON.stringify(pathToFileURL(join(candidate, 'node_modules/@kite-ai/service/daemon.js')).href)};import {createClient} from ${JSON.stringify(pathToFileURL(join(candidate, 'node_modules/@kite-ai/client/index.js')).href)};const p=selectProfile({dataRoot:${JSON.stringify(dataRoot)},profile:'default'}),profile={dataRoot:p.dataRoot,name:p.profile,accessKey:p.profileAccessKey};const b=await requestDaemonBootstrap(selectDaemonEndpoint({profileAccessKey:p.profileAccessKey,explicitSocket:${JSON.stringify(socket)}}),profile);const c=createClient({endpoint:b.httpEndpoint,token:b.token,expected:{profile,apiMajor:1,instanceId:b.instanceId,buildId:b.buildId,requiredCapabilities:['sessions','commands']}});try{const info=await c.connect();await c.createSession({expectedStoreId:info.storeId,commandId:'create-resume-delete-target',sessionId:'resume-delete-target',workspaceId:${JSON.stringify(first.session.workspaceId)},title:'Directory delete target'});console.log('DIRECTORY_SEEDED');}finally{c.disposeNetwork();}`,
    );
    const seeded = await execute([runtime, seedDirectory], workspace, home);
    expect(seeded.code).toBe(0);
    expect(seeded.stdout).toContain('DIRECTORY_SEEDED');
    expect(calls).toBe(1);
    const ptyDriver = join(root, 'PTY.ts');
    writeFileSync(
      ptyDriver,
      `import assert from 'node:assert/strict';
import {existsSync,writeFileSync} from 'node:fs';
import {ptyDeadline,spawnTuiPTY,terminateTuiTree} from ${JSON.stringify(pathToFileURL(join(repositoryRoot, 'apps/cli/test/fixtures/tui-pty.ts')).href)};
const owned=spawnTuiPTY({cmd:[${JSON.stringify(process.execPath)},${JSON.stringify(tui)},'--test-ui-diagnostics','--thread','formal-session','--workspace',${JSON.stringify(workspace)},'--server',${JSON.stringify(socket)}],cwd:${JSON.stringify(workspace)}});
const cancelled=new AbortController();
process.once('SIGTERM',()=>cancelled.abort(Error('owned PTY cancelled')));
const cancellation=new Promise((_,reject)=>cancelled.signal.addEventListener('abort',()=>reject(cancelled.signal.reason),{once:true}));
void cancellation.catch(()=>{});
function cancellable(work){cancelled.signal.throwIfAborted();return Promise.race([work,cancellation]);}
async function observeDirectory(){
 const response=await fetch(${JSON.stringify(`${provider.url.href}directory-observation`)},{signal:cancelled.signal});
 assert.equal(response.status,200);
 await response.arrayBuffer();
}
let action=false;
// Keep the original driver's exact raw material checks after each key.
const ansi=/\\x1b\\[[0-?]*[ -/]*[@-~]/g;
async function readUntil(text,seconds){
 const end=Date.now()+seconds*1000;
 while(!(action?owned.sinceAction():owned.text()).replace(ansi,'').includes(text)){
  cancelled.signal.throwIfAborted();
  assert.ok(Date.now()<end,'formal PTY deadline '+owned.text().slice(-4000));
  await owned.drain();
  await Bun.sleep(20);
 }
}
async function key(value,text){action=true;await owned.key(value);await readUntil(text,10);}
async function selectDeleteTarget(){
 const end=Date.now()+10000;
 for(;;){
  cancelled.signal.throwIfAborted();
  await owned.drain();
  const frame=owned.viewport();
  const rows=frame.split('\\n');
  const target=rows.findIndex(line=>line.includes('Directory delete target'));
  const selected=rows.findIndex(line=>line.includes('❯ '));
  if(target>=0&&target===selected)return;
  assert.ok(Date.now()<end,'formal Session target selection deadline '+frame);
  if(!frame.includes('Loading session history')&&target>=0&&selected>=0){
   action=true;await owned.key(target<selected?'\\x1b[A':'\\x1b[B');
  }
  await Bun.sleep(20);
 }
}
try{
 await readUntil('FORMAL CLI COMPLETE',10);
 await readUntil('New Run >',10);
 action=true;await owned.key('formal TUI task');
 await readUntil('formal TUI task',10);
 await owned.key('\\r');
 await readUntil('Working',10);
 const end=Date.now()+10000;
 while(!existsSync(${JSON.stringify(join(root, 'tui-model-started'))})){
  cancelled.signal.throwIfAborted();
  assert.ok(Date.now()<end,'original model did not start');
  await owned.drain();await Bun.sleep(20);
 }
 await key('\\x12','Select Session (arrows/Enter, Esc)');
 await readUntil('Directory delete target',10);
 await selectDeleteTarget();
 await key('d','Delete Session?');await readUntil('Original Session [resume-delete-target]',10);await readUntil('❯ Keep Session',10);
 await key('\\r','Select Session (arrows/Enter, Esc)');
 await observeDirectory();
 await key('d','Delete Session?');await readUntil('Original Session [resume-delete-target]',10);await readUntil('❯ Keep Session',10);
 await key('\\x1b[B','❯ Delete Session');
 await key('\\r','delete_requested');await readUntil('stop unconfirmed',10);
 await observeDirectory();
 // The confirmed original deletion and refreshed directory close the chooser.
 // Wait for its real main-screen handoff; Escape there would cancel held work.
 const closedDeadline=Date.now()+10000;
 for(;;){
  cancelled.signal.throwIfAborted();await owned.drain();
  const frame=owned.viewport();
  if(frame.includes('Working')&&!frame.includes('Select Session (arrows/Enter, Esc)')&&!frame.includes('Delete Session?'))break;
  assert.ok(Date.now()<closedDeadline,'confirmed directory deletion did not return to original main '+frame);
  await Bun.sleep(20);
 }
 writeFileSync(${JSON.stringify(join(root, 'release-tui-model'))},'explicit fixture release');
 await readUntil('FORMAL TUI COMPLETE',10);
 await owned.key('\\x11');
 const exitDeadline=Date.now()+5000;
 while(!owned.ended&&Date.now()<exitDeadline){cancelled.signal.throwIfAborted();await cancellable(owned.drain());await cancellable(Bun.sleep(20));}
 const code=await ptyDeadline(cancellable(Promise.all([owned.host.exited,owned.eof]).then(([code])=>code)),3000,'host exit timeout');
 assert.equal(code,0);
 await owned.drain();
 writeFileSync(${JSON.stringify(join(root, 'pty-output'))},owned.text());
 console.log('FORMAL_PTY_COMPLETE');
}finally{
 writeFileSync(${JSON.stringify(join(root, 'pty-output'))},owned.text());
 try{if(!owned.ended)await terminateTuiTree(owned,{exitTimeoutMs:3000});}
 finally{owned.close();}
}
`,
    );
    const pty = await execute([process.execPath, ptyDriver], workspace, home);
    expect(pty.code).toBe(0);
    expect(pty.stdout).toContain('FORMAL_PTY_COMPLETE');
    expect(directoryObservations).toHaveLength(2);
    expect(directoryObservations[0]).toMatchObject({
      target: { id: 'resume-delete-target', delete_requested: 0, control_revision: 0 },
      active: { cancel_requested: 0 },
      deletions: [],
      calls: 2,
    });
    expect(directoryObservations[1]).toMatchObject({
      target: { id: 'resume-delete-target', delete_requested: 1, control_revision: 1 },
      active: directoryObservations[0]!.active,
      calls: 2,
    });
    const deletions = directoryObservations[1]!.deletions as {
      session_id: string;
      request_json: string;
      receipt_json: string;
    }[];
    expect(deletions).toHaveLength(1);
    expect(deletions[0]!.session_id).toBe('resume-delete-target');
    expect(JSON.parse(deletions[0]!.request_json)).toEqual({
      kind: 'session.delete',
      ifRevision: '0',
    });
    expect(JSON.parse(deletions[0]!.receipt_json)).toMatchObject({
      outcome: 'delete_requested',
      stopConfirmed: false,
      session: { id: 'resume-delete-target' },
    });
    const after = await execute([runtime, read], workspace, home);
    expect(after.code).toBe(0);
    const facts = JSON.parse(after.stdout);
    expect(facts.runs).toHaveLength(2);
    expect(facts.runs.every((r: { status: string }) => r.status === 'completed')).toBe(true);
    expect(facts.executions).toHaveLength(2);
    expect(calls).toBe(2);
    const publicRead = join(root, 'public-read.mjs');
    writeFileSync(
      publicRead,
      `import {selectProfile} from ${JSON.stringify(pathToFileURL(join(candidate, 'node_modules/@kite-ai/agent/profile.js')).href)};import {requestDaemonBootstrap,selectDaemonEndpoint} from ${JSON.stringify(pathToFileURL(join(candidate, 'node_modules/@kite-ai/service/daemon.js')).href)};import {createClient} from ${JSON.stringify(pathToFileURL(join(candidate, 'node_modules/@kite-ai/client/index.js')).href)};const p=selectProfile({dataRoot:${JSON.stringify(dataRoot)},profile:'default'}),profile={dataRoot:p.dataRoot,name:p.profile,accessKey:p.profileAccessKey};const b=await requestDaemonBootstrap(selectDaemonEndpoint({profileAccessKey:p.profileAccessKey,explicitSocket:${JSON.stringify(socket)}}),profile);const c=createClient({endpoint:b.httpEndpoint,token:b.token,expected:{profile,apiMajor:1,instanceId:b.instanceId,buildId:b.buildId,requiredCapabilities:['sessions','history']}});try{const info=await c.connect();console.log(JSON.stringify({storeId:info.storeId,view:await c.getView('formal-session'),runs:await Promise.all(${JSON.stringify(facts.runs.map((r: { id: string }) => r.id))}.map(id=>c.getRun(id)))}));}finally{c.disposeNetwork();}`,
    );
    const publicResult = await execute([runtime, publicRead], workspace, home);
    expect(publicResult.code).toBe(0);
    const actual = JSON.parse(publicResult.stdout);
    expect(actual.view).toMatchObject({
      storeId: actual.storeId,
      session: { id: 'formal-session', workspaceId: facts.session.workspaceId },
    });
    expect(actual.runs).toHaveLength(2);
    for (const run of actual.runs)
      expect(run).toMatchObject({
        originStoreId: actual.storeId,
        sessionId: 'formal-session',
        status: 'completed',
        isActive: false,
      });
    expect(calls).toBe(2);

    expect(readFileSync(join(candidate, 'terminal-manifest.json'))).toEqual(manifest);
    const verifyOrigin = performance.now();
    timing.phase('candidate_reverify', 'begin');
    expect(verifyTerminalBundle(candidate).digest).toBe(built.digest);
    timing.phase('candidate_reverify', 'end', {
      durationMs: Math.round(performance.now() - verifyOrigin),
    });
    const stopOrigin = performance.now();
    timing.phase('final_server_stop', 'begin');
    expect(
      (
        await execute(
          [process.execPath, cli, 'server', 'stop', '--server', socket],
          workspace,
          home,
        )
      ).code,
    ).toBe(0);
    timing.phase('final_server_stop', 'end', {
      durationMs: Math.round(performance.now() - stopOrigin),
    });
    started = false;
    const asset = join(candidate, built.manifest.entries.service),
      original = readFileSync(asset);
    writeFileSync(asset, Buffer.concat([original, Buffer.from('\n//tampered')]));
    const tampered = await execute(
      [process.execPath, cli, 'run', '--task', 'must never submit'],
      workspace,
      home,
    );
    expect(tampered.code).toBe(1);
    expect(tampered.stderr).toContain('terminal_bundle_identity_mismatch');
    writeFileSync(asset, original);
    console.log(
      JSON.stringify({
        qualification: 'formal-source-terminal',
        buildId: built.buildId,
        digest: built.digest,
        providerCalls: calls,
        sessionId: facts.session.id,
        runIds: facts.runs.map((r: { id: string }) => r.id),
        runStatuses: facts.runs.map((r: { status: string }) => r.status),
        daemonInstanceId: identity.instanceId,
        web,
      }),
    );
  } finally {
    const cleanupOrigin = performance.now();
    timing.cleanup();
    stopped = true;
    if (started)
      await execute([process.execPath, cli, 'server', 'stop', '--server', socket], workspace, home);
    provider.stop(true);
    timing.phase('cleanup', 'end', {
      durationMs: Math.round(performance.now() - cleanupOrigin),
    });
    // Retain fresh physical candidate and PTY evidence for independent review; no profile authority escapes.
  }
}, 60000);

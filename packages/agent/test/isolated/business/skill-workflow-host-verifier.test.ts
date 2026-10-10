import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createSkillWorkflowVerifier } from '../../../src/business/skill-workflow/verifier';
import type { JobEvent, JobHandle } from '../../../src/extensions';
import { captureMacosHostLaunch } from '../../../src/jobs/host-preparation';
import {
  decodeMacosShellProcessEvidence,
  type MacosShellProcessEvidence,
  shellProcessEvidenceEnded,
} from '../../../src/jobs/shell';
import { compileSkillWorkflow } from '../../../src/skills/workflow-contract';

const mac = process.platform === 'darwin' ? test : test.skip;
let assets: string;
let supervisor: string;
let library: string;
const roots: string[] = [];
beforeAll(async () => {
  if (process.platform !== 'darwin') return;
  assets = realpathSync.native(mkdtempSync('/private/tmp/kite-workflow-host-assets-'));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, '../../../src/platform/process/shell-supervisor.ts')],
    outdir: assets,
    target: 'bun',
    naming: 'guardian.js',
  });
  expect(built.success).toBe(true);
  supervisor = built.outputs[0]!.path;
  library = join(assets, 'source.dylib');
  writeFileSync(join(assets, 'source.c'), 'int source_answer(void) { return 43; }\n');
  const compiler = Bun.spawn(
    [
      '/usr/bin/clang',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-dynamiclib',
      join(assets, 'source.c'),
      '-o',
      library,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(compiler.stdout).text(),
    new Response(compiler.stderr).text(),
    compiler.exited,
  ]);
  expect(code, `${stdout}${stderr}`).toBe(0);
  const { dlopen, FFIType } = await import('bun:ffi');
  const native = dlopen(library, { source_answer: { args: [], returns: FFIType.int } });
  try {
    expect(native.symbols.source_answer()).toBe(43);
  } finally {
    native.close();
  }
});
afterAll(() => {
  for (const root of roots) {
    if (readdirSync(join(root, 'control')).length || readdirSync(join(root, 'temp')).length)
      continue;
    rmSync(root, { recursive: true, force: true });
  }
  if (assets && roots.every((root) => !existsSync(root)))
    rmSync(assets, { recursive: true, force: true });
});
function fixture(script: string, timeout = 5000, full = false) {
  const root = realpathSync.native(mkdtempSync('/private/tmp/kite-workflow-host-verifier-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const data = join(root, 'data');
  const control = join(root, 'control');
  const temp = join(root, 'temp');
  const skill = join(data, 'profiles', 'selected', 'skills', 'checker');
  for (const path of [workspace, control, temp, skill, join(skill, 'node_modules', 'ignored')])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(data, 'secret'), 'other private data');
  writeFileSync(join(control, 'secret'), 'coordination data');
  writeFileSync(join(skill, 'helper.ts'), "export const selected = 'relative original helper';\n");
  writeFileSync(join(skill, 'node_modules', 'ignored', 'resource'), 'original ignored resource');
  copyFileSync('/bin/echo', join(skill, 'native'));
  copyFileSync(library, join(skill, 'source.dylib'));
  const manifest = {
    name: 'checker',
    version: '1.0.0',
    description: 'Original private script verifier',
    invocation: { allow_implicit: false, allow_manual: true },
    context: { mode: 'inline', agent: 'code' },
    input_schema: { type: 'object' },
    output_schema: {
      type: 'object',
      properties: { ok: { const: true } },
      required: ['ok'],
      additionalProperties: false,
    },
    capabilities: { require: [], deny: [] },
    effects: { filesystem: 'write', network: 'none', external_state: 'none' },
    approval: { minimum: 'user' },
    execution: { timeout_ms: 5000, max_attempts: 1 },
    verification: {
      mode: 'required',
      strategy: 'script',
      entrypoint: 'check.ts',
      timeout_ms: timeout,
    },
    recovery: { retry: 'never' },
  };
  writeFileSync(
    join(skill, 'SKILL.md'),
    `---\n${JSON.stringify(manifest)}\n---\nOriginal checker\n`,
  );
  writeFileSync(join(skill, 'check.ts'), script);
  const entry = compileSkillWorkflow({ skillDir: skill, source: 'user', origin: '.agents' });
  expect(entry.diagnostics).toEqual([]);
  const host = {
    controlBase: control,
    protectedRoots: [data],
    runtimeReadOnlyRoots: [dirname(process.execPath), assets],
    temporaryRoot: temp,
    filesystemScope: full ? ('full_access' as const) : ('workspace_write' as const),
  };
  const verifier = createSkillWorkflowVerifier({
    entries: [entry],
    shell: {
      cwd: workspace,
      env: { PATH: '/usr/bin:/bin', WORKSPACE: workspace, DATA: data, CONTROL: control },
      supervisorPath: supervisor,
      bunExecutable: process.execPath,
      shellExecutable: '/bin/sh',
    },
    host,
  });
  const job = verifier.extension.jobs![0]!;
  const output = { ok: true };
  const input = verifier.verificationJob.prepare({
    entry,
    activationId: 'original',
    attempt: 1,
    outputDigest: createHash('sha256').update(JSON.stringify(output)).digest('hex'),
    output,
  });
  return {
    root,
    workspace,
    data,
    control,
    temp,
    skill,
    host,
    job,
    start: () =>
      job.start(input, {
        sessionId: 'host-workflow',
        executionId: crypto.randomUUID(),
        signal: new AbortController().signal,
      }),
  };
}
async function observe(job: ReturnType<typeof fixture>['job'], handle: JobHandle) {
  const events: JobEvent[] = [];
  for await (const event of job.observe(handle)) events.push(event);
  return events;
}
function ended(events: JobEvent[], handle: JobHandle) {
  const terminals = events.filter((event) => event.type === 'terminal');
  expect(terminals).toHaveLength(1);
  const terminal = terminals[0]!;
  expect(terminal.supervision).toBe('ended');
  const outer = terminal.result.details as Record<string, unknown>;
  const details = (outer.shellResult ?? outer) as Record<string, unknown>;
  expect(details).toMatchObject({ processTreeStopped: true, groupStopped: true });
  const original = (handle.reference as unknown as { ownedProcesses: MacosShellProcessEvidence })
    .ownedProcesses;
  const evidence = decodeMacosShellProcessEvidence(
    details.ownedProcesses,
    original.binding,
    process.pid,
  );
  expect(evidence?.coverage).toBe('shell-owned-coalition');
  expect(evidence && shellProcessEvidenceEnded(evidence)).toBe(true);
  return terminal;
}
const originalSourceScript = `
import {selected} from './helper';
import {readFileSync,writeFileSync,readdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {dlopen,FFIType} from 'bun:ffi';
const source=process.cwd(), workspace=process.env.WORKSPACE!, data=process.env.DATA!, control=process.env.CONTROL!;
const denied=(label:string,operation:()=>unknown)=>{
  try { operation(); throw Error('unexpected allow:'+label); }
  catch(error) { if (!['EACCES','EPERM'].includes((error as any).code)) throw error; console.log('denied:'+label); }
};
const resource=readFileSync('node_modules/ignored/resource','utf8');
writeFileSync(join(workspace,'original-result'),JSON.stringify({source,selected,resource}));
denied('private',()=>readFileSync(join(data,'secret')));
denied('coordination',()=>readFileSync(join(control,'secret')));
denied('ancestor-list',()=>readdirSync(join(data,'profiles')));
denied('source-write',()=>writeFileSync('check.ts','replace original'));
denied('source-create',()=>writeFileSync('created','new source'));
denied('private-write',()=>writeFileSync(join(data,'secret'),'replace private'));
denied('source-move',()=>renameSync(source,source+'-moved'));
denied('ancestor-move',()=>renameSync(join(data,'profiles'),join(data,'moved')));
denied('native-exec',()=>Bun.spawnSync([join(source,'native'),'untrusted native']));
let mapped=false;
try { const native=dlopen(join(source,'source.dylib'),{source_answer:{args:[],returns:FFIType.int}}); mapped=true; native.close(); }
catch(error) { console.log('denied:native-map'); }
if(mapped)throw Error('unexpected native map');
console.log('original-source-complete');
`;
mac.each([false, true])(
  'original Profile source remains readable, readonly and protected in Full=%s',
  async (full) => {
    const f = fixture(originalSourceScript, 5000, full);
    const handle = await f.start();
    try {
      const events = await observe(f.job, handle);
      const output = events
        .filter((event) => event.type === 'output')
        .map((event) => event.content)
        .join('');
      expect(ended(events, handle).result.outcome, output).toBe('succeeded');
      for (const label of [
        'private',
        'coordination',
        'ancestor-list',
        'source-write',
        'source-create',
        'private-write',
        'source-move',
        'ancestor-move',
        'native-exec',
        'native-map',
      ])
        expect(output).toContain(`denied:${label}`);
      expect(output).toContain('original-source-complete');
      expect(JSON.parse(readFileSync(join(f.workspace, 'original-result'), 'utf8'))).toEqual({
        source: f.skill,
        selected: 'relative original helper',
        resource: 'original ignored resource',
      });
      expect(readFileSync(join(f.skill, 'check.ts'), 'utf8')).toBe(originalSourceScript);
      expect(readFileSync(join(f.data, 'secret'), 'utf8')).toBe('other private data');
      expect((await f.job.cancel(handle)).status).toBe('already_finished');
    } finally {
      await f.job.dispose(handle);
    }
    expect(readdirSync(f.temp)).toEqual([]);
    expect(readdirSync(f.control)).toEqual(['secret']);
    // The fixture's non-runtime coordination sentinel is removed only after actual disposal.
    rmSync(join(f.control, 'secret'));
  },
);
mac(
  'Profile source drift and invalid trusted projections refuse before business starts',
  async () => {
    const f = fixture(
      "import{writeFileSync}from'node:fs';writeFileSync(process.env.WORKSPACE+'/effect','started');",
    );
    writeFileSync(join(f.skill, 'helper.ts'), "export const selected='changed';");
    await expect(f.start()).rejects.toThrow('workflow_source_changed');
    expect(existsSync(join(f.workspace, 'effect'))).toBe(false);
    for (const source of [f.data, f.control, f.workspace])
      expect(() =>
        captureMacosHostLaunch(
          { ...f.host, cwd: source, workspaceRoot: f.workspace, readOnlySourceRoot: source },
          [supervisor, process.execPath, '/bin/sh'],
        ),
      ).toThrow('shell_readonly_source_invalid');
    rmSync(join(f.control, 'secret'));
  },
);
mac.each(['cancel', 'timeout'] as const)(
  'Profile verifier %s retains whole-tree stopping proof',
  async (reason) => {
    const f = fixture(
      `
import {writeFileSync} from 'node:fs';
const child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},100)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});
writeFileSync(process.env.WORKSPACE+'/pids',process.pid+' '+child.pid);
setInterval(()=>{},100);
`,
      reason === 'timeout' ? 1000 : 5000,
    );
    const handle = await f.start();
    try {
      const observing = observe(f.job, handle);
      const deadline = Date.now() + 2000;
      while (!existsSync(join(f.workspace, 'pids'))) {
        if (Date.now() > deadline) throw Error('workflow_host_script_not_started');
        await Bun.sleep(10);
      }
      const pids = readFileSync(join(f.workspace, 'pids'), 'utf8').split(' ').map(Number);
      if (reason === 'cancel') expect((await f.job.cancel(handle)).status).toBe('stopped');
      const terminal = ended(await observing, handle);
      expect(terminal.result.outcome).toBe(reason === 'timeout' ? 'failed' : 'cancelled');
      if (reason === 'timeout')
        expect(terminal.result.content).toBe('workflow_verification_timeout');
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await f.job.dispose(handle);
    }
    expect(readdirSync(f.temp)).toEqual([]);
    expect(readdirSync(f.control)).toEqual(['secret']);
    rmSync(join(f.control, 'secret'));
  },
);

import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillWorkflowCompensator } from '../../../src/business/skill-workflow/compensator';
import type { JobEvent, Json } from '../../../src/extensions';
import { canonicalJson } from '../../../src/json';
import { compileSkillWorkflow } from '../../../src/skills/workflow-contract';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const mac = process.platform === 'darwin' ? test : test.skip;
async function fixture(script: string, timeoutMs = 5000) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-workflow-compensator-')));
  roots.push(root);
  const workspace = join(root, 'workspace'),
    skillDir = join(workspace, 'skill'),
    runtimeRoot = join(root, 'runtime'),
    profile = join(root, 'profile');
  for (const path of [skillDir, runtimeRoot, profile]) mkdirSync(path, { recursive: true });
  const manifest = {
    name: 'compensator',
    version: '1.0.0',
    description: 'Original declared compensation',
    invocation: { allow_implicit: false, allow_manual: true },
    context: { mode: 'inline', agent: 'code' },
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    capabilities: { require: [], deny: [] },
    effects: { filesystem: 'write', network: 'none', external_state: 'none' },
    approval: { minimum: 'user' },
    execution: { timeout_ms: timeoutMs, max_attempts: 1 },
    verification: { mode: 'required' },
    recovery: { retry: 'never', compensation: 'compensate.ts' },
  };
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\n${JSON.stringify(manifest)}\n---\nCompensate only by user\n`,
  );
  writeFileSync(join(skillDir, 'compensate.ts'), script);
  writeFileSync(join(skillDir, 'bytes.bin'), Buffer.from([0, 255, 0xc0, 0xfe, 1]));
  const entry = compileSkillWorkflow({ skillDir, source: 'project', origin: '.agents' });
  expect(entry.diagnostics).toEqual([]);
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, '../../../src/platform/process/shell-supervisor.ts')],
    outdir: join(root, 'assets'),
    target: 'bun',
    naming: 'shell-supervisor.js',
  });
  expect(built.success).toBe(true);
  const create = (cwd = workspace) =>
    createSkillWorkflowCompensator({
      entries: [entry],
      protectedRoots: [profile],
      temporaryRoot: runtimeRoot,
      shell: {
        cwd,
        env: { SECRET_SHOULD_NOT_ENTER: 'private-provider-token' },
        supervisorPath: built.outputs[0]!.path,
        bunExecutable: process.execPath,
        shellExecutable: '/bin/sh',
      },
    });
  const compensator = create(),
    job = compensator.extension.jobs![0]!;
  const input = compensator.compensationJob.prepare({
    entry,
    activationId: 'one',
    attempt: 1,
    outputDigest: createHash('sha256').update(canonicalJson({})).digest('hex'),
    output: {},
    decisionKey: 'original/accepted/decision',
    decisionDigest: 'a'.repeat(64),
  });
  const start = (value: Json = input, signal = new AbortController().signal) =>
    job.start(value, { sessionId: 's', executionId: crypto.randomUUID(), signal });
  const collect = async (handle: Awaited<ReturnType<typeof start>>) => {
    const events: JobEvent[] = [];
    for await (const event of job.observe(handle)) events.push(event);
    return events;
  };
  return {
    root,
    workspace,
    skillDir,
    runtimeRoot,
    profile,
    entry,
    compensator,
    job,
    input,
    create,
    start,
    collect,
  };
}
mac(
  'declared compensation executes complete original bytes and binary assets in the Workspace with no secret environment',
  async () => {
    const body = '补偿完整正文'.repeat(10000);
    const f = await fixture(
      `import{writeFileSync,readFileSync}from'node:fs';const body=${JSON.stringify(body)};writeFileSync('actual',JSON.stringify({body,bytes:[...readFileSync(import.meta.dir+'/bytes.bin')],cwd:process.cwd(),secret:process.env.SECRET_SHOULD_NOT_ENTER??null}));`,
    );
    const handle = await f.start();
    try {
      expect((await f.collect(handle)).at(-1)).toMatchObject({
        type: 'terminal',
        supervision: 'ended',
        result: { outcome: 'succeeded' },
      });
      expect(JSON.parse(readFileSync(join(f.workspace, 'actual'), 'utf8'))).toEqual({
        body,
        bytes: [0, 255, 192, 254, 1],
        cwd: f.workspace,
        secret: null,
      });
      expect((handle.reference as Record<string, Json>).assetsDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(readdirSync(f.runtimeRoot)).toEqual([]);
      expect((await f.job.cancel(handle)).status).toBe('already_finished');
    } finally {
      await f.job.dispose(handle);
    }
  },
);
mac(
  'network, profile and sealed-code writes remain denied after the user chose compensation',
  async () => {
    let accepts = 0;
    const server = createServer((socket) => {
      accepts++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      const port = (server.address() as { port: number }).port;
      f = await fixture(
        `import{writeFileSync}from'node:fs';import{connect}from'node:net';let profile='none',sealed='none';try{writeFileSync(${JSON.stringify('PROFILE_PLACEHOLDER')},'escaped');profile='wrote'}catch{profile='denied'}try{writeFileSync(import.meta.dir+'/bytes.bin','replaced');sealed='wrote'}catch{sealed='denied'}const socket=connect(${port},'127.0.0.1');socket.on('error',()=>{writeFileSync('denials',JSON.stringify({profile,sealed}));socket.destroy()});setTimeout(()=>socket.destroy(),100);`,
      );
      writeFileSync(
        join(f.skillDir, 'compensate.ts'),
        readFileSync(join(f.skillDir, 'compensate.ts'), 'utf8').replace(
          'PROFILE_PLACEHOLDER',
          join(f.profile, 'escaped'),
        ),
      );
      const changed = compileSkillWorkflow({
        skillDir: f.skillDir,
        source: 'project',
        origin: '.agents',
      });
      const leaf = createSkillWorkflowCompensator({
        entries: [changed],
        protectedRoots: [f.profile],
        temporaryRoot: f.runtimeRoot,
        shell: {
          cwd: f.workspace,
          env: {},
          supervisorPath: join(f.root, 'assets/shell-supervisor.js'),
          bunExecutable: process.execPath,
        },
      });
      const job = leaf.extension.jobs![0]!,
        input = leaf.compensationJob.prepare({
          entry: changed,
          activationId: 'one',
          attempt: 1,
          outputDigest: createHash('sha256').update('{}').digest('hex'),
          output: {},
          decisionKey: 'original',
          decisionDigest: 'a'.repeat(64),
        });
      const handle = await job.start(input, {
        sessionId: 's',
        executionId: 'exact',
        signal: new AbortController().signal,
      });
      try {
        for await (const event of job.observe(handle))
          if (event.type === 'terminal')
            expect(event).toMatchObject({ supervision: 'ended', result: { outcome: 'succeeded' } });
      } finally {
        await job.dispose(handle);
      }
      expect(accepts).toBe(0);
      expect(existsSync(join(f.profile, 'escaped'))).toBe(false);
      expect(JSON.parse(readFileSync(join(f.workspace, 'denials'), 'utf8'))).toEqual({
        profile: 'denied',
        sealed: 'denied',
      });
      expect(readdirSync(f.runtimeRoot)).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
mac('source, root and closed input drift reject before a compensation effect', async () => {
  const f = await fixture("import{writeFileSync}from'node:fs';writeFileSync('actual','original');");
  for (const change of [
    { command: 'touch actual' },
    { cwd: f.workspace },
    { attempt: 0 },
    { outputDigest: '0'.repeat(64) },
    { decisionDigest: 'fake' },
  ])
    await expect(
      f.start(JSON.parse(JSON.stringify({ ...(f.input as object), ...change })) as Json),
    ).rejects.toThrow('workflow_compensator_input_invalid');
  writeFileSync(join(f.skillDir, 'compensate.ts'), "throw Error('changed source');");
  await expect(f.start()).rejects.toThrow('workflow_source_changed');
  expect(existsSync(join(f.workspace, 'actual'))).toBe(false);
  expect(readdirSync(f.runtimeRoot)).toEqual([]);
  const outside = f.create(f.profile);
  expect(outside.compensationJob.supports(f.entry)).toBe(false);
  expect(() =>
    outside.compensationJob.prepare({
      entry: f.entry,
      activationId: 'one',
      attempt: 1,
      outputDigest: 'a'.repeat(64),
      output: {},
      decisionKey: 'd',
      decisionDigest: 'a'.repeat(64),
    }),
  ).toThrow('workflow_compensation_unavailable');
});
mac(
  'a killed original guardian preserves unknown compensation and sealed assets without claiming a stop',
  async () => {
    const f = await fixture(
      "import{writeFileSync}from'node:fs';writeFileSync('owned-process',JSON.stringify({pid:process.pid,sealed:import.meta.dir,temp:process.env.TMPDIR}));setInterval(()=>{},1000);",
    );
    const handle = await f.start();
    const shell = (handle.reference as { shell: { processGroupId: number; supervisorPid: number } })
      .shell;
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const pidFile = join(f.workspace, 'owned-process');
    let fact: { pid: number; sealed: string; temp: string } | undefined;
    try {
      const deadline = Date.now() + 4000;
      while (!existsSync(pidFile)) {
        if (Date.now() > deadline) throw Error('compensation_owned_process_deadline');
        await Bun.sleep(5);
      }
      fact = JSON.parse(readFileSync(pidFile, 'utf8'));
      expect(fact!.pid).toBe(shell.processGroupId);
      expect(alive(fact!.pid)).toBe(true);
      expect(alive(shell.supervisorPid)).toBe(true);
      process.kill(shell.supervisorPid, 'SIGKILL');
      const events = await f.collect(handle);
      expect(events.find((event) => event.type === 'terminal')).toMatchObject({
        supervision: 'unknown',
        result: { outcome: 'outcome_unknown' },
      });
      expect((await f.job.cancel(handle)).status).toBe('unknown');
      await f.job.dispose(handle);
      expect(alive(fact!.pid)).toBe(true);
      expect(existsSync(join(fact!.sealed, 'compensate.ts'))).toBe(true);
      expect(existsSync(fact!.temp)).toBe(true);
      expect(readdirSync(f.runtimeRoot).length).toBeGreaterThan(0);
    } finally {
      // The test owns this exact captured group; this teardown is not a Job stop receipt.
      if (alive(shell.processGroupId)) process.kill(-shell.processGroupId, 'SIGKILL');
      if (alive(shell.supervisorPid)) process.kill(shell.supervisorPid, 'SIGKILL');
      const deadline = Date.now() + 4000;
      while (alive(shell.processGroupId) && Date.now() <= deadline) {
        await Bun.sleep(5);
      }
      const stopped = !alive(shell.processGroupId);
      const releaseOwnedDirectories = (root: string) => {
        chmodSync(root, 0o700);
        for (const name of readdirSync(root)) {
          const path = join(root, name),
            stat = lstatSync(path);
          if (stat.isDirectory() && !stat.isSymbolicLink()) releaseOwnedDirectories(path);
        }
      };
      // Assets intentionally remain sealed after an unknown receipt; only owned fixture teardown opens them.
      if (stopped) releaseOwnedDirectories(f.runtimeRoot);
      else roots.splice(roots.indexOf(f.root), 1);
      expect(stopped).toBe(true);
    }
  },
  10000,
);
mac.each(['cancel', 'timeout'] as const)(
  'compensation %s confirms the original process and cleans the sealed runtime assets',
  async (mode) => {
    const f = await fixture(
      "import{writeFileSync}from'node:fs';writeFileSync('started',String(process.pid));setInterval(()=>{},100);",
      mode === 'timeout' ? 1000 : 5000,
    );
    const controller = new AbortController(),
      handle = await f.start(f.input, controller.signal);
    try {
      const observed = f.collect(handle);
      while (!existsSync(join(f.workspace, 'started'))) await Bun.sleep(10);
      const pid = Number(readFileSync(join(f.workspace, 'started'), 'utf8'));
      if (mode === 'cancel') {
        controller.abort();
        expect((await f.job.cancel(handle)).status).toBe('stopped');
      }
      expect((await observed).at(-1)).toMatchObject({
        type: 'terminal',
        supervision: 'ended',
        result: { outcome: mode === 'cancel' ? 'cancelled' : 'failed' },
      });
      expect(() => process.kill(pid, 0)).toThrow();
      expect(readdirSync(f.runtimeRoot)).toEqual([]);
    } finally {
      await f.job.dispose(handle);
    }
  },
);

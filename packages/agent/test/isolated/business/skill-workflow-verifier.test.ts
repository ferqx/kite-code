import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
import { join } from 'node:path';
import { createSkillWorkflowVerifier } from '../../../src/business/skill-workflow/verifier';
import type { JobEvent, Json } from '../../../src/extensions';
import { compileSkillWorkflow } from '../../../src/skills/workflow-contract';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(script: string, timeoutMs = 5000) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-workflow-verifier-')));
  roots.push(root);
  const skillDir = join(root, 'skill');
  mkdirSync(skillDir);
  const manifest = {
    name: 'checker',
    version: '1.0.0',
    description: 'Real script check',
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
      timeout_ms: timeoutMs,
    },
    recovery: { retry: 'never' },
  };
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\n${JSON.stringify(manifest)}\n---\nReal governed verification\n`,
  );
  writeFileSync(join(skillDir, 'check.ts'), script);
  const entry = compileSkillWorkflow({ skillDir, source: 'project', origin: '.kite-code' });
  expect(entry.diagnostics).toEqual([]);
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, '../../../src/platform/process/shell-supervisor.ts')],
    outdir: join(root, 'assets'),
    target: 'bun',
    naming: 'shell-supervisor.js',
  });
  expect(built.success).toBe(true);
  const verifier = createSkillWorkflowVerifier({
    entries: [entry],
    shell: {
      cwd: root,
      env: { PATH: '/usr/bin:/bin', FIXTURE_ENV: 'selected' },
      supervisorPath: built.outputs[0]!.path,
      bunExecutable: process.execPath,
      shellExecutable: '/bin/sh',
    },
  });
  const job = verifier.extension.jobs![0]!;
  const input = verifier.verificationJob.prepare({
    entry,
    activationId: 'activation',
    attempt: 1,
    outputDigest: createHash('sha256')
      .update(JSON.stringify({ ok: true }))
      .digest('hex'),
    output: { ok: true },
  });
  const start = (value: Json = input, signal = new AbortController().signal) =>
    job.start(value, { sessionId: 's', executionId: crypto.randomUUID(), signal });
  const collect = async (handle: Awaited<ReturnType<typeof start>>) => {
    const events: JobEvent[] = [];
    for await (const event of job.observe(handle)) events.push(event);
    return events;
  };
  return { root, skillDir, entry, verifier, job, input, start, collect };
}
const posix = process.platform === 'darwin' || process.platform === 'linux' ? test : test.skip;
posix.each([0, 7])(
  'real script exit %i preserves exact terminal and selected root/env',
  async (exit) => {
    const f = await fixture(
      `import {writeFileSync} from 'node:fs';writeFileSync('effect',process.cwd()+'\\n'+process.env.FIXTURE_ENV); console.log('actual output');process.exit(${exit});`,
    );
    const handle = await f.start();
    try {
      const events = await f.collect(handle);
      expect(
        events
          .filter((e) => e.type === 'output')
          .map((e) => e.content)
          .join(''),
      ).toContain('actual output');
      expect(events.at(-1)).toMatchObject({
        type: 'terminal',
        supervision: 'ended',
        result: {
          outcome: exit === 0 ? 'succeeded' : 'failed',
          details: { exitCode: exit, groupStopped: true },
        },
      });
      expect(readFileSync(join(f.skillDir, 'effect'), 'utf8')).toBe(`${f.skillDir}\nselected`);
      expect((await f.job.cancel(handle)).status).toBe('already_finished');
    } finally {
      await f.job.dispose(handle);
    }
  },
);
posix('source drift refuses before actual script start', async () => {
  const f = await fixture(
    "import {writeFileSync} from 'node:fs';writeFileSync('effect','started');",
  );
  writeFileSync(join(f.skillDir, 'check.ts'), "throw new Error('changed');");
  await expect(f.start()).rejects.toThrow('workflow_source_changed');
  expect(existsSync(join(f.skillDir, 'effect'))).toBe(false);
});
posix(
  'closed verifier input cannot replace command, root, output or original revision',
  async () => {
    const f = await fixture(
      "import {writeFileSync} from 'node:fs';writeFileSync('effect','started');",
    );
    for (const input of [
      { ...(f.input as object), command: 'touch effect' },
      { ...(f.input as object), cwd: f.root },
      { ...(f.input as object), revision: '0'.repeat(64) },
      { ...(f.input as object), attempt: 0 },
      { ...(f.input as object), attempt: 1.5 },
      { ...(f.input as object), outputDigest: '0'.repeat(64) },
      { ...(f.input as object), output: { ok: false } },
    ])
      await expect(f.start(JSON.parse(JSON.stringify(input)) as Json)).rejects.toThrow();
    expect(existsSync(join(f.skillDir, 'effect'))).toBe(false);
  },
);
posix('timeout cancels and confirms original process group before reporting failed', async () => {
  const f = await fixture(
    "import {writeFileSync} from 'node:fs';writeFileSync('started',String(process.pid));setInterval(()=>{},100);",
    1000,
  );
  const handle = await f.start();
  try {
    const events = await f.collect(handle);
    expect(existsSync(join(f.skillDir, 'started'))).toBe(true);
    const pid = Number(readFileSync(join(f.skillDir, 'started'), 'utf8'));
    expect(events.at(-1)).toMatchObject({
      type: 'terminal',
      supervision: 'ended',
      result: {
        outcome: 'failed',
        content: 'workflow_verification_timeout',
        details: { timeout: true, shellResult: { groupStopped: true } },
      },
    });
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await f.job.cancel(handle)).status).toBe('already_finished');
  } finally {
    await f.job.dispose(handle);
  }
});
posix('external cancel retains cancelled outcome with confirmed supervision', async () => {
  const f = await fixture('setInterval(()=>{},100);');
  const controller = new AbortController();
  const handle = await f.start(f.input, controller.signal);
  try {
    const observed = f.collect(handle);
    controller.abort();
    const confirmation = await f.job.cancel(handle);
    expect(confirmation.status).toBe('stopped');
    expect((await observed).at(-1)).toMatchObject({
      type: 'terminal',
      supervision: 'ended',
      result: { outcome: 'cancelled', details: { groupStopped: true } },
    });
  } finally {
    await f.job.dispose(handle);
  }
});

posix('late observation preserves a natural terminal recorded before the timeout', async () => {
  const f = await fixture("console.log('ended naturally');", 150);
  const handle = await f.start();
  try {
    await Bun.sleep(250);
    expect((await f.collect(handle)).at(-1)).toMatchObject({
      type: 'terminal',
      supervision: 'ended',
      result: { outcome: 'succeeded', details: { exitCode: 0, groupStopped: true } },
    });
  } finally {
    await f.job.dispose(handle);
  }
});

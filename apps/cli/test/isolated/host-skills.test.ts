import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import type { CLIServiceArtifact } from '../../host';
import { workflowManifest } from '../fixtures/workflow-manifest';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
async function fixture(
  duplicateNames = false,
  workflow?: 'enabled' | 'disabled' | 'structured' | 'unsupported',
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cli-host-skills-')));
  const workspace = join(root, 'workspace'),
    elsewhere = join(root, 'elsewhere');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(elsewhere, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'driver' });
  let calls = 0;
  const observed: string[][] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 64 * 1024 * 1024,
    async fetch(request) {
      const input = (await request.json()) as { messages: { content: unknown }[] };
      calls++;
      observed.push(
        input.messages.map((item) =>
          typeof item.content === 'string' ? item.content : JSON.stringify(item.content),
        ),
      );
      const chosen = calls <= 2 ? 'alpha' : 'beta';
      const load = calls % 2 === 1;
      const delta = load
        ? {
            tool_calls: [
              {
                index: 0,
                id: `load-${calls}`,
                type: 'function',
                function: workflow
                  ? {
                      name: 'complete_skill',
                      arguments: JSON.stringify({ activation_id: 'manual-1', output: {} }),
                    }
                  : { name: 'skills.load', arguments: JSON.stringify({ id: chosen }) },
              },
            ],
          }
        : { content: 'done' };
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = (value: unknown, finish: string | null) =>
            `data: ${JSON.stringify({ id: 'actual', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
          controller.enqueue(
            encoder.encode(
              `${chunk(delta, null)}${chunk({}, load ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'configured',
      tools: [{ id: 'skills.load' }],
      skills: [
        { id: 'alpha', path: 'skills/alpha' },
        { id: 'beta', path: 'skills/beta' },
      ],
      models: [
        {
          id: 'configured',
          provider: 'compatible',
          model: 'fixture',
          baseURL: `${provider.url.href}v1`,
        },
      ],
    }),
    { mode: 0o600 },
  );
  for (const [id, name] of [
    ['alpha', 'AlphaSkill'],
    ['beta', duplicateNames ? 'AlphaSkill' : 'BetaSkill'],
  ]) {
    const path = join(workspace, 'skills', id!);
    mkdirSync(join(path, 'scripts'), { recursive: true });
    writeFileSync(
      join(path, 'SKILL.md'),
      `---\nname: ${name}\ndescription: summary ${id}\n---\n${id!.toUpperCase()}_FULL_BODY_${'正文'.repeat(5000)}_TAIL\n[helper](scripts/helper.sh)\n`,
    );
    writeFileSync(
      join(path, 'scripts/helper.sh'),
      `echo unexpected > ${join(root, 'script-effect')}\n`,
    );
  }
  if (workflow) {
    writeFileSync(
      join(workspace, 'skills/alpha/SKILL.md'),
      `---\n${JSON.stringify(workflowManifest('alpha-skill', workflow === 'structured'))}\n---\nWORKFLOW_INLINE_ORIGINAL_BODY\n`,
    );
    if (workflow !== 'disabled')
      writeFileSync(
        join(profile.profilePath, 'skill-workflow.jsonc'),
        JSON.stringify({
          version: 1,
          features: { skillActivation: true, skillWorkflow: true, verification: false },
        }),
        { mode: 0o600 },
      );
  }
  const service = join(root, 'service.js');
  symlinkSync(join(import.meta.dir, '../../../../node_modules'), join(root, 'node_modules'), 'dir');
  const result = await Bun.build({
    entrypoints: [
      workflow === 'unsupported'
        ? join(import.meta.dir, '../fixtures/workflow-no-capability-child.ts')
        : join(import.meta.dir, '../../../service/src/main.ts'),
    ],
    target: 'bun',
    packages: 'external',
    outdir: root,
    naming: 'service.js',
  });
  if (!result.success) throw new Error('fixture_build_failed');
  const artifact: CLIServiceArtifact = {
    entrypoint: service,
    entrypointSha256: hash(readFileSync(service)),
    executable: process.execPath,
    executableSha256: hash(readFileSync(process.execPath)),
    buildId: `cli-fixture-${hash(readFileSync(service))}`,
    apiMajor: 1,
  };
  const driver = join(root, 'driver.ts');
  writeFileSync(
    driver,
    `import { runCLIProcess } from ${JSON.stringify(join(import.meta.dir, '../../host/main.ts'))};\ntry { process.exitCode = await runCLIProcess({artifact:${JSON.stringify(artifact)},dataRoot:${JSON.stringify(profile.dataRoot)},profile:'driver',cwd:${JSON.stringify(workspace)}}); } catch(error) { process.stderr.write(String(error?.code ?? 'driver_failed')+'\\n'); process.exitCode=1; }\n`,
  );
  const children: ReturnType<typeof Bun.spawn>[] = [];
  async function run(argv: string[]) {
    const child = Bun.spawn([process.execPath, driver, ...argv], {
      cwd: elsewhere,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' },
    });
    children.push(child);
    child.stdin.end();
    const timeout = setTimeout(() => child.kill('SIGTERM'), 5000);
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timeout);
    return { code, stdout, stderr };
  }
  return {
    root,
    profile,
    artifact,
    workspace,
    run,
    calls: () => calls,
    observed,
    counts() {
      const db = new Database(profile.databasePath, { readonly: true });
      try {
        return {
          sessions: (db.query('SELECT COUNT(*) AS n FROM session').get() as { n: number }).n,
          runs: (db.query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n,
          commands: (db.query('SELECT COUNT(*) AS n FROM command').get() as { n: number }).n,
        };
      } finally {
        db.close();
      }
    },
    close() {
      for (const child of children) if (child.exitCode === null) child.kill();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('actual argv selects only discovered Skill names/IDs, loads full body through ordinary Tool and seals two independent Run snapshots', async () => {
  const f = await fixture();
  try {
    const one = await f.run([
      'run',
      '--thread',
      'original',
      '--task',
      'load first',
      '--skill',
      'AlphaSkill',
      '--skill',
      'alpha',
      '--full',
      '--trust-workspace',
    ]);
    expect(one.code).toBe(0);
    expect(one.stderr).toBe('');
    expect(f.calls()).toBe(2);
    expect(f.observed[0]!.join('\n')).toContain('AlphaSkill');
    expect(f.observed[0]!.join('\n')).not.toContain('BetaSkill');
    expect(f.observed[0]!.join('\n')).not.toContain('ALPHA_FULL_BODY_');
    expect(f.observed[1]!.join('\n')).toContain('ALPHA_FULL_BODY_');
    expect(f.observed[1]!.join('\n')).toContain('_TAIL');
    const body = readFileSync(join(f.workspace, 'skills/alpha/SKILL.md'), 'utf8');
    expect(
      f.observed[1]!.some(
        (content) => content.includes(body) || content.includes(JSON.stringify(body).slice(1, -1)),
      ),
    ).toBe(true);
    expect(existsSync(join(f.root, 'script-effect'))).toBe(false);
    const database = new Database(f.profile.databasePath, { readonly: true });
    const original = database
      .query('SELECT id,config_json FROM run ORDER BY rowid LIMIT 1')
      .get() as { id: string; config_json: string };
    const modelSources = database
      .query("SELECT decision_source_json FROM execution WHERE kind='model' ORDER BY rowid")
      .all() as { decision_source_json: string }[];
    expect(modelSources[1]!.decision_source_json).toContain('skill.body:alpha');
    database.close();
    const sealed = JSON.parse(original.config_json) as {
      snapshot: {
        actualCapabilities: {
          skills: { id: string; version: string; requiredCapabilities: string[] }[];
        };
      };
    };
    expect(sealed.snapshot.actualCapabilities.skills).toEqual([
      {
        id: 'alpha',
        version: hash(readFileSync(join(f.workspace, 'skills/alpha/SKILL.md'))),
        requiredCapabilities: [],
      },
    ]);
    const two = await f.run([
      'resume',
      '--thread',
      'original',
      '--task',
      'load second',
      '--skill',
      'beta',
    ]);
    expect(two.code).toBe(0);
    expect(two.stderr).toBe('');
    expect(f.calls()).toBe(4);
    expect(f.observed[2]!.join('\n')).toContain('BetaSkill');
    expect(f.observed[3]!.join('\n')).toContain('BETA_FULL_BODY_');
    expect(existsSync(join(f.root, 'script-effect'))).toBe(false);
    const reopened = new Database(f.profile.databasePath, { readonly: true });
    try {
      expect(
        (
          reopened.query('SELECT config_json FROM run WHERE id=?').get(original.id) as {
            config_json: string;
          }
        ).config_json,
      ).toBe(original.config_json);
      const configs = reopened.query('SELECT config_json FROM run ORDER BY rowid').all() as {
        config_json: string;
      }[];
      expect(configs).toHaveLength(2);
      expect(configs[0]!.config_json).toContain('alpha');
      expect(configs[1]!.config_json).toContain('beta');
      expect(JSON.parse(configs[1]!.config_json).snapshot.actualCapabilities.skills).toEqual([
        {
          id: 'beta',
          version: hash(readFileSync(join(f.workspace, 'skills/beta/SKILL.md'))),
          requiredCapabilities: [],
        },
      ]);
      expect(configs[0]!.config_json).not.toContain('BetaSkill');
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
}, 15000);
test('unknown Skill selector fails explicitly before Provider and cannot create a path or script authority', async () => {
  const f = await fixture();
  try {
    const result = await f.run([
      'run',
      '--task',
      'unknown',
      '--skill',
      '../outside/SKILL.md',
      '--full',
      '--trust-workspace',
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain('skill_not_discovered');
    expect(f.calls()).toBe(0);
    expect(existsSync(join(f.root, 'script-effect'))).toBe(false);
  } finally {
    f.close();
  }
}, 15000);

test('selecting a known Skill alone does not grant workspace trust or Tool execution', async () => {
  const f = await fixture();
  try {
    const result = await f.run([
      'run',
      '--thread',
      'untrusted',
      '--task',
      'try selected skill',
      '--skill',
      'alpha',
    ]);
    expect(result.code).toBe(0);
    expect(f.calls()).toBe(2);
    expect(f.observed[0]!.join('\n')).toContain('AlphaSkill');
    expect(f.observed[1]!.join('\n')).not.toContain('ALPHA_FULL_BODY_');
    const db = new Database(f.profile.databasePath, { readonly: true });
    try {
      const tool = db
        .query(
          "SELECT dispatched,state FROM execution WHERE kind='tool' AND adapter_id='skills.load'",
        )
        .get() as { dispatched: number; state: string };
      expect(tool.dispatched).toBe(0);
      expect(tool.state).toBe('failed');
    } finally {
      db.close();
    }
    expect(existsSync(join(f.root, 'script-effect'))).toBe(false);
  } finally {
    f.close();
  }
}, 15000);

test('ambiguous discovered names persist original rejection and perform no Model or Skill Tool dispatch', async () => {
  const f = await fixture(true);
  try {
    const result = await f.run([
      'run',
      '--thread',
      'ambiguous',
      '--task',
      'do not guess',
      '--skill',
      'AlphaSkill',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('skill_selection_ambiguous');
    expect(f.calls()).toBe(0);
    const intent = JSON.parse(
      result.stdout
        .split('\n')
        .find((line) => line.startsWith('work intent '))!
        .slice(12),
    ) as { commandId: string };
    const db = new Database(f.profile.databasePath, { readonly: true });
    try {
      const command = db
        .query('SELECT status,receipt_json FROM command WHERE id=?')
        .get(intent.commandId) as { status: string; receipt_json: string };
      expect(command.status).toBe('rejected');
      expect(JSON.parse(command.receipt_json).reason).toBe('skill_selection_ambiguous');
      expect((db.query('SELECT COUNT(*) AS n FROM execution').get() as { n: number }).n).toBe(0);
      expect((db.query('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
    expect(existsSync(join(f.root, 'script-effect'))).toBe(false);
  } finally {
    f.close();
  }
}, 15000);

test('actual paired argv explicitly initializes Workflow while preserving independent knowledge selection', async () => {
  const f = await fixture(false, 'enabled');
  try {
    const reply = await f.run([
      'run',
      '--thread',
      'workflow',
      '--task',
      'original task',
      '--skill',
      'beta',
      '--activate-skill',
      'alpha-skill',
      '--activate-skill',
      'skill:alpha-skill',
      '--full',
      '--trust-workspace',
    ]);
    expect(reply.code).toBe(0);
    expect(reply.stderr).toBe('');
    expect(f.calls()).toBe(2);
    expect(f.observed[0]!.join('\n')).toContain('WORKFLOW_INLINE_ORIGINAL_BODY');
    const db = new Database(f.profile.databasePath, { readonly: true });
    try {
      const request = JSON.parse(
        (
          db.query("SELECT request_json FROM command WHERE kind='run.start'").get() as {
            request_json: string;
          }
        ).request_json,
      );
      expect(request.content).toBe('original task');
      expect(request.selectedSkills).toEqual(['beta']);
      expect(request.extensionInputs[0].input.activations).toEqual([
        { key: 'manual-1', skillId: 'skill:alpha-skill', input: {} },
      ]);
      expect((db.query('SELECT count(*) AS n FROM run').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    f.close();
  }
}, 30000);

test('actual paired argv refuses default-off and structured-input Workflows before Model or Run', async () => {
  for (const mode of ['disabled', 'structured'] as const) {
    const f = await fixture(false, mode);
    try {
      const reply = await f.run([
        'run',
        '--task',
        'original task',
        '--activate-skill',
        mode === 'disabled' ? 'alpha' : 'alpha-skill',
        '--full',
        '--trust-workspace',
      ]);
      expect(reply.code).toBe(1);
      expect(reply.stderr).toContain(
        mode === 'disabled' ? 'workflow_disabled' : 'workflow_input_required',
      );
      expect(f.calls()).toBe(0);
      expect(f.counts().runs).toBe(0);
    } finally {
      f.close();
    }
  }
}, 30000);

test('actual paired host lacking extension-input capability rejects explicit activation before creating work', async () => {
  const f = await fixture(false, 'unsupported');
  try {
    const reply = await f.run([
      'run',
      '--task',
      'original task',
      '--activate-skill',
      'alpha-skill',
      '--full',
      '--trust-workspace',
    ]);
    expect(reply.code).toBe(1);
    expect(reply.stderr).toContain('capability');
    expect(f.calls()).toBe(0);
    expect(f.counts().runs).toBe(0);
  } finally {
    f.close();
  }
}, 30000);

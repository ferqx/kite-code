import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import type { CLIServiceArtifact } from '../../host';
import { buildOwnedDaemon } from './daemon-host-build';
import { workflowManifest } from './workflow-manifest';

/** Actual default assembly and ordinary supervised verifier; no custom permission authority. */
export async function workflowQuestionProfile(decision: 'replan' | 'waive') {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-workflow-decision-')),
    workspace = join(root, 'workspace'),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(join(workspace, 'skill'), { recursive: true });
  mkdirSync(join(profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
  writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
    mode: 0o600,
  });
  const instructions =
    'ORIGINAL_VERIFICATION_INSTRUCTIONS full input and original output stay immutable';
  const manifest = {
    ...workflowManifest('alpha-skill'),
    effects: { filesystem: 'write', network: 'none', external_state: 'none' },
    approval: { minimum: 'user' },
    output_schema: {
      type: 'object',
      required: ['answer'],
      properties: { answer: { type: 'string' } },
      additionalProperties: false,
    },
    verification: {
      mode: 'required',
      strategy: 'script',
      entrypoint: 'check.ts',
      timeout_ms: 3000,
    },
  };
  writeFileSync(
    join(workspace, 'skill/SKILL.md'),
    `---\n${JSON.stringify(manifest)}\n---\n${instructions}\n`,
  );
  const ledger = join(root, 'verifier-ledger');
  writeFileSync(
    join(workspace, 'skill/check.ts'),
    `import {appendFileSync,readFileSync} from 'node:fs';appendFileSync(${JSON.stringify(ledger)},'verified attempt\\n');process.exit(readFileSync(${JSON.stringify(ledger)},'utf8').trim().split('\\n').length===1?1:0);`,
  );
  writeFileSync(
    join(profile.profilePath, 'skill-workflow.jsonc'),
    JSON.stringify({
      version: 1,
      features: { skillActivation: true, skillWorkflow: true, verification: true },
    }),
    { mode: 0o600 },
  );
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  let provider: ReturnType<typeof Bun.serve>;
  try {
    provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const input = (await request.json()) as (typeof requests)[number];
        requests.push(input);
        const db = new Database(profile.databasePath, { readonly: true });
        let key: string;
        try {
          const row = db
            .query(
              "SELECT request_json FROM command WHERE kind='run.start' ORDER BY seq DESC LIMIT 1",
            )
            .get() as { request_json: string };
          key = JSON.parse(row.request_json).extensionInputs[0].input.activations[0].key;
        } finally {
          db.close();
        }
        const call =
          requests.length === 1
            ? {
                name: 'complete_skill',
                input: {
                  activation_id: key,
                  attempt: 1,
                  output: { answer: 'original failed output' },
                },
              }
            : requests.length === 2
              ? { name: 'decide_skill_verification', input: { activation_id: key, attempt: 1 } }
              : decision === 'replan' && requests.length === 3
                ? {
                    name: 'complete_skill',
                    input: {
                      activation_id: key,
                      attempt: 2,
                      output: { answer: 'replanned repaired output' },
                    },
                  }
                : null;
        const delta = call
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `original-${requests.length}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.input) },
                },
              ],
            }
          : { content: 'WORKFLOW_DECISION_DONE' };
        const chunk = (value: unknown, finish: string | null) =>
          `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
        return new Response(
          `${chunk(delta, null)}${chunk({}, call ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  };
  try {
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'fixed',
        tools: [],
        skills: [{ id: 'alpha', path: 'skill' }],
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
    const artifactRoot = join(root, 'artifact');
    await buildOwnedDaemon(artifactRoot);
    const repo = resolve(import.meta.dir, '../../../..');
    const supervisor = await Bun.build({
      entrypoints: [join(repo, 'packages/agent/src/platform/process/shell-supervisor.ts')],
      target: 'bun',
      outdir: join(root, 'assets'),
      naming: 'shell-supervisor.js',
    });
    if (!supervisor.success) throw Error('supervisor_fixture_build');
    const source = join(artifactRoot, 'workflow-question-service.ts');
    writeFileSync(
      source,
      `import {selectProfile} from '@kite-ai/agent/profile';import {createDefaultProcessConfiguration} from '@kite-ai/service/configuration';import {runServiceProcess} from '@kite-ai/service/main';await runServiceProcess({configure(startup){return createDefaultProcessConfiguration({profile:selectProfile(startup.profile),hostConfiguration:startup.hostConfiguration,shell:${JSON.stringify({ platform: 'darwin', configurationId: 'owned-question-verifier', env: { PATH: '/usr/bin:/bin' }, supervisorPath: supervisor.outputs[0]!.path, bunExecutable: realpathSync(process.execPath), shellExecutable: '/bin/sh' })}});}});`,
    );
    const built = await Bun.build({
      entrypoints: [source],
      target: 'bun',
      packages: 'external',
      outdir: artifactRoot,
    });
    if (!built.success) throw Error('question_service_fixture_build');
    const entrypoint = join(artifactRoot, 'workflow-question-service.js');
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const artifact: CLIServiceArtifact = {
      entrypoint,
      entrypointSha256: hash(entrypoint),
      executable: realpathSync(process.execPath),
      executableSha256: hash(process.execPath),
      buildId: 'owned-workflow-question',
      apiMajor: 1,
    };
    return { root, workspace, profile, artifact, ledger, requests, instructions, close };
  } catch (error) {
    close();
    throw error;
  }
}

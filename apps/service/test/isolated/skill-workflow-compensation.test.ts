import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { startService } from '../../src/index';

test.each(
  process.platform === 'darwin' ? ['repair', 'deny'] : [],
)('configured default Service compensation %s keeps original failed proof and independent HTTP approvals', async (mode) => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-service-compensation-'));
  const workspace = join(root, 'workspace'),
    skill = join(workspace, 'skill'),
    checkLedger = join(workspace, 'checks'),
    effectLedger = join(workspace, 'compensations');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(skill, { recursive: true });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  mkdirSync(profile.coordinationPath, { recursive: true, mode: 0o700 });
  const output = { text: `${'完整原正文🙂'.repeat(16000)}ORIGINAL_OUTPUT_TAIL` };
  writeFileSync(
    join(skill, 'SKILL.md'),
    `---\n${JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      description: 'Original compensation declaration',
      invocation: { allow_manual: true, allow_implicit: false },
      context: { mode: 'inline', agent: 'code' },
      input_schema: { type: 'object', additionalProperties: false },
      output_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      capabilities: { require: [], deny: [] },
      effects: { filesystem: 'write', network: 'none', external_state: 'none' },
      approval: { minimum: 'none' },
      execution: { timeout_ms: 5000, max_attempts: 1 },
      verification: {
        mode: 'required',
        strategy: 'script',
        entrypoint: 'check.ts',
        timeout_ms: 3000,
      },
      recovery: { retry: 'never', compensation: 'compensate.ts' },
    })}\n---\nPreserve the original failure and compensate only by explicit decision.\n`,
  );
  writeFileSync(
    join(skill, 'check.ts'),
    `import {existsSync,readFileSync,writeFileSync} from 'node:fs';const p=${JSON.stringify(checkLedger)};const n=existsSync(p)?Number(readFileSync(p,'utf8')):0;writeFileSync(p,String(n+1));if(n===0)process.exit(1);`,
  );
  writeFileSync(
    join(skill, 'compensate.ts'),
    `import {existsSync,readFileSync,writeFileSync} from 'node:fs';const p=${JSON.stringify(effectLedger)};const n=existsSync(p)?Number(readFileSync(p,'utf8')):0;writeFileSync(p,String(n+1));`,
  );
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, '../../../../packages/agent/src/platform/process/shell-supervisor.ts'),
    ],
    outdir: join(root, 'assets'),
    target: 'bun',
    naming: 'shell-supervisor.js',
  });
  expect(built.success).toBe(true);
  let modelCalls = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch() {
      modelCalls++;
      const call =
        modelCalls === 1 || (mode === 'repair' && modelCalls === 4)
          ? {
              name: 'complete_skill',
              input: {
                activation_id: 'original',
                attempt: modelCalls === 1 ? 1 : 2,
                output,
              },
            }
          : modelCalls === 2 || (mode === 'deny' && modelCalls === 3)
            ? {
                name: 'decide_skill_verification',
                input: { activation_id: 'original', attempt: 1 },
              }
            : mode === 'repair' && modelCalls === 3
              ? {
                  name: 'repair_skill',
                  input: {
                    activation_id: 'original',
                    attempt: 1,
                    detail: 'Repair and verify again',
                  },
                }
              : null;
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call-${modelCalls}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              },
            ],
          }
        : { role: 'assistant', content: 'Original decision settled accurately' };
      const chunk = (value: unknown, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', created: 0, model: 'fixed', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
      return new Response(
        `${chunk(delta, null)}${chunk({}, call ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'fixed',
      models: [
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
      ],
      tools: [],
      skills: [{ id: 'configured', path: 'skill' }],
    }),
  );
  writeFileSync(
    join(profile.profilePath, 'skill-workflow.jsonc'),
    JSON.stringify({
      version: 1,
      features: { skillActivation: true, skillWorkflow: true, verification: true },
    }),
  );
  const host = createDefaultProcessConfiguration({
    profile,
    permissions: { authorize: async () => ({ allowed: true, revision: 'trusted-owned-fixture' }) },
    shell: {
      platform: 'darwin',
      configurationId: 'owned-compensation',
      env: { SECRET_MUST_NOT_ENTER: 'owned-nonsecret' },
      supervisorPath: built.outputs[0]!.path,
      bunExecutable: process.execPath,
      shellExecutable: '/bin/sh',
    },
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    extensions: host.extensions,
    permissions: host.permissions!,
    resolveRunConfiguration: host.resolveRunConfiguration,
    supportsExtensionInputs: true,
  });
  host.permissionManagement?.(runtime);
  const service = await startService({
    runtime,
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    buildId: 'owned-compensation',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['run_extension_inputs'],
    },
  });
  const expectedStoreId = (await runtime.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'owned',
      rootUri: `file://${workspace}`,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'w',
      title: 'compensation',
    });
    await client.connect();
    await client.startRun('s', {
      kind: 'run.start',
      expectedStoreId,
      commandId: 'original',
      content: 'Execute the original declared workflow',
      extensionInputs: [
        {
          extensionId: 'builtin.skill-workflow',
          definitionVersion: '1',
          input: { activations: [{ key: 'original', skillId: 'skill:fixture', input: {} }] },
        },
      ],
    });
    const answered = new Set<string>();
    let questions = 0,
      approvals = 0;
    const deadline = Date.now() + 20000;
    for (;;) {
      const page = await client.listInteractions('s', {
        storeId: expectedStoreId,
        state: 'pending',
      });
      for (const interaction of page.interactions) {
        if (answered.has(interaction.id)) continue;
        answered.add(interaction.id);
        if (interaction.kind === 'approval') {
          approvals++;
          expect(interaction.request).toMatchObject({
            definitionId: 'skill.workflow.compensate',
            policy: { review: { kind: 'artifact', complete: true } },
          });
          const attachment = await client.readInteractionAttachment(interaction);
          expect(JSON.parse(attachment.text)).toMatchObject({
            definitionId: 'skill.workflow.compensate',
            input: { output },
            policy: { minimum: 'user' },
          });
          expect(Bun.file(effectLedger).size).toBe(0);
        } else {
          expect(interaction.kind).toBe('question');
          questions++;
          expect(interaction.request).toMatchObject({
            schema: { properties: { decision: { enum: ['replan', 'waive', 'compensate'] } } },
          });
        }
        await client.answerInteraction('s', interaction.id, {
          expectedStoreId,
          commandId: `answer-${answered.size}`,
          expectedRevision: interaction.revision,
          answer:
            interaction.kind === 'approval'
              ? mode === 'deny'
                ? { kind: 'approval', decision: 'deny' }
                : { kind: 'approval', decision: 'approve', grant: 'approve_once' }
              : {
                  kind: 'question',
                  answers: {
                    decision: questions === 1 ? 'compensate' : 'waive',
                    detail: 'Actual original verification decision',
                  },
                },
        });
      }
      const command = await runtime.getCommand('original');
      const runId =
        command?.receipt && typeof command.receipt === 'object' && !Array.isArray(command.receipt)
          ? command.receipt.runId
          : undefined;
      if (typeof runId === 'string' && !(await store.getRun(runId))?.isActive) break;
      if (command?.status === 'rejected') throw Error(JSON.stringify(command.receipt));
      if (Date.now() > deadline) throw Error('service_compensation_deadline');
      await Bun.sleep(5);
    }
    const command = await runtime.getCommand('original');
    const run = await store.getRun((command!.receipt as { runId: string }).runId);
    expect(run!.status).toBe('completed');
    expect(approvals).toBe(1);
    expect(questions).toBe(mode === 'repair' ? 1 : 2);
    expect(readFileSync(checkLedger, 'utf8')).toBe(mode === 'repair' ? '2' : '1');
    expect(await Bun.file(effectLedger).exists()).toBe(mode === 'repair');
    if (mode === 'repair') expect(readFileSync(effectLedger, 'utf8')).toBe('1');
    const records = await store.listExtensionRecords({
      extensionId: 'builtin.skill-workflow',
      sessionId: 's',
      limit: 64,
    });
    const originalOutput = records.find((record) => record.key.endsWith('/attempts/1/closed'))!;
    expect((originalOutput.value as { output: Json }).output).toEqual(output);
    expect(
      records.find((record) => record.key.endsWith('/attempts/1/verification'))?.value,
    ).toMatchObject({ outcome: 'failed' });
    expect(
      records.find((record) => record.key.endsWith('/compensation-result'))?.value,
    ).toMatchObject({
      outcome: mode === 'repair' ? 'compensated' : 'failed',
      attempt: 1,
      resultRevision: '1',
    });
    const jobs = (await store.listExecutions('s')).filter(
      (execution) => execution.definitionId === 'skill.workflow.compensate',
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe(mode === 'repair' ? 'succeeded' : 'failed');
    if (mode === 'repair') {
      expect(
        records.find((record) => record.key.endsWith('/attempts/2/verification'))?.value,
      ).toMatchObject({ outcome: 'passed' });
      expect(modelCalls).toBe(5);
    } else {
      expect(jobs[0]!.result).toMatchObject({ details: { adapterAttempted: false } });
      expect(modelCalls).toBe(4);
    }
  } finally {
    try {
      await service.close();
    } finally {
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 30000);

import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { workflowSnapshotDigest } from '../../src/skill-workflow-configuration';

test.each(
  process.platform === 'darwin' ? ['repair', 'replan'] : [],
)('Service fork %s uses a new real child and preserves original failed verification', async (decision) => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-service-fork-attempts-'));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  const skill = join(root, 'skill');
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  mkdirSync(skill);
  const originalInput = `${'Exact original input. '.repeat(400)}ORIGINAL_INPUT_TAIL`;
  const instructions = 'Original immutable fork instructions. ORIGINAL_INSTRUCTIONS_TAIL';
  const detail = 'Use the original input and repair the failed verification';
  const ledger = join(root, 'verification-ledger');
  writeFileSync(
    join(skill, 'SKILL.md'),
    `---\n${JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      description: 'fixture',
      invocation: { allow_manual: true, allow_implicit: true },
      context: { mode: 'fork', agent: 'code' },
      input_schema: {
        type: 'object',
        properties: { blob: { type: 'string' } },
        required: ['blob'],
        additionalProperties: false,
      },
      output_schema: {
        type: 'object',
        properties: { result: { type: 'string' } },
        required: ['result'],
        additionalProperties: false,
      },
      capabilities: { require: [], deny: [] },
      effects: { filesystem: 'read', network: 'none', external_state: 'none' },
      approval: { minimum: 'user' },
      execution: { timeout_ms: 5000, max_attempts: 1 },
      verification: {
        mode: 'required',
        strategy: 'script',
        entrypoint: 'check.ts',
        timeout_ms: 3000,
      },
      recovery: { retry: 'never' },
    })}\n---\n${instructions}\n`,
  );
  writeFileSync(
    join(skill, 'check.ts'),
    `import {existsSync,readFileSync,writeFileSync} from 'node:fs';const path=${JSON.stringify(ledger)};const n=existsSync(path)?Number(readFileSync(path,'utf8')):0;writeFileSync(path,String(n+1));if(n===0)process.exit(1);`,
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
  const childRequests: Record<string, unknown>[] = [];
  let parentCalls = 0;
  const outputs = [
    { result: `first real child ${'complete output '.repeat(400)}FIRST_OUTPUT_TAIL` },
    { result: `second real child ${'complete output '.repeat(400)}SECOND_OUTPUT_TAIL` },
  ];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      const isChild = JSON.stringify(body.messages).includes(
        'Execute the explicitly activated Skill',
      );
      let delta: unknown,
        reason = 'stop';
      if (isChild) {
        childRequests.push(body);
        delta = { role: 'assistant', content: JSON.stringify(outputs[childRequests.length - 1]) };
      } else {
        parentCalls++;
        const call =
          parentCalls === 1
            ? {
                name: 'activate_skill',
                input: {
                  key: 'original',
                  skill_id: 'skill:fixture',
                  input: { blob: originalInput },
                },
              }
            : parentCalls === 2
              ? {
                  name: decision === 'repair' ? 'repair_skill' : 'decide_skill_verification',
                  input: {
                    activation_id: 'original',
                    attempt: 1,
                    ...(decision === 'repair' ? { detail } : {}),
                  },
                }
              : null;
        delta = call
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `parent-${parentCalls}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.input) },
                },
              ],
            }
          : { role: 'assistant', content: 'Completed after real second child verification' };
        if (call) reason = 'tool_calls';
      }
      const chunk = (value: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', created: 0, model: 'fixed', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
      return new Response(`${chunk(delta, null)}${chunk({}, reason)}data: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  writeFileSync(
    join(profile.profilePath, 'skill-workflow.jsonc'),
    JSON.stringify({
      version: 1,
      features: { skillActivation: true, skillWorkflow: true, verification: true },
    }),
  );
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
  const host = createDefaultProcessConfiguration({
    profile,
    child: [{ id: 'code', version: '1', toolIds: [] }],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'trusted-owned-fixture' };
      },
    },
    shell: {
      platform: 'darwin',
      configurationId: 'qualified-fixture',
      env: { PATH: '/usr/bin:/bin' },
      supervisorPath: built.outputs[0]!.path,
      bunExecutable: process.execPath,
      shellExecutable: '/bin/sh',
    },
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    permissions: host.permissions!,
    extensions: host.extensions,
    resolveRunConfiguration: host.resolveRunConfiguration,
    childConfigurations: host.childConfigurations,
    resolveChildRunConfiguration: host.resolveChildRunConfiguration,
    supportsExtensionInputs: true,
  });
  host.permissionManagement?.(runtime);
  const expectedStoreId = (await runtime.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'owned',
      rootUri: `file://${root}`,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'w',
      title: decision,
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'start',
      request: {
        kind: 'run.start',
        content: 'Activate the exact fork workflow and repair its failed verification',
      },
    });
    const end = Date.now() + 20000;
    const answered = new Set<string>();
    let approvals = 0,
      questions = 0;
    for (;;) {
      const executions = await store.listExecutions('s');
      const sessions = [
        's',
        ...executions.flatMap((execution) =>
          execution.childSessionId ? [execution.childSessionId] : [],
        ),
      ];
      for (const sessionId of sessions) {
        const page = await store.listInteractions({ ...base, sessionId, state: 'pending' });
        for (const interaction of page.interactions) {
          if (answered.has(interaction.id)) continue;
          answered.add(interaction.id);
          const answer =
            interaction.kind === 'approval'
              ? { kind: 'approval' as const, decision: 'approve' as const }
              : { kind: 'question' as const, answers: { decision: 'replan', detail } };
          if (interaction.kind === 'approval') approvals++;
          else {
            questions++;
            expect(decision).toBe('replan');
          }
          await runtime.answerInteraction({
            ...base,
            commandId: `answer-${answered.size}`,
            presentationSessionId: 's',
            interactionId: interaction.id,
            expectedRevision: interaction.revision,
            answer,
          });
        }
      }
      const view = await store.getView('s');
      const run = view.runs.find((run) => run.originCommandId === 'start');
      if (run && !run.isActive) {
        if (run.status !== 'completed')
          throw Error(
            `fork_attempts_failed:${JSON.stringify(view.executions.map((execution) => ({ id: execution.definitionId, status: execution.status, result: execution.result })))}`,
          );
        expect(run.status).toBe('completed');
        const anchorKey = `run/${run.id}/workflow.${createHash('sha256').update('original').digest('hex')}`;
        const record = (suffix: string) =>
          store.getExtensionRecord({
            sessionId: 's',
            extensionId: 'builtin.skill-workflow',
            key: `${anchorKey}${suffix}`,
          });
        const anchor = await record('');
        const head = await record('/head');
        if (!head)
          throw Error(
            `fork_attempts_anchor_missing:${JSON.stringify({ parentCalls, childCalls: childRequests.length, runStatus: run.status, executions: view.executions.map(({ definitionId, status, result }) => ({ definitionId, status, result })) })}`,
          );
        expect(head?.value).toEqual({ kind: 'head', attempt: 2 });
        const firstClosed = await record('/attempts/1/closed');
        const firstVerification = await record('/attempts/1/verification');
        expect(firstClosed?.value).toMatchObject({ output: outputs[0], attempt: 1 });
        expect(firstVerification?.value).toMatchObject({ outcome: 'failed', attempt: 1 });
        expect((await record('/attempts/2/closed'))?.value).toMatchObject({
          output: outputs[1],
          attempt: 2,
        });
        expect((await record('/attempts/2/verification'))?.value).toMatchObject({
          outcome: 'passed',
          attempt: 2,
        });
        expect((await record('/attempts/2/opening'))?.value).toMatchObject({
          previousAttempt: 1,
          createdBy: decision,
          detail,
          anchorRevision: anchor!.revision,
        });
        const agents = executions.filter((execution) => execution.definitionId === 'agent/code');
        expect(agents).toHaveLength(2);
        expect(new Set(agents.map((execution) => execution.childSessionId)).size).toBe(2);
        const verifiers = executions.filter(
          (execution) => execution.definitionId === 'skill.workflow.verify',
        );
        expect(verifiers).toHaveLength(2);
        expect(verifiers.map((execution) => execution.status).sort()).toEqual([
          'failed',
          'succeeded',
        ]);
        for (const [index, agent] of agents.entries()) {
          expect(agent.status).toBe('succeeded');
          const fork = (await record(`/attempts/${index + 1}/fork-operation`))!.value as Record<
            string,
            Json
          >;
          expect(fork.ref).toMatchObject({ executionId: agent.id });
          const carrier = (await store.getExecution(agent.parentExecutionId!))!;
          expect(carrier.definitionId).toBe(
            index === 0
              ? 'activate_skill'
              : decision === 'repair'
                ? 'repair_skill'
                : 'decide_skill_verification',
          );
          expect((await record(`/attempts/${index + 1}/fork-opening`))?.value).toMatchObject({
            carrierExecutionId: carrier.id,
            carrierInputDigest: createHash('sha256')
              .update(workflowSnapshotDigest(carrier.input))
              .digest('hex'),
            originStoreId: expectedStoreId,
            configurationId: 'code',
            configurationVersion: '1',
          });
          const childView = await store.getView(agent.childSessionId!);
          expect(childView.runs[0]?.status).toBe('completed');
          expect((childView.runs[0]?.configuration as { tools: unknown[] }).tools).toHaveLength(0);
        }
        if (decision === 'replan') {
          const opening = (await record('/attempts/2/opening'))!.value as Record<string, Json>;
          const saved = (await store.getExtensionRecord({
            sessionId: 's',
            extensionId: 'builtin.skill-workflow',
            key: String(opening.decisionKey),
          }))!.value as Record<string, Json>;
          expect(saved.outcome).toBe('replan');
          const proof = saved.proof as Record<string, Json>;
          const interaction = (await store.getInteraction({
            ...base,
            interactionId: String(proof.interactionId),
          }))!;
          expect(interaction.acceptedDecisionRevision).toBe(String(proof.decisionRevision));
          expect(interaction.subjectId).toBe('owner');
        }
        // Exact historical records remain unchanged after the new attempt completes.
        expect(await record('/attempts/1/closed')).toEqual(firstClosed);
        expect(await record('/attempts/1/verification')).toEqual(firstVerification);
        break;
      }
      if (Date.now() > end) throw Error('fork_attempts_deadline');
      await Bun.sleep(5);
    }
    expect(childRequests).toHaveLength(2);
    for (const request of childRequests) {
      const messages = JSON.stringify(request.messages);
      expect(messages).toContain(originalInput);
      expect(messages).toContain(instructions);
    }
    expect(JSON.stringify(childRequests[1]!.messages)).toContain(detail);
    expect(parentCalls).toBe(3);
    expect(Number(readFileSync(ledger, 'utf8'))).toBe(2);
    expect(approvals).toBeGreaterThanOrEqual(4);
    expect(questions).toBe(decision === 'replan' ? 1 : 0);
  } finally {
    await runtime.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

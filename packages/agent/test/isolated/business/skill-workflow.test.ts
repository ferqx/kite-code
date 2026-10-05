import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFixedModel,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import {
  createSkillWorkflow,
  skillWorkflowExtensionId,
  type WorkflowActivationInput,
} from '../../../src/business/skill-workflow';
import type { Extension, JobEvent, Json, PublicInteraction } from '../../../src/extensions';
import { canonicalJson } from '../../../src/json';
import { createRuntime, type RunRequirementInitializer } from '../../../src/runtime';
import { compileSkillWorkflow } from '../../../src/skills/workflow-contract';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, input: Json): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
const complete = (output: Json = { ok: true }) =>
  call('complete_skill', { activation_id: 'one', output });
async function fixture(
  options: {
    responses?: ModelEvent[][];
    dynamic?: boolean;
    verification?: boolean;
    script?: 'succeeded' | 'failed' | 'outcome_unknown';
    scriptResults?: ('succeeded' | 'failed' | 'outcome_unknown')[];
    userDecisions?: {
      version: '1';
      allowWaiver: boolean;
      allowReplan: boolean;
      allowCompensation?: boolean;
    };
    compensation?: 'succeeded' | 'failed' | 'outcome_unknown';
    compensationAvailable?: boolean;
    declareCompensation?: boolean;
    approveCompensation?: boolean;
    disabled?: boolean;
    drift?: boolean;
    forkBody?: string;
    denyJob?: boolean;
    driftClosed?: boolean;
    holdJobPermission?: boolean;
    approveJob?: boolean;
    instructions?: string;
    activationInput?: Json;
    artifacts?: boolean;
    rebind?: 'valid' | 'missing' | 'changed';
    tamperDecision?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'kite-workflow-runtime-'));
  const skillDir = join(root, 'skill');
  mkdirSync(skillDir);
  const manifest = {
    name: 'fixture',
    version: '1.0.0',
    description: 'Actual governed fixture',
    invocation: { allow_implicit: true, allow_manual: true },
    context: { mode: options.forkBody === undefined ? 'inline' : 'fork', agent: 'code' },
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string' } },
      additionalProperties: false,
    },
    output_schema: {
      type: 'object',
      properties: { ok: { const: true }, note: { type: 'string' } },
      required: ['ok'],
      additionalProperties: false,
    },
    capabilities: { require: ['fixture:allowed'], deny: [] },
    effects: { filesystem: 'read', network: 'none', external_state: 'none' },
    approval: { minimum: 'none' },
    execution: { timeout_ms: 5000, max_attempts: 1 },
    verification: options.script
      ? { mode: 'required', strategy: 'script', entrypoint: 'check.sh' }
      : { mode: 'required' },
    recovery: {
      retry: 'never',
      ...(options.compensation && options.declareCompensation !== false
        ? { compensation: 'compensate.sh' }
        : {}),
    },
  };
  const source = `---\n${JSON.stringify(manifest)}\n---\n${options.instructions ?? 'Actual workflow instructions'}\n`;
  writeFileSync(join(skillDir, 'SKILL.md'), source);
  writeFileSync(join(skillDir, 'check.sh'), 'harmless fixture script');
  if (options.compensation)
    writeFileSync(join(skillDir, 'compensate.sh'), 'original declared compensation');
  const entry = compileSkillWorkflow({ skillDir, source: 'project', origin: '.kite-code' });
  expect(entry.diagnostics).toEqual([]);
  let starts = 0,
    effects = 0,
    compensationStarts = 0;
  const makeWorkflow = (initialActivations: readonly WorkflowActivationInput[] | undefined) =>
    createSkillWorkflow({
      flags: {
        skillActivation: !options.disabled,
        skillWorkflow: true,
        verification: options.verification ?? true,
      },
      entries: [entry],
      ...(options.userDecisions ? { userDecisions: options.userDecisions } : {}),
      ...(initialActivations === undefined ? {} : { initialActivations }),
      ...(options.forkBody === undefined
        ? {}
        : {
            forkConfigurations: [
              { agent: 'code', configurationId: 'child', definitionVersion: '1' },
            ],
          }),
      capabilities: [
        {
          capabilityId: 'fixture:allowed',
          kind: 'tool',
          definitionId: 'allowed',
          definitionVersion: '1',
        },
      ],
      ...(options.script
        ? {
            verificationJob: {
              definitionId: 'checker',
              definitionVersion: '1',
              prepare: () => ({ activation: 'one' }),
            },
          }
        : {}),
      ...(options.compensation
        ? {
            compensationJob: {
              definitionId: 'compensator',
              definitionVersion: '1',
              supports: () => options.compensationAvailable !== false,
              prepare: (input) => ({
                skillId: input.entry.descriptor.capabilityId,
                revision: input.entry.descriptor.revision,
                activationId: input.activationId,
                attempt: input.attempt,
                outputDigest: input.outputDigest,
                output: input.output,
                decisionKey: input.decisionKey,
                decisionDigest: input.decisionDigest,
              }),
            },
          }
        : {}),
    });
  const originalActivations = options.dynamic
    ? undefined
    : [{ key: 'one', skillId: 'skill:fixture', input: options.activationInput ?? {} }];
  const workflow = makeWorkflow(originalActivations);
  let selectedWorkflow = workflow;
  let initializations = 0,
    rebound = false;
  const initializeRequirements: RunRequirementInitializer = async (input) => {
    initializations++;
    return workflow.initializeRequirements(input);
  };
  // The registered host delegates to a freshly assembled business instance after the persisted anchor exists.
  // Every effect still receives the actual authorized Runtime ToolContext; this is not OS crash recovery.
  const workflowExtension: Extension = options.rebind
    ? {
        ...workflow.extension,
        tools: workflow.extension.tools!.map((tool) => ({
          ...tool,
          execute: (input, context) =>
            selectedWorkflow.extension
              .tools!.find((t) => t.id === tool.id)!
              .execute(input, context),
        })),
        context: {
          capture: (request, context) =>
            selectedWorkflow.extension.context!.capture(request, context),
        },
        conditions: {
          evaluate: (refs, phase, context) =>
            selectedWorkflow.extension.conditions!.evaluate(refs, phase, context),
        },
      }
    : options.tamperDecision
      ? {
          ...workflow.extension,
          tools: workflow.extension.tools!.map((tool) =>
            tool.id !== 'decide_skill_verification'
              ? tool
              : {
                  ...tool,
                  async execute(input, context) {
                    const value = await tool.execute(input, context);
                    const records = await context.records.list();
                    const saved = records.find((record) => record.key.includes('/decision/'));
                    if (!saved) throw new Error('missing_real_decision_for_tamper');
                    const modified = structuredClone(saved.value) as Record<string, Json>;
                    const fields = options.tamperDecision!.split(':');
                    const field = fields.pop()!;
                    let target = modified;
                    for (const key of fields) target = target[key] as Record<string, Json>;
                    target[field!] = field === 'attempt' ? 99 : 'foreign-target';
                    await context.records.write({
                      key: saved.key,
                      expectedRevision: saved.revision,
                      contentType: saved.contentType,
                      contentVersion: saved.contentVersion,
                      executable: true,
                      value: modified,
                    });
                    return value;
                  },
                },
          ),
        }
      : workflow.extension;
  const ordinary: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    tools: ['allowed', 'denied'].map((id) => ({
      id,
      version: '1',
      description: id,
      inputSchema: { type: 'object' },
      async execute() {
        effects++;
        return { outcome: 'succeeded' as const, content: id };
      },
    })),
    jobs: [
      ...(options.compensation
        ? [
            {
              id: 'compensator',
              version: '1',
              description: 'Original ordinary compensation Job',
              inputSchema: { type: 'object' },
              async start() {
                compensationStarts++;
                return { reference: { originalCompensation: true } };
              },
              async *observe(): AsyncIterable<JobEvent> {
                yield {
                  type: 'terminal',
                  supervision: 'ended',
                  result: {
                    outcome: options.compensation!,
                    content: 'real ordinary compensation result',
                  },
                };
              },
              async cancel() {
                return { status: 'stopped' as const };
              },
              async dispose() {},
            },
          ]
        : []),
      {
        id: 'checker',
        version: '1',
        description: 'Ordinary bounded checker',
        inputSchema: { type: 'object' },
        async start() {
          starts++;
          return { reference: { original: true } };
        },
        async *observe(): AsyncIterable<JobEvent> {
          yield {
            type: 'terminal',
            result: {
              outcome: options.scriptResults?.[starts - 1] ?? options.script ?? 'succeeded',
              content: 'checker result',
            },
            supervision: 'ended',
          };
        },
        async cancel() {
          return { status: 'stopped' };
        },
        async dispose() {},
      },
    ],
  };
  const profile = { dataRoot: join(root, 'data'), profile: 'isolated' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const fixed = createFixedModel(options.responses ?? [complete(), [finish]]);
  const requests: ModelRequest[] = [];
  const model: ModelAdapter = {
    async *stream(request, streamOptions) {
      requests.push(structuredClone(request));
      if (options.driftClosed && requests.length === 2)
        writeFileSync(join(skillDir, 'SKILL.md'), source + 'changed after completion');
      yield* fixed.stream(request, streamOptions);
    },
  };
  let releasePermission!: () => void, enterPermission!: () => void;
  const permissionEntered = new Promise<void>((resolve) => {
    enterPermission = resolve;
  });
  const permissionRelease = new Promise<void>((resolve) => {
    releasePermission = resolve;
  });
  const permissions: string[] = [];
  let policyRevision = 'fixture-policy';
  const runtime = createRuntime({
    store,
    ...(options.artifacts ? { artifacts: createArtifactStore({ profile, store }) } : {}),
    model,
    modelId: 'fixed',
    supportsExtensionInputs: true,
    ...(options.forkBody === undefined
      ? {}
      : {
          childConfigurations: [
            {
              id: 'child',
              version: '1',
              modelId: 'child-fixed',
              model: createFixedModel([[{ type: 'text_delta', text: options.forkBody }, finish]]),
              extensions: [workflow.extension],
              toolIds: [],
              snapshot: { child: true },
            },
          ],
        }),
    resolveRunConfiguration: async () => ({
      model,
      modelId: 'fixed',
      extensions: [workflowExtension, ordinary],
      initializeRequirements,
      snapshot: { fixture: true },
    }),
    permissions: {
      async authorize(request) {
        permissions.push(`${request.kind}:${request.definitionId}`);
        if (options.rebind && request.kind === 'model' && !rebound) {
          const anchors = await store.listExtensionRecords({
            sessionId: 's',
            extensionId: skillWorkflowExtensionId,
          });
          expect(anchors.filter((r) => r.contentType.includes('activation'))).toHaveLength(1);
          const cached =
            options.rebind === 'missing'
              ? undefined
              : options.rebind === 'changed'
                ? [{ key: 'one', skillId: 'skill:fixture', input: { target: 'changed' } }]
                : originalActivations;
          selectedWorkflow = makeWorkflow(cached);
          expect(selectedWorkflow).not.toBe(workflow);
          rebound = true;
        }
        if (options.holdJobPermission && request.definitionId === 'checker') {
          enterPermission();
          await permissionRelease;
        }
        if (options.drift && request.definitionId === 'complete_skill')
          writeFileSync(join(skillDir, 'SKILL.md'), source + 'changed');
        return {
          allowed:
            !(options.denyJob && request.kind === 'job') &&
            !(options.approveCompensation && request.definitionId === 'compensator') &&
            !(options.approveJob && request.definitionId === 'checker'),
          revision: policyRevision,
          ...(options.approveCompensation && request.definitionId === 'compensator'
            ? { approval: { request: { reason: 'independent original compensation approval' } } }
            : {}),
          ...(options.approveJob && request.definitionId === 'checker'
            ? { approval: { request: { reason: 'actual independent verifier approval' } } }
            : {}),
        };
      },
    },
  });
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'fixture',
    rootUri: `file://${root}`,
  });
  await runtime.createSession({
    ...base,
    commandId: 'create',
    workspaceId: 'w',
    title: 'workflow',
  });
  return {
    root,
    store,
    runtime,
    source,
    skillDir,
    permissions,
    setPolicyRevision(value: string) {
      policyRevision = value;
    },
    requests,
    permissionEntered,
    releasePermission,
    base,
    get initializations() {
      return initializations;
    },
    get rebound() {
      return rebound;
    },
    get starts() {
      return starts;
    },
    get effects() {
      return effects;
    },
    get compensationStarts() {
      return compensationStarts;
    },
    async run(timeoutMs = 5000) {
      await runtime.submitCommand({
        ...base,
        commandId: 'work',
        request: {
          kind: 'run.start',
          content: 'Perform workflow',
          ...(options.dynamic
            ? {}
            : {
                extensionInputs: [
                  {
                    extensionId: skillWorkflowExtensionId,
                    definitionVersion: '1',
                    input: {
                      activations: [
                        {
                          key: 'one',
                          skillId: 'skill:fixture',
                          input: options.activationInput ?? {},
                        },
                      ],
                    },
                  },
                ],
              }),
        },
      });
      const command = await runtime.waitForCommand('work', { timeoutMs });
      const run = await store.getRun((command.receipt as { runId: string }).runId);
      if (!run) throw new Error(JSON.stringify(command));
      return run;
    },
    async records() {
      return store.listExtensionRecords({ sessionId: 's', extensionId: skillWorkflowExtensionId });
    },
    async close() {
      releasePermission();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('explicit inline activation closes only with exact schema proof and durable obligation', async () => {
  const f = await fixture();
  try {
    const run = await f.run();
    expect(run.status).toBe('completed');
    expect(run.requirements).toHaveLength(1);
    const records = await f.records();
    expect(records.find((r) => r.key.endsWith('/verification'))?.value).toMatchObject({
      outcome: 'passed',
      kind: 'schema',
    });
    expect(f.starts).toBe(0);
  } finally {
    await f.close();
  }
});
test('model activation is durable and a repeated identical key does not create another frame', async () => {
  const activate = call('activate_skill', { key: 'one', skill_id: 'skill:fixture', input: {} });
  const f = await fixture({
    dynamic: true,
    responses: [
      activate,
      call('activate_skill', { key: 'one', skill_id: 'skill:fixture', input: {} }),
      complete(),
      [finish],
    ],
  });
  try {
    expect((await f.run()).status).toBe('completed');
    expect((await f.records()).filter((r) => r.contentType.includes('activation'))).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test.each([
  {},
  { ok: false },
  { ok: true, extra: true },
])('verification off still rejects invalid output %j', async (output) => {
  const f = await fixture({ verification: false, responses: [complete(output as Json), [finish]] });
  try {
    expect((await f.run()).status).toBe('failed');
    expect(
      (await f.store.listExecutions('s')).some((e) => e.definitionId === 'complete_skill'),
    ).toBe(true);
    expect((await f.records()).some((r) => r.key.endsWith('/closed'))).toBe(false);
    expect(f.starts).toBe(0);
  } finally {
    await f.close();
  }
});
test('an unfinished activation prevents ordinary completion', async () => {
  const f = await fixture({ responses: [[finish]] });
  try {
    expect((await f.run()).status).toBe('failed');
    expect((await f.store.listExecutions('s')).some((e) => e.kind === 'model')).toBe(true);
    expect((await f.records()).some((r) => r.key.endsWith('/closed'))).toBe(false);
  } finally {
    await f.close();
  }
});
test.each([
  'allowed',
  'denied',
])('actual dispatch obeys active workflow ceiling: %s', async (id) => {
  const f = await fixture({ responses: [call(id, {}), complete(), [finish]] });
  try {
    await f.run();
    expect(f.effects).toBe(id === 'allowed' ? 1 : 0);
    const execution = (await f.store.listExecutions('s')).find((e) => e.definitionId === id)!;
    expect(execution.status).toBe(id === 'allowed' ? 'succeeded' : 'failed');
  } finally {
    await f.close();
  }
});
test.each([
  'succeeded',
  'failed',
  'outcome_unknown',
] as const)('script required verification binds actual ordinary Job result: %s', async (outcome) => {
  const f = await fixture({ script: outcome });
  try {
    const run = await f.run();
    expect(run.status).toBe(outcome === 'succeeded' ? 'completed' : 'failed');
    expect(f.starts).toBe(1);
    expect(f.permissions).toContain('job:checker');
    const proof = (await f.records()).find((r) => r.key.endsWith('/verification'))!.value;
    expect(proof).toMatchObject({
      outcome: outcome === 'succeeded' ? 'passed' : outcome === 'failed' ? 'failed' : 'unknown',
    });
  } finally {
    await f.close();
  }
});

test('verification disabled accepts valid output without creating verification proof or Job', async () => {
  const f = await fixture({ verification: false });
  try {
    expect((await f.run()).status).toBe('completed');
    expect((await f.records()).some((r) => r.key.endsWith('/closed'))).toBe(true);
    expect((await f.records()).some((r) => r.key.endsWith('/verification'))).toBe(false);
    expect(f.starts).toBe(0);
  } finally {
    await f.close();
  }
});
test('disabled activation gate fails before Model or any business effect', async () => {
  const f = await fixture({ disabled: true });
  try {
    const run = await f.run();
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('workflow_disabled');
    expect(await f.store.listExecutions('s')).toHaveLength(0);
    expect(await f.records()).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test('source drift at permission barrier prevents closing the original activation', async () => {
  const f = await fixture({ drift: true });
  try {
    expect((await f.run()).status).toBe('failed');
    expect(f.permissions).toContain('tool:complete_skill');
    const executions = await f.store.listExecutions('s');
    expect(executions.some((e) => e.kind === 'model' && e.status === 'succeeded')).toBe(true);
    expect((await f.records()).some((r) => r.key.endsWith('/closed'))).toBe(false);
    expect(f.starts).toBe(0);
  } finally {
    await f.close();
  }
});

test.each([
  '{"ok":true}',
  '```json\n{"ok":true}\n```',
  '[]',
  '{"ok":false}',
])('actual fork consumes exact child terminal output: %s', async (body) => {
  const f = await fixture({
    dynamic: true,
    forkBody: body,
    responses: [
      call('activate_skill', { key: 'one', skill_id: 'skill:fixture', input: {} }),
      [finish],
    ],
  });
  try {
    const run = await f.run();
    expect(run.status).toBe(body === '{"ok":true}' ? 'completed' : 'failed');
    const jobs = (await f.store.listExecutions('s')).filter((e) => e.kind === 'job');
    expect(jobs).toHaveLength(1);
    const childId = (jobs[0]!.result as { details: { childSessionId: string } }).details
      .childSessionId;
    expect(await f.store.getSession(childId)).toMatchObject({
      parentSessionId: 's',
      rootSessionId: 's',
    });
    const childModels = (await f.store.listExecutions(childId)).filter((e) => e.kind === 'model');
    expect(childModels).toHaveLength(1);
    expect(childModels[0]).toMatchObject({ status: 'succeeded', result: { content: body } });
    expect((await f.records()).some((r) => r.key.endsWith('/closed'))).toBe(body === '{"ok":true}');
    if (body !== '{"ok":true}')
      expect((await f.records()).find((r) => r.key.endsWith('/invalidated'))?.value).toMatchObject({
        status: 'invalidated',
        reason: 'workflow_output_schema_invalid',
      });
  } finally {
    await f.close();
  }
});

test('script verification remains ordinary permission controlled with zero denied Job start', async () => {
  const f = await fixture({ script: 'succeeded', denyJob: true });
  try {
    expect((await f.run()).status).toBe('failed');
    expect(f.permissions).toContain('job:checker');
    expect(f.starts).toBe(0);
    const execution = (await f.store.listExecutions('s')).find(
      (e) => e.definitionId === 'checker',
    )!;
    expect(execution.status).toBe('failed');
    expect((await f.records()).find((r) => r.key.endsWith('/verification'))?.value).toMatchObject({
      outcome: 'failed',
    });
  } finally {
    await f.close();
  }
});
test('repeated verification reads its original proof without starting a second Job', async () => {
  const f = await fixture({
    script: 'succeeded',
    responses: [complete(), call('verify_skill', { activation_id: 'one' }), [finish]],
  });
  try {
    expect((await f.run()).status).toBe('completed');
    expect(f.starts).toBe(1);
    const jobs = (await f.store.listExecutions('s')).filter((e) => e.definitionId === 'checker');
    expect(jobs).toHaveLength(1);
    expect((await f.records()).filter((r) => r.key.endsWith('/verification'))).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('dynamic inline activation exposes full instructions schema and original input to the next Model', async () => {
  const f = await fixture({
    dynamic: true,
    responses: [
      call('activate_skill', {
        key: 'one',
        skill_id: 'skill:fixture',
        input: { target: 'original-target' },
      }),
      complete(),
      [finish],
    ],
  });
  try {
    expect((await f.run()).status).toBe('completed');
    const next = f.requests[1]!;
    const activation = next.messages
      .filter((m) => m.role === 'tool')
      .map((m) => {
        try {
          return JSON.parse(m.content);
        } catch {
          return null;
        }
      })
      .find((v) => v?.activationId === 'one');
    expect(activation).toMatchObject({
      input: { target: 'original-target' },
      instructions: 'Actual workflow instructions',
      outputSchema: {
        properties: { ok: { const: true }, note: { type: 'string' } },
        required: ['ok'],
        additionalProperties: false,
      },
    });
  } finally {
    await f.close();
  }
});
test('manual fork intent is started by its exact original key through activate_skill', async () => {
  const f = await fixture({
    forkBody: '{"ok":true}',
    responses: [
      call('activate_skill', { key: 'one', skill_id: 'skill:fixture', input: {} }),
      [finish],
    ],
  });
  try {
    expect((await f.run()).status).toBe('completed');
    expect((await f.store.listExecutions('s')).filter((e) => e.kind === 'job')).toHaveLength(1);
    expect((await f.records()).find((r) => r.key.endsWith('/closed'))?.value).toMatchObject({
      status: 'closed',
      output: { ok: true },
    });
  } finally {
    await f.close();
  }
});
test('manual fork cannot fabricate completion without its actual original child result', async () => {
  const f = await fixture({ forkBody: '{"ok":true}', responses: [complete(), [finish]] });
  try {
    expect((await f.run()).status).toBe('failed');
    expect((await f.store.listExecutions('s')).filter((e) => e.kind === 'job')).toHaveLength(0);
    expect((await f.records()).some((r) => r.key.endsWith('/closed'))).toBe(false);
    expect(
      (await f.store.listExecutions('s')).find((e) => e.definitionId === 'complete_skill')?.result,
    ).toMatchObject({ content: 'workflow_fork_unverifiable' });
  } finally {
    await f.close();
  }
});
test('a closed verified workflow keeps original facts after source drift while unrelated work continues', async () => {
  const f = await fixture({
    driftClosed: true,
    responses: [complete(), call('denied', {}), [finish]],
  });
  try {
    expect((await f.run()).status).toBe('completed');
    expect(f.effects).toBe(1);
    expect((await f.records()).find((r) => r.key.endsWith('/verification'))?.value).toMatchObject({
      outcome: 'passed',
    });
  } finally {
    await f.close();
  }
});
test('source changes during queued Job permission wait prevent its actual start', async () => {
  const f = await fixture({ script: 'succeeded', holdJobPermission: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = f.run();
    await Promise.race([
      f.permissionEntered,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('job_permission_barrier_missing')), 3000);
      }),
    ]);
    writeFileSync(join(f.skillDir, 'check.sh'), 'source changed at actual permission wait');
    f.releasePermission();
    expect((await pending).status).toBe('failed');
    expect(f.starts).toBe(0);
    expect(
      (await f.store.listExecutions('s')).find((e) => e.definitionId === 'checker')?.result,
    ).toMatchObject({ content: 'workflow_source_changed' });
  } finally {
    clearTimeout(timer);
    f.releasePermission();
    await f.close();
  }
});

test('manual inline large valid input and Skill instructions remain complete with bounded anchor metadata', async () => {
  const instructions =
    'INSTRUCTIONS BEGIN\n' + 'i'.repeat(1024 * 1024 + 4096) + '\nINSTRUCTIONS VERIFIED TAIL';
  const target = 'INPUT BEGIN ' + 'x'.repeat(40 * 1024) + ' INPUT VERIFIED TAIL';
  const f = await fixture({ instructions, activationInput: { target }, artifacts: true });
  try {
    const run = await f.run();
    if (run.status !== 'completed')
      throw new Error(
        `large_workflow_failed:${run.reason};models=${f.requests.length};records=${(await f.records()).length}`,
      );
    expect(run.status).toBe('completed');
    const first = f.requests[0]!;
    expect(first).toBeDefined();
    const intent = first.messages
      .map((m) => {
        try {
          return JSON.parse(m.content);
        } catch {
          return null;
        }
      })
      .find(
        (value) => value?.kind === 'workflow_activation_intent' && value.activationId === 'one',
      );
    expect(intent).toBeDefined();
    expect(intent.instructions).toBe(instructions);
    expect(intent.input).toEqual({ target });
    expect(intent.instructions).toEndWith('INSTRUCTIONS VERIFIED TAIL');
    expect(intent.input.target).toEndWith('INPUT VERIFIED TAIL');
    const anchor = (await f.records()).find((r) => r.contentType.includes('activation'))!;
    expect(Buffer.byteLength(canonicalJson(anchor.value))).toBeLessThan(32 * 1024);
    expect((await f.records()).find((r) => r.key.endsWith('/closed'))?.value).toMatchObject({
      output: { ok: true },
      status: 'closed',
    });
    expect((await f.records()).find((r) => r.key.endsWith('/verification'))?.value).toMatchObject({
      outcome: 'passed',
    });
  } finally {
    await f.close();
  }
});

test.each([
  'valid',
  'missing',
  'changed',
] as const)('fresh Workflow business binding uses only exact trusted manual input: %s', async (mode) => {
  const instructions =
    'REBOUND CONTRACT BEGIN\n' + 'r'.repeat(1024 * 1024 + 512) + '\nREBOUND CONTRACT TAIL';
  const target = 'REBOUND INPUT BEGIN ' + 'v'.repeat(40 * 1024) + ' REBOUND INPUT TAIL';
  const f = await fixture({
    rebind: mode,
    instructions,
    activationInput: { target },
    artifacts: true,
  });
  try {
    const run = await f.run();
    expect(f.initializations).toBe(1);
    expect(f.rebound).toBe(true);
    expect(run.status).toBe(mode === 'valid' ? 'completed' : 'failed');
    const anchors = (await f.records()).filter((r) => r.contentType.includes('activation'));
    expect(anchors).toHaveLength(1);
    expect(Buffer.byteLength(canonicalJson(anchors[0]!.value))).toBeLessThan(32 * 1024);
    if (mode === 'valid') {
      const intent = f.requests[0]!.messages.map((m) => {
        try {
          return JSON.parse(m.content);
        } catch {
          return null;
        }
      }).find((v) => v?.kind === 'workflow_activation_intent');
      expect(intent.instructions).toBe(instructions);
      expect(intent.input).toEqual({ target });
      expect((await f.records()).find((r) => r.key.endsWith('/closed'))?.value).toMatchObject({
        status: 'closed',
        output: { ok: true },
      });
      expect((await f.records()).find((r) => r.key.endsWith('/verification'))?.value).toMatchObject(
        { outcome: 'passed' },
      );
      expect(
        (await f.store.listExecutions('s')).find((e) => e.definitionId === 'complete_skill')
          ?.status,
      ).toBe('succeeded');
    } else {
      expect(run.reason).toBe('workflow_activation_input_unverifiable');
      expect(f.requests).toHaveLength(0);
      expect((await f.records()).some((r) => r.key.endsWith('/closed'))).toBe(false);
    }
  } finally {
    await f.close();
  }
});

const repair = (attempt = 1) =>
  call('repair_skill', { activation_id: 'one', attempt, detail: 'Fix the original requirement' });
const decision = () => call('decide_skill_verification', { activation_id: 'one', attempt: 1 });
const completedAttempt = (attempt: number, note: string) =>
  call('complete_skill', { activation_id: 'one', attempt, output: { ok: true, note } });
async function answerDecision(
  f: Awaited<ReturnType<typeof fixture>>,
  choice: string,
  commandId: string,
) {
  const original = await question(f);
  await f.runtime.answerInteraction({
    ...f.base,
    commandId,
    presentationSessionId: 's',
    interactionId: original.id,
    expectedRevision: original.revision,
    answer: {
      kind: 'question',
      answers: { decision: choice, detail: 'actual original user choice' },
    },
  });
  return original;
}
async function question(f: Awaited<ReturnType<typeof fixture>>) {
  const deadline = Date.now() + 4000;
  for (;;) {
    const page = await f.runtime.listInteractions({ ...f.base, state: 'pending' });
    const found = page.interactions.find((value) => value.kind === 'question');
    if (found) return found;
    if (Date.now() > deadline) throw new Error('workflow_decision_question_deadline');
    await Bun.sleep(5);
  }
}
test('failed required verification retains its ceiling and append-only repair creates exactly a new operation', async () => {
  const f = await fixture({
    script: 'failed',
    scriptResults: ['failed', 'succeeded'],
    responses: [
      completedAttempt(1, 'original'),
      call('allowed', {}),
      call('denied', {}),
      repair(),
      completedAttempt(2, 'repaired'),
      call('verify_skill', { activation_id: 'one', attempt: 1 }),
      [finish],
    ],
  });
  try {
    expect((await f.run()).status).toBe('completed');
    expect(f.starts).toBe(2);
    expect(f.effects).toBe(1);
    const records = await f.records();
    expect(records.find((r) => r.key.endsWith('/attempts/1/closed'))?.value).toMatchObject({
      output: { ok: true, note: 'original' },
    });
    expect(records.find((r) => r.key.endsWith('/attempts/1/verification'))?.value).toMatchObject({
      attempt: 1,
      outcome: 'failed',
    });
    expect(records.find((r) => r.key.endsWith('/attempts/2/closed'))?.value).toMatchObject({
      output: { ok: true, note: 'repaired' },
    });
    expect(records.find((r) => r.key.endsWith('/attempts/2/verification'))?.value).toMatchObject({
      attempt: 2,
      outcome: 'passed',
    });
    expect(records.filter((r) => r.key.endsWith('/verification-operation'))).toHaveLength(2);
    expect(records.find((r) => r.key.endsWith('/head'))?.value).toEqual({
      kind: 'head',
      attempt: 2,
    });
    expect(
      (await f.store.listExecutions('s')).find((e) => e.definitionId === 'denied')?.status,
    ).toBe('failed');
  } finally {
    await f.close();
  }
});
test('complete default remains attempt one and a stale repair cannot close or advance current attempt', async () => {
  const f = await fixture({
    script: 'failed',
    scriptResults: ['failed', 'succeeded'],
    responses: [
      complete(),
      repair(),
      complete(),
      repair(1),
      completedAttempt(2, 'accurate'),
      [finish],
    ],
  });
  try {
    expect((await f.run()).status).toBe('completed');
    expect(f.starts).toBe(2);
    const attempts = (await f.records()).filter((r) => r.key.endsWith('/opening'));
    expect(attempts).toHaveLength(2);
    const tools = (await f.store.listExecutions('s')).filter((e) => e.kind === 'tool');
    expect(tools.filter((e) => e.status === 'failed')).toHaveLength(3);
    expect(
      (await f.records()).find((r) => r.key.endsWith('/attempts/2/closed'))?.value,
    ).toMatchObject({ output: { ok: true, note: 'accurate' } });
  } finally {
    await f.close();
  }
});
for (const choice of ['waive', 'replan'] as const)
  test(`real accepted question ${choice} preserves original failure and exact target`, async () => {
    const f = await fixture({
      script: 'failed',
      scriptResults: ['failed', 'succeeded'],
      userDecisions: { version: '1', allowWaiver: true, allowReplan: true },
      responses: [
        completedAttempt(1, 'original'),
        decision(),
        ...(choice === 'replan' ? [completedAttempt(2, 'replanned')] : []),
        [finish],
      ],
    });
    try {
      const running = f.run();
      const original = await question(f);
      expect(original.runId).not.toBeNull();
      expect(original.executionId).not.toBeNull();
      await f.runtime.answerInteraction({
        ...f.base,
        commandId: 'real-answer',
        presentationSessionId: 's',
        interactionId: original.id,
        expectedRevision: original.revision,
        answer: {
          kind: 'question',
          answers: { decision: choice, detail: ' Original accurate reason ' },
        },
      });
      expect((await running).status).toBe('completed');
      const actual = await f.runtime.getInteraction({ ...f.base, interactionId: original.id });
      expect(actual?.acceptedDecisionRevision).toBe('2');
      expect(actual?.subjectId).toBe('owner');
      expect((await f.store.getExecution(original.executionId))?.interactionBinding).toBeNull();
      const records = await f.records();
      const saved = records.find((r) => r.key.includes('/decision/'))!.value as Record<
        string,
        Json
      >;
      expect(saved).toMatchObject({
        outcome: choice === 'waive' ? 'waived' : 'replan',
        detail: 'Original accurate reason',
      });
      expect((saved.proof as Record<string, Json>).interactionId).toBe(original.id);
      expect((saved.request as Record<string, Json>).headRevision).toBe(
        (records.find((r) => r.key.endsWith('/attempts/1/closed'))!.value as Record<string, Json>)
          .headRevision,
      );
      expect(records.find((r) => r.key.endsWith('/attempts/1/verification'))?.value).toMatchObject({
        outcome: 'failed',
      });
      expect(f.starts).toBe(choice === 'waive' ? 1 : 2);
      if (choice === 'replan')
        expect(
          records.find((r) => r.key.endsWith('/attempts/2/verification'))?.value,
        ).toMatchObject({ outcome: 'passed' });
    } finally {
      await f.close();
    }
  });
test('actual compensation question and independent Job approval preserve failed proof and require a later verified repair', async () => {
  const f = await fixture({
    script: 'failed',
    scriptResults: ['failed', 'succeeded'],
    compensation: 'succeeded',
    approveCompensation: true,
    userDecisions: { version: '1', allowWaiver: true, allowReplan: true, allowCompensation: true },
    responses: [
      completedAttempt(1, 'original'),
      decision(),
      repair(),
      completedAttempt(2, 'fixed'),
      [finish],
    ],
  });
  try {
    const running = f.run();
    const original = await answerDecision(f, 'compensate', 'real-compensation-choice');
    const deadline = Date.now() + 4000;
    let approval: PublicInteraction | undefined;
    while (!approval) {
      const page = await f.runtime.listInteractions({ ...f.base, state: 'pending' });
      approval = page.interactions.find((value) => value.kind === 'approval');
      if (Date.now() > deadline) throw Error('compensation_approval_deadline');
      if (!approval) await Bun.sleep(5);
    }
    expect(f.compensationStarts).toBe(0);
    expect(approval.executionId).not.toBe(original.executionId);
    expect(approval.request).toMatchObject({
      definitionId: 'compensator',
      policy: { reason: 'independent original compensation approval' },
    });
    await f.runtime.answerInteraction({
      ...f.base,
      commandId: 'compensation-approval',
      presentationSessionId: 's',
      interactionId: approval.id,
      expectedRevision: approval.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    expect((await running).status).toBe('completed');
    if (f.compensationStarts !== 1)
      throw new Error(
        JSON.stringify({
          code: 'compensation_missing_actual_start',
          executions: (await f.store.listExecutions('s')).map((execution) => ({
            id: execution.id,
            parent: execution.parentExecutionId,
            kind: execution.kind,
            definition: execution.definitionId,
            state: execution.status,
            result: execution.result,
          })),
        }),
      );
    expect(f.compensationStarts).toBe(1);
    expect(f.starts).toBe(2);
    const records = await f.records();
    expect(records.find((r) => r.key.endsWith('/attempts/1/verification'))?.value).toMatchObject({
      outcome: 'failed',
    });
    expect(records.find((r) => r.key.endsWith('/compensation-result'))?.value).toMatchObject({
      outcome: 'compensated',
      attempt: 1,
      executionId: approval.executionId,
      resultRevision: '1',
    });
    expect(records.find((r) => r.key.endsWith('/attempts/2/verification'))?.value).toMatchObject({
      outcome: 'passed',
    });
    expect(records.filter((r) => r.key.endsWith('/compensation-operation'))).toHaveLength(1);
    expect(records.find((r) => r.key.endsWith('/head'))?.value).toEqual({
      kind: 'head',
      attempt: 2,
    });
    const actual = await f.runtime.getInteraction({ ...f.base, interactionId: original.id });
    expect(actual?.subjectId).toBe('owner');
    expect(actual?.acceptedDecisionRevision).toBe('2');
  } finally {
    await f.close();
  }
});
test('another actual compensation choice reads the original operation once and exact waiver remains a separate decision', async () => {
  const f = await fixture({
    script: 'failed',
    compensation: 'succeeded',
    userDecisions: { version: '1', allowWaiver: true, allowReplan: true, allowCompensation: true },
    responses: [complete(), decision(), decision(), decision(), [finish]],
  });
  try {
    const running = f.run();
    await answerDecision(f, 'compensate', 'first-choice');
    await answerDecision(f, 'compensate', 'second-choice');
    await answerDecision(f, 'waive', 'accurate-waiver');
    expect((await running).status).toBe('completed');
    expect(f.compensationStarts).toBe(1);
    expect(f.starts).toBe(1);
    const records = await f.records();
    expect(records.filter((r) => r.key.endsWith('/compensation-operation'))).toHaveLength(1);
    expect(records.filter((r) => r.key.endsWith('/compensation-result'))).toHaveLength(1);
    expect(records.find((r) => r.key.endsWith('/verification'))?.value).toMatchObject({
      outcome: 'failed',
    });
    const head = records.find((r) => r.key.endsWith('/head'))?.value as Record<string, Json>;
    expect(head.attempt).toBe(1);
    expect(head.waiverKey).toBeTruthy();
  } finally {
    await f.close();
  }
});
for (const mode of ['policy_disabled', 'backend_unavailable', 'undeclared'] as const)
  test(`compensation is not offered when ${mode}`, async () => {
    const f = await fixture({
      script: 'failed',
      compensation: 'succeeded',
      compensationAvailable: mode !== 'backend_unavailable',
      declareCompensation: mode !== 'undeclared',
      userDecisions: {
        version: '1',
        allowWaiver: true,
        allowReplan: true,
        allowCompensation: mode !== 'policy_disabled',
      },
      responses: [complete(), decision(), [finish]],
    });
    try {
      const running = f.run();
      const original = await question(f);
      expect(original.request).toMatchObject({
        schema: { properties: { decision: { enum: ['replan', 'waive'] } } },
      });
      await answerDecision(f, 'waive', `waive-${mode}`);
      expect((await running).status).toBe('completed');
      expect(f.compensationStarts).toBe(0);
    } finally {
      await f.close();
    }
  });
for (const drift of ['source', 'permission', 'cancel', 'blank'] as const)
  test(`waiting decision rejects ${drift} without adopting a waiver`, async () => {
    const f = await fixture({
      script: 'failed',
      userDecisions: { version: '1', allowWaiver: true, allowReplan: true },
      responses: [complete(), decision(), [finish]],
    });
    try {
      const running = f.run();
      const original = await question(f);
      if (drift === 'source') writeFileSync(join(f.skillDir, 'SKILL.md'), f.source + 'changed');
      if (drift === 'permission') f.setPolicyRevision('changed-policy');
      if (drift === 'cancel')
        await f.runtime.cancelCommand({
          ...f.base,
          commandId: 'cancel-work',
          targetCommandId: 'work',
        });
      const answering = f.runtime.answerInteraction({
        ...f.base,
        commandId: 'real-answer',
        presentationSessionId: 's',
        interactionId: original.id,
        expectedRevision: original.revision,
        answer: {
          kind: 'question',
          answers: { decision: 'waive', detail: drift === 'blank' ? '   ' : 'original reason' },
        },
      });
      if (drift === 'cancel') await answering.catch(() => {});
      else await answering;
      expect((await running).status).not.toBe('completed');
      expect((await f.records()).filter((r) => r.key.includes('/decision/'))).toHaveLength(0);
      expect(f.starts).toBe(1);
    } finally {
      await f.close();
    }
  });
for (const mode of ['unknown', 'policy-denied'] as const)
  test(`decision ${mode} cannot request user authority or replay verifier`, async () => {
    const f = await fixture({
      script: mode === 'unknown' ? 'outcome_unknown' : 'failed',
      userDecisions: { version: '1', allowWaiver: false, allowReplan: mode === 'unknown' },
      responses: [complete(), decision(), ...(mode === 'unknown' ? [repair()] : []), [finish]],
    });
    try {
      expect((await f.run()).status).toBe('failed');
      expect(f.starts).toBe(1);
      const pending = await f.runtime.listInteractions({ ...f.base });
      expect(pending.interactions).toHaveLength(0);
      expect((await f.records()).filter((r) => r.key.endsWith('/opening'))).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

test('model actor and waiver text cannot replace a real accepted question', async () => {
  const f = await fixture({
    script: 'failed',
    userDecisions: { version: '1', allowWaiver: true, allowReplan: true },
    responses: [
      complete(),
      call('decide_skill_verification', {
        activation_id: 'one',
        attempt: 1,
        actor: 'user',
        reason: 'waive it',
      }),
      [finish],
    ],
  });
  try {
    expect((await f.run()).status).toBe('failed');
    expect((await f.runtime.listInteractions({ ...f.base })).interactions).toHaveLength(0);
    expect((await f.records()).filter((r) => r.key.includes('/decision/'))).toHaveLength(0);
    expect(f.starts).toBe(1);
  } finally {
    await f.close();
  }
});
test('original verifier waits across an observation timeout for its independent actual approval', async () => {
  const f = await fixture({ script: 'succeeded', approveJob: true });
  try {
    const running = f.run(40000);
    // Preserve rejection for the awaited assertion while allowing fixture cleanup on failure.
    void running.catch(() => {});
    let original:
      | Awaited<ReturnType<typeof f.runtime.listInteractions>>['interactions'][number]
      | undefined;
    const deadline = Date.now() + 5000;
    while (!original && Date.now() < deadline) {
      original = (
        await f.runtime.listInteractions({ ...f.base, state: 'pending' })
      ).interactions.find((value) => value.definitionId === 'checker');
      if (!original) await Bun.sleep(10);
    }
    if (!original) throw new Error('original verifier approval was not requested');
    expect(original.runId).toBeNull();
    expect(f.starts).toBe(0);
    await Bun.sleep(31000);
    const pending = await f.runtime.getInteraction({ ...f.base, interactionId: original.id });
    expect(pending?.state).toBe('pending');
    expect(pending?.revision).toBe(original.revision);
    expect(f.starts).toBe(0);
    const tools = (await f.store.listExecutions('s')).filter((value) => value.kind === 'tool');
    expect(tools.find((value) => value.definitionId === 'complete_skill')?.status).toBe(
      'dispatching',
    );
    expect(
      (await f.records()).filter((value) => value.key.endsWith('/verification-operation')),
    ).toHaveLength(1);
    await f.runtime.answerInteraction({
      ...f.base,
      commandId: 'original-delayed-approval',
      presentationSessionId: 's',
      interactionId: original.id,
      expectedRevision: original.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    expect((await running).status).toBe('completed');
    expect(f.starts).toBe(1);
    expect(
      (await f.store.listExecutions('s')).filter((value) => value.kind === 'job'),
    ).toHaveLength(1);
    expect(
      (await f.runtime.getInteraction({ ...f.base, interactionId: original.id }))
        ?.acceptedDecisionRevision,
    ).toBe('2');
    expect(
      (await f.records()).find((value) => value.key.endsWith('/verification'))?.value,
    ).toMatchObject({ attempt: 1, outcome: 'passed', executionId: original.executionId });
  } finally {
    await f.close();
  }
}, 45000);
for (const changed of [
  'request:originStoreId',
  'request:sessionId',
  'request:runId',
  'request:activationId',
  'request:anchorKey',
  'request:anchorRevision',
  'request:requirementId',
  'request:requirementRevision',
  'request:skillId',
  'request:skillRevision',
  'request:attempt',
  'request:headRevision',
  'request:outputDigest',
  'request:verifier:executionId',
  'request:verifier:resultRevision',
  'proof:originStoreId',
  'proof:sessionId',
  'proof:runId',
  'proof:executionId',
  'proof:interactionId',
  'proof:decisionRevision',
])
  test(`final exact waiver rejects changed ${changed} after the actual user answer`, async () => {
    const f = await fixture({
      script: 'failed',
      tamperDecision: changed,
      userDecisions: { version: '1', allowWaiver: true, allowReplan: true },
      responses: [complete(), decision(), [finish]],
    });
    try {
      const running = f.run(),
        original = await question(f);
      await f.runtime.answerInteraction({
        ...f.base,
        commandId: 'real-answer',
        presentationSessionId: 's',
        interactionId: original.id,
        expectedRevision: original.revision,
        answer: { kind: 'question', answers: { decision: 'waive', detail: 'actual reason' } },
      });
      expect((await running).status).toBe('failed');
      expect(
        (await f.runtime.getInteraction({ ...f.base, interactionId: original.id }))
          ?.acceptedDecisionRevision,
      ).toBe('2');
      expect(
        (await f.records()).find((r) => r.key.endsWith('/attempts/1/verification'))?.value,
      ).toMatchObject({ outcome: 'failed' });
      expect(f.starts).toBe(1);
    } finally {
      await f.close();
    }
  });

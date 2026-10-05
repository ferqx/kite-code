import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionRecord, Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import {
  createWorkflowConfiguration,
  readSkillWorkflowFlags,
  workflowForkFence,
  workflowSnapshotDigest,
} from '../../src/skill-workflow-configuration';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kite-workflow-service-'));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'fixture' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const skill = join(root, 'skill');
  mkdirSync(skill);
  const manifest = {
    name: 'fixture',
    version: '1.0.0',
    description: 'fixture',
    invocation: { allow_manual: true, allow_implicit: true },
    context: { mode: 'inline', agent: 'code' },
    input_schema: { type: 'object', additionalProperties: false },
    output_schema: { type: 'object', additionalProperties: false },
    capabilities: { require: ['files.read'], deny: [] },
    effects: { filesystem: 'read', network: 'none', external_state: 'none' },
    approval: { minimum: 'user' },
    execution: { timeout_ms: 5000, max_attempts: 1 },
    verification: { mode: 'required' },
    recovery: { retry: 'never' },
  };
  writeFileSync(
    join(skill, 'SKILL.md'),
    `---\n${JSON.stringify(manifest)}\n---\nOriginal workflow instructions\n`,
  );
  const flags = { skillActivation: true, skillWorkflow: true, verification: true };
  const capabilities = [
    {
      kind: 'tool' as const,
      definitionId: 'files.read',
      definitionVersion: '1',
      capability: {
        capabilityId: 'files.read',
        revision: 'actual-file-read-1',
        availability: 'available' as const,
        effectiveEffects: {
          filesystem: 'read' as const,
          network: 'none' as const,
          externalState: 'none' as const,
        },
        policy: { minimumApproval: 'none' as const },
      },
    },
  ];
  const input = {
    extensionId: 'builtin.skill-workflow',
    definitionVersion: '1',
    input: { activations: [{ key: 'original', skillId: 'skill:fixture', input: {} }] },
  };
  return {
    root,
    profile,
    skill,
    flags,
    capabilities,
    input,
    bind(request: Json, overrides = {}) {
      return createWorkflowConfiguration({
        profile,
        workspaceRoot: root,
        skills: [{ id: 'configured', path: 'skill' }],
        toolIds: ['files.read'],
        allowedCapabilities: ['files.read'],
        flags,
        request,
        capabilities,
        forkConfigurations: [],
        ...overrides,
      });
    },
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('profile Workflow switches are explicit, closed and default off', () => {
  const f = fixture();
  try {
    expect(readSkillWorkflowFlags(f.profile)).toEqual({
      skillActivation: false,
      skillWorkflow: false,
      verification: false,
    });
    writeFileSync(
      join(f.profile.profilePath, 'skill-workflow.jsonc'),
      JSON.stringify({ version: 1, features: f.flags }),
    );
    expect(readSkillWorkflowFlags(f.profile)).toEqual(f.flags);
    writeFileSync(
      join(f.profile.profilePath, 'skill-workflow.jsonc'),
      JSON.stringify({ version: 1, features: { ...f.flags, arbitraryGrant: true } }),
    );
    expect(() => readSkillWorkflowFlags(f.profile)).toThrow('workflow_configuration_invalid');
  } finally {
    f.close();
  }
});
test('trusted discovered sources bind original intent and reject unsupported envelopes/schema/disabled/untrusted sources', async () => {
  const f = fixture();
  try {
    const binding = await f.bind({ extensionInputs: [f.input] });
    expect(binding.enabled).toBe(true);
    expect(binding.entries[0]?.descriptor.availability).toBe('available');
    expect(binding.snapshot.originalActivationIntent).toEqual([f.input]);
    expect(binding.entries[0]?.contract?.instructions).toContain('Original workflow instructions');
    await expect(
      f.bind({ extensionInputs: [{ ...f.input, extensionId: 'unregistered' }] }),
    ).rejects.toThrow('workflow_extension_input_unavailable');
    await expect(
      f.bind({ extensionInputs: [{ ...f.input, definitionVersion: '2' }] }),
    ).rejects.toThrow('workflow_extension_input_unavailable');
    await expect(f.bind({ extensionInputs: [f.input, f.input] })).rejects.toThrow(
      'workflow_duplicate_input',
    );
    await expect(
      f.bind({ extensionInputs: [f.input] }, { flags: { ...f.flags, skillActivation: false } }),
    ).rejects.toThrow('workflow_disabled');
    await expect(
      f.bind({
        extensionInputs: [
          {
            ...f.input,
            input: {
              activations: [
                { key: 'original', skillId: 'skill:fixture', input: { unexpected: true } },
              ],
            },
          },
        ],
      }),
    ).rejects.toThrow('workflow_input_schema_invalid');
    await expect(
      f.bind(
        { extensionInputs: [f.input] },
        { skills: [{ id: 'outside', path: join(f.root, '..', 'outside') }] },
      ),
    ).rejects.toThrow('workflow_skill_unavailable');
    expect((await f.bind({ extensionInputs: [] })).snapshot.originalActivationIntent).toEqual([]);
    expect((await f.bind({})).snapshot.originalActivationIntent).toBeNull();
  } finally {
    f.close();
  }
});
test('fork ceiling is extracted from original activation and sealed facts, never child text', async () => {
  const config = {
    snapshot: {
      skillWorkflow: {
        entries: [
          {
            descriptor: { capabilityId: 'skill:fixture', revision: 'original' },
            contract: {
              context: { mode: 'fork', agent: 'code' },
              effectiveCapabilityCeiling: ['files.read'],
            },
          },
        ],
        capabilities: [
          {
            kind: 'tool',
            definitionId: 'files.read',
            definitionVersion: '1',
            capability: { capabilityId: 'files.read' },
          },
          {
            kind: 'tool',
            definitionId: 'files.write',
            definitionVersion: '1',
            capability: { capabilityId: 'files.write' },
          },
        ],
        forkConfigurations: [{ agent: 'code', configurationId: 'code', definitionVersion: '1' }],
      },
    },
  };
  const parent = {
    id: 'carrier',
    runId: 'run',
    sessionId: 's',
    originStoreId: 'store',
    definitionId: 'activate_skill',
    definitionVersion: '1',
    input: { key: 'original', skill_id: 'skill:fixture', input: {} },
  };
  const anchorKey = `run/run/workflow.${createHash('sha256').update('original').digest('hex')}`;
  const records = new Map<string, ExtensionRecord>();
  const write = (key: string, value: Json, revision = key) =>
    records.set(key, {
      key,
      value,
      revision,
      extensionId: 'builtin.skill-workflow',
      sessionId: 's',
      originStoreId: 'store',
      contentVersion: 1,
      contentType:
        key === anchorKey
          ? 'application/vnd.kite.skill-activation+json'
          : 'application/vnd.kite.skill-workflow-state+json',
    });
  const shared = {
    activationId: 'original',
    skillId: 'skill:fixture',
    skillRevision: 'original',
    runId: 'run',
    sessionId: 's',
    originStoreId: 'store',
    anchorRevision: 'anchor',
    attempt: 1,
  };
  write(anchorKey, { ...shared, kind: 'activation' }, 'anchor');
  write(`${anchorKey}/head`, { kind: 'head', attempt: 1 }, 'head');
  write(`${anchorKey}/attempts/1/opening`, {
    ...shared,
    kind: 'attempt',
    createdBy: 'initial',
    previousAttempt: null,
    detail: null,
    executionId: null,
  });
  write(`${anchorKey}/attempts/1/fork-opening`, {
    ...shared,
    kind: 'fork_opening',
    headRevision: 'head',
    carrierExecutionId: 'carrier',
    carrierDefinitionId: 'activate_skill',
    carrierDefinitionVersion: '1',
    carrierInputDigest: createHash('sha256')
      .update(workflowSnapshotDigest(parent.input))
      .digest('hex'),
    configurationId: 'code',
    configurationVersion: '1',
  });
  const scope = {
    runId: 'run',
    records: {
      async get(key: string) {
        return records.get(key) ?? null;
      },
    },
  };
  const role = { id: 'code', version: '1', toolIds: ['files.read', 'files.write'] };
  const fence = await workflowForkFence(config, parent, role, scope);
  expect(fence?.toolIds).toEqual(['files.read']);
  expect(fence?.capabilities).toEqual([
    { kind: 'tool', definitionId: 'files.read', definitionVersion: '1' },
  ]);
  for (const changed of [
    { ...parent, input: { ...parent.input, skill_id: 'forged' } },
    { ...parent, id: 'forged' },
    { ...parent, runId: 'wrong' },
    { ...parent, originStoreId: 'wrong' },
    { ...parent, sessionId: 'wrong' },
  ])
    await expect(workflowForkFence(config, changed, role, scope)).rejects.toThrow(
      'workflow_fork_unavailable',
    );
  write(`${anchorKey}/head`, { kind: 'head', attempt: 2 }, 'new-head');
  await expect(workflowForkFence(config, parent, role, scope)).rejects.toThrow(
    'workflow_fork_unavailable',
  );
  write(`${anchorKey}/head`, { kind: 'head', attempt: 1, waiverKey: 'waiver' }, 'head');
  await expect(workflowForkFence(config, parent, role, scope)).rejects.toThrow(
    'workflow_fork_unavailable',
  );
  for (const createdBy of ['repair', 'replan']) {
    const carrier = {
      ...parent,
      id: `${createdBy}-carrier`,
      definitionId: createdBy === 'repair' ? 'repair_skill' : 'decide_skill_verification',
      input: {
        activation_id: 'original',
        attempt: 1,
        ...(createdBy === 'repair' ? { detail: 'Repair the original output' } : {}),
      },
    };
    const detail = 'Repair the original output';
    const decisionKey = `${anchorKey}/attempts/1/decision/${carrier.id}`;
    write(`${anchorKey}/head`, { kind: 'head', attempt: 2 }, 'head2');
    write(`${anchorKey}/attempts/2/opening`, {
      ...shared,
      kind: 'attempt',
      attempt: 2,
      createdBy,
      previousAttempt: 1,
      detail,
      executionId: carrier.id,
      ...(createdBy === 'replan' ? { decisionKey } : {}),
    });
    write(`${anchorKey}/attempts/2/fork-opening`, {
      ...shared,
      kind: 'fork_opening',
      attempt: 2,
      headRevision: 'head2',
      carrierExecutionId: carrier.id,
      carrierDefinitionId: carrier.definitionId,
      carrierDefinitionVersion: '1',
      carrierInputDigest: createHash('sha256')
        .update(workflowSnapshotDigest(carrier.input))
        .digest('hex'),
      configurationId: 'code',
      configurationVersion: '1',
    });
    if (createdBy === 'replan') {
      const verifier = {
        outcome: 'failed',
        outputDigest: 'original-output',
        executionId: 'verifier',
        resultRevision: 'result',
      };
      write(`${anchorKey}/attempts/1/verification`, verifier);
      const request = {
        kind: 'skill_workflow_verification',
        originStoreId: 'store',
        sessionId: 's',
        runId: 'run',
        activationId: 'original',
        anchorKey,
        anchorRevision: 'anchor',
        requirementId: `workflow.${createHash('sha256').update('original').digest('hex')}`,
        requirementRevision: 'anchor',
        skillId: 'skill:fixture',
        skillRevision: 'original',
        attempt: 1,
        headRevision: 'head1',
        outputDigest: 'original-output',
        verifier,
      };
      write(decisionKey, {
        kind: 'user_decision',
        outcome: 'replan',
        detail,
        request,
        proof: {
          originStoreId: 'store',
          sessionId: 's',
          runId: 'run',
          executionId: carrier.id,
          interactionId: 'accepted',
          decisionRevision: 'accepted-decision',
          attempt: 1,
          request,
          answer: { kind: 'question', answers: { decision: 'replan', detail } },
        },
        recordedAt: 1,
      });
    }
    const repaired = await workflowForkFence(config, carrier, role, scope);
    expect(repaired?.toolIds).toEqual(['files.read']);
    expect(repaired?.openingFacts.opening.value).toMatchObject({
      attempt: 2,
      createdBy,
      executionId: carrier.id,
    });
    await expect(
      workflowForkFence(
        config,
        { ...carrier, input: { ...carrier.input, attempt: 2 } },
        role,
        scope,
      ),
    ).rejects.toThrow('workflow_fork_unavailable');
    await expect(
      workflowForkFence(config, carrier, { ...role, version: '2' }, scope),
    ).rejects.toThrow('workflow_fork_unavailable');
    records.delete(`${anchorKey}/attempts/2/fork-opening`);
    await expect(workflowForkFence(config, carrier, role, scope)).rejects.toThrow(
      'workflow_fork_unavailable',
    );
  }
});

test.each(
  process.platform === 'darwin'
    ? ['schema', 'script', 'script_asset_drift', 'large', 'large_follow_up']
    : ['schema', 'large', 'large_follow_up'],
)('default Service binds activation before first fixed Model and verification (%s)', async (verification) => {
  const { createRuntime } = await import('@kite-ai/agent');
  const { openSqliteStore } = await import('@kite-ai/agent/sqlite');
  const { createDefaultProcessConfiguration } = await import('../../src/configuration');
  const { createArtifactStore } = await import('@kite-ai/agent/artifacts');
  const f = fixture();
  let shell: import('../../src/configuration').ShellConfigurationOptions | undefined;
  let expectedInstructions: string | undefined;
  let expectedInputBlob: string | undefined;
  if (verification.startsWith('large')) {
    const instructions =
      'Original workflow instructions\n' +
      'Long original instructions. '.repeat(43000) +
      '\nEXACT_INSTRUCTIONS_TAIL';
    writeFileSync(
      join(f.skill, 'SKILL.md'),
      readFileSync(join(f.skill, 'SKILL.md'), 'utf8')
        .replace(
          '"input_schema":{"type":"object","additionalProperties":false}',
          '"input_schema":{"type":"object","properties":{"blob":{"type":"string"}},"required":["blob"],"additionalProperties":false}',
        )
        .replace('Original workflow instructions', instructions),
    );
    expectedInstructions = instructions;
    expectedInputBlob = `${'original-input-'.repeat(4000)}EXACT_INPUT_TAIL`;
    f.input.input.activations[0]!.input = { blob: expectedInputBlob };
    expect(Buffer.byteLength(instructions)).toBeGreaterThan(1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(f.input.input))).toBeGreaterThan(32 * 1024);
  }

  if (verification.startsWith('script')) {
    writeFileSync(
      join(f.skill, 'SKILL.md'),
      readFileSync(join(f.skill, 'SKILL.md'), 'utf8').replace(
        '"verification":{"mode":"required"}',
        '"verification":{"mode":"required","strategy":"script","entrypoint":"check.ts","timeout_ms":3000}',
      ),
    );
    writeFileSync(
      join(f.skill, 'check.ts'),
      `import {writeFileSync} from 'node:fs'; if(process.env.WORKFLOW_FIXTURE!=='selected')throw Error('env');writeFileSync(${JSON.stringify(join(f.root, 'verification-ledger'))},'verified');`,
    );
    const built = await Bun.build({
      entrypoints: [
        join(
          import.meta.dir,
          '../../../../packages/agent/src/platform/process/shell-supervisor.ts',
        ),
      ],
      outdir: join(f.root, 'assets'),
      target: 'bun',
      naming: 'shell-supervisor.js',
    });
    expect(built.success).toBe(true);
    shell = {
      platform: 'darwin',
      configurationId: 'qualified-fixture',
      env: { PATH: '/usr/bin:/bin', WORKFLOW_FIXTURE: 'selected' },
      supervisorPath: built.outputs[0]!.path,
      bunExecutable: process.execPath,
      shellExecutable: '/bin/sh',
    };
  }
  const requests: Record<string, unknown>[] = [];
  let vaultReads = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Record<string, unknown>);
      const first = requests.length === 1;
      const delta = first
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'complete-original',
                type: 'function',
                function: {
                  name: 'complete_skill',
                  arguments: JSON.stringify({ activation_id: 'original', output: {} }),
                },
              },
            ],
          }
        : { role: 'assistant', content: 'Untranslated original Model text' };
      const chunk = (value: unknown, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', created: 1, model: 'fixed', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
      return new Response(
        `${chunk(delta, null)}${chunk({}, first ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  writeFileSync(
    join(f.profile.profilePath, 'skill-workflow.jsonc'),
    JSON.stringify({ version: 1, features: f.flags }),
  );
  writeFileSync(
    join(f.profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'fixed',
      models: [
        {
          id: 'fixed',
          provider: 'compatible',
          model: 'fixed',
          baseURL: `http://127.0.0.1:${provider.port}/v1`,
          credentialRef: 'credential:11111111-1111-1111-1111-111111111111',
        },
      ],
      tools: [{ id: 'files.read' }],
      skills: [{ id: 'configured', path: 'skill' }],
    }),
  );
  const store = await openSqliteStore({ dataRoot: f.profile.dataRoot, profile: f.profile.profile });
  const host = createDefaultProcessConfiguration({
    profile: f.profile,
    allowedToolCapabilities: ['files.read'],
    shell,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'trusted-test-policy' };
      },
    },
    credentialBackend: {
      kind: 'temporary',
      async put() {},
      async remove() {},
      async resolve() {
        vaultReads++;
        return 'fixed-nonsecret';
      },
    },
  });
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile: f.profile, store }),
    permissions: host.permissions!,
    extensions: host.extensions,
    resolveRunConfiguration: host.resolveRunConfiguration,
    supportsExtensionInputs: host.supportsExtensionInputs,
  });
  host.permissionManagement?.(runtime);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  const until = async <T>(read: () => Promise<T>, matches: (value: T) => boolean) => {
    const end = Date.now() + 5000;
    for (;;) {
      const value = await read();
      if (matches(value)) return value;
      if (Date.now() > end) throw Error('workflow_service_deadline');
      await Bun.sleep(5);
    }
  };
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'fixture',
      rootUri: `file://${f.root}`,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'w',
      title: 'fixture',
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'bad',
      request: {
        kind: 'run.start',
        content: 'bad',
        extensionInputs: [{ ...f.input, definitionVersion: 'unavailable' }],
      },
    });
    expect((await runtime.waitForCommand('bad', { timeoutMs: 5000 })).status).toBe('rejected');
    expect(vaultReads).toBe(0);
    expect(requests).toHaveLength(0);
    await runtime.submitCommand({
      ...base,
      commandId: 'good',
      request: { kind: 'run.start', content: 'explicit', extensionInputs: [f.input] },
    });
    const command = await until(
      () => store.getCommand('good'),
      (command) => command?.status === 'applied',
    );
    expect(command?.status).toBe('applied');
    if (verification.startsWith('large')) {
      const view = await until(
        () => store.getView('s'),
        (view) =>
          requests.length > 0 ||
          view.runs.some((run) => run.originCommandId === 'good' && !run.isActive),
      );
      const original = view.runs.find((run) => run.originCommandId === 'good');
      if (original && !original.isActive)
        throw Error(`large_workflow_initialization_failed:${original.reason}`);
    }
    const cards = await until(
      () => store.listInteractions({ ...base, state: 'pending' }),
      (page) => page.interactions.some((card) => card.kind === 'approval'),
    );
    const card = cards.interactions.find((card) => card.kind === 'approval')!;
    expect(card.definitionId).toBe('complete_skill');
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.messages)).toContain('Original workflow instructions');
    if (verification.startsWith('large')) {
      expect(JSON.stringify(requests[0]?.messages)).toContain('EXACT_INSTRUCTIONS_TAIL');
      expect(JSON.stringify(requests[0]?.messages)).toContain('EXACT_INPUT_TAIL');
      const messages = requests[0]?.messages as { content: string }[];
      const original = messages
        .flatMap((message) => {
          try {
            return [
              JSON.parse(message.content) as {
                activationId?: string;
                instructions?: string;
                input?: { blob?: string };
              },
            ];
          } catch {
            return [];
          }
        })
        .find((value) => value.activationId === 'original');
      expect(original?.instructions).toBe(expectedInstructions);
      expect(original?.input?.blob).toBe(expectedInputBlob);
    }
    const run = (await store.getView('s')).runs.find((run) => run.originCommandId === 'good')!;
    expect(run.requirements.some((ref) => ref.extensionId === 'builtin.skill-workflow')).toBe(true);
    expect(
      (await store.listExecutions('s')).find(
        (execution) => execution.definitionId === 'complete_skill',
      )?.status,
    ).toBe('planned');
    await runtime.answerInteraction({
      ...base,
      commandId: 'approve',
      presentationSessionId: 's',
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve' },
    });
    if (verification.startsWith('script')) {
      const pending = await until(
        () => store.listInteractions({ ...base, state: 'pending' }),
        (page) => page.interactions.some((card) => card.definitionId === 'skill.workflow.verify'),
      );
      const approval = pending.interactions.find(
        (card) => card.definitionId === 'skill.workflow.verify',
      )!;
      expect(existsSync(join(f.root, 'verification-ledger'))).toBe(false);
      expect(requests).toHaveLength(1);
      if (verification === 'script_asset_drift')
        writeFileSync(
          shell!.supervisorPath,
          `${readFileSync(shell!.supervisorPath, 'utf8')}\n// replacement during approval\n`,
        );
      await runtime.answerInteraction({
        ...base,
        commandId: 'approve-verifier',
        presentationSessionId: 's',
        interactionId: approval.id,
        expectedRevision: approval.revision,
        answer: { kind: 'approval', decision: 'approve' },
      });
    }
    await until(
      () => store.getRun(run.id),
      (run) => !!run && !run.isActive,
    );
    expect((await store.getRun(run.id))?.status).toBe(
      verification === 'script_asset_drift' ? 'failed' : 'completed',
    );
    expect(requests).toHaveLength(2);
    expect(vaultReads).toBe(1);
    if (verification === 'script') {
      expect(readFileSync(join(f.root, 'verification-ledger'), 'utf8')).toBe('verified');
      expect(
        (await store.listExecutions('s'))
          .filter((execution) => execution.definitionId === 'skill.workflow.verify')
          .map((execution) => ({ kind: execution.kind, status: execution.status })),
      ).toEqual([{ kind: 'job', status: 'succeeded' }]);
    }
    if (verification === 'script_asset_drift') {
      expect(existsSync(join(f.root, 'verification-ledger'))).toBe(false);
      expect(
        (await store.listExecutions('s')).find(
          (execution) => execution.definitionId === 'skill.workflow.verify',
        )?.result,
      ).toMatchObject({ details: { code: 'workflow_verifier_asset_changed' } });
    }
    const original = await store.getCommand('good');
    expect(original?.request).toMatchObject({ extensionInputs: [f.input] });
    if (verification === 'large_follow_up') {
      await runtime.submitCommand({
        ...base,
        commandId: 'large-follow-up',
        request: {
          kind: 'input.follow_up',
          content: 'Continue the original session',
          afterRunId: run.id,
          contextSelectionId: (await store.getSession('s'))!.contextSelectionId,
        },
      });
      const continuation = await runtime.waitForCommand('large-follow-up', { timeoutMs: 5000 });
      expect(continuation).toMatchObject({ status: 'applied' });
    }

    writeFileSync(
      join(f.skill, 'SKILL.md'),
      readFileSync(join(f.skill, 'SKILL.md'), 'utf8').replace(
        'Original workflow instructions',
        'Changed workflow instructions',
      ),
    );
    // Direct observation avoids Bun's promise-rejection matcher retaining this real Runtime.
    let recoveryError: unknown;
    try {
      await host.resolveRecoveryRunConfiguration!({
        command: original!,
        run: (await store.getRun(run.id))!,
        session: (await store.getSession('s'))!,
        workspace: (await store.getWorkspace('w'))!,
        signal: new AbortController().signal,
      });
    } catch (error) {
      recoveryError = error;
    }
    expect(recoveryError).toBeInstanceOf(Error);
    if (!(recoveryError instanceof Error)) throw Error('workflow_recovery_expected_rejection');
    expect(recoveryError.message).toContain('recovery_configuration_changed');
    expect(vaultReads).toBe(verification === 'large_follow_up' ? 2 : 1);
    expect(requests).toHaveLength(verification === 'large_follow_up' ? 3 : 2);
  } finally {
    await runtime.close();
    provider.stop(true);
    f.close();
  }
});

test.each([
  'clean',
  'mutation',
  'drift',
  'large',
])('actual fork inherits sealed child capability ceiling (%s)', async (scenario) => {
  const malicious = scenario === 'mutation' || scenario === 'drift';
  const { createRuntime } = await import('@kite-ai/agent');
  const { openSqliteStore } = await import('@kite-ai/agent/sqlite');
  const { createDefaultProcessConfiguration } = await import('../../src/configuration');
  const { createArtifactStore } = await import('@kite-ai/agent/artifacts');
  const f = fixture();
  writeFileSync(
    join(f.skill, 'SKILL.md'),
    readFileSync(join(f.skill, 'SKILL.md'), 'utf8').replace('"mode":"inline"', '"mode":"fork"'),
  );
  const expectedForkInstructions = `Original workflow instructions\n${'Large fork original instructions. '.repeat(35000)}\nEXACT_FORK_INSTRUCTIONS_TAIL`;
  if (scenario === 'large') {
    writeFileSync(
      join(f.skill, 'SKILL.md'),
      readFileSync(join(f.skill, 'SKILL.md'), 'utf8').replace(
        'Original workflow instructions',
        expectedForkInstructions,
      ),
    );
    expect(Buffer.byteLength(expectedForkInstructions)).toBeGreaterThan(1024 * 1024);
  }
  const requests: Record<string, unknown>[] = [];
  let childCalls = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const child = JSON.stringify(body.messages).includes(
        'Execute the explicitly activated Skill',
      );
      const call =
        child && malicious && childCalls++ === 0
          ? scenario === 'drift'
            ? { name: 'files.read', input: { path: 'skill/SKILL.md' } }
            : { name: 'files.write', input: { path: 'forbidden.txt', content: 'must not execute' } }
          : requests.length === 1
            ? {
                name: 'activate_skill',
                input: { key: 'fork', skill_id: 'skill:fixture', input: {} },
              }
            : null;
      const delta = call
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call-${requests.length}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              },
            ],
          }
        : { role: 'assistant', content: child ? '{}' : 'Parent complete' };
      const chunk = (value: unknown, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', created: 1, model: 'fixed', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
      return new Response(
        `${chunk(delta, null)}${chunk({}, call ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  writeFileSync(
    join(f.profile.profilePath, 'skill-workflow.jsonc'),
    JSON.stringify({ version: 1, features: f.flags }),
  );
  writeFileSync(
    join(f.profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'fixed',
      models: [
        {
          id: 'fixed',
          provider: 'compatible',
          model: 'fixed',
          baseURL: `http://127.0.0.1:${provider.port}/v1`,
        },
      ],
      tools: [{ id: 'files.read' }, { id: 'files.write' }],
      skills: [{ id: 'configured', path: 'skill' }],
    }),
  );
  const host = createDefaultProcessConfiguration({
    profile: f.profile,
    allowedToolCapabilities: ['files.read', 'files.write'],
    child: [{ id: 'code', version: '1', toolIds: ['files.read', 'files.write'] }],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'trusted-test' };
      },
    },
  });
  const store = await openSqliteStore({ dataRoot: f.profile.dataRoot, profile: f.profile.profile });
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile: f.profile, store }),
    permissions: host.permissions!,
    extensions: host.extensions,
    resolveRunConfiguration: host.resolveRunConfiguration,
    childConfigurations: host.childConfigurations,
    resolveChildRunConfiguration: host.resolveChildRunConfiguration,
    supportsExtensionInputs: host.supportsExtensionInputs,
  });
  host.permissionManagement?.(runtime);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'fixture',
      rootUri: `file://${f.root}`,
    });
    await runtime.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'fork' });
    await runtime.submitCommand({
      ...base,
      commandId: 'fork',
      request: { kind: 'run.start', content: 'Explicit fork fixture' },
    });
    const end = Date.now() + 5000;
    let answers = 0;
    for (;;) {
      const interactions = await store.listInteractions({ ...base, state: 'pending' });
      const childId = (await store.listExecutions('s')).find(
        (execution) => execution.definitionId === 'agent/code',
      )?.childSessionId;
      if (childId)
        interactions.interactions.push(
          ...(await store.listInteractions({ ...base, sessionId: childId, state: 'pending' }))
            .interactions,
        );
      for (const card of interactions.interactions.filter((card) => card.kind === 'approval')) {
        if (scenario === 'drift' && card.definitionId === 'files.read') {
          expect(requests.length).toBe(2);
          expect(
            (await store.getView(card.sessionId)).executions
              .filter((execution) => execution.definitionId === 'files.read')
              .every((execution) => execution.status === 'planned'),
          ).toBe(true);
          writeFileSync(
            join(f.skill, 'SKILL.md'),
            readFileSync(join(f.skill, 'SKILL.md'), 'utf8').replace(
              'Original workflow instructions',
              'Unauthorized changed instructions',
            ),
          );
        }
        await runtime.answerInteraction({
          ...base,
          commandId: `approve-${answers++}`,
          presentationSessionId: 's',
          interactionId: card.id,
          expectedRevision: card.revision,
          answer: { kind: 'approval', decision: 'approve' },
        });
      }
      const view = await store.getView('s');
      const run = view.runs.find((run) => run.originCommandId === 'fork');
      if (run && !run.isActive) {
        if (scenario === 'large' && run.status !== 'completed')
          throw Error(
            `large_fork_failed:${JSON.stringify(view.executions.map((execution) => ({ definitionId: execution.definitionId, status: execution.status, result: execution.result })))}`,
          );
        expect(run.status).toBe(malicious ? 'failed' : 'completed');
        break;
      }
      if (Date.now() > end)
        throw Error(
          `workflow_fork_deadline:${JSON.stringify(view.executions.map((execution) => ({ id: execution.definitionId, status: execution.status, result: execution.result })))}`,
        );
      await Bun.sleep(5);
    }
    const agent = (await store.listExecutions('s')).find(
      (execution) => execution.definitionId === 'agent/code',
    )!;
    expect(agent.status).toBe(malicious ? 'failed' : 'succeeded');
    expect(agent.childSessionId).toBeTruthy();
    const childView = await store.getView(agent.childSessionId!);
    const manifest = childView.runs[0]!.configuration as {
      tools: { extensionId: string; id: string; version: string }[];
    };
    expect(manifest.tools).toContainEqual({
      extensionId: 'builtin.files',
      id: 'files.read',
      version: '3',
    });
    expect(manifest.tools.some((tool) => tool.id === 'files.write')).toBe(false);
    const childRequests = requests.filter((request) =>
      JSON.stringify(request.messages).includes('Execute the explicitly activated Skill'),
    );
    expect(childRequests.length).toBeGreaterThan(0);
    if (scenario === 'large') {
      expect(JSON.stringify(childRequests[0]?.messages)).toContain('EXACT_FORK_INSTRUCTIONS_TAIL');
      const containsFullInstructions = (value: unknown): boolean => {
        if (typeof value === 'string') {
          if (value.includes(expectedForkInstructions)) return true;
          try {
            return containsFullInstructions(JSON.parse(value));
          } catch {
            return false;
          }
        }
        if (Array.isArray(value)) return value.some(containsFullInstructions);
        if (value && typeof value === 'object')
          return Object.values(value).some(containsFullInstructions);
        return false;
      };
      expect(containsFullInstructions(childRequests[0]?.messages)).toBe(true);
    }
    expect(
      (childRequests[0]?.tools as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      ),
    ).not.toContain('files.write');
    expect(
      childView.executions
        .filter(
          (execution) =>
            execution.definitionId === (scenario === 'drift' ? 'files.read' : 'files.write'),
        )
        .every((execution) => execution.status !== 'succeeded'),
    ).toBe(true);
    if (scenario === 'drift') expect(requests).toHaveLength(2);
    expect(existsSync(join(f.root, 'forbidden.txt'))).toBe(false);
  } finally {
    await runtime.close();
    provider.stop(true);
    f.close();
  }
});

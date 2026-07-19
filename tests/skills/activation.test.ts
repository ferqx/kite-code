import { describe, expect, it } from 'bun:test';
import { getFeatureFlags } from '../../src/core/config/features';
import { executeRuntimeTools } from '../../src/core/controllers/tool-controller';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import { createInitialRuntimeState } from '../../src/core/runtime/state';
import {
  evaluateSkillActivation,
  skillFrameInvalidationReason,
} from '../../src/core/skills/activation';
import type { SkillCatalogSnapshot } from '../../src/core/skills/catalog';

const catalog: SkillCatalogSnapshot = {
  revision: 'catalog-r1',
  capabilities: {
    revision: 'catalog-r1',
    descriptors: [
      {
        capabilityId: 'skill:read-report',
        revision: 'skill-r1',
        kind: 'skill',
        displayName: 'read-report',
        description: 'Read a report.',
        provider: { type: 'skill', id: 'read-report', provenance: 'project', version: '1.0.0' },
        inputSchema: {
          type: 'object',
          properties: { report: { type: 'string' } },
          required: ['report'],
        },
        outputSchema: { type: 'object' },
        declaredEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
        effectiveEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
        policy: { workspaceTrustRequired: true, minimumApproval: 'none' },
        execution: { retry: 'never' },
        availability: 'available',
        diagnostics: [],
      },
    ],
  },
  entries: [
    {
      sourcePath: '/workspace/.kite-code/skills/read-report',
      source: 'project',
      origin: '.kite-code',
      diagnostics: [],
      descriptor: {
        capabilityId: 'skill:read-report',
        revision: 'skill-r1',
        kind: 'skill',
        displayName: 'read-report',
        description: 'Read a report.',
        provider: { type: 'skill', id: 'read-report', provenance: 'project', version: '1.0.0' },
        inputSchema: {
          type: 'object',
          properties: { report: { type: 'string' } },
          required: ['report'],
        },
        outputSchema: { type: 'object' },
        declaredEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
        effectiveEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
        policy: { workspaceTrustRequired: true, minimumApproval: 'none' },
        execution: { retry: 'never' },
        availability: 'available',
        diagnostics: [],
      },
      contract: {
        schemaVersion: 1,
        name: 'read-report',
        version: '1.0.0',
        description: 'Read a report.',
        instructions: 'Read it.',
        invocation: { allowImplicit: true, allowManual: true },
        context: { mode: 'inline', agent: 'code' },
        inputSchema: {
          type: 'object',
          properties: { report: { type: 'string' } },
          required: ['report'],
        },
        outputSchema: { type: 'object' },
        capabilityCeiling: ['builtin:read_file'],
        deniedCapabilities: [],
        effectiveCapabilityCeiling: ['builtin:read_file'],
        effects: { filesystem: 'read', network: 'none', externalState: 'none' },
        effectiveEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
        minimumApproval: 'none',
        effectiveMinimumApproval: 'none',
        execution: { timeoutMs: 1_000, maxAttempts: 1 },
        verification: { mode: 'not_required' },
        recovery: { retry: 'never' },
        files: ['SKILL.md'],
        dependencyRevisions: {},
      },
    },
  ],
};

function activeState() {
  let state = createInitialRuntimeState({
    threadId: 'thread',
    userId: 'user',
    workspace: '/workspace',
  });
  state = reduceRuntimeState(state, {
    type: 'task.started',
    taskId: 'task',
    userGoal: 'read report',
    turnId: state.turn.turnId,
  });
  return state;
}

describe('Skill Workflow activation', () => {
  it('fails closed until both Skill flags are enabled', () => {
    const result = evaluateSkillActivation({
      state: activeState(),
      catalog,
      flags: getFeatureFlags(),
      request: {
        skillId: 'skill:read-report',
        input: { report: 'daily' },
        requestedBy: 'user',
        implicit: false,
      },
    });
    expect(result).toEqual({
      ok: false,
      reason: 'Skill Workflow activation is disabled by feature flag.',
    });
  });

  it('creates durable catalog and frame facts for a valid activation', () => {
    const result = evaluateSkillActivation({
      state: activeState(),
      catalog,
      flags: getFeatureFlags({ features: { skillWorkflowV1: true, skillActivationV2: true } }),
      request: {
        skillId: 'skill:read-report',
        input: { report: 'daily' },
        requestedBy: 'user',
        implicit: false,
      },
      now: new Date('2026-07-15T00:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    let state = activeState();
    for (const event of result.events) state = reduceRuntimeState(state, event);
    expect(state.skills.catalogRevision).toBe('catalog-r1');
    expect(state.skills.frames[result.activation.activationId]).toMatchObject({
      skillId: 'skill:read-report',
      status: 'active',
      contextMode: 'inline',
      agent: 'code',
    });
  });

  it('rejects malformed input and invalidates frames after revision drift', () => {
    const flags = getFeatureFlags({ features: { skillWorkflowV1: true, skillActivationV2: true } });
    const invalid = evaluateSkillActivation({
      state: activeState(),
      catalog,
      flags,
      request: { skillId: 'skill:read-report', input: {}, requestedBy: 'user', implicit: false },
    });
    expect(invalid.ok).toBe(false);

    const valid = evaluateSkillActivation({
      state: activeState(),
      catalog,
      flags,
      request: {
        skillId: 'skill:read-report',
        input: { report: 'daily' },
        requestedBy: 'user',
        implicit: false,
      },
    });
    if (!valid.ok) throw new Error(valid.reason);
    const drifted: SkillCatalogSnapshot = {
      ...catalog,
      entries: catalog.entries.map((entry) => ({
        ...entry,
        descriptor: { ...entry.descriptor, revision: 'skill-r2' },
      })),
    };
    expect(skillFrameInvalidationReason(valid.activation, drifted)).toContain(
      'changed after activation',
    );
  });

  it('routes model activation through the effective minimum approval', async () => {
    const state = activeState();
    const descriptor = {
      ...catalog.capabilities.descriptors[0]!,
      policy: { workspaceTrustRequired: true, minimumApproval: 'user' as const },
      effectiveEffects: {
        filesystem: 'write' as const,
        network: 'none' as const,
        externalState: 'none' as const,
      },
    };
    state.capabilities.disclosures[descriptor.capabilityId] = {
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      issuedForTurnId: state.turn.turnId,
    };
    state.tools.calls.activate = {
      toolCallId: 'activate',
      modelMessageId: 'model',
      name: 'activate_skill',
      args: { skill_id: descriptor.capabilityId, input: { report: 'daily' } },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('activate');
    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['activate'],
      skillCatalog: {
        ...catalog,
        capabilities: { revision: 'risk-r1', descriptors: [descriptor] },
        entries: catalog.entries.map((entry) => ({ ...entry, descriptor })),
      },
      taskConfig: {
        apiKey: '',
        baseURL: 'http://localhost',
        modelName: 'test',
        providerName: 'test',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
        features: {
          toolSearchV1: true,
          skillWorkflowV1: true,
          skillActivationV2: true,
        },
      },
    });
    expect(events.some((event) => event.type === 'approval.requested')).toBe(true);
    expect(events.some((event) => event.type === 'skill.activation_started')).toBe(false);
  });
});

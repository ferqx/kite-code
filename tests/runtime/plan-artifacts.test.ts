import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planArtifactPath } from '@/core/config/paths';
import { executeRuntimeTools } from '@/core/controllers/tool-controller';
import { PlanArtifactError, PlanArtifactStore } from '@/core/persistence/plan-artifacts';
import { createAgentKernel } from '@/core/runtime/kernel';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import {
  computePlanStructuralDigest,
  createInitialRuntimeState,
  RUNTIME_STATE_SCHEMA_VERSION,
} from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';
import { writePlanInputSchema } from '@/core/tools/registry/builtins/write-plan';
import type { PlanDocument } from '@/protocol/events';

let home: string;
let previousHome: string | undefined;

function document(version = 1): PlanDocument {
  const plan: PlanDocument = {
    planSchemaVersion: 2,
    planId: 'plan-artifact-test',
    version,
    title: 'Artifact-backed plan',
    bodyMarkdown: 'Inspect the Artifact lifecycle and verify the review boundary.',
    steps: [{ id: 'inspect', title: 'Inspect the Artifact lifecycle', status: 'pending' }],
    structuralDigest: '',
    createdAtTurnId: 'turn-1',
    updatedAtTurnId: 'turn-1',
    completionEvidence: {
      schemaVersion: 1,
      verification: [],
      execution: [],
      skipped: [],
      unresolved: [],
    },
  };
  plan.structuralDigest = computePlanStructuralDigest(plan);
  return plan;
}

const validWrite = {
  action: 'save' as const,
  title: 'Artifact-backed plan',
  body_markdown: 'Inspect the Artifact lifecycle and verify every transition.',
  steps: [{ id: 'inspect', title: 'Inspect the Artifact lifecycle' }],
};

function withCall(
  state: ReturnType<typeof createInitialRuntimeState>,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
) {
  return {
    ...state,
    tools: {
      ...state.tools,
      calls: {
        ...state.tools.calls,
        [toolCallId]: {
          toolCallId,
          modelMessageId: `model-${toolCallId}`,
          ordinal: 0,
          name,
          args,
          status: 'queued' as const,
          createdAtTurnId: state.turn.turnId,
        },
      },
      queue: [...state.tools.queue, toolCallId],
    },
  };
}

describe('Plan Artifact persistence and two-phase review', () => {
  beforeEach(() => {
    previousHome = process.env.KITE_CODE_HOME;
    home = mkdtempSync(join(tmpdir(), 'kite-code-plan-artifact-'));
    process.env.KITE_CODE_HOME = home;
  });

  afterEach(() => {
    if (previousHome == null) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  test('writes an immutable versioned Markdown Artifact and reads it back', () => {
    const store = new PlanArtifactStore();
    const first = store.write('task-1', document());

    expect(first.artifactId).toBe('plan-artifact-test:v1');
    expect(first.fileName).toBe('v1.md');
    expect(readFileSync(first.displayPath, 'utf8')).toContain('# Artifact-backed plan');
    expect(store.read(first).plan.bodyMarkdown).toContain('Inspect the Artifact lifecycle');

    const changed = {
      ...document(),
      bodyMarkdown: 'A different plan body entirely.',
      structuralDigest: '',
    };
    changed.structuralDigest = computePlanStructuralDigest(changed);
    expect(() => store.write('task-1', changed)).toThrow(PlanArtifactError);
  });

  test('enforces PlanDocument V2 title, body, step, count, and identity schema limits', () => {
    expect(writePlanInputSchema.safeParse({ ...validWrite, title: 'bad\ntitle' }).success).toBe(
      false,
    );
    expect(
      writePlanInputSchema.safeParse({ ...validWrite, body_markdown: 'too short' }).success,
    ).toBe(false);
    expect(
      writePlanInputSchema.safeParse({
        ...validWrite,
        steps: [{ id: 'inspect', title: 'bad\nstep' }],
      }).success,
    ).toBe(false);
    expect(
      writePlanInputSchema.safeParse({
        ...validWrite,
        steps: [
          { id: 'same', title: 'First step' },
          { id: 'same', title: 'Second step' },
        ],
      }).success,
    ).toBe(false);
    expect(
      writePlanInputSchema.safeParse({
        ...validWrite,
        steps: Array.from({ length: 13 }, (_, index) => ({
          id: `step-${index}`,
          title: `Step ${index}`,
        })),
      }).success,
    ).toBe(false);
  });

  test('rejects structurally invalid step metadata before write or read', () => {
    const invalid = {
      ...document(),
      planId: 'invalid-step-plan',
      steps: [{ id: null, title: 'Invalid step', status: 'bogus' }],
      structuralDigest: '',
    } as unknown as PlanDocument;
    invalid.structuralDigest = computePlanStructuralDigest(invalid);
    const store = new PlanArtifactStore();

    expect(() => store.write('task-invalid-step-write', invalid)).toThrow(PlanArtifactError);

    const target = planArtifactPath('task-invalid-step-read', invalid.planId, invalid.version);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      `<!-- kite-code-plan ${JSON.stringify({
        artifactFormatVersion: 1,
        planSchemaVersion: 2,
        taskId: 'task-invalid-step-read',
        planId: invalid.planId,
        version: invalid.version,
        title: invalid.title,
        structuralDigest: invalid.structuralDigest,
        steps: invalid.steps,
        createdAtTurnId: invalid.createdAtTurnId,
        updatedAtTurnId: invalid.updatedAtTurnId,
        completionEvidence: invalid.completionEvidence,
      })} -->\n# ${invalid.title}\n\n${invalid.bodyMarkdown}\n`,
    );

    expect(() =>
      store.read({
        artifactId: `${invalid.planId}:v${invalid.version}`,
        taskId: 'task-invalid-step-read',
        planId: invalid.planId,
        version: invalid.version,
        fileName: `v${invalid.version}.md`,
        relativePath: '',
        displayPath: target,
        structuralDigest: invalid.structuralDigest,
        byteLength: 0,
      }),
    ).toThrow(PlanArtifactError);
  });

  test('rejects a structural digest that does not match parsed or written content', () => {
    const inconsistent = {
      ...document(),
      planId: 'inconsistent-digest-plan',
      structuralDigest: '0'.repeat(64),
    };
    const store = new PlanArtifactStore();

    expect(() => store.write('task-inconsistent-digest-write', inconsistent)).toThrow(
      PlanArtifactError,
    );

    const target = planArtifactPath(
      'task-inconsistent-digest-read',
      inconsistent.planId,
      inconsistent.version,
    );
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      `<!-- kite-code-plan ${JSON.stringify({
        artifactFormatVersion: 1,
        planSchemaVersion: 2,
        taskId: 'task-inconsistent-digest-read',
        planId: inconsistent.planId,
        version: inconsistent.version,
        title: inconsistent.title,
        structuralDigest: inconsistent.structuralDigest,
        steps: inconsistent.steps,
        createdAtTurnId: inconsistent.createdAtTurnId,
        updatedAtTurnId: inconsistent.updatedAtTurnId,
        completionEvidence: inconsistent.completionEvidence,
      })} -->\n# ${inconsistent.title}\n\n${inconsistent.bodyMarkdown}\n`,
    );

    expect(() =>
      store.read({
        artifactId: `${inconsistent.planId}:v${inconsistent.version}`,
        taskId: 'task-inconsistent-digest-read',
        planId: inconsistent.planId,
        version: inconsistent.version,
        fileName: `v${inconsistent.version}.md`,
        relativePath: '',
        displayPath: target,
        structuralDigest: inconsistent.structuralDigest,
        byteLength: 0,
      }),
    ).toThrow(PlanArtifactError);
  });

  test('reads legacy V1 Artifacts but refuses to write a legacy PlanDocument', () => {
    const store = new PlanArtifactStore();
    const legacy = { ...document() };
    delete (legacy as Partial<PlanDocument>).planSchemaVersion;
    const target = planArtifactPath('task-legacy-read', legacy.planId, legacy.version);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      `<!-- kite-code-plan ${JSON.stringify({
        artifactFormatVersion: 1,
        taskId: 'task-legacy-read',
        planId: legacy.planId,
        version: legacy.version,
        title: legacy.title,
        structuralDigest: legacy.structuralDigest,
        steps: legacy.steps,
        createdAtTurnId: legacy.createdAtTurnId,
        updatedAtTurnId: legacy.updatedAtTurnId,
      })} -->\n# ${legacy.title}\n\n${legacy.bodyMarkdown}\n`,
    );
    const ref = {
      artifactId: `${legacy.planId}:v${legacy.version}`,
      taskId: 'task-legacy-read',
      planId: legacy.planId,
      version: legacy.version,
      fileName: `v${legacy.version}.md`,
      relativePath: '',
      displayPath: target,
      structuralDigest: legacy.structuralDigest,
      byteLength: 0,
    };

    expect(store.read(ref).plan.planSchemaVersion).toBeUndefined();
    expect(() => store.write('task-legacy-write', legacy)).toThrow(PlanArtifactError);
  });

  test('rejects non-metadata fields in V2 completion evidence', () => {
    const plan = document();
    plan.completionEvidence = {
      schemaVersion: 1,
      verification: [],
      execution: [
        {
          toolCallId: 'tool-1',
          outcome: 'succeeded',
          stdout: 'secret output',
        } as never,
      ],
      skipped: [],
      unresolved: [],
    };

    expect(() => new PlanArtifactStore().write('task-private', plan)).toThrow(PlanArtifactError);
  });

  test('requires a V2 replan/save before continuing a legacy executing plan', async () => {
    const legacy = { ...document() };
    delete (legacy as Partial<PlanDocument>).planSchemaVersion;
    delete (legacy as Partial<PlanDocument>).completionEvidence;
    const state = createInitialRuntimeState({
      threadId: 'legacy-plan-continuation',
      userId: 'user',
      workspace: home,
    });
    state.planning = {
      kind: 'executing',
      document: legacy,
      executionMode: 'auto',
      approvedAtTurnId: state.turn.turnId,
    };
    const updateEvents = await executeRuntimeTools({
      state: withCall(state, 'legacy-update', 'update_plan', {
        plan_id: legacy.planId,
        version: legacy.version,
        structural_digest: legacy.structuralDigest,
        updates: [{ step_id: 'inspect', status: 'in_progress' }],
      }),
      toolCallIds: ['legacy-update'],
      planArtifactStore: new PlanArtifactStore(),
    });
    expect(updateEvents).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', reason: 'legacy_plan_replan_required' }),
    );

    const replanEvents = await executeRuntimeTools({
      state: withCall(state, 'legacy-replan', 'write_plan', {
        action: 'save',
        plan_id: legacy.planId,
        version: legacy.version,
        structural_digest: legacy.structuralDigest,
        title: 'Artifact-backed plan V2',
        body_markdown: 'Replan the legacy execution into a strictly identified V2 document.',
        steps: [{ id: 'inspect', title: 'Inspect the V2 Artifact lifecycle' }],
        replan_reason: 'legacy_schema_upgrade',
      }),
      toolCallIds: ['legacy-replan'],
      planArtifactStore: new PlanArtifactStore(),
    });
    expect(replanEvents).toContainEqual(
      expect.objectContaining({
        type: 'plan.drafted',
        planId: legacy.planId,
        version: legacy.version + 1,
        planSchemaVersion: 2,
      }),
    );
  });

  test('save returns metadata only, then submit reads the saved Artifact without creating v2', async () => {
    const store = new PlanArtifactStore();
    let state = createInitialRuntimeState({
      threadId: 'artifact-runtime',
      userId: 'user',
      workspace: home,
      phase: 'planning',
    });
    state = reduceRuntimeState(state, {
      type: 'task.started',
      taskId: 'task-1',
      userGoal: 'Review a saved plan',
      turnId: state.turn.turnId,
    });
    state = reduceRuntimeState(state, {
      type: 'planning.entered',
      taskId: 'task-1',
      source: 'user_command',
    });

    const draft = document();
    const saveEvents = await executeRuntimeTools({
      state: withCall(state, 'save-1', 'write_plan', {
        action: 'save',
        title: draft.title,
        body_markdown: draft.bodyMarkdown,
        steps: draft.steps.map(({ id, title }) => ({ id, title })),
      }),
      toolCallIds: ['save-1'],
      planArtifactStore: store,
    });
    const saveResult = saveEvents.find((event) => event.type === 'tool.finished');
    expect(saveResult?.type).toBe('tool.finished');
    if (saveResult?.type !== 'tool.finished') return;
    const saved = JSON.parse(saveResult.result.stdout) as {
      plan_id: string;
      version: number;
      structural_digest: string;
      artifact: { artifact_id: string };
    };
    expect(saved).toMatchObject({
      status: 'draft_saved',
      version: 1,
      structural_digest: draft.structuralDigest,
    });
    expect(saveResult.result.stdout).not.toContain(draft.bodyMarkdown);
    for (const event of saveEvents) state = reduceRuntimeState(state, event);

    const missingIdentity = await executeRuntimeTools({
      state: withCall(state, 'save-missing-identity', 'write_plan', {
        action: 'save',
        title: 'Revised Artifact-backed plan',
        body_markdown: 'Revise the Artifact lifecycle while keeping its identity strict.',
        steps: [{ id: 'inspect', title: 'Inspect the revised Artifact lifecycle' }],
      }),
      toolCallIds: ['save-missing-identity'],
      planArtifactStore: store,
    });
    expect(missingIdentity).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', reason: 'plan_identity_required' }),
    );
    const staleIdentity = await executeRuntimeTools({
      state: withCall(state, 'save-stale-identity', 'write_plan', {
        action: 'save',
        plan_id: saved.plan_id,
        version: saved.version,
        structural_digest: 'stale-digest',
        title: 'Revised Artifact-backed plan',
        body_markdown: 'Revise the Artifact lifecycle while keeping its identity strict.',
        steps: [{ id: 'inspect', title: 'Inspect the revised Artifact lifecycle' }],
      }),
      toolCallIds: ['save-stale-identity'],
      planArtifactStore: store,
    });
    expect(staleIdentity).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', reason: 'plan_identity_mismatch' }),
    );

    const loadedEvents = await executeRuntimeTools({
      state: withCall(state, 'read-1', 'read_plan', {
        plan_id: saved.plan_id,
        version: saved.version,
        structural_digest: saved.structural_digest,
      }),
      toolCallIds: ['read-1'],
      planArtifactStore: store,
    });
    const loaded = loadedEvents.find((event) => event.type === 'tool.finished');
    expect(loaded?.type).toBe('tool.finished');
    if (loaded?.type === 'tool.finished') {
      expect(JSON.parse(loaded.result.stdout)).toMatchObject({
        status: 'plan_loaded',
        plan_id: saved.plan_id,
        version: 1,
        body_markdown: draft.bodyMarkdown,
      });
    }

    const submitEvents = await executeRuntimeTools({
      state: withCall(state, 'submit-1', 'write_plan', {
        action: 'submit',
        plan_id: saved.plan_id,
        version: saved.version,
        structural_digest: saved.structural_digest,
      }),
      toolCallIds: ['submit-1'],
      planArtifactStore: store,
    });
    expect(submitEvents.map((event) => event.type)).toContain('plan.review_requested');
    expect(submitEvents.map((event) => event.type)).not.toContain('tool.finished');
    const review = submitEvents.find((event) => event.type === 'plan.review_requested');
    expect(review?.type).toBe('plan.review_requested');
    if (review?.type === 'plan.review_requested') {
      expect(review.artifact?.artifactId).toBe(saved.artifact.artifact_id);
      expect(review.plan.description).toContain('Inspect the Artifact lifecycle');
    }
  });

  test('a new top-level task starts a fresh plan at v1', async () => {
    const store = new PlanArtifactStore();
    let state = createInitialRuntimeState({
      threadId: 'task-isolation-runtime',
      userId: 'user',
      workspace: home,
    });

    state = reduceRuntimeState(state, {
      type: 'user.message_appended',
      messageId: 'message-1',
      content: 'Implement feature A',
    });
    const firstTaskId = state.activeTaskId;
    if (!firstTaskId) throw new Error('first task was not created');
    const firstSaveEvents = await executeRuntimeTools({
      state: withCall(state, 'save-a', 'write_plan', {
        action: 'save',
        title: 'Feature A',
        body_markdown: 'Detailed plan for feature A.',
        steps: [{ id: 'a-step', title: 'Implement feature A' }],
      }),
      toolCallIds: ['save-a'],
      planArtifactStore: store,
    });
    const firstResult = firstSaveEvents.find((event) => event.type === 'tool.finished');
    if (firstResult?.type !== 'tool.finished') throw new Error('first plan was not saved');
    const first = JSON.parse(firstResult.result.stdout) as {
      plan_id: string;
      version: number;
      artifact: { relative_path: string };
    };
    expect(first.version).toBe(1);
    for (const event of firstSaveEvents) state = reduceRuntimeState(state, event);

    state = reduceRuntimeState(state, {
      type: 'task.completed',
      taskId: firstTaskId,
      turnId: state.turn.turnId,
    });
    state = reduceRuntimeState(state, {
      type: 'user.message_appended',
      messageId: 'message-2',
      content: 'Implement feature B',
    });
    const secondTaskId = state.activeTaskId;
    if (!secondTaskId) throw new Error('second task was not created');

    const secondSaveEvents = await executeRuntimeTools({
      state: withCall(state, 'save-b', 'write_plan', {
        action: 'save',
        title: 'Feature B',
        body_markdown: 'Detailed plan for feature B.',
        steps: [{ id: 'b-step', title: 'Implement feature B' }],
      }),
      toolCallIds: ['save-b'],
      planArtifactStore: store,
    });
    const secondResult = secondSaveEvents.find((event) => event.type === 'tool.finished');
    if (secondResult?.type !== 'tool.finished') throw new Error('second plan was not saved');
    const second = JSON.parse(secondResult.result.stdout) as {
      plan_id: string;
      version: number;
      artifact: { relative_path: string };
    };

    expect(secondTaskId).not.toBe(firstTaskId);
    expect(second.plan_id).not.toBe(first.plan_id);
    expect(second.version).toBe(1);
    expect(first.artifact.relative_path).toContain(`${firstTaskId}/`);
    expect(second.artifact.relative_path).toContain(`${secondTaskId}/`);
  });

  test('schema v4 snapshots retain legacy inline plans as read-only V1 state', () => {
    const state = createInitialRuntimeState({
      threadId: 'migration-thread',
      userId: 'user',
      workspace: home,
      phase: 'planning',
    });
    const legacyDocument = { ...document() };
    delete (legacyDocument as Partial<PlanDocument>).planSchemaVersion;
    delete (legacyDocument as Partial<PlanDocument>).completionEvidence;
    const legacyTask = {
      taskId: 'task-legacy',
      userGoal: 'Migrate this plan',
      status: 'active' as const,
      startedAtTurnId: state.turn.turnId,
      sideEffectsStarted: false,
      planning: { kind: 'planning_draft' as const, document: legacyDocument },
      planHistory: [],
    };
    const legacyState = {
      ...state,
      schemaVersion: 4,
      activeTaskId: legacyTask.taskId,
      tasks: { [legacyTask.taskId]: legacyTask },
      planning: legacyTask.planning,
    };
    const runtimeDb = join(home, 'runtime.sqlite');
    const store = createRuntimeStore(runtimeDb);
    store.saveSnapshot('migration-thread', legacyState);
    store.close();

    const kernel = createAgentKernel({
      threadId: 'migration-thread',
      userId: 'user',
      workspace: home,
      storePath: runtimeDb,
      phase: 'building',
    });
    const migrated = kernel.getState();
    expect(migrated.schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);
    const migratedPlan = migrated.tasks['task-legacy']?.planning;
    expect(migratedPlan?.kind).toBe('planning_draft');
    if (migratedPlan?.kind === 'planning_draft') {
      expect(migratedPlan.document.artifact).toBeUndefined();
      expect(migratedPlan.document.planSchemaVersion).toBeUndefined();
      expect(migratedPlan.document.completionEvidence).toBeUndefined();
      expect(migratedPlan.document.bodyMarkdown).toContain('Inspect the Artifact lifecycle');
    }
    kernel.close();
  });
});

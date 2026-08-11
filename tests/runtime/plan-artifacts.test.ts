import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import type { PlanDocument } from '@/protocol/events';

let home: string;
let previousHome: string | undefined;

function document(version = 1): PlanDocument {
  const plan: PlanDocument = {
    planId: 'plan-artifact-test',
    version,
    title: 'Artifact-backed plan',
    bodyMarkdown: 'Inspect the Artifact lifecycle and verify the review boundary.',
    steps: [
      {
        id: 'inspect',
        title: 'Inspect the Artifact lifecycle',
        status: 'pending',
      },
    ],
    structuralDigest: '',
    createdAtTurnId: 'turn-1',
    updatedAtTurnId: 'turn-1',
  };
  plan.structuralDigest = computePlanStructuralDigest(plan);
  return plan;
}

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
        body_markdown: 'Plan for feature A.',
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
      type: 'run.completed',
      turnId: state.turn.turnId,
      output: 'Feature A complete',
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
        body_markdown: 'Plan for feature B.',
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

  test('schema v4 migration keeps legacy inline plans pure and does not write Artifacts', () => {
    const state = createInitialRuntimeState({
      threadId: 'migration-thread',
      userId: 'user',
      workspace: home,
      phase: 'planning',
    });
    const legacyTask = {
      taskId: 'task-legacy',
      userGoal: 'Migrate this plan',
      status: 'active' as const,
      startedAtTurnId: state.turn.turnId,
      sideEffectsStarted: false,
      planning: { kind: 'planning_draft' as const, document: document() },
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
      expect(migratedPlan.document.structuralDigest).toBe(document().structuralDigest);
      expect(existsSync(join(home, 'plans'))).toBe(false);
    }
    kernel.close();
  });
});

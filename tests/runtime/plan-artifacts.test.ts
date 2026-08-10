import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  getActivePlanning,
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

async function executingPlanFixture(store: PlanArtifactStore, suffix: string) {
  const taskId = `task-replan-${suffix}`;
  const input = {
    title: `Same-structure replan ${suffix}`,
    body_markdown: 'Preserve the reviewed structure while resetting one execution revision.',
    steps: [{ id: 'verify-replan', title: 'Verify the replacement revision' }],
  };
  let state = createInitialRuntimeState({
    threadId: `artifact-replan-${suffix}`,
    userId: 'user',
    workspace: home,
    phase: 'planning',
  });
  state = reduceRuntimeState(state, {
    type: 'task.started',
    taskId,
    userGoal: 'Replace an executing plan revision',
    turnId: state.turn.turnId,
  });
  state = reduceRuntimeState(state, {
    type: 'planning.entered',
    taskId,
    source: 'user_command',
  });
  const firstEvents = await executeRuntimeTools({
    state: withCall(state, `save-${suffix}-v1`, 'write_plan', { action: 'save', ...input }),
    toolCallIds: [`save-${suffix}-v1`],
    planArtifactStore: store,
  });
  for (const event of firstEvents) state = reduceRuntimeState(state, event);
  const firstPlanning = getActivePlanning(state);
  if (firstPlanning.kind !== 'planning_draft') throw new Error('fixture did not save v1');
  const executingDocument: PlanDocument = {
    ...firstPlanning.document,
    steps: firstPlanning.document.steps.map((step) => ({ ...step, status: 'completed' as const })),
    updatedAtTurnId: 'execution-turn',
    completionEvidence: {
      schemaVersion: 1,
      verification: [],
      execution: [],
      skipped: [],
      unresolved: [{ kind: 'failure', referenceId: 'old-execution-failure' }],
    },
  };
  const executing = {
    kind: 'executing' as const,
    document: executingDocument,
    executionMode: 'auto' as const,
    approvedAtTurnId: state.turn.turnId,
  };
  state = {
    ...state,
    planning: executing,
    tasks: {
      ...state.tasks,
      [taskId]: {
        ...state.tasks[taskId]!,
        planning: executing,
        executionMode: 'auto',
        sideEffectsStarted: true,
      },
    },
  };
  return { state, taskId, input, executingDocument };
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

  test.each([
    'status',
    'evidence',
    'replan metadata',
  ] as const)('rejects same identity and structural digest with different full content: %s', (difference) => {
    const store = new PlanArtifactStore();
    const first = document(2);
    first.supersedesPlanVersion = 1;
    first.replanReason = 'first_reason';
    const ref = store.write('task-full-content-conflict', first);
    const changed = structuredClone(first);
    if (difference === 'status') changed.steps[0]!.status = 'completed';
    if (difference === 'evidence') {
      changed.completionEvidence = {
        schemaVersion: 1,
        verification: [],
        execution: [],
        skipped: [],
        unresolved: [{ kind: 'failure', referenceId: 'failure-1' }],
      };
    }
    if (difference === 'replan metadata') changed.replanReason = 'second_reason';

    expect(() => store.write('task-full-content-conflict', changed)).toThrow(
      expect.objectContaining({ code: 'artifact_conflict' }),
    );
    expect(readdirSync(dirname(ref.displayPath)).filter((name) => name.endsWith('.tmp'))).toEqual(
      [],
    );
  });

  test('treats an EEXIST-style same-content publish collision as idempotent', () => {
    const firstWriter = new PlanArtifactStore();
    const secondWriter = new PlanArtifactStore();
    const plan = document(3);
    const first = firstWriter.write('task-idempotent-collision', plan);
    const second = secondWriter.write('task-idempotent-collision', structuredClone(plan));

    expect(second).toEqual(first);
    expect(readdirSync(dirname(first.displayPath)).filter((name) => name.endsWith('.tmp'))).toEqual(
      [],
    );
  });

  test('rejects an existing symlink instead of traversing it during collision handling', () => {
    const store = new PlanArtifactStore();
    const plan = document(4);
    const source = store.write('task-symlink-source', plan);
    const target = planArtifactPath('task-symlink-target', plan.planId, plan.version);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source.displayPath, target);

    expect(() => store.write('task-symlink-target', structuredClone(plan))).toThrow(
      expect.objectContaining({ code: 'artifact_conflict' }),
    );
    expect(readFileSync(source.displayPath, 'utf8')).toContain('# Artifact-backed plan');
    expect(readdirSync(dirname(target)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test.each([
    'task',
    'plan',
  ] as const)('rejects a %s ancestor symlink without creating an Artifact outside the managed root', (ancestor) => {
    const store = new PlanArtifactStore();
    const plan = { ...document(5), planId: `ancestor-${ancestor}-write` };
    plan.structuralDigest = computePlanStructuralDigest(plan);
    const taskId = `task-ancestor-${ancestor}-write`;
    const target = planArtifactPath(taskId, plan.planId, plan.version);
    const planDirectory = dirname(target);
    const taskDirectory = dirname(planDirectory);
    const managedRoot = dirname(taskDirectory);
    const outside = join(home, `outside-${ancestor}-write`);
    mkdirSync(outside, { recursive: true });
    mkdirSync(managedRoot, { recursive: true });
    if (ancestor === 'task') {
      symlinkSync(outside, taskDirectory);
    } else {
      mkdirSync(taskDirectory);
      symlinkSync(outside, planDirectory);
    }

    expect(() => store.write(taskId, plan)).toThrow(
      expect.objectContaining({ code: 'invalid_reference' }),
    );
    const escapedTarget =
      ancestor === 'task'
        ? join(outside, plan.planId, `v${plan.version}.md`)
        : join(outside, `v${plan.version}.md`);
    expect(existsSync(escapedTarget)).toBe(false);
  });

  test('rejects a final Artifact symlink on read without following it', () => {
    const plan = { ...document(6), planId: 'final-symlink-read' };
    plan.structuralDigest = computePlanStructuralDigest(plan);
    const taskId = 'task-final-symlink-read';
    const target = planArtifactPath(taskId, plan.planId, plan.version);
    const outside = join(home, 'outside-final-artifact.md');
    writeFileSync(outside, 'must not be read');
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(outside, target);

    expect(() =>
      new PlanArtifactStore().read({
        artifactId: `${plan.planId}:v${plan.version}`,
        taskId,
        planId: plan.planId,
        version: plan.version,
        fileName: `v${plan.version}.md`,
        relativePath: '',
        displayPath: target,
        structuralDigest: plan.structuralDigest,
        byteLength: 0,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_reference' }));
  });

  test('rejects an ancestor symlink on read even when it points to a valid Artifact', () => {
    const store = new PlanArtifactStore();
    const plan = { ...document(7), planId: 'ancestor-symlink-read' };
    plan.structuralDigest = computePlanStructuralDigest(plan);
    const taskId = 'task-ancestor-symlink-read';
    const ref = store.write(taskId, plan);
    const target = ref.displayPath;
    const taskDirectory = dirname(dirname(target));
    const outside = join(home, 'outside-ancestor-read');
    const outsideTarget = join(outside, plan.planId, `v${plan.version}.md`);
    mkdirSync(dirname(outsideTarget), { recursive: true });
    writeFileSync(outsideTarget, readFileSync(target, 'utf8'));
    rmSync(taskDirectory, { recursive: true });
    symlinkSync(outside, taskDirectory);

    expect(() => store.read(ref)).toThrow(expect.objectContaining({ code: 'invalid_reference' }));
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

  test('rejects unknown step metadata fields before write or read', () => {
    const invalid = {
      ...document(),
      planId: 'unknown-step-field-plan',
      steps: [
        {
          id: 'inspect',
          title: 'Inspect the Artifact lifecycle',
          status: 'pending',
          command: 'cat private.txt',
        },
      ],
    } as unknown as PlanDocument;
    invalid.structuralDigest = computePlanStructuralDigest(invalid);
    const store = new PlanArtifactStore();

    expect(() => store.write('task-unknown-step-write', invalid)).toThrow(PlanArtifactError);

    const target = planArtifactPath('task-unknown-step-read', invalid.planId, invalid.version);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      `<!-- kite-code-plan ${JSON.stringify({
        artifactFormatVersion: 1,
        planSchemaVersion: 2,
        taskId: 'task-unknown-step-read',
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
        taskId: 'task-unknown-step-read',
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

  test.each([
    'stdout',
    'prompt',
    'path',
    'extra',
  ])('rejects unknown V2 Artifact metadata key: %s', (unknownKey) => {
    const plan = { ...document(), planId: `unknown-v2-${unknownKey}` };
    const taskId = `task-unknown-v2-${unknownKey}`;
    const target = planArtifactPath(taskId, plan.planId, plan.version);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      `<!-- kite-code-plan ${JSON.stringify({
        artifactFormatVersion: 1,
        planSchemaVersion: 2,
        taskId,
        planId: plan.planId,
        version: plan.version,
        title: plan.title,
        structuralDigest: plan.structuralDigest,
        steps: plan.steps,
        createdAtTurnId: plan.createdAtTurnId,
        updatedAtTurnId: plan.updatedAtTurnId,
        completionEvidence: plan.completionEvidence,
        [unknownKey]: 'must not be accepted',
      })} -->\n# ${plan.title}\n\n${plan.bodyMarkdown}\n`,
    );

    expect(() =>
      new PlanArtifactStore().read({
        artifactId: `${plan.planId}:v${plan.version}`,
        taskId,
        planId: plan.planId,
        version: plan.version,
        fileName: `v${plan.version}.md`,
        relativePath: '',
        displayPath: target,
        structuralDigest: plan.structuralDigest,
        byteLength: 0,
      }),
    ).toThrow(PlanArtifactError);
  });

  test('rejects non-object JSON metadata as a corrupt Artifact', () => {
    const plan = { ...document(), planId: 'null-metadata-plan' };
    const target = planArtifactPath('task-null-metadata', plan.planId, plan.version);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      `<!-- kite-code-plan null -->\n# ${plan.title}\n\n${plan.bodyMarkdown}\n`,
    );

    expect(() =>
      new PlanArtifactStore().read({
        artifactId: `${plan.planId}:v${plan.version}`,
        taskId: 'task-null-metadata',
        planId: plan.planId,
        version: plan.version,
        fileName: `v${plan.version}.md`,
        relativePath: '',
        displayPath: target,
        structuralDigest: plan.structuralDigest,
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

  test('rejects a Markdown heading that does not match metadata title', () => {
    const plan = { ...document(), planId: 'heading-mismatch-plan' };
    const target = planArtifactPath('task-heading-mismatch', plan.planId, plan.version);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      `<!-- kite-code-plan ${JSON.stringify({
        artifactFormatVersion: 1,
        planSchemaVersion: 2,
        taskId: 'task-heading-mismatch',
        planId: plan.planId,
        version: plan.version,
        title: plan.title,
        structuralDigest: plan.structuralDigest,
        steps: plan.steps,
        createdAtTurnId: plan.createdAtTurnId,
        updatedAtTurnId: plan.updatedAtTurnId,
        completionEvidence: plan.completionEvidence,
      })} -->\n# Substituted heading\n\n${plan.bodyMarkdown}\n`,
    );

    expect(() =>
      new PlanArtifactStore().read({
        artifactId: `${plan.planId}:v${plan.version}`,
        taskId: 'task-heading-mismatch',
        planId: plan.planId,
        version: plan.version,
        fileName: `v${plan.version}.md`,
        relativePath: '',
        displayPath: target,
        structuralDigest: plan.structuralDigest,
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
        supersedesPlanVersion: 1,
        replanReason: 'legacy_replan',
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

    const restored = store.read(ref).plan;
    expect(restored.planSchemaVersion).toBeUndefined();
    expect(restored.supersedesPlanVersion).toBe(1);
    expect(restored.replanReason).toBe('legacy_replan');
    expect(() => store.write('task-legacy-write', legacy)).toThrow(PlanArtifactError);
  });

  test('rejects unknown V1 Artifact metadata outside the explicit compatibility keys', () => {
    const legacy = { ...document(), planId: 'legacy-unknown-key' };
    delete (legacy as Partial<PlanDocument>).planSchemaVersion;
    delete (legacy as Partial<PlanDocument>).completionEvidence;
    const taskId = 'task-legacy-unknown-key';
    const target = planArtifactPath(taskId, legacy.planId, legacy.version);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      `<!-- kite-code-plan ${JSON.stringify({
        artifactFormatVersion: 1,
        taskId,
        planId: legacy.planId,
        version: legacy.version,
        title: legacy.title,
        structuralDigest: legacy.structuralDigest,
        steps: legacy.steps,
        createdAtTurnId: legacy.createdAtTurnId,
        updatedAtTurnId: legacy.updatedAtTurnId,
        stdout: 'not a legacy compatibility field',
      })} -->\n# ${legacy.title}\n\n${legacy.bodyMarkdown}\n`,
    );

    expect(() =>
      new PlanArtifactStore().read({
        artifactId: `${legacy.planId}:v${legacy.version}`,
        taskId,
        planId: legacy.planId,
        version: legacy.version,
        fileName: `v${legacy.version}.md`,
        relativePath: '',
        displayPath: target,
        structuralDigest: legacy.structuralDigest,
        byteLength: 0,
      }),
    ).toThrow(PlanArtifactError);
  });

  test.each([
    ['supersedesPlanVersion zero', { supersedesPlanVersion: 0 }],
    ['supersedesPlanVersion negative', { supersedesPlanVersion: -1 }],
    ['supersedesPlanVersion fractional', { supersedesPlanVersion: 1.5 }],
    ['supersedesPlanVersion string', { supersedesPlanVersion: '1' }],
    ['supersedesPlanVersion null', { supersedesPlanVersion: null }],
    ['replanReason object', { replanReason: { prompt: 'secret' } }],
    ['replanReason null', { replanReason: null }],
    ['replanReason too long', { replanReason: 'x'.repeat(501) }],
  ] as const)('rejects malicious V1 optional metadata: %s', (_label, optionalMetadata) => {
    const legacy = { ...document(), planId: 'legacy-invalid-optional' };
    delete (legacy as Partial<PlanDocument>).planSchemaVersion;
    delete (legacy as Partial<PlanDocument>).completionEvidence;
    const taskId = 'task-legacy-invalid-optional';
    const target = planArtifactPath(taskId, legacy.planId, legacy.version);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      `<!-- kite-code-plan ${JSON.stringify({
        artifactFormatVersion: 1,
        taskId,
        planId: legacy.planId,
        version: legacy.version,
        title: legacy.title,
        structuralDigest: legacy.structuralDigest,
        steps: legacy.steps,
        createdAtTurnId: legacy.createdAtTurnId,
        updatedAtTurnId: legacy.updatedAtTurnId,
        ...optionalMetadata,
      })} -->\n# ${legacy.title}\n\n${legacy.bodyMarkdown}\n`,
    );

    expect(() =>
      new PlanArtifactStore().read({
        artifactId: `${legacy.planId}:v${legacy.version}`,
        taskId,
        planId: legacy.planId,
        version: legacy.version,
        fileName: `v${legacy.version}.md`,
        relativePath: '',
        displayPath: target,
        structuralDigest: legacy.structuralDigest,
        byteLength: 0,
      }),
    ).toThrow(PlanArtifactError);
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

  test('reuses the canonical Artifact document for an unchanged strict-identity save in a later turn', async () => {
    const store = new PlanArtifactStore();
    let state = createInitialRuntimeState({
      threadId: 'artifact-idempotent-save',
      userId: 'user',
      workspace: home,
      phase: 'planning',
    });
    state = reduceRuntimeState(state, {
      type: 'task.started',
      taskId: 'task-idempotent-save',
      userGoal: 'Save one canonical plan twice',
      turnId: state.turn.turnId,
    });
    state = reduceRuntimeState(state, {
      type: 'planning.entered',
      taskId: 'task-idempotent-save',
      source: 'user_command',
    });
    const input = {
      title: 'Canonical idempotent plan',
      body_markdown: 'Keep one immutable canonical document across unchanged saves.',
      steps: [{ id: 'verify-canonical', title: 'Verify canonical document reuse' }],
    };

    const firstEvents = await executeRuntimeTools({
      state: withCall(state, 'save-canonical-1', 'write_plan', { action: 'save', ...input }),
      toolCallIds: ['save-canonical-1'],
      planArtifactStore: store,
    });
    for (const event of firstEvents) state = reduceRuntimeState(state, event);
    const firstPlanning = getActivePlanning(state);
    if (firstPlanning.kind !== 'planning_draft') throw new Error('first save did not draft');
    const canonicalDocument = structuredClone(firstPlanning.document);
    const canonicalArtifact = canonicalDocument.artifact;
    if (!canonicalArtifact) throw new Error('first save did not persist an Artifact');

    state = reduceRuntimeState(state, { type: 'turn.started', turnId: 'later-turn' });
    const secondEvents = await executeRuntimeTools({
      state: withCall(state, 'save-canonical-2', 'write_plan', {
        action: 'save',
        plan_id: canonicalDocument.planId,
        version: canonicalDocument.version,
        structural_digest: canonicalDocument.structuralDigest,
        ...input,
      }),
      toolCallIds: ['save-canonical-2'],
      planArtifactStore: store,
    });

    expect(secondEvents).not.toContainEqual(expect.objectContaining({ type: 'tool.rejected' }));
    const secondFinished = secondEvents.find((event) => event.type === 'tool.finished');
    expect(secondFinished?.type).toBe('tool.finished');
    if (secondFinished?.type === 'tool.finished') {
      expect(JSON.parse(secondFinished.result.stdout)).toMatchObject({
        plan_id: canonicalDocument.planId,
        version: canonicalDocument.version,
        structural_digest: canonicalDocument.structuralDigest,
        artifact: { artifact_id: canonicalArtifact.artifactId },
      });
    }
    const repeatedDraft = secondEvents.find((event) => event.type === 'plan.drafted');
    expect(repeatedDraft?.type).toBe('plan.drafted');
    if (repeatedDraft?.type === 'plan.drafted') {
      const substitutedStatus = structuredClone(repeatedDraft);
      substitutedStatus.plan.steps[0]!.status = 'completed';
      expect(reduceRuntimeState(state, substitutedStatus)).toBe(state);

      const substitutedArtifact = structuredClone(repeatedDraft);
      if (!substitutedArtifact.artifact) throw new Error('repeat save omitted Artifact');
      substitutedArtifact.artifact.displayPath += '.substituted';
      expect(reduceRuntimeState(state, substitutedArtifact)).toBe(state);
    }
    for (const event of secondEvents) state = reduceRuntimeState(state, event);
    const replayedPlanning = getActivePlanning(state);
    if (replayedPlanning.kind !== 'planning_draft') throw new Error('repeat save lost draft');
    expect(replayedPlanning.document).toEqual(canonicalDocument);

    const persisted = store.read(canonicalArtifact).plan;
    const { artifact: _artifact, ...canonicalWithoutArtifact } = canonicalDocument;
    expect(persisted).toEqual(canonicalWithoutArtifact);
    expect(persisted.updatedAtTurnId).not.toBe('later-turn');
  });

  test.each([
    'save',
    'submit',
  ] as const)('creates a new canonical revision for an executing same-structure replan: %s', async (action) => {
    const store = new PlanArtifactStore();
    const fixture = await executingPlanFixture(store, `direct-${action}`);
    let state = reduceRuntimeState(fixture.state, {
      type: 'turn.started',
      turnId: `replan-${action}-turn`,
    });
    const events = await executeRuntimeTools({
      state: withCall(state, `replan-${action}`, 'write_plan', {
        action,
        plan_id: fixture.executingDocument.planId,
        version: fixture.executingDocument.version,
        structural_digest: fixture.executingDocument.structuralDigest,
        replan_reason: `same_structure_${action}`,
        ...fixture.input,
      }),
      toolCallIds: [`replan-${action}`],
      planArtifactStore: store,
    });

    expect(events).not.toContainEqual(expect.objectContaining({ type: 'tool.rejected' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'plan.replan_requested' }));
    const drafted = events.find((event) => event.type === 'plan.drafted');
    expect(drafted?.type).toBe('plan.drafted');
    if (drafted?.type !== 'plan.drafted' || !drafted.artifact) return;
    expect(drafted).toMatchObject({
      planId: fixture.executingDocument.planId,
      version: fixture.executingDocument.version + 1,
      supersedesPlanVersion: fixture.executingDocument.version,
      replanReason: `same_structure_${action}`,
    });
    expect(drafted.artifact.artifactId).toBe(
      `${fixture.executingDocument.planId}:v${fixture.executingDocument.version + 1}`,
    );
    expect(drafted.plan.steps.every((step) => step.status === 'pending')).toBe(true);
    for (const event of events) state = reduceRuntimeState(state, event);
    const planning = getActivePlanning(state);
    expect(planning.kind).toBe(action === 'submit' ? 'awaiting_review' : 'replanning_draft');
    if (planning.kind !== 'awaiting_review' && planning.kind !== 'replanning_draft') return;
    expect(planning.document).toMatchObject({
      version: fixture.executingDocument.version + 1,
      supersedesPlanVersion: fixture.executingDocument.version,
      replanReason: `same_structure_${action}`,
      createdAtTurnId: `replan-${action}-turn`,
      updatedAtTurnId: `replan-${action}-turn`,
      completionEvidence: {
        verification: [],
        execution: [],
        skipped: [],
        unresolved: [],
      },
    });
    expect(planning.document.steps.every((step) => step.status === 'pending')).toBe(true);
    const persisted = store.read(drafted.artifact).plan;
    const { artifact: _artifact, ...projected } = planning.document;
    expect(persisted).toEqual(projected);
    expect(state.tasks[fixture.taskId]?.planHistory).toContainEqual(fixture.executingDocument);
  });

  test('creates the initial replanning draft, then idempotently reuses that saved revision', async () => {
    const store = new PlanArtifactStore();
    const fixture = await executingPlanFixture(store, 'initial-draft');
    let state = reduceRuntimeState(fixture.state, {
      type: 'turn.started',
      turnId: 'initial-replan-turn',
    });
    state = reduceRuntimeState(state, {
      type: 'plan.replan_requested',
      toolCallId: 'request-initial-replan',
      reason: 'same_structure_initial',
      supersedesPlanVersion: fixture.executingDocument.version,
    });
    const firstRevisionEvents = await executeRuntimeTools({
      state: withCall(state, 'save-initial-replan', 'write_plan', {
        action: 'save',
        plan_id: fixture.executingDocument.planId,
        version: fixture.executingDocument.version,
        structural_digest: fixture.executingDocument.structuralDigest,
        ...fixture.input,
      }),
      toolCallIds: ['save-initial-replan'],
      planArtifactStore: store,
    });
    expect(firstRevisionEvents).not.toContainEqual(
      expect.objectContaining({ type: 'tool.rejected' }),
    );
    expect(firstRevisionEvents).not.toContainEqual(
      expect.objectContaining({ type: 'plan.replan_requested' }),
    );
    for (const event of firstRevisionEvents) state = reduceRuntimeState(state, event);
    const firstRevision = getActivePlanning(state);
    if (firstRevision.kind !== 'replanning_draft') throw new Error('new revision was not saved');
    expect(firstRevision.document).toMatchObject({
      version: fixture.executingDocument.version + 1,
      supersedesPlanVersion: fixture.executingDocument.version,
      replanReason: 'same_structure_initial',
    });
    const canonicalRevision = structuredClone(firstRevision.document);
    if (!canonicalRevision.artifact) throw new Error('new revision omitted Artifact');

    state = reduceRuntimeState(state, { type: 'turn.started', turnId: 'repeat-replan-turn' });
    const repeatEvents = await executeRuntimeTools({
      state: withCall(state, 'save-initial-replan-again', 'write_plan', {
        action: 'save',
        plan_id: canonicalRevision.planId,
        version: canonicalRevision.version,
        structural_digest: canonicalRevision.structuralDigest,
        ...fixture.input,
      }),
      toolCallIds: ['save-initial-replan-again'],
      planArtifactStore: store,
    });
    expect(repeatEvents).not.toContainEqual(expect.objectContaining({ type: 'tool.rejected' }));
    for (const event of repeatEvents) state = reduceRuntimeState(state, event);
    const repeated = getActivePlanning(state);
    if (repeated.kind !== 'replanning_draft') throw new Error('repeat lost replanning draft');
    expect(repeated.document).toEqual(canonicalRevision);
    expect(repeated.document.updatedAtTurnId).not.toBe('repeat-replan-turn');
  });

  test('submits a new revision from an initial replanning draft with the same structure', async () => {
    const store = new PlanArtifactStore();
    const fixture = await executingPlanFixture(store, 'initial-submit');
    let state = reduceRuntimeState(fixture.state, {
      type: 'plan.replan_requested',
      toolCallId: 'request-initial-submit',
      reason: 'same_structure_initial_submit',
      supersedesPlanVersion: fixture.executingDocument.version,
    });
    const events = await executeRuntimeTools({
      state: withCall(state, 'submit-initial-replan', 'write_plan', {
        action: 'submit',
        plan_id: fixture.executingDocument.planId,
        version: fixture.executingDocument.version,
        structural_digest: fixture.executingDocument.structuralDigest,
        ...fixture.input,
      }),
      toolCallIds: ['submit-initial-replan'],
      planArtifactStore: store,
    });

    expect(events).not.toContainEqual(expect.objectContaining({ type: 'tool.rejected' }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'plan.replan_requested' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'plan.drafted',
        version: fixture.executingDocument.version + 1,
        supersedesPlanVersion: fixture.executingDocument.version,
        replanReason: 'same_structure_initial_submit',
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'plan.review_requested' }));
    for (const event of events) state = reduceRuntimeState(state, event);
    const planning = getActivePlanning(state);
    expect(planning.kind).toBe('awaiting_review');
    if (planning.kind === 'awaiting_review') {
      expect(planning.document.version).toBe(fixture.executingDocument.version + 1);
      expect(planning.document.steps.every((step) => step.status === 'pending')).toBe(true);
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

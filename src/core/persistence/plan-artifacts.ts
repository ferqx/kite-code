import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { planArtifactPath, planArtifactRoot, userKiteCodeDir } from '@/core/config/paths';
import { computePlanStructuralDigest } from '@/core/runtime/hashes';
import type { PlanArtifactRef, PlanDocument } from '@/protocol/events';

const ARTIFACT_FORMAT_VERSION = 1;
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

export interface PlanArtifactContent {
  taskId: string;
  plan: PlanDocument;
  markdown: string;
  artifact: PlanArtifactRef;
}

export class PlanArtifactError extends Error {
  public readonly code:
    | 'invalid_reference'
    | 'artifact_missing'
    | 'artifact_conflict'
    | 'artifact_corrupt';

  constructor(
    message: string,
    code: 'invalid_reference' | 'artifact_missing' | 'artifact_conflict' | 'artifact_corrupt',
  ) {
    super(message);
    this.name = 'PlanArtifactError';
    this.code = code;
  }
}

function assertSafeSegment(value: string, label: string): void {
  if (!SAFE_SEGMENT.test(value)) {
    throw new PlanArtifactError(
      `Invalid ${label} in Plan Artifact reference.`,
      'invalid_reference',
    );
  }
}

function assertSafeVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new PlanArtifactError('Invalid Plan Artifact version.', 'invalid_reference');
  }
}

function artifactId(planId: string, version: number): string {
  return `${planId}:v${version}`;
}

function toRelativePath(target: string): string {
  return relative(userKiteCodeDir(), target).replaceAll('\\', '/');
}

function assertInsideRoot(target: string): void {
  const root = resolve(planArtifactRoot());
  const resolved = resolve(target);
  const outside = relative(root, resolved).startsWith('..') || isAbsolute(relative(root, resolved));
  if (outside) {
    throw new PlanArtifactError(
      'Plan Artifact path escapes the user artifact root.',
      'invalid_reference',
    );
  }
}

function serialize(plan: PlanDocument, taskId: string): string {
  const metadata = {
    artifactFormatVersion: ARTIFACT_FORMAT_VERSION,
    taskId,
    planId: plan.planId,
    version: plan.version,
    title: plan.title,
    structuralDigest: plan.structuralDigest,
    steps: plan.steps,
    createdAtTurnId: plan.createdAtTurnId,
    updatedAtTurnId: plan.updatedAtTurnId,
    ...(plan.supersedesPlanVersion == null
      ? {}
      : { supersedesPlanVersion: plan.supersedesPlanVersion }),
    ...(plan.replanReason == null ? {} : { replanReason: plan.replanReason }),
  };
  return `<!-- kite-code-plan ${JSON.stringify(metadata)} -->\n# ${plan.title}\n\n${plan.bodyMarkdown.trim()}\n`;
}

function parse(
  markdown: string,
  expected: { taskId: string; planId: string; version: number },
): PlanDocument {
  const firstLine = markdown.split('\n', 1)[0] ?? '';
  const match = /^<!-- kite-code-plan (.+) -->$/.exec(firstLine.trim());
  if (!match) {
    throw new PlanArtifactError('Plan Artifact metadata header is missing.', 'artifact_corrupt');
  }

  let metadata: {
    artifactFormatVersion?: number;
    taskId?: string;
    planId?: string;
    version?: number;
    title?: string;
    structuralDigest?: string;
    steps?: PlanDocument['steps'];
    createdAtTurnId?: string;
    updatedAtTurnId?: string;
    supersedesPlanVersion?: number;
    replanReason?: string;
  };
  try {
    metadata = JSON.parse(match[1]!) as typeof metadata;
  } catch {
    throw new PlanArtifactError('Plan Artifact metadata is invalid JSON.', 'artifact_corrupt');
  }

  if (
    metadata.artifactFormatVersion !== ARTIFACT_FORMAT_VERSION ||
    metadata.taskId !== expected.taskId ||
    metadata.planId !== expected.planId ||
    metadata.version !== expected.version ||
    typeof metadata.title !== 'string' ||
    typeof metadata.structuralDigest !== 'string' ||
    !Array.isArray(metadata.steps) ||
    typeof metadata.createdAtTurnId !== 'string' ||
    typeof metadata.updatedAtTurnId !== 'string'
  ) {
    throw new PlanArtifactError(
      'Plan Artifact metadata does not match its reference.',
      'artifact_corrupt',
    );
  }

  const body = markdown.replace(/^<!-- kite-code-plan .+ -->\n# .*\n\n?/, '').trim();
  const plan: PlanDocument = {
    planId: metadata.planId,
    version: metadata.version,
    title: metadata.title,
    bodyMarkdown: body,
    steps: metadata.steps,
    structuralDigest: metadata.structuralDigest,
    createdAtTurnId: metadata.createdAtTurnId,
    updatedAtTurnId: metadata.updatedAtTurnId,
    ...(metadata.supersedesPlanVersion == null
      ? {}
      : { supersedesPlanVersion: metadata.supersedesPlanVersion }),
    ...(metadata.replanReason == null ? {} : { replanReason: metadata.replanReason }),
  };
  if (computePlanStructuralDigest(plan) !== plan.structuralDigest) {
    throw new PlanArtifactError(
      'Plan Artifact content does not match its structural digest.',
      'artifact_corrupt',
    );
  }
  return plan;
}

function makeRef(
  taskId: string,
  plan: PlanDocument,
  target: string,
  byteLength: number,
): PlanArtifactRef {
  return {
    artifactId: artifactId(plan.planId, plan.version),
    taskId,
    planId: plan.planId,
    version: plan.version,
    fileName: `v${plan.version}.md`,
    relativePath: toRelativePath(target),
    displayPath: target,
    structuralDigest: plan.structuralDigest,
    byteLength,
  };
}

export class PlanArtifactStore {
  write(taskId: string, plan: PlanDocument): PlanArtifactRef {
    assertSafeSegment(taskId, 'taskId');
    assertSafeSegment(plan.planId, 'planId');
    assertSafeVersion(plan.version);
    assertInsideRoot(planArtifactPath(taskId, plan.planId, plan.version));

    const target = planArtifactPath(taskId, plan.planId, plan.version);
    const markdown = serialize(plan, taskId);
    mkdirSync(dirname(target), { recursive: true });

    if (existsSync(target)) {
      const existing = readFileSync(target, 'utf8');
      const existingPlan = parse(existing, {
        taskId,
        planId: plan.planId,
        version: plan.version,
      });
      if (existingPlan.structuralDigest !== plan.structuralDigest) {
        throw new PlanArtifactError(
          `Plan Artifact ${plan.planId}:v${plan.version} already exists with a different digest.`,
          'artifact_conflict',
        );
      }
      return makeRef(taskId, existingPlan, target, Buffer.byteLength(existing, 'utf8'));
    }

    const temporary = join(
      dirname(target),
      `.${plan.version}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    try {
      writeFileSync(temporary, markdown, 'utf8');
      renameSync(temporary, target);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    return makeRef(taskId, plan, target, Buffer.byteLength(markdown, 'utf8'));
  }

  read(ref: PlanArtifactRef): PlanArtifactContent {
    assertSafeSegment(ref.taskId, 'taskId');
    assertSafeSegment(ref.planId, 'planId');
    assertSafeVersion(ref.version);
    const target = planArtifactPath(ref.taskId, ref.planId, ref.version);
    assertInsideRoot(target);
    if (!existsSync(target)) {
      throw new PlanArtifactError(
        `Plan Artifact ${ref.artifactId} does not exist.`,
        'artifact_missing',
      );
    }
    const markdown = readFileSync(target, 'utf8');
    const plan = parse(markdown, {
      taskId: ref.taskId,
      planId: ref.planId,
      version: ref.version,
    });
    if (plan.structuralDigest !== ref.structuralDigest) {
      throw new PlanArtifactError(
        `Plan Artifact ${ref.artifactId} digest mismatch.`,
        'artifact_conflict',
      );
    }
    const stats = statSync(target);
    return {
      taskId: ref.taskId,
      plan,
      markdown,
      artifact: makeRef(ref.taskId, plan, target, stats.size),
    };
  }
}

export const defaultPlanArtifactStore = new PlanArtifactStore();

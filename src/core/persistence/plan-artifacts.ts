import type { Stats } from 'node:fs';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { planArtifactRoot, userKiteCodeDir } from '@/core/config/paths';
import { planArtifactPath } from '@/core/persistence/plan-artifact-paths';
import { computePlanStructuralDigest } from '@/core/runtime/hashes';
import {
  hasValidPlanRevisionMetadata,
  isPlanDocumentV2,
  isPlanStepMetadata,
} from '@/core/runtime/plan-document';
import type { PlanArtifactRef, PlanDocument } from '@/protocol/events';

const ARTIFACT_FORMAT_VERSION = 1;
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const ARTIFACT_METADATA_KEYS = [
  'artifactFormatVersion',
  'planSchemaVersion',
  'taskId',
  'planId',
  'version',
  'title',
  'structuralDigest',
  'steps',
  'createdAtTurnId',
  'updatedAtTurnId',
  'supersedesPlanVersion',
  'replanReason',
  'completionEvidence',
] as const;

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

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

function assertPlanDocumentV2(
  plan: PlanDocument,
  code: 'invalid_reference' | 'artifact_corrupt',
): void {
  if (!isPlanDocumentV2(plan)) {
    throw new PlanArtifactError('PlanDocument V2 schema validation failed.', code);
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

interface FileIdentity {
  dev: number;
  ino: number;
}

interface ArtifactParentBoundary extends FileIdentity {
  path: string;
  realPath: string;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function pathError(message: string, code: 'invalid_reference' | 'artifact_missing'): never {
  throw new PlanArtifactError(message, code);
}

function lstatDirectory(
  directory: string,
  missingCode: 'invalid_reference' | 'artifact_missing',
): Stats {
  let stats: Stats;
  try {
    stats = lstatSync(directory);
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) {
      return pathError('Plan Artifact directory does not exist.', missingCode);
    }
    return pathError('Plan Artifact directory could not be validated.', 'invalid_reference');
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    pathError('Plan Artifact path contains a non-directory or symbolic link.', 'invalid_reference');
  }
  return stats;
}

function assertRealPathInsideRoot(root: string, directory: string): string {
  let realRoot: string;
  let realDirectory: string;
  try {
    realRoot = realpathSync(root);
    realDirectory = realpathSync(directory);
  } catch {
    pathError('Plan Artifact directory could not be resolved safely.', 'invalid_reference');
  }
  const fromRoot = relative(realRoot, realDirectory);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    pathError('Plan Artifact directory resolves outside the managed root.', 'invalid_reference');
  }
  return realDirectory;
}

function validateArtifactParent(
  target: string,
  options: { create: boolean; missingCode: 'invalid_reference' | 'artifact_missing' },
): ArtifactParentBoundary {
  assertInsideRoot(target);
  const root = resolve(planArtifactRoot());
  const parent = dirname(resolve(target));
  const parentFromRoot = relative(root, parent);
  if (parentFromRoot.startsWith('..') || isAbsolute(parentFromRoot)) {
    pathError('Plan Artifact parent escapes the managed root.', 'invalid_reference');
  }

  if (options.create) {
    try {
      mkdirSync(root, { recursive: true });
    } catch {
      pathError('Plan Artifact root could not be created safely.', 'invalid_reference');
    }
  }
  lstatDirectory(root, options.missingCode);

  let current = root;
  const segments = parentFromRoot === '' ? [] : parentFromRoot.split(sep);
  for (const segment of segments) {
    current = join(current, segment);
    if (options.create) {
      try {
        mkdirSync(current);
      } catch (error) {
        if (!isFileSystemError(error, 'EEXIST')) {
          pathError('Plan Artifact directory could not be created safely.', 'invalid_reference');
        }
      }
    }
    lstatDirectory(current, options.missingCode);
  }

  const stats = lstatDirectory(parent, options.missingCode);
  return {
    path: parent,
    realPath: assertRealPathInsideRoot(root, parent),
    dev: stats.dev,
    ino: stats.ino,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertParentStable(boundary: ArtifactParentBoundary): void {
  const current = lstatDirectory(boundary.path, 'invalid_reference');
  let currentRealPath: string;
  try {
    currentRealPath = realpathSync(boundary.path);
  } catch {
    pathError('Plan Artifact parent could not be resolved safely.', 'invalid_reference');
  }
  if (!sameIdentity(boundary, current) || currentRealPath !== boundary.realPath) {
    pathError('Plan Artifact parent changed during the operation.', 'invalid_reference');
  }
}

function lstatRegularFile(
  target: string,
  missingCode: 'invalid_reference' | 'artifact_missing',
): Stats {
  let stats: Stats;
  try {
    stats = lstatSync(target);
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) {
      return pathError('Plan Artifact does not exist.', missingCode);
    }
    return pathError('Plan Artifact could not be validated.', 'invalid_reference');
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    pathError(
      'Plan Artifact must be a regular file and cannot be a symbolic link.',
      'invalid_reference',
    );
  }
  return stats;
}

function readRegularArtifact(
  target: string,
  missingCode: 'invalid_reference' | 'artifact_missing',
  boundary = validateArtifactParent(target, { create: false, missingCode }),
): { markdown: string; byteLength: number; identity: FileIdentity } {
  const beforeOpen = lstatRegularFile(target, missingCode);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(target, constants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(beforeOpen, opened)) {
      pathError('Plan Artifact changed while being opened.', 'invalid_reference');
    }
    assertParentStable(boundary);
    const markdown = readFileSync(descriptor, 'utf8');
    const afterRead = fstatSync(descriptor);
    if (!afterRead.isFile() || !sameIdentity(opened, afterRead)) {
      pathError('Plan Artifact changed while being read.', 'invalid_reference');
    }
    assertParentStable(boundary);
    return {
      markdown,
      byteLength: afterRead.size,
      identity: { dev: afterRead.dev, ino: afterRead.ino },
    };
  } catch (error) {
    if (error instanceof PlanArtifactError) throw error;
    if (isFileSystemError(error, 'ENOENT')) {
      return pathError('Plan Artifact does not exist.', missingCode);
    }
    return pathError(
      'Plan Artifact could not be opened without following links.',
      'invalid_reference',
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function serialize(plan: PlanDocument, taskId: string): string {
  const metadata = {
    artifactFormatVersion: ARTIFACT_FORMAT_VERSION,
    planSchemaVersion: plan.planSchemaVersion,
    taskId,
    planId: plan.planId,
    version: plan.version,
    title: plan.title,
    structuralDigest: plan.structuralDigest,
    steps: plan.steps,
    createdAtTurnId: plan.createdAtTurnId,
    updatedAtTurnId: plan.updatedAtTurnId,
    completionEvidence: plan.completionEvidence,
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
  const lines = markdown.split(/\r?\n/);
  const firstLine = lines[0] ?? '';
  const match = /^<!-- kite-code-plan (.+) -->$/.exec(firstLine.trim());
  if (!match) {
    throw new PlanArtifactError('Plan Artifact metadata header is missing.', 'artifact_corrupt');
  }

  let parsedMetadata: unknown;
  try {
    parsedMetadata = JSON.parse(match[1]!);
  } catch {
    throw new PlanArtifactError('Plan Artifact metadata is invalid JSON.', 'artifact_corrupt');
  }
  if (
    typeof parsedMetadata !== 'object' ||
    parsedMetadata === null ||
    Array.isArray(parsedMetadata)
  ) {
    throw new PlanArtifactError('Plan Artifact metadata is invalid.', 'artifact_corrupt');
  }
  const rawMetadata = parsedMetadata as Record<string, unknown>;
  if (!hasOnlyKeys(rawMetadata, ARTIFACT_METADATA_KEYS)) {
    throw new PlanArtifactError(
      'Plan Artifact metadata contains unknown fields.',
      'artifact_corrupt',
    );
  }

  const metadata = parsedMetadata as {
    artifactFormatVersion?: number;
    planSchemaVersion?: number;
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
    completionEvidence?: unknown;
  };

  if (
    metadata.artifactFormatVersion !== ARTIFACT_FORMAT_VERSION ||
    metadata.planSchemaVersion !== 2 ||
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

  if (!metadata.steps.every(isPlanStepMetadata)) {
    throw new PlanArtifactError('Plan Artifact step metadata is invalid.', 'artifact_corrupt');
  }

  if (!hasValidPlanRevisionMetadata(rawMetadata)) {
    throw new PlanArtifactError('Plan Artifact plan schema is invalid.', 'artifact_corrupt');
  }

  if (lines[1] !== `# ${metadata.title}`) {
    throw new PlanArtifactError(
      'Plan Artifact Markdown heading does not match metadata title.',
      'artifact_corrupt',
    );
  }
  const bodyStart = lines[2] === '' ? 3 : 2;
  const body = lines.slice(bodyStart).join('\n').trim();
  const plan: PlanDocument = {
    planSchemaVersion: 2,
    planId: metadata.planId,
    version: metadata.version,
    title: metadata.title,
    bodyMarkdown: body,
    steps: metadata.steps,
    structuralDigest: metadata.structuralDigest,
    createdAtTurnId: metadata.createdAtTurnId,
    updatedAtTurnId: metadata.updatedAtTurnId,
    completionEvidence: metadata.completionEvidence as PlanDocument['completionEvidence'],
    ...(metadata.supersedesPlanVersion === undefined
      ? {}
      : { supersedesPlanVersion: metadata.supersedesPlanVersion }),
    ...(metadata.replanReason === undefined ? {} : { replanReason: metadata.replanReason }),
  };
  assertPlanDocumentV2(plan, 'artifact_corrupt');
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

function existingArtifactRef(
  taskId: string,
  plan: PlanDocument,
  target: string,
  expectedMarkdown: string,
  boundary: ArtifactParentBoundary,
): PlanArtifactRef {
  try {
    const existing = readRegularArtifact(target, 'invalid_reference', boundary);
    const existingPlan = parse(existing.markdown, {
      taskId,
      planId: plan.planId,
      version: plan.version,
    });
    if (
      existingPlan.planSchemaVersion !== 2 ||
      serialize(existingPlan, taskId) !== expectedMarkdown
    ) {
      throw new Error('Existing artifact has different canonical content.');
    }
    return makeRef(taskId, existingPlan, target, existing.byteLength);
  } catch {
    throw new PlanArtifactError(
      `Plan Artifact ${plan.planId}:v${plan.version} already exists with different content.`,
      'artifact_conflict',
    );
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return isFileSystemError(error, 'EEXIST');
}

function createTemporaryArtifact(
  temporary: string,
  markdown: string,
  boundary: ArtifactParentBoundary,
): FileIdentity {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) {
      pathError('Plan Artifact temporary file is not a regular file.', 'invalid_reference');
    }
    assertParentStable(boundary);
    writeFileSync(descriptor, markdown, 'utf8');
    fsyncSync(descriptor);
    const written = fstatSync(descriptor);
    if (!written.isFile() || !sameIdentity(opened, written)) {
      pathError('Plan Artifact temporary file changed while writing.', 'invalid_reference');
    }
    assertParentStable(boundary);
    return { dev: written.dev, ino: written.ino };
  } catch (error) {
    if (error instanceof PlanArtifactError) throw error;
    return pathError(
      'Plan Artifact temporary file could not be created safely.',
      'invalid_reference',
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function cleanupTemporaryArtifact(
  temporary: string,
  identity: FileIdentity | undefined,
  boundary: ArtifactParentBoundary,
): void {
  if (!identity) return;
  try {
    assertParentStable(boundary);
    const current = lstatSync(temporary);
    if (current.isFile() && !current.isSymbolicLink() && sameIdentity(identity, current)) {
      unlinkSync(temporary);
    }
  } catch {
    // A changed/missing parent or temp is intentionally left untouched: never clean through a link.
  }
}

function syncArtifactDirectoryChain(directory: string): void {
  const root = resolve(planArtifactRoot());
  const directories = [dirname(root), root];
  const fromRoot = relative(root, resolve(directory));
  let current = root;
  for (const segment of fromRoot === '' ? [] : fromRoot.split(sep)) {
    current = join(current, segment);
    directories.push(current);
  }
  for (const candidate of directories.reverse()) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(candidate, constants.O_RDONLY | NO_FOLLOW);
      if (!fstatSync(descriptor).isDirectory()) continue;
      fsyncSync(descriptor);
    } catch {
      // Directory fsync is not supported on every platform. The Artifact file
      // itself remains fsynced and the publish path remains fail-safe.
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}

export class PlanArtifactStore {
  write(taskId: string, plan: PlanDocument): PlanArtifactRef {
    assertSafeSegment(taskId, 'taskId');
    assertSafeSegment(plan.planId, 'planId');
    assertSafeVersion(plan.version);
    assertPlanDocumentV2(plan, 'invalid_reference');
    assertInsideRoot(planArtifactPath(taskId, plan.version));

    const target = planArtifactPath(taskId, plan.version);
    const markdown = serialize(plan, taskId);

    try {
      const currentBoundary = validateArtifactParent(target, {
        create: false,
        missingCode: 'artifact_missing',
      });
      try {
        lstatRegularFile(target, 'artifact_missing');
      } catch (error) {
        if (error instanceof PlanArtifactError && error.code === 'artifact_missing') throw error;
        return existingArtifactRef(taskId, plan, target, markdown, currentBoundary);
      }
      return existingArtifactRef(taskId, plan, target, markdown, currentBoundary);
    } catch (error) {
      if (!(error instanceof PlanArtifactError) || error.code !== 'artifact_missing') throw error;
    }

    const boundary = validateArtifactParent(target, {
      create: true,
      missingCode: 'invalid_reference',
    });

    const temporary = join(
      dirname(target),
      `.${plan.version}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    let temporaryIdentity: FileIdentity | undefined;
    try {
      temporaryIdentity = createTemporaryArtifact(temporary, markdown, boundary);
      assertParentStable(boundary);
      try {
        linkSync(temporary, target);
      } catch (error) {
        if (isAlreadyExistsError(error)) {
          return existingArtifactRef(taskId, plan, target, markdown, boundary);
        }
        throw error;
      }
      assertParentStable(boundary);
      const published = readRegularArtifact(target, 'invalid_reference', boundary);
      if (!sameIdentity(temporaryIdentity, published.identity) || published.markdown !== markdown) {
        pathError(
          'Published Plan Artifact does not match its temporary file.',
          'invalid_reference',
        );
      }
      syncArtifactDirectoryChain(boundary.path);
    } finally {
      cleanupTemporaryArtifact(temporary, temporaryIdentity, boundary);
    }
    return makeRef(taskId, plan, target, Buffer.byteLength(markdown, 'utf8'));
  }

  read(ref: PlanArtifactRef): PlanArtifactContent {
    assertSafeSegment(ref.taskId, 'taskId');
    assertSafeSegment(ref.planId, 'planId');
    assertSafeVersion(ref.version);
    const target = planArtifactPath(ref.taskId, ref.version);
    assertInsideRoot(target);
    const artifactFile = readRegularArtifact(target, 'artifact_missing');
    const plan = parse(artifactFile.markdown, {
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
    return {
      taskId: ref.taskId,
      plan,
      markdown: artifactFile.markdown,
      artifact: makeRef(ref.taskId, plan, target, artifactFile.byteLength),
    };
  }
}

export const defaultPlanArtifactStore = new PlanArtifactStore();

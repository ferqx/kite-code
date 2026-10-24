import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import {
  artifactPath,
  verifyPublishedArtifact,
  verifyPublishedArtifactSteps,
} from '../../artifacts-files';
import { inputImages } from '../../input-images';
import { canonicalJson } from '../../json';
import { assertNoSymlinkPath } from '../../platform/profile-identity';
import type { Store } from '../port';
import { AgentError, type ArtifactReference, type ArtifactScope } from '../types';
import { isHumanBoundReviewRequest } from './authorization-review';
import type { SqliteOperations } from './operations';
import { blobReferences, blobs } from './schema';

type Register = Parameters<Store['registerArtifact']>[0];
type Get = Parameters<Store['getArtifactReference']>[0];
/** Private pre-transaction continuation. Never decoded from a Store argument. */
export class ArtifactVerificationPending extends Error {}
type Verification = {
  input: Register;
  chunks: Generator<unknown, void, void>;
  identity: string;
  complete: boolean;
};
const verifications = new WeakMap<SqliteOperations, Map<number, Verification>>();
function artifactIdentity(profile: string, input: Register): string {
  const path = artifactPath(profile, input.hash);
  assertNoSymlinkPath(path);
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.size !== BigInt(input.size))
    throw new AgentError('artifact_content_mismatch');
  return [stat.dev, stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs, stat.mode].join(':');
}
/** Called only when the original request is finally ACKed, successfully or otherwise. */
export function disposeArtifactVerification(ops: SqliteOperations, requestId: number): void {
  const pending = verifications.get(ops);
  const state = pending?.get(requestId);
  pending?.delete(requestId);
  if (pending?.size === 0) verifications.delete(ops);
  state?.chunks.return();
}
function verifyArtifact(ops: SqliteOperations, input: Register, requestId?: number): string {
  const profile = dirname(ops.db.filename);
  // Direct synchronous Operations callers retain the same complete validation.
  if (requestId === undefined) {
    const identity = artifactIdentity(profile, input);
    verifyPublishedArtifact(profile, input.hash, input.size);
    if (artifactIdentity(profile, input) !== identity)
      throw new AgentError('artifact_content_mismatch');
    return identity;
  }
  let pending = verifications.get(ops);
  if (!pending) {
    pending = new Map();
    verifications.set(ops, pending);
  }
  let state = pending.get(requestId);
  if (!state) {
    state = {
      input,
      identity: artifactIdentity(profile, input),
      chunks: verifyPublishedArtifactSteps(profile, input.hash, input.size),
      complete: false,
    };
    pending.set(requestId, state);
  }
  if (state.input !== input) throw new AgentError('artifact_scope_invalid');
  if (!state.complete) {
    const until = performance.now() + 8;
    for (let remaining = 64; remaining > 0; remaining--) {
      if (state.chunks.next().done) {
        state.complete = true;
        break;
      }
      if (performance.now() >= until) break;
    }
    if (!state.complete) throw new ArtifactVerificationPending();
  }
  // Keep a completed full proof across an unstarted BEGIN wait, but never reuse it
  // after the immutable object/path identity changed while other queries ran.
  if (artifactIdentity(profile, input) !== state.identity)
    throw new AgentError('artifact_content_mismatch');
  return state.identity;
}
export function assertInputImages(
  ops: SqliteOperations,
  input: { expectedStoreId: string; sessionId: string; subjectId: string; images: unknown },
): void {
  if (!Array.isArray(input.images) || input.images.length > 10)
    throw new AgentError('input_image_invalid');
  for (const image of inputImages(input.images)) {
    const ref = image.reference;
    if (
      ref.storeId !== input.expectedStoreId ||
      ref.sessionId !== input.sessionId ||
      ref.subjectId !== input.subjectId
    )
      throw new AgentError('input_image_scope_mismatch');
    const lookup = { ...input, refId: ref.id, scope: ref.scope };
    scope(ops, lookup, true);
    const original = get(ops, lookup);
    if (
      !original ||
      canonicalJson(original as unknown as import('../types').Json) !==
        canonicalJson(ref as unknown as import('../types').Json)
    )
      throw new AgentError('input_image_scope_mismatch');
  }
}
function validate(input: Get): void {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.refId) ||
    !input.subjectId ||
    input.subjectId.length > 256 ||
    !['session', 'execution', 'message'].includes(input.scope.kind) ||
    !input.scope.id ||
    input.scope.id.length > 256
  )
    throw new AgentError('artifact_scope_invalid');
}
function scope(ops: SqliteOperations, input: Get, live: boolean): void {
  validate(input);
  const session = ops.row('SELECT * FROM session WHERE id=?', input.sessionId);
  const creator = session?.parent_id
    ? ops.row(
        `SELECT start.subject_id FROM command start
         JOIN execution carrier ON carrier.child_session_id=start.session_id
         JOIN command origin ON origin.id=carrier.origin_command_id
         JOIN session parent ON parent.id=carrier.session_id
         WHERE start.session_id=? AND start.kind='child.start'
           AND carrier.root_session_id=? AND parent.id=? AND parent.root_id=?
           AND start.subject_id=origin.subject_id
           AND start.origin_store_id=carrier.origin_store_id
           AND origin.origin_store_id=carrier.origin_store_id`,
        input.sessionId,
        String(session.root_id),
        String(session.parent_id),
        String(session.root_id),
      )
    : ops.row(
        "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
        input.sessionId,
      );
  if (
    !session ||
    !creator ||
    creator.subject_id !== input.subjectId ||
    (live && session.delete_requested)
  )
    throw new AgentError('artifact_scope_denied');
  if (input.scope.kind === 'session') {
    if (input.scope.id !== input.sessionId) throw new AgentError('artifact_scope_denied');
  } else if (input.scope.kind === 'execution') {
    const origin = ops.row(
      'SELECT c.subject_id, e.origin_store_id, c.origin_store_id AS command_origin FROM execution e JOIN command c ON c.id=e.origin_command_id WHERE e.id=? AND e.session_id=?',
      input.scope.id,
      input.sessionId,
    );
    if (
      !origin ||
      origin.subject_id !== input.subjectId ||
      (live &&
        (origin.origin_store_id !== input.expectedStoreId ||
          origin.command_origin !== input.expectedStoreId))
    )
      throw new AgentError('artifact_scope_denied');
  } else if (
    !ops.row('SELECT id FROM message WHERE id=? AND session_id=?', input.scope.id, input.sessionId)
  )
    throw new AgentError('artifact_scope_denied');
}
function get(ops: SqliteOperations, input: Get, publishing = false): ArtifactReference | null {
  const row = drizzle(ops.db)
    .select({
      id: blobReferences.id,
      hash: blobReferences.hash,
      sessionId: blobReferences.sessionId,
      subjectId: blobReferences.subjectId,
      originStoreId: blobReferences.originStoreId,
      scopeKind: blobReferences.scopeKind,
      scopeId: blobReferences.scopeId,
      size: sql<string>`CAST(${blobs.size} AS TEXT)`,
      mediaType: blobReferences.mediaType,
    })
    .from(blobReferences)
    .innerJoin(blobs, eq(blobs.hash, blobReferences.hash))
    .where(
      and(
        eq(blobReferences.id, input.refId),
        eq(blobReferences.sessionId, input.sessionId),
        eq(blobReferences.subjectId, input.subjectId),
        eq(blobReferences.scopeKind, input.scope.kind),
        eq(blobReferences.scopeId, input.scope.id),
        ...(publishing ? [eq(blobReferences.originStoreId, input.expectedStoreId)] : []),
      ),
    )
    .get();
  if (row && input.scope.kind === 'execution') {
    const execution = ops.row(
      'SELECT e.origin_store_id, c.origin_store_id AS command_origin FROM execution e JOIN command c ON c.id=e.origin_command_id WHERE e.id=? AND e.session_id=?',
      input.scope.id,
      input.sessionId,
    );
    if (
      !execution ||
      execution.origin_store_id !== row.originStoreId ||
      execution.command_origin !== execution.origin_store_id
    )
      return null;
  }
  return row
    ? {
        id: String(row.id),
        storeId: String(row.originStoreId),
        sessionId: String(row.sessionId),
        subjectId: String(row.subjectId),
        scope: { kind: String(row.scopeKind) as ArtifactScope['kind'], id: String(row.scopeId) },
        hash: String(row.hash),
        size: String(row.size),
        mediaType: String(row.mediaType),
      }
    : null;
}
/** Internal lookup inside the caller's existing transaction; it does not establish byte integrity. */
export function lookupArtifactReference(
  ops: SqliteOperations,
  input: Get,
): ArtifactReference | null {
  ops.identity(input.expectedStoreId);
  scope(ops, input, false);
  return get(ops, input);
}
export function callArtifact(
  ops: SqliteOperations,
  method: string,
  args: unknown[],
  requestId?: number,
): unknown {
  const input = args[0] as Register;
  if (method === 'getArtifactReference' || method === 'getLegacyReviewArtifactReference') {
    ops.db.run('BEGIN');
    try {
      ops.identity(input.expectedStoreId);
      scope(ops, input, false);
      const reference = get(ops, input);
      const result =
        method === 'getLegacyReviewArtifactReference' && reference
          ? isHumanBoundReviewRequest(ops, reference)
            ? reference
            : null
          : reference;
      ops.db.run('COMMIT');
      return result;
    } catch (error) {
      return ops.rollback(error);
    }
  }
  if (method !== 'registerArtifact') throw new AgentError('storage_method_invalid');
  // Full file validation belongs outside the short identity/reference commit.
  ops.identity(input.expectedStoreId);
  scope(ops, input, true);
  if (
    !/^[a-f0-9]{64}$/.test(input.hash) ||
    !/^(0|[1-9][0-9]*)$/.test(input.size) ||
    BigInt(input.size) > 9223372036854775807n ||
    !input.mediaType ||
    input.mediaType.length > 256 ||
    [...input.mediaType].some((character) => character.charCodeAt(0) < 32)
  )
    throw new AgentError('artifact_metadata_invalid');
  const verifiedIdentity = verifyArtifact(ops, input, requestId);
  return ops.tx(() => {
    // BEGIN may itself wait for a writer. Recheck the private complete proof
    // after that wait, before any registration effect, without whole-body IO.
    if (artifactIdentity(dirname(ops.db.filename), input) !== verifiedIdentity)
      throw new AgentError('artifact_content_mismatch');
    ops.identity(input.expectedStoreId);
    scope(ops, input, true);

    const old = ops.row('SELECT * FROM blob_ref WHERE id=?', input.refId);
    if (old) {
      const ref = get(ops, input, true);
      if (
        !ref ||
        ref.hash !== input.hash ||
        ref.size !== input.size ||
        ref.mediaType !== input.mediaType
      )
        throw new AgentError('artifact_reference_conflict');
      return ref;
    }
    const blob = ops.row('SELECT * FROM blob WHERE hash=?', input.hash);
    if (blob && String(blob.size) !== input.size)
      throw new AgentError('artifact_metadata_conflict');
    if (!blob)
      ops.run(
        'INSERT INTO blob(hash,size,published_at) VALUES(?,?,?)',
        input.hash,
        BigInt(input.size),
        String(Date.now()),
      );
    ops.run(
      'INSERT INTO blob_ref(id,blob_hash,session_id,owner_kind,owner_id,subject_id,origin_store_id,media_type) VALUES(?,?,?,?,?,?,?,?)',
      input.refId,
      input.hash,
      input.sessionId,
      input.scope.kind,
      input.scope.id,
      input.subjectId,
      input.expectedStoreId,
      input.mediaType,
    );
    ops.event(input.sessionId, input.refId, 'artifact.published');

    return get(ops, input, true)!;
  });
}

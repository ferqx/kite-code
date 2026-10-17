import type { SourceRequest } from './context';
import { semanticDigest } from './json';
import { bodyReference, type ModelBodyReference } from './model-body';
import { AgentError, type ArtifactReference, type Json } from './storage/types';

export interface SourceRequestJournalIdentity {
  storeId: string;
  sessionId: string;
  subjectId: string;
  workspaceId: string;
  runId: string;
}

/** Append-only private checkpoint data. Each original input is sealed once per Run. */
export function sourceRequestJournalNode(
  identity: SourceRequestJournalIdentity,
  previous: ModelBodyReference | null,
  requests: readonly SourceRequest[],
): Json {
  return {
    version: 1,
    runId: identity.runId,
    sessionId: identity.sessionId,
    workspaceId: identity.workspaceId,
    previous: previous as unknown as Json,
    requests: requests as unknown as Json,
  };
}

export async function readSourceRequestJournal(
  value: Json,
  identity: SourceRequestJournalIdentity,
  read: (reference: ArtifactReference) => Promise<Json>,
  signal: AbortSignal,
): Promise<SourceRequest[]> {
  signal.throwIfAborted();
  const pages: SourceRequest[][] = [];
  const seen = new Set<string>();
  let current = value;
  while (current !== null) {
    signal.throwIfAborted();
    const head = bodyReference(current);
    const ref = head?.reference;
    if (
      !ref ||
      ref.storeId !== identity.storeId ||
      ref.sessionId !== identity.sessionId ||
      ref.subjectId !== identity.subjectId ||
      ref.scope.kind !== 'session' ||
      ref.scope.id !== identity.sessionId ||
      seen.has(ref.id)
    )
      throw new AgentError('run_continuation_invalid');
    seen.add(ref.id);
    const node = await read(ref);
    if (
      !node ||
      typeof node !== 'object' ||
      Array.isArray(node) ||
      node.version !== 1 ||
      node.runId !== identity.runId ||
      node.sessionId !== identity.sessionId ||
      node.workspaceId !== identity.workspaceId ||
      node.previous === undefined ||
      !Array.isArray(node.requests) ||
      !node.requests.length ||
      Object.keys(node).some(
        (key) =>
          !['version', 'runId', 'sessionId', 'workspaceId', 'previous', 'requests'].includes(key),
      )
    )
      throw new AgentError('run_continuation_invalid');
    const page: SourceRequest[] = [];
    for (const request of node.requests) {
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        request.sessionId !== identity.sessionId ||
        request.workspaceId !== identity.workspaceId ||
        typeof request.definitionId !== 'string' ||
        !request.definitionId ||
        request.input === undefined ||
        Object.keys(request).some(
          (key) => !['sessionId', 'workspaceId', 'definitionId', 'input'].includes(key),
        )
      )
        throw new AgentError('run_continuation_invalid');
      page.push(request as unknown as SourceRequest);
    }
    pages.push(page);
    current = node.previous;
  }
  const result: SourceRequest[] = [];
  const keys = new Set<string>();
  for (const page of pages.reverse())
    for (const request of page) {
      signal.throwIfAborted();
      const key = `${request.definitionId}:${await semanticDigest(request.input)}`;
      if (keys.has(key)) throw new AgentError('run_continuation_invalid');
      keys.add(key);
      result.push(request);
    }
  return result;
}

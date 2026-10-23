import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { createRuntime } from '@kite-ai/agent';
import type { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelRequest } from '@kite-ai/ai';

/** Private original inspector evidence; no Provider calls or synthesized model outputs. */
export async function saveLiveCanonicalModelEvidence(options: {
  runtime: ReturnType<typeof createRuntime>;
  store: Awaited<ReturnType<typeof openSqliteStore>>;
  requests: readonly ModelRequest[];
  root: string;
  subjectId: string;
  /** Compare actual captured dispatches with Store-decoded sealed requests while open. */
  verifyRequests?: boolean;
}) {
  const expectedStoreId = (await options.store.getMetadata()).storeId;
  const records = [];
  let complete = true;
  const requestIdentities: {
    requestId: string;
    sessionId?: string;
    runId?: string | null;
    matches: boolean;
  }[] = [];
  const uniqueRequestIds = new Set(options.requests.map((request) => request.requestId));
  if (options.verifyRequests && uniqueRequestIds.size !== options.requests.length) complete = false;
  for (const executionId of new Set(options.requests.map((request) => request.requestId))) {
    const execution = await options.store.getExecution(executionId);
    if (execution?.kind !== 'model') {
      records.push({ executionId, executionUnavailable: true });
      complete = false;
      if (options.verifyRequests)
        requestIdentities.push({ requestId: executionId, matches: false });
      continue;
    }
    const scope = {
      expectedStoreId,
      sessionId: execution.sessionId,
      subjectId: options.subjectId,
      executionId,
    };
    try {
      const input = await options.runtime.readModelInput(scope);
      if (options.verifyRequests) {
        const matches =
          input.executionId === executionId &&
          input.sessionId === execution.sessionId &&
          input.runId === execution.runId &&
          input.storeId === expectedStoreId &&
          isDeepStrictEqual(
            input.request,
            options.requests.find((request) => request.requestId === executionId),
          );
        requestIdentities.push({
          requestId: executionId,
          sessionId: execution.sessionId,
          runId: execution.runId,
          matches,
        });
        if (!matches) complete = false;
      }
      const output =
        execution.status === 'succeeded' ? await options.runtime.readModelOutput(scope) : undefined;
      records.push({ scope, execution, input, ...(output ? { output } : {}) });
      if (output && !output.output.complete) complete = false;
    } catch {
      // The original Store remains retained if an active/failed request has no inspector body.
      records.push({ scope, execution, inspectorUnavailable: true });
      complete = false;
      if (
        options.verifyRequests &&
        !requestIdentities.some((identity) => identity.requestId === executionId)
      )
        requestIdentities.push({
          requestId: executionId,
          sessionId: execution.sessionId,
          runId: execution.runId,
          matches: false,
        });
    }
  }
  const body = `${JSON.stringify(records, null, 2)}\n`;
  writeFileSync(join(options.root, 'canonical-model-evidence.json'), body, { mode: 0o600 });
  return {
    file: 'canonical-model-evidence.json',
    sha256: createHash('sha256').update(body).digest('hex'),
    models: records.length,
    complete,
    ...(options.verifyRequests
      ? {
          requestIdentity: {
            matches:
              uniqueRequestIds.size === options.requests.length &&
              requestIdentities.length === options.requests.length &&
              requestIdentities.every((identity) => identity.matches),
            checked: requestIdentities.length,
            dispatched: options.requests.length,
            records: requestIdentities,
          },
        }
      : {}),
  };
}

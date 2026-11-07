import type { Json } from '../../extensions';
import { modelCursor, readModelCursor } from '../../model-cursor';
import { AgentError } from '../../storage/types';

export interface BrowserReferenceScope {
  storeId: string;
  sessionId: string;
  runId: string;
}
/** Exact live-controller locator. Its original generation/sequence checks still decide validity. */
export function browserPageReference(
  scope: BrowserReferenceScope,
  target: { browserId: string; generation: string | null },
): string {
  return modelCursor(
    { kind: 'browser_page', ...scope },
    { browserId: target.browserId, generation: target.generation },
  );
}
export function browserElementReference(
  scope: BrowserReferenceScope,
  target: { browserId: string; generation: string; seq: string; ref: string },
): string {
  return modelCursor(
    { kind: 'browser_element', ...scope },
    {
      browserId: target.browserId,
      generation: target.generation,
      seq: target.seq,
      ref: target.ref,
    },
  );
}
export function readBrowserReference(
  value: Json,
  scope: BrowserReferenceScope,
  element: boolean,
): Record<string, Json> {
  const target = readModelCursor(value, {
    kind: element ? 'browser_element' : 'browser_page',
    ...scope,
  });
  if (
    !target ||
    typeof target !== 'object' ||
    Array.isArray(target) ||
    Object.keys(target).sort().join(',') !==
      (element ? 'browserId,generation,ref,seq' : 'browserId,generation') ||
    typeof target.browserId !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(target.browserId) ||
    !(
      (target.generation === null && !element) ||
      (typeof target.generation === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(target.generation))
    ) ||
    (element &&
      (typeof target.ref !== 'string' ||
        !/^@?e[1-9][0-9]{0,12}$/.test(target.ref) ||
        typeof target.seq !== 'string' ||
        !/^(0|[1-9][0-9]{0,18})$/.test(target.seq)))
  )
    throw new AgentError('tool_reference_invalid');
  if (target.generation === null) {
    const { generation: _, ...pending } = target;
    return pending;
  }
  return target;
}

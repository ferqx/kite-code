import type { Interaction } from '@kite-ai/client';
import type { TuiMcpSourceItem, TuiMcpSourceSnapshot } from './mcp-source';

export const sourceDecisions = ['approved', 'rejected', 'cancel'] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).sort().join(',') === expected.sort().join(',');
const choices = (value: unknown) =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((item, index) => item === sourceDecisions[index]);

/** Only the exact Source Action's closed Question receives enum navigation. */
export function isMcpSourceQuestion(card: Interaction): boolean {
  const request = card.request;
  if (
    card.kind !== 'question' ||
    card.state !== 'pending' ||
    card.definitionId !== 'builtin.mcp.sources/mcp.source.approve' ||
    card.definitionVersion !== '1' ||
    !object(request) ||
    request.kind !== 'mcp_source_approval' ||
    request.executionId !== card.executionId ||
    request.originalStoreId !== card.originStoreId ||
    request.sessionId !== card.sessionId ||
    !choices(request.choices)
  )
    return false;
  const schema = request.schema;
  if (
    !object(schema) ||
    !keys(schema, ['type', 'additionalProperties', 'required', 'properties']) ||
    schema.type !== 'object' ||
    schema.additionalProperties !== false ||
    !Array.isArray(schema.required) ||
    schema.required.length !== 1 ||
    schema.required[0] !== 'decision' ||
    !object(schema.properties) ||
    !keys(schema.properties, ['decision'])
  )
    return false;
  const decision = schema.properties.decision;
  return (
    object(decision) &&
    keys(decision, ['type', 'enum']) &&
    decision.type === 'string' &&
    choices(decision.enum)
  );
}
export function reviewableMcpSource(
  item: TuiMcpSourceItem | undefined,
  facts: TuiMcpSourceSnapshot,
): boolean {
  return (
    !!item &&
    item.source.kind === 'workspace' &&
    item.transport !== null &&
    item.transportDigest !== null &&
    facts.readSet?.workspace !== null &&
    facts.readSet?.workspace !== undefined &&
    facts.readSet.workspace.identity.kind === 'workspace' &&
    item.source.rootIdentity === facts.readSet.workspace.identity.rootIdentity &&
    item.source.pathDigest === facts.readSet.workspace.identity.pathDigest &&
    facts.readSet.workspace.error === null
  );
}

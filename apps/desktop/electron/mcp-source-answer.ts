import {
  type AnswerInteractionRequest,
  ClientError,
  canonicalModelBody,
  type Interaction,
  validateMcpCommandRequest,
} from '@kite-ai/client';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const closed = (value: unknown, keys: string[]) =>
  Object.keys(object(value)).sort().join(',') === keys.sort().join(',');
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
/** Guard the nonsecret decision before the ordinary answer journal can durably save it. */
export function verifyNativeMcpSourceAnswer(
  card: Interaction,
  answer: AnswerInteractionRequest['answer'],
  storeId: string,
): void {
  const q = object(card.request),
    credential = q.kind === 'mcp_credential_binding';
  const answers = object(object(answer).answers);
  if (
    q.kind !== 'mcp_source_approval' &&
    q.kind !== 'mcp_credential_binding' &&
    !(
      card.kind === 'question' &&
      [
        'builtin.mcp.sources/mcp.source.approve',
        'builtin.mcp.sources/mcp.credential.bind',
      ].includes(card.definitionId)
    )
  )
    return;
  const fail = (): never => {
    throw new ClientError('mcp_source_question_invalid');
  };
  const decisions = credential ? ['bind', 'revoke', 'cancel'] : ['approved', 'rejected', 'cancel'];
  if (
    card.kind !== 'question' ||
    card.state !== 'pending' ||
    card.definitionVersion !== '1' ||
    card.definitionId !==
      `builtin.mcp.sources/${credential ? 'mcp.credential.bind' : 'mcp.source.approve'}` ||
    card.originStoreId !== storeId ||
    q.originalStoreId !== storeId ||
    q.executionId !== card.executionId ||
    q.sessionId !== card.sessionId ||
    q.kind !== (credential ? 'mcp_credential_binding' : 'mcp_source_approval') ||
    !closed(q, [
      'kind',
      'executionId',
      'originalStoreId',
      'sessionId',
      'server',
      'readSet',
      'choices',
      'instruction',
      ...(credential
        ? ['authProfileDigest', 'credentialReferenceDigest', 'expiresAt']
        : ['schema']),
    ]) ||
    typeof q.instruction !== 'string' ||
    canonicalModelBody(q.choices) !== canonicalModelBody(decisions) ||
    !closed(answer, ['kind', 'answers']) ||
    answer.kind !== 'question' ||
    !closed(answers, ['decision']) ||
    typeof answers.decision !== 'string' ||
    !decisions.includes(answers.decision)
  )
    fail();
  const server = object(q.server),
    source = object(server.source),
    reads = object(q.readSet),
    read = object(reads[String(source.kind)]);
  if (
    !closed(server, [
      'id',
      'name',
      'source',
      'rawEntryDigest',
      'transportDigest',
      'transport',
      'enabled',
      'admitted',
      'reason',
    ]) ||
    typeof server.name !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(server.name) ||
    !hash(server.rawEntryDigest) ||
    !hash(server.transportDigest) ||
    (server.transport !== 'http' && server.transport !== 'stdio') ||
    typeof server.enabled !== 'boolean' ||
    typeof server.admitted !== 'boolean' ||
    (server.reason !== null && typeof server.reason !== 'string') ||
    !['user', 'workspace'].includes(source.kind as string) ||
    canonicalModelBody(source) !== canonicalModelBody(read.identity) ||
    (!credential && source.kind !== 'workspace')
  )
    fail();
  try {
    validateMcpCommandRequest({
      expectedStoreId: storeId,
      commandId: 'source-review',
      kind: 'extension.invoke',
      extensionId: 'builtin.mcp.sources',
      actionId: credential ? 'mcp.credential.bind' : 'mcp.source.approve',
      definitionVersion: '1',
      input: {
        serverId: server.id,
        expectedReadSet: q.readSet,
        ...(credential ? { expiresAt: q.expiresAt } : {}),
      },
    });
  } catch {
    fail();
  }
  if (credential) {
    if (!hash(q.authProfileDigest) || !hash(q.credentialReferenceDigest)) fail();
  } else if (
    canonicalModelBody(q.schema) !==
    canonicalModelBody({
      type: 'object',
      additionalProperties: false,
      required: ['decision'],
      properties: { decision: { type: 'string', enum: decisions } },
    })
  )
    fail();
}

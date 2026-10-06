import type { Interaction } from '@kite-ai/client';
import { useRef, useState } from 'react';
import type { InteractionAnswer } from './interactions';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const closed = (value: unknown, keys: string[]) => {
  const row = object(value);
  return row &&
    Object.keys(row).length === keys.length &&
    keys.every((key) => Object.hasOwn(row, key))
    ? row
    : undefined;
};
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function source(value: unknown, kind?: string) {
  const row = closed(value, ['kind', 'pathDigest', 'rootIdentity']);
  return (
    !!row &&
    typeof row.kind === 'string' &&
    ['user', 'workspace'].includes(row.kind) &&
    (!kind || row.kind === kind) &&
    hash(row.pathDigest) &&
    hash(row.rootIdentity)
  );
}
function readSet(value: unknown) {
  const row = closed(value, [
    'scopeDigest',
    'user',
    'workspace',
    'approvalEtag',
    'bindingEtag',
    'variablesDigest',
  ]);
  const read = (value: unknown, kind: string) => {
    const row = closed(value, ['identity', 'etag', 'error']);
    return (
      !!row &&
      source(row.identity, kind) &&
      (row.etag === null || hash(row.etag)) &&
      row.error === null
    );
  };
  return (
    !!row &&
    hash(row.scopeDigest) &&
    hash(row.variablesDigest) &&
    read(row.user, 'user') &&
    (row.workspace === null || read(row.workspace, 'workspace')) &&
    [row.approvalEtag, row.bindingEtag].every((value) => value === null || hash(value))
  );
}
export function isMcpSourceReview(interaction: Interaction) {
  const kind = object(interaction.request)?.kind;
  return (
    kind === 'mcp_source_approval' ||
    kind === 'mcp_credential_binding' ||
    (interaction.kind === 'question' &&
      [
        'builtin.mcp.sources/mcp.source.approve',
        'builtin.mcp.sources/mcp.credential.bind',
      ].includes(interaction.definitionId))
  );
}
export function mcpSourceDecisions(interaction: Interaction): readonly string[] | undefined {
  const request = object(interaction.request),
    binding = request?.kind === 'mcp_credential_binding';
  const decisions = binding ? ['bind', 'revoke', 'cancel'] : ['approved', 'rejected', 'cancel'];
  const keys = [
    'kind',
    'executionId',
    'originalStoreId',
    'sessionId',
    'server',
    'readSet',
    'choices',
    'instruction',
    ...(binding ? ['authProfileDigest', 'credentialReferenceDigest', 'expiresAt'] : ['schema']),
  ];
  if (
    !closed(request, keys) ||
    interaction.kind !== 'question' ||
    interaction.definitionVersion !== '1' ||
    interaction.definitionId !==
      `builtin.mcp.sources/${binding ? 'mcp.credential.bind' : 'mcp.source.approve'}` ||
    request!.kind !== (binding ? 'mcp_credential_binding' : 'mcp_source_approval') ||
    request!.executionId !== interaction.executionId ||
    request!.originalStoreId !== interaction.originStoreId ||
    request!.sessionId !== interaction.sessionId ||
    typeof request!.instruction !== 'string' ||
    !readSet(request!.readSet) ||
    JSON.stringify(request!.choices) !== JSON.stringify(decisions)
  )
    return;
  const server = closed(request!.server, [
    'id',
    'name',
    'source',
    'rawEntryDigest',
    'transportDigest',
    'transport',
    'enabled',
    'admitted',
    'reason',
  ]);
  if (
    !server ||
    typeof server.id !== 'string' ||
    !/^mcp-[a-f0-9]{64}$/.test(server.id) ||
    typeof server.name !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(server.name) ||
    !source(server.source) ||
    !hash(server.rawEntryDigest) ||
    !hash(server.transportDigest) ||
    typeof server.transport !== 'string' ||
    !['http', 'stdio'].includes(server.transport) ||
    typeof server.enabled !== 'boolean' ||
    typeof server.admitted !== 'boolean' ||
    !(server.reason === null || typeof server.reason === 'string')
  )
    return;
  const sourceIdentity = object(server.source);
  const reads = object(request!.readSet);
  const observed =
    typeof sourceIdentity?.kind === 'string' ? object(reads?.[sourceIdentity.kind]) : undefined;
  if (
    !['kind', 'pathDigest', 'rootIdentity'].every(
      (key) => sourceIdentity?.[key] === object(observed?.identity)?.[key],
    ) ||
    (!binding && sourceIdentity?.kind !== 'workspace')
  )
    return undefined;
  if (binding) {
    if (
      !hash(request!.authProfileDigest) ||
      !hash(request!.credentialReferenceDigest) ||
      !Number.isSafeInteger(request!.expiresAt) ||
      Number(request!.expiresAt) <= 0
    )
      return;
  } else {
    const schema = closed(request!.schema, [
      'type',
      'additionalProperties',
      'required',
      'properties',
    ]);
    const properties = closed(schema?.properties, ['decision']),
      decision = closed(properties?.decision, ['type', 'enum']);
    if (
      schema?.type !== 'object' ||
      schema.additionalProperties !== false ||
      JSON.stringify(schema.required) !== '["decision"]' ||
      decision?.type !== 'string' ||
      JSON.stringify(decision.enum) !== JSON.stringify(decisions)
    )
      return;
  }
  return decisions;
}
export function McpSourceReview({
  interaction,
  disabled,
  onAnswer,
}: {
  interaction: Interaction;
  disabled: boolean;
  onAnswer?: (interaction: Interaction, answer: InteractionAnswer) => void | Promise<void>;
}) {
  const decisions = mcpSourceDecisions(interaction),
    flight = useRef(false),
    [error, setError] = useState('');
  if (!decisions)
    return (
      <p role="alert">Exact MCP Source Review unavailable. Original request cannot be answered.</p>
    );
  return (
    <section aria-label="MCP Source Review">
      <p>
        Review this exact source fingerprint. This decision does not connect or grant Tool
        permission.
      </p>
      <pre>{JSON.stringify(interaction.request, null, 2)}</pre>
      {decisions.map((decision) => (
        <button
          key={decision}
          type="button"
          disabled={disabled}
          onClick={async () => {
            if (disabled || flight.current || !onAnswer) return;
            flight.current = true;
            setError('');
            try {
              await onAnswer(interaction, { kind: 'question', answers: { decision } });
            } catch {
              setError('Source Review answer unavailable; check the original submission.');
            } finally {
              flight.current = false;
            }
          }}
        >
          {decision}
        </button>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

import { type AgentClient, validateRequest } from '@kite-ai/client';
import type { NativeTraceOperation, NativeTraceResult } from '../src/native-trace-bridge';

export function decodeNativeTraceOperation(value: unknown): NativeTraceOperation {
  const fail = (): never => {
    throw Error('invalid_native_request');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const operation = value as Record<string, unknown>;
  const kind = operation.kind;
  if (typeof kind !== 'string') return fail();
  const inputs = {
    validate: 'TraceInstallRequest',
    install: 'TraceInstallRequest',
    installOpenTelemetry: 'TraceOtelInstallRequest',
    configure: 'TraceConfigureRequest',
    grant: 'TraceGrantRequest',
    update: 'TraceInstallRequest',
    history: 'TraceHistoryRequest',
    bindCredential: 'TraceCredentialBind',
    revokeCredential: 'TraceCredentialRevoke',
  } as const;
  const hasInput = kind in inputs;
  const hasPartition = ['partition', 'deadLetters', 'retry', 'cancel', 'pause', 'resume'].includes(
    kind,
  );
  const hasId =
    hasPartition ||
    [
      'inspect',
      'delivery',
      'configure',
      'grant',
      'update',
      'history',
      'bindCredential',
      'revokeCredential',
      'enable',
      'disable',
      'revoke',
      'uninstall',
    ].includes(kind);
  if (!hasInput && !hasId && kind !== 'list') return fail();
  const keys = [
    'kind',
    ...(hasInput ? ['input'] : []),
    ...(hasId ? ['installationId'] : []),
    ...(hasPartition ? ['partitionId'] : []),
  ];
  if (
    Object.keys(operation).length !== keys.length ||
    Object.keys(operation).some((key) => !keys.includes(key))
  )
    return fail();
  if (
    hasId &&
    (typeof operation.installationId !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(operation.installationId))
  )
    return fail();
  if (
    hasPartition &&
    (typeof operation.partitionId !== 'string' ||
      !operation.partitionId ||
      operation.partitionId.length > 512)
  )
    return fail();
  if (hasInput) validateRequest(inputs[kind as keyof typeof inputs], operation.input);
  return value as NativeTraceOperation;
}
export async function invokeNativeTrace(
  client: AgentClient['traceExtensions'],
  operation: NativeTraceOperation,
): Promise<NativeTraceResult> {
  switch (operation.kind) {
    case 'list':
      return { kind: 'trace.installations', value: await client.list() };
    case 'inspect':
      return { kind: 'trace.installation', value: await client.inspect(operation.installationId) };
    case 'delivery':
      return { kind: 'trace.delivery', value: await client.delivery(operation.installationId) };
    case 'validate':
      return { kind: 'trace.validated', value: await client.validate(operation.input) };
    case 'install':
      return { kind: 'trace.installed', value: await client.install(operation.input) };
    case 'installOpenTelemetry':
      return { kind: 'trace.installed', value: await client.installOpenTelemetry(operation.input) };
    case 'configure':
      return {
        kind: 'trace.installation',
        value: await client.configure(operation.installationId, operation.input),
      };
    case 'grant':
      return {
        kind: 'trace.installation',
        value: await client.grant(operation.installationId, operation.input),
      };
    case 'update':
      return {
        kind: 'trace.installation',
        value: await client.update(operation.installationId, operation.input),
      };
    case 'enable':
    case 'disable':
    case 'revoke':
    case 'uninstall':
      return {
        kind: 'trace.action',
        value: await client.action(operation.installationId, operation.kind),
      };
    case 'history':
      return {
        kind: 'trace.history',
        value: await client.history(operation.installationId, operation.input),
      };
    case 'partition':
      return {
        kind: 'trace.partition',
        value: await client.partition(operation.installationId, operation.partitionId),
      };
    case 'deadLetters':
      return {
        kind: 'trace.deadLetters',
        value: await client.deadLetters(operation.installationId, operation.partitionId),
      };
    case 'retry':
    case 'cancel':
    case 'pause':
    case 'resume':
      return {
        kind: 'trace.action',
        value: await client.partitionAction(
          operation.installationId,
          operation.partitionId,
          operation.kind,
        ),
      };
    case 'bindCredential':
      return {
        kind: 'trace.credential',
        value: await client.bindCredential(operation.installationId, operation.input),
      };
    case 'revokeCredential':
      return {
        kind: 'trace.action',
        value: await client.revokeCredential(operation.installationId, operation.input),
      };
  }
}

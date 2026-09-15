import type {
  RuntimeAccess,
  RuntimeCommand,
  RuntimeCommandReceipt,
} from '@kite-ai/runtime-contract';

/** Called only while continuing a Session after an explicit pre-dispatch rejection. */
export async function recoverSessionIfSafe(
  runtime: Pick<RuntimeAccess, 'query' | 'command'>,
  sessionId: string,
  commandId: string,
): Promise<RuntimeCommandReceipt | undefined> {
  const facts = await runtime.query({
    schema: 'kite.runtime-query.v1',
    type: 'get_session_recovery',
    sessionId,
  });
  if (facts.status !== 'ok' || facts.recovery?.action !== 'recover') return undefined;
  const projection = await runtime.query({
    schema: 'kite.runtime-query.v1',
    type: 'get_session_projection',
    sessionId,
  });
  if (projection.status !== 'ok' || !projection.session) return undefined;
  const command = {
    schema: 'kite.runtime-command.v1',
    type: 'recover_session',
    commandId,
    sessionId,
    expectedRevision: projection.session.revision,
    expectedAuthorityRevision: facts.recovery.authorityRevision,
  } as const;
  try {
    return await runtime.command(command);
  } catch (error) {
    // A missing reply is never a reason to send the mutation again.
    try {
      const result = await runtime.query({
        schema: 'kite.runtime-query.v1',
        type: 'get_command_receipt',
        sessionId,
        command,
      });
      if (result.status === 'ok' && result.receipt) return result.receipt;
    } catch {}
    throw error;
  }
}

/** Read the original durable result after a lost reply; this never dispatches a command. */
export async function readCommandReceipt(
  runtime: Pick<RuntimeAccess, 'query'>,
  command: RuntimeCommand,
): Promise<RuntimeCommandReceipt | undefined> {
  const sessionId =
    command.type === 'create_session'
      ? (command.bootstrapSessionId ?? `create:${command.commandId}`)
      : command.type === 'fork_session'
        ? command.sourceSessionId
        : command.sessionId;
  const result = await runtime.query({
    schema: 'kite.runtime-query.v1',
    type: 'get_command_receipt',
    sessionId,
    command,
  });
  return result.status === 'ok' ? result.receipt : undefined;
}

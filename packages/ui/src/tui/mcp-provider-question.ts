import type { Interaction } from '@kite-ai/client';
import { questionForm } from './question';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Presentation only for a persisted question belonging to the exact failed MCP Tool. */
export function isMcpProviderQuestion(card: Interaction, storeId: string, sessionId: string) {
  const value = card.request;
  if (
    card.kind !== 'question' ||
    card.state !== 'pending' ||
    card.originStoreId !== storeId ||
    card.sessionId !== sessionId ||
    typeof card.definitionId !== 'string' ||
    !card.definitionId.startsWith('mcp.') ||
    !object(value) ||
    value.kind !== 'mcp_provider_action' ||
    value.originalStoreId !== storeId ||
    value.sessionId !== sessionId ||
    typeof value.serverId !== 'string' ||
    typeof value.serverName !== 'string' ||
    !object(value.failedTool) ||
    value.failedTool.executionId !== card.executionId ||
    value.failedTool.definitionId !== card.definitionId ||
    value.failedTool.definitionVersion !== card.definitionVersion ||
    !['mcp_oauth_login_required', 'mcp_oauth_reauth_required'].includes(String(value.sourceCode))
  )
    return false;
  const form = questionForm(value);
  const field = form?.fields[0];
  return (
    form?.object === true &&
    form.fields.length === 1 &&
    field?.key === 'action' &&
    field.required &&
    !field.text &&
    field.choices.length === 2 &&
    field.choices[0]?.value === 'login' &&
    field.choices[1]?.value === 'later'
  );
}

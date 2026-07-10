import type { AIMessage } from '@langchain/core/messages';
import { ChatOllama } from '@langchain/ollama';
import type { SupportedChatModel } from './factory';

/**
 * Invoke a bound model without depending on the execution graph.  This module
 * is intentionally graph-free so both the legacy adapter and Kernel executor
 * can share the provider-specific bind behaviour during the migration.
 */
export async function invokeBoundModel(params: {
  model: SupportedChatModel;
  tools: unknown[];
  messages: import('@langchain/core/messages').BaseMessage[];
  signal?: AbortSignal;
}): Promise<AIMessage> {
  const bound =
    params.model instanceof ChatOllama
      ? params.model.bindTools(params.tools as never[])
      : params.model.bindTools(params.tools as never[], { tool_choice: 'auto' });
  return (await bound.invoke(params.messages, { signal: params.signal })) as AIMessage;
}

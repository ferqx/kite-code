import type {
  ListRuntimeLogEventsRequest,
  ListRuntimeLogSessionsRequest,
  RuntimeHistorySessionTranscript,
  RuntimeLogEventPage,
  RuntimeLogSessionPage,
} from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';

export * from './client';
export * from './store';

export const RUNTIME_CLIENT_BOUNDARY_ = Object.freeze({
  frameworkNeutral: true,
  transport: 'logical-message',
  protocolSchema: 'kite.runtime-protocol.v1',
} as const);

export interface RuntimeClientConnection {
  send(message: RuntimeProtocolMessage): Promise<void>;
  messages(): AsyncIterable<unknown>;
  close(reason?: string): Promise<void>;
}

export interface RuntimeClientTransport {
  connect(): Promise<RuntimeClientConnection>;
}

/** App-injected, client-safe durable history; never a generic Store/Event port. */
export interface RuntimeHistoryClient {
  listSessions(request: ListRuntimeLogSessionsRequest): Promise<RuntimeLogSessionPage>;
  listEvents(request: ListRuntimeLogEventsRequest): Promise<RuntimeLogEventPage>;
  /** Complete closed transcript used by local presentation replay. */
  loadSession(sessionId: string): Promise<RuntimeHistorySessionTranscript>;
}

import {
  arrayValue,
  booleanValue,
  type ExactJsonCodec,
  enumValue,
  exactCodec,
  exactObject,
  integerValue,
  invalid,
  type JsonObject,
  optional,
  required,
  safeIdentifier,
  stringValue,
} from './validation';

/**
 * The Web contract is a deliberately separate, read-only browser surface.
 * None of these DTOs carry a Workspace path, Runtime command, credential,
 * Store locator, or raw Runtime event.  Browser authentication material is
 * owned by the Gateway carrier and is not part of this semantic contract.
 */
export const WEB_BOOTSTRAP_REQUEST_SCHEMA_ = 'kite.app.web.bootstrap-request.v1' as const;
export const WEB_BOOTSTRAP_RESPONSE_SCHEMA_ = 'kite.app.web.bootstrap-response.v1' as const;
export const WEB_OBSERVER_CONTRACT_REVISION_ = 'kite-app-web-observer-v2' as const;
export const WEB_TAB_CREATE_REQUEST_SCHEMA_ = 'kite.app.web.tab-create-request.v1' as const;
export const WEB_TAB_CREATE_RESPONSE_SCHEMA_ = 'kite.app.web.tab-create-response.v1' as const;
export const WEB_DIRECTORY_REQUEST_SCHEMA_ = 'kite.app.web.directory-request.v1' as const;
export const WEB_DIRECTORY_RESPONSE_SCHEMA_ = 'kite.app.web.directory-response.v1' as const;
export const WEB_HISTORY_REQUEST_SCHEMA_ = 'kite.app.web.history-request.v1' as const;
export const WEB_HISTORY_RESPONSE_SCHEMA_ = 'kite.app.web.history-response.v1' as const;
export const WEB_LIVE_EVENT_SCHEMA_ = 'kite.app.web.live-event.v1' as const;
/** Live failures use the same closed event schema and a different type. */
export const WEB_STREAM_EVENT_SCHEMA_ = WEB_LIVE_EVENT_SCHEMA_;
export const WEB_SUBSCRIBE_REQUEST_SCHEMA_ = 'kite.app.web.subscribe-request.v1' as const;
export const WEB_SUBSCRIBE_RESPONSE_SCHEMA_ = 'kite.app.web.subscribe-response.v1' as const;
export const WEB_UNSUBSCRIBE_REQUEST_SCHEMA_ = 'kite.app.web.unsubscribe-request.v1' as const;
export const WEB_UNSUBSCRIBE_RESPONSE_SCHEMA_ = 'kite.app.web.unsubscribe-response.v1' as const;
export const WEB_DISCONNECT_REQUEST_SCHEMA_ = 'kite.app.web.disconnect-request.v1' as const;
export const WEB_DISCONNECT_RESPONSE_SCHEMA_ = 'kite.app.web.disconnect-response.v1' as const;

export const WEB_HISTORY_PAGE_MIN_LIMIT = 1;
export const WEB_HISTORY_PAGE_MAX_LIMIT = 200;
export const WEB_MAX_WORKSPACES = 128;
export const WEB_MAX_SESSIONS_PER_WORKSPACE = 256;
export const WEB_MAX_MESSAGE_BLOCKS = 256;

export type WebSessionStatus =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'unavailable';

export type WebMessageRole = 'user' | 'assistant' | 'system';

export type WebToolActivityStatus = 'queued' | 'running';

export type WebPresentationBlock =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string; readonly complete: boolean }
  | {
      readonly kind: 'tool_activity';
      readonly toolId: string;
      readonly label: string;
      readonly status: WebToolActivityStatus;
      readonly summary?: string;
    }
  | {
      readonly kind: 'tool_result';
      readonly toolId: string;
      readonly label: string;
      readonly ok: boolean;
      readonly stdout: string;
      readonly stderr: string;
      /** Present for Shell-like results; non-process tools must not invent an exit code. */
      readonly exitCode?: number;
    }
  | { readonly kind: 'error'; readonly code: string; readonly text: string }
  | { readonly kind: 'status'; readonly status: WebSessionStatus; readonly text?: string };

/**
 * A message is already a display projection.  It is not a Runtime event and
 * contains no transport chunk, arbitrary detail map, path, or credential.
 */
export interface WebPresentationMessage {
  readonly messageId: string;
  readonly sequence: number;
  readonly role: WebMessageRole;
  readonly blocks: readonly WebPresentationBlock[];
}

/** Path-free Workspace grouping used by the left-hand Web session list. */
export interface WebWorkspaceSummary {
  readonly workspaceId: string;
  readonly label: string;
  readonly sessions: readonly WebSessionSummary[];
}

export interface WebSessionSummary {
  readonly sessionId: string;
  readonly displayName: string;
  readonly updatedAt: number;
  readonly lastSequence: number;
  readonly status: WebSessionStatus;
}

export interface WebBootstrapRequest {
  readonly schema: typeof WEB_BOOTSTRAP_REQUEST_SCHEMA_;
}

export interface WebBootstrapResponse {
  readonly schema: typeof WEB_BOOTSTRAP_RESPONSE_SCHEMA_;
  readonly gatewayInstanceId: string;
  readonly contractRevision: string;
}

/** The tab handle is an opaque browser binding, not a Runtime capability. */
export interface WebTabCreateRequest {
  readonly schema: typeof WEB_TAB_CREATE_REQUEST_SCHEMA_;
}

export interface WebTabCreateResponse {
  readonly schema: typeof WEB_TAB_CREATE_RESPONSE_SCHEMA_;
  readonly tabHandle: string;
  readonly connectionGeneration: number;
}

export interface WebDirectoryRequest {
  readonly schema: typeof WEB_DIRECTORY_REQUEST_SCHEMA_;
}

export interface WebDirectoryResponse {
  readonly schema: typeof WEB_DIRECTORY_RESPONSE_SCHEMA_;
  readonly workspaces: readonly WebWorkspaceSummary[];
}

export interface WebHistoryRequest {
  readonly schema: typeof WEB_HISTORY_REQUEST_SCHEMA_;
  readonly sessionId: string;
  readonly cursor?: number;
  readonly limit: number;
}

export interface WebHistoryResponse {
  readonly schema: typeof WEB_HISTORY_RESPONSE_SCHEMA_;
  readonly sessionId: string;
  readonly messages: readonly WebPresentationMessage[];
  readonly nextCursor?: number;
  readonly hasMore: boolean;
  readonly observedLastSequence: number;
}

/** One ordered, browser-safe projection update for a running Session. */
export interface WebLiveEvent {
  readonly schema: typeof WEB_LIVE_EVENT_SCHEMA_;
  readonly type: 'message';
  readonly sessionId: string;
  readonly sequence: number;
  readonly message: WebPresentationMessage;
}

export type WebUnavailableReason =
  | 'gateway_unavailable'
  | 'worker_unavailable'
  | 'history_unavailable'
  | 'session_unavailable'
  | 'subscription_unavailable'
  | 'gateway_draining';

export type WebResyncReason =
  | 'sequence_gap'
  | 'stream_overflow'
  | 'generation_changed'
  | 'history_changed';

/** Typed stream failures contain only a closed low-information reason. */
export type WebObserverStreamEvent =
  | WebLiveEvent
  | {
      readonly schema: typeof WEB_STREAM_EVENT_SCHEMA_;
      readonly type: 'unavailable';
      readonly sessionId: string;
      readonly reason: WebUnavailableReason;
    }
  | {
      readonly schema: typeof WEB_STREAM_EVENT_SCHEMA_;
      readonly type: 'resync_required';
      readonly sessionId: string;
      readonly reason: WebResyncReason;
      readonly afterSequence?: number;
    };

export interface WebSubscribeRequest {
  readonly schema: typeof WEB_SUBSCRIBE_REQUEST_SCHEMA_;
  readonly sessionId: string;
  readonly afterSequence?: number;
}

export interface WebSubscribeResponse {
  readonly schema: typeof WEB_SUBSCRIBE_RESPONSE_SCHEMA_;
  readonly subscriptionId: string;
  readonly sessionId: string;
  readonly liveSequence: number | null;
}

export interface WebUnsubscribeRequest {
  readonly schema: typeof WEB_UNSUBSCRIBE_REQUEST_SCHEMA_;
  readonly subscriptionId: string;
}

export interface WebUnsubscribeResponse {
  readonly schema: typeof WEB_UNSUBSCRIBE_RESPONSE_SCHEMA_;
  readonly subscriptionId: string;
  readonly unsubscribed: boolean;
}

export interface WebDisconnectRequest {
  readonly schema: typeof WEB_DISCONNECT_REQUEST_SCHEMA_;
}

export interface WebDisconnectResponse {
  readonly schema: typeof WEB_DISCONNECT_RESPONSE_SCHEMA_;
  readonly disconnected: boolean;
}

/**
 * Closed Observer-only method surface for a Gateway adapter.  There is no
 * generic call method, and no mutation/controller method can be added through
 * this interface without an explicit contract change.
 */
export interface WebGatewayObserverClient {
  bootstrap(request: WebBootstrapRequest): Promise<WebBootstrapResponse>;
  createTab(request: WebTabCreateRequest): Promise<WebTabCreateResponse>;
  listDirectory(request: WebDirectoryRequest): Promise<WebDirectoryResponse>;
  loadHistory(request: WebHistoryRequest): Promise<WebHistoryResponse>;
  subscribe(request: WebSubscribeRequest): Promise<WebSubscribeResponse>;
  unsubscribe(request: WebUnsubscribeRequest): Promise<WebUnsubscribeResponse>;
  disconnect(request: WebDisconnectRequest): Promise<WebDisconnectResponse>;
}

export const webBootstrapRequestCodec: ExactJsonCodec<WebBootstrapRequest> = exactCodec({
  schema: WEB_BOOTSTRAP_REQUEST_SCHEMA_,
  decode: decodeWebBootstrapRequest,
  encode: encodeWebBootstrapRequest,
});

export const webBootstrapResponseCodec: ExactJsonCodec<WebBootstrapResponse> = exactCodec({
  schema: WEB_BOOTSTRAP_RESPONSE_SCHEMA_,
  decode: decodeWebBootstrapResponse,
  encode: encodeWebBootstrapResponse,
});

export const webTabCreateRequestCodec: ExactJsonCodec<WebTabCreateRequest> = exactCodec({
  schema: WEB_TAB_CREATE_REQUEST_SCHEMA_,
  decode: decodeWebTabCreateRequest,
  encode: encodeWebTabCreateRequest,
});

export const webTabCreateResponseCodec: ExactJsonCodec<WebTabCreateResponse> = exactCodec({
  schema: WEB_TAB_CREATE_RESPONSE_SCHEMA_,
  decode: decodeWebTabCreateResponse,
  encode: encodeWebTabCreateResponse,
});

export const webDirectoryRequestCodec: ExactJsonCodec<WebDirectoryRequest> = exactCodec({
  schema: WEB_DIRECTORY_REQUEST_SCHEMA_,
  decode: decodeWebDirectoryRequest,
  encode: encodeWebDirectoryRequest,
});

export const webDirectoryResponseCodec: ExactJsonCodec<WebDirectoryResponse> = exactCodec({
  schema: WEB_DIRECTORY_RESPONSE_SCHEMA_,
  decode: decodeWebDirectoryResponse,
  encode: encodeWebDirectoryResponse,
});

export const webHistoryRequestCodec: ExactJsonCodec<WebHistoryRequest> = exactCodec({
  schema: WEB_HISTORY_REQUEST_SCHEMA_,
  decode: decodeWebHistoryRequest,
  encode: encodeWebHistoryRequest,
});

export const webHistoryResponseCodec: ExactJsonCodec<WebHistoryResponse> = exactCodec({
  schema: WEB_HISTORY_RESPONSE_SCHEMA_,
  decode: decodeWebHistoryResponse,
  encode: encodeWebHistoryResponse,
});

export const webLiveEventCodec: ExactJsonCodec<WebLiveEvent> = exactCodec({
  schema: WEB_LIVE_EVENT_SCHEMA_,
  decode: decodeWebLiveEvent,
  encode: encodeWebLiveEvent,
});

export const webObserverStreamEventCodec: ExactJsonCodec<WebObserverStreamEvent> = exactCodec({
  schema: WEB_STREAM_EVENT_SCHEMA_,
  decode: decodeWebObserverStreamEvent,
  encode: encodeWebObserverStreamEvent,
});

export const webSubscribeRequestCodec: ExactJsonCodec<WebSubscribeRequest> = exactCodec({
  schema: WEB_SUBSCRIBE_REQUEST_SCHEMA_,
  decode: decodeWebSubscribeRequest,
  encode: encodeWebSubscribeRequest,
});

export const webSubscribeResponseCodec: ExactJsonCodec<WebSubscribeResponse> = exactCodec({
  schema: WEB_SUBSCRIBE_RESPONSE_SCHEMA_,
  decode: decodeWebSubscribeResponse,
  encode: encodeWebSubscribeResponse,
});

export const webUnsubscribeRequestCodec: ExactJsonCodec<WebUnsubscribeRequest> = exactCodec({
  schema: WEB_UNSUBSCRIBE_REQUEST_SCHEMA_,
  decode: decodeWebUnsubscribeRequest,
  encode: encodeWebUnsubscribeRequest,
});

export const webUnsubscribeResponseCodec: ExactJsonCodec<WebUnsubscribeResponse> = exactCodec({
  schema: WEB_UNSUBSCRIBE_RESPONSE_SCHEMA_,
  decode: decodeWebUnsubscribeResponse,
  encode: encodeWebUnsubscribeResponse,
});

export const webDisconnectRequestCodec: ExactJsonCodec<WebDisconnectRequest> = exactCodec({
  schema: WEB_DISCONNECT_REQUEST_SCHEMA_,
  decode: decodeWebDisconnectRequest,
  encode: encodeWebDisconnectRequest,
});

export const webDisconnectResponseCodec: ExactJsonCodec<WebDisconnectResponse> = exactCodec({
  schema: WEB_DISCONNECT_RESPONSE_SCHEMA_,
  decode: decodeWebDisconnectResponse,
  encode: encodeWebDisconnectResponse,
});

function decodeWebBootstrapRequest(input: unknown): WebBootstrapRequest {
  const value = exactObject(input, ['schema'], 'WebBootstrapRequest');
  assertSchema(value, WEB_BOOTSTRAP_REQUEST_SCHEMA_, 'WebBootstrapRequest');
  return { schema: WEB_BOOTSTRAP_REQUEST_SCHEMA_ };
}

function encodeWebBootstrapRequest(value: WebBootstrapRequest): JsonObject {
  return { schema: value.schema };
}

function decodeWebBootstrapResponse(input: unknown): WebBootstrapResponse {
  const value = exactObject(
    input,
    ['contractRevision', 'gatewayInstanceId', 'schema'],
    'WebBootstrapResponse',
  );
  assertSchema(value, WEB_BOOTSTRAP_RESPONSE_SCHEMA_, 'WebBootstrapResponse');
  return {
    schema: WEB_BOOTSTRAP_RESPONSE_SCHEMA_,
    gatewayInstanceId: safeIdentifier(
      required(value, 'gatewayInstanceId', 'WebBootstrapResponse'),
      'WebBootstrapResponse.gatewayInstanceId',
    ),
    contractRevision: safeIdentifier(
      required(value, 'contractRevision', 'WebBootstrapResponse'),
      'WebBootstrapResponse.contractRevision',
    ),
  };
}

function encodeWebBootstrapResponse(value: WebBootstrapResponse): JsonObject {
  return {
    schema: value.schema,
    gatewayInstanceId: value.gatewayInstanceId,
    contractRevision: value.contractRevision,
  };
}

function decodeWebTabCreateRequest(input: unknown): WebTabCreateRequest {
  const value = exactObject(input, ['schema'], 'WebTabCreateRequest');
  assertSchema(value, WEB_TAB_CREATE_REQUEST_SCHEMA_, 'WebTabCreateRequest');
  return { schema: WEB_TAB_CREATE_REQUEST_SCHEMA_ };
}

function encodeWebTabCreateRequest(value: WebTabCreateRequest): JsonObject {
  return { schema: value.schema };
}

function decodeWebTabCreateResponse(input: unknown): WebTabCreateResponse {
  const value = exactObject(
    input,
    ['connectionGeneration', 'schema', 'tabHandle'],
    'WebTabCreateResponse',
  );
  assertSchema(value, WEB_TAB_CREATE_RESPONSE_SCHEMA_, 'WebTabCreateResponse');
  return {
    schema: WEB_TAB_CREATE_RESPONSE_SCHEMA_,
    tabHandle: safeIdentifier(
      required(value, 'tabHandle', 'WebTabCreateResponse'),
      'WebTabCreateResponse.tabHandle',
    ),
    connectionGeneration: integerValue(
      required(value, 'connectionGeneration', 'WebTabCreateResponse'),
      'WebTabCreateResponse.connectionGeneration',
      { min: 1 },
    ),
  };
}

function encodeWebTabCreateResponse(value: WebTabCreateResponse): JsonObject {
  return {
    schema: value.schema,
    tabHandle: value.tabHandle,
    connectionGeneration: value.connectionGeneration,
  };
}

function decodeWebDirectoryRequest(input: unknown): WebDirectoryRequest {
  const value = exactObject(input, ['schema'], 'WebDirectoryRequest');
  assertSchema(value, WEB_DIRECTORY_REQUEST_SCHEMA_, 'WebDirectoryRequest');
  return { schema: WEB_DIRECTORY_REQUEST_SCHEMA_ };
}

function encodeWebDirectoryRequest(value: WebDirectoryRequest): JsonObject {
  return { schema: value.schema };
}

function decodeWebDirectoryResponse(input: unknown): WebDirectoryResponse {
  const value = exactObject(input, ['schema', 'workspaces'], 'WebDirectoryResponse');
  assertSchema(value, WEB_DIRECTORY_RESPONSE_SCHEMA_, 'WebDirectoryResponse');
  return {
    schema: WEB_DIRECTORY_RESPONSE_SCHEMA_,
    workspaces: arrayValue(
      required(value, 'workspaces', 'WebDirectoryResponse'),
      'WebDirectoryResponse.workspaces',
      (entry, index) =>
        decodeWebWorkspaceSummary(entry, `WebDirectoryResponse.workspaces[${index}]`),
      WEB_MAX_WORKSPACES,
    ),
  };
}

function encodeWebDirectoryResponse(value: WebDirectoryResponse): JsonObject {
  return {
    schema: value.schema,
    workspaces: value.workspaces.map(encodeWebWorkspaceSummary),
  };
}

function decodeWebHistoryRequest(input: unknown): WebHistoryRequest {
  const value = exactObject(input, ['cursor', 'limit', 'schema', 'sessionId'], 'WebHistoryRequest');
  assertSchema(value, WEB_HISTORY_REQUEST_SCHEMA_, 'WebHistoryRequest');
  const cursor = optional(value, 'cursor');
  return {
    schema: WEB_HISTORY_REQUEST_SCHEMA_,
    sessionId: safeIdentifier(
      required(value, 'sessionId', 'WebHistoryRequest'),
      'WebHistoryRequest.sessionId',
    ),
    ...(cursor === undefined
      ? {}
      : { cursor: integerValue(cursor, 'WebHistoryRequest.cursor', { min: 0 }) }),
    limit: integerValue(required(value, 'limit', 'WebHistoryRequest'), 'WebHistoryRequest.limit', {
      min: WEB_HISTORY_PAGE_MIN_LIMIT,
      max: WEB_HISTORY_PAGE_MAX_LIMIT,
    }),
  };
}

function encodeWebHistoryRequest(value: WebHistoryRequest): JsonObject {
  return {
    schema: value.schema,
    sessionId: value.sessionId,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
    limit: value.limit,
  };
}

function decodeWebHistoryResponse(input: unknown): WebHistoryResponse {
  const value = exactObject(
    input,
    ['hasMore', 'messages', 'nextCursor', 'observedLastSequence', 'schema', 'sessionId'],
    'WebHistoryResponse',
  );
  assertSchema(value, WEB_HISTORY_RESPONSE_SCHEMA_, 'WebHistoryResponse');
  const nextCursor = optional(value, 'nextCursor');
  const hasMore = booleanValue(
    required(value, 'hasMore', 'WebHistoryResponse'),
    'WebHistoryResponse.hasMore',
  );
  if (hasMore && nextCursor === undefined) {
    invalid('WebHistoryResponse.nextCursor is required when hasMore is true.');
  }
  if (!hasMore && nextCursor !== undefined) {
    invalid('WebHistoryResponse.nextCursor must be omitted when hasMore is false.');
  }
  return {
    schema: WEB_HISTORY_RESPONSE_SCHEMA_,
    sessionId: safeIdentifier(
      required(value, 'sessionId', 'WebHistoryResponse'),
      'WebHistoryResponse.sessionId',
    ),
    messages: arrayValue(
      required(value, 'messages', 'WebHistoryResponse'),
      'WebHistoryResponse.messages',
      (entry, index) =>
        decodeWebPresentationMessage(entry, `WebHistoryResponse.messages[${index}]`),
      WEB_HISTORY_PAGE_MAX_LIMIT,
    ),
    ...(nextCursor === undefined
      ? {}
      : { nextCursor: integerValue(nextCursor, 'WebHistoryResponse.nextCursor', { min: 0 }) }),
    hasMore,
    observedLastSequence: integerValue(
      required(value, 'observedLastSequence', 'WebHistoryResponse'),
      'WebHistoryResponse.observedLastSequence',
      { min: 0 },
    ),
  };
}

function encodeWebHistoryResponse(value: WebHistoryResponse): JsonObject {
  return {
    schema: value.schema,
    sessionId: value.sessionId,
    messages: value.messages.map(encodeWebPresentationMessage),
    ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
    hasMore: value.hasMore,
    observedLastSequence: value.observedLastSequence,
  };
}

function decodeWebLiveEvent(input: unknown): WebLiveEvent {
  const value = exactObject(
    input,
    ['message', 'schema', 'sequence', 'sessionId', 'type'],
    'WebLiveEvent',
  );
  assertSchema(value, WEB_LIVE_EVENT_SCHEMA_, 'WebLiveEvent');
  if (value.type !== 'message') invalid('WebLiveEvent.type must equal message.');
  const sessionId = safeIdentifier(
    required(value, 'sessionId', 'WebLiveEvent'),
    'WebLiveEvent.sessionId',
  );
  const sequence = integerValue(
    required(value, 'sequence', 'WebLiveEvent'),
    'WebLiveEvent.sequence',
    {
      min: 0,
    },
  );
  const message = decodeWebPresentationMessage(
    required(value, 'message', 'WebLiveEvent'),
    'WebLiveEvent.message',
  );
  if (message.sequence !== sequence) invalid('WebLiveEvent.message.sequence must match sequence.');
  return { schema: WEB_LIVE_EVENT_SCHEMA_, type: 'message', sessionId, sequence, message };
}

function encodeWebLiveEvent(value: WebLiveEvent): JsonObject {
  return {
    schema: value.schema,
    type: value.type,
    sessionId: value.sessionId,
    sequence: value.sequence,
    message: encodeWebPresentationMessage(value.message),
  };
}

function decodeWebObserverStreamEvent(input: unknown): WebObserverStreamEvent {
  const value = exactObject(
    input,
    ['afterSequence', 'message', 'reason', 'schema', 'sequence', 'sessionId', 'type'],
    'WebObserverStreamEvent',
  );
  const type = enumValue(
    required(value, 'type', 'WebObserverStreamEvent'),
    'WebObserverStreamEvent.type',
    ['message', 'unavailable', 'resync_required'] as const,
  );
  const sessionId = safeIdentifier(
    required(value, 'sessionId', 'WebObserverStreamEvent'),
    'WebObserverStreamEvent.sessionId',
  );
  if (type === 'message') {
    const messageValue = exactObject(
      input,
      ['message', 'schema', 'sequence', 'sessionId', 'type'],
      'WebObserverStreamEvent',
    );
    const sequence = integerValue(
      required(messageValue, 'sequence', 'WebObserverStreamEvent'),
      'WebObserverStreamEvent.sequence',
      { min: 0 },
    );
    const message = decodeWebPresentationMessage(
      required(messageValue, 'message', 'WebObserverStreamEvent'),
      'WebObserverStreamEvent.message',
    );
    if (message.sequence !== sequence) {
      invalid('WebObserverStreamEvent.message.sequence must match sequence.');
    }
    if (value.schema !== WEB_STREAM_EVENT_SCHEMA_)
      invalid('WebObserverStreamEvent.schema is invalid.');
    return { schema: WEB_STREAM_EVENT_SCHEMA_, type, sessionId, sequence, message };
  }
  if (type === 'unavailable') {
    const unavailableValue = exactObject(
      input,
      ['reason', 'schema', 'sessionId', 'type'],
      'WebObserverStreamEvent',
    );
    const reason = enumValue(
      required(unavailableValue, 'reason', 'WebObserverStreamEvent'),
      'WebObserverStreamEvent.reason',
      [
        'gateway_unavailable',
        'worker_unavailable',
        'history_unavailable',
        'session_unavailable',
        'subscription_unavailable',
        'gateway_draining',
      ] as const,
    );
    if (value.schema !== WEB_STREAM_EVENT_SCHEMA_)
      invalid('WebObserverStreamEvent.schema is invalid.');
    return { schema: WEB_STREAM_EVENT_SCHEMA_, type, sessionId, reason };
  }
  const resyncValue = exactObject(
    input,
    ['afterSequence', 'reason', 'schema', 'sessionId', 'type'],
    'WebObserverStreamEvent',
  );
  const reason = enumValue(
    required(resyncValue, 'reason', 'WebObserverStreamEvent'),
    'WebObserverStreamEvent.reason',
    ['sequence_gap', 'stream_overflow', 'generation_changed', 'history_changed'] as const,
  );
  const afterSequence = optional(resyncValue, 'afterSequence');
  if (value.schema !== WEB_STREAM_EVENT_SCHEMA_)
    invalid('WebObserverStreamEvent.schema is invalid.');
  return {
    schema: WEB_STREAM_EVENT_SCHEMA_,
    type,
    sessionId,
    reason,
    ...(afterSequence === undefined
      ? {}
      : {
          afterSequence: integerValue(afterSequence, 'WebObserverStreamEvent.afterSequence', {
            min: 0,
          }),
        }),
  };
}

function encodeWebObserverStreamEvent(value: WebObserverStreamEvent): JsonObject {
  if (value.type === 'message') {
    return {
      schema: value.schema,
      type: value.type,
      sessionId: value.sessionId,
      sequence: value.sequence,
      message: encodeWebPresentationMessage(value.message),
    };
  }
  return {
    schema: value.schema,
    type: value.type,
    sessionId: value.sessionId,
    reason: value.reason,
    ...(value.type === 'resync_required' && value.afterSequence !== undefined
      ? { afterSequence: value.afterSequence }
      : {}),
  };
}

function decodeWebSubscribeRequest(input: unknown): WebSubscribeRequest {
  const value = exactObject(input, ['afterSequence', 'schema', 'sessionId'], 'WebSubscribeRequest');
  assertSchema(value, WEB_SUBSCRIBE_REQUEST_SCHEMA_, 'WebSubscribeRequest');
  const afterSequence = optional(value, 'afterSequence');
  return {
    schema: WEB_SUBSCRIBE_REQUEST_SCHEMA_,
    sessionId: safeIdentifier(
      required(value, 'sessionId', 'WebSubscribeRequest'),
      'WebSubscribeRequest.sessionId',
    ),
    ...(afterSequence === undefined
      ? {}
      : {
          afterSequence: integerValue(afterSequence, 'WebSubscribeRequest.afterSequence', {
            min: 0,
          }),
        }),
  };
}

function encodeWebSubscribeRequest(value: WebSubscribeRequest): JsonObject {
  return {
    schema: value.schema,
    sessionId: value.sessionId,
    ...(value.afterSequence === undefined ? {} : { afterSequence: value.afterSequence }),
  };
}

function decodeWebSubscribeResponse(input: unknown): WebSubscribeResponse {
  const value = exactObject(
    input,
    ['liveSequence', 'schema', 'sessionId', 'subscriptionId'],
    'WebSubscribeResponse',
  );
  assertSchema(value, WEB_SUBSCRIBE_RESPONSE_SCHEMA_, 'WebSubscribeResponse');
  const liveSequence = required(value, 'liveSequence', 'WebSubscribeResponse');
  return {
    schema: WEB_SUBSCRIBE_RESPONSE_SCHEMA_,
    subscriptionId: safeIdentifier(
      required(value, 'subscriptionId', 'WebSubscribeResponse'),
      'WebSubscribeResponse.subscriptionId',
    ),
    sessionId: safeIdentifier(
      required(value, 'sessionId', 'WebSubscribeResponse'),
      'WebSubscribeResponse.sessionId',
    ),
    liveSequence:
      liveSequence === null
        ? null
        : integerValue(liveSequence, 'WebSubscribeResponse.liveSequence', { min: 0 }),
  };
}

function encodeWebSubscribeResponse(value: WebSubscribeResponse): JsonObject {
  return {
    schema: value.schema,
    subscriptionId: value.subscriptionId,
    sessionId: value.sessionId,
    liveSequence: value.liveSequence,
  };
}

function decodeWebUnsubscribeRequest(input: unknown): WebUnsubscribeRequest {
  const value = exactObject(input, ['schema', 'subscriptionId'], 'WebUnsubscribeRequest');
  assertSchema(value, WEB_UNSUBSCRIBE_REQUEST_SCHEMA_, 'WebUnsubscribeRequest');
  return {
    schema: WEB_UNSUBSCRIBE_REQUEST_SCHEMA_,
    subscriptionId: safeIdentifier(
      required(value, 'subscriptionId', 'WebUnsubscribeRequest'),
      'WebUnsubscribeRequest.subscriptionId',
    ),
  };
}

function encodeWebUnsubscribeRequest(value: WebUnsubscribeRequest): JsonObject {
  return { schema: value.schema, subscriptionId: value.subscriptionId };
}

function decodeWebUnsubscribeResponse(input: unknown): WebUnsubscribeResponse {
  const value = exactObject(
    input,
    ['schema', 'subscriptionId', 'unsubscribed'],
    'WebUnsubscribeResponse',
  );
  assertSchema(value, WEB_UNSUBSCRIBE_RESPONSE_SCHEMA_, 'WebUnsubscribeResponse');
  return {
    schema: WEB_UNSUBSCRIBE_RESPONSE_SCHEMA_,
    subscriptionId: safeIdentifier(
      required(value, 'subscriptionId', 'WebUnsubscribeResponse'),
      'WebUnsubscribeResponse.subscriptionId',
    ),
    unsubscribed: booleanValue(
      required(value, 'unsubscribed', 'WebUnsubscribeResponse'),
      'WebUnsubscribeResponse.unsubscribed',
    ),
  };
}

function encodeWebUnsubscribeResponse(value: WebUnsubscribeResponse): JsonObject {
  return {
    schema: value.schema,
    subscriptionId: value.subscriptionId,
    unsubscribed: value.unsubscribed,
  };
}

function decodeWebDisconnectRequest(input: unknown): WebDisconnectRequest {
  const value = exactObject(input, ['schema'], 'WebDisconnectRequest');
  assertSchema(value, WEB_DISCONNECT_REQUEST_SCHEMA_, 'WebDisconnectRequest');
  return { schema: WEB_DISCONNECT_REQUEST_SCHEMA_ };
}

function encodeWebDisconnectRequest(value: WebDisconnectRequest): JsonObject {
  return { schema: value.schema };
}

function decodeWebDisconnectResponse(input: unknown): WebDisconnectResponse {
  const value = exactObject(input, ['disconnected', 'schema'], 'WebDisconnectResponse');
  assertSchema(value, WEB_DISCONNECT_RESPONSE_SCHEMA_, 'WebDisconnectResponse');
  return {
    schema: WEB_DISCONNECT_RESPONSE_SCHEMA_,
    disconnected: booleanValue(
      required(value, 'disconnected', 'WebDisconnectResponse'),
      'WebDisconnectResponse.disconnected',
    ),
  };
}

function encodeWebDisconnectResponse(value: WebDisconnectResponse): JsonObject {
  return { schema: value.schema, disconnected: value.disconnected };
}

function decodeWebWorkspaceSummary(input: unknown, label: string): WebWorkspaceSummary {
  const value = exactObject(input, ['label', 'sessions', 'workspaceId'], label);
  return {
    workspaceId: safeIdentifier(required(value, 'workspaceId', label), `${label}.workspaceId`),
    label: displayText(required(value, 'label', label), `${label}.label`, 256),
    sessions: arrayValue(
      required(value, 'sessions', label),
      `${label}.sessions`,
      (entry, index) => decodeWebSessionSummary(entry, `${label}.sessions[${index}]`),
      WEB_MAX_SESSIONS_PER_WORKSPACE,
    ),
  };
}

function encodeWebWorkspaceSummary(value: WebWorkspaceSummary): JsonObject {
  return {
    workspaceId: value.workspaceId,
    label: value.label,
    sessions: value.sessions.map(encodeWebSessionSummary),
  };
}

function decodeWebSessionSummary(input: unknown, label: string): WebSessionSummary {
  const value = exactObject(
    input,
    ['displayName', 'lastSequence', 'sessionId', 'status', 'updatedAt'],
    label,
  );
  return {
    sessionId: safeIdentifier(required(value, 'sessionId', label), `${label}.sessionId`),
    displayName: displayText(required(value, 'displayName', label), `${label}.displayName`, 512),
    updatedAt: integerValue(required(value, 'updatedAt', label), `${label}.updatedAt`, { min: 0 }),
    lastSequence: integerValue(required(value, 'lastSequence', label), `${label}.lastSequence`, {
      min: 0,
    }),
    status: enumValue(required(value, 'status', label), `${label}.status`, [
      'idle',
      'running',
      'waiting',
      'completed',
      'cancelled',
      'failed',
      'unavailable',
    ] as const),
  };
}

function encodeWebSessionSummary(value: WebSessionSummary): JsonObject {
  return {
    sessionId: value.sessionId,
    displayName: value.displayName,
    updatedAt: value.updatedAt,
    lastSequence: value.lastSequence,
    status: value.status,
  };
}

function decodeWebPresentationMessage(input: unknown, label: string): WebPresentationMessage {
  const value = exactObject(input, ['blocks', 'messageId', 'role', 'sequence'], label);
  return {
    messageId: safeIdentifier(required(value, 'messageId', label), `${label}.messageId`),
    sequence: integerValue(required(value, 'sequence', label), `${label}.sequence`, { min: 0 }),
    role: enumValue(required(value, 'role', label), `${label}.role`, [
      'user',
      'assistant',
      'system',
    ] as const),
    blocks: arrayValue(
      required(value, 'blocks', label),
      `${label}.blocks`,
      (entry, index) => decodeWebPresentationBlock(entry, `${label}.blocks[${index}]`),
      WEB_MAX_MESSAGE_BLOCKS,
    ),
  };
}

function encodeWebPresentationMessage(value: WebPresentationMessage): JsonObject {
  return {
    messageId: value.messageId,
    sequence: value.sequence,
    role: value.role,
    blocks: value.blocks.map(encodeWebPresentationBlock),
  };
}

function decodeWebPresentationBlock(input: unknown, label: string): WebPresentationBlock {
  if (!isObjectWithKind(input)) invalid(`${label} must be a presentation block.`);
  const kind = enumValue(input.kind, `${label}.kind`, [
    'text',
    'thinking',
    'tool_activity',
    'tool_result',
    'error',
    'status',
  ] as const);
  switch (kind) {
    case 'text': {
      const value = exactObject(input, ['kind', 'text'], label);
      return { kind, text: displayText(required(value, 'text', label), `${label}.text`, 65_536) };
    }
    case 'thinking': {
      const value = exactObject(input, ['complete', 'kind', 'text'], label);
      return {
        kind,
        text: displayText(required(value, 'text', label), `${label}.text`, 65_536),
        complete: booleanValue(required(value, 'complete', label), `${label}.complete`),
      };
    }
    case 'tool_activity': {
      const value = exactObject(input, ['kind', 'label', 'status', 'summary', 'toolId'], label);
      const summary = optional(value, 'summary');
      return {
        kind,
        toolId: safeIdentifier(required(value, 'toolId', label), `${label}.toolId`),
        label: displayText(required(value, 'label', label), `${label}.label`, 256),
        status: enumValue(required(value, 'status', label), `${label}.status`, [
          'queued',
          'running',
        ] as const),
        ...(summary === undefined
          ? {}
          : { summary: displayText(summary, `${label}.summary`, 8_192) }),
      };
    }
    case 'tool_result': {
      const value = exactObject(
        input,
        ['exitCode', 'kind', 'label', 'ok', 'stderr', 'stdout', 'toolId'],
        label,
      );
      const exitCode = optional(value, 'exitCode');
      return {
        kind,
        toolId: safeIdentifier(required(value, 'toolId', label), `${label}.toolId`),
        label: displayText(required(value, 'label', label), `${label}.label`, 256),
        ok: booleanValue(required(value, 'ok', label), `${label}.ok`),
        stdout: outputText(required(value, 'stdout', label), `${label}.stdout`),
        stderr: outputText(required(value, 'stderr', label), `${label}.stderr`),
        ...(exitCode === undefined
          ? {}
          : { exitCode: integerValue(exitCode, `${label}.exitCode`) }),
      };
    }
    case 'error': {
      const value = exactObject(input, ['code', 'kind', 'text'], label);
      return {
        kind,
        code: safeIdentifier(required(value, 'code', label), `${label}.code`, 128),
        text: displayText(required(value, 'text', label), `${label}.text`, 8_192),
      };
    }
    case 'status': {
      const value = exactObject(input, ['kind', 'status', 'text'], label);
      const text = optional(value, 'text');
      return {
        kind,
        status: enumValue(required(value, 'status', label), `${label}.status`, [
          'idle',
          'running',
          'waiting',
          'completed',
          'cancelled',
          'failed',
          'unavailable',
        ] as const),
        ...(text === undefined ? {} : { text: displayText(text, `${label}.text`, 8_192) }),
      };
    }
  }
}

function encodeWebPresentationBlock(value: WebPresentationBlock): JsonObject {
  switch (value.kind) {
    case 'text':
      return { kind: value.kind, text: value.text };
    case 'thinking':
      return { kind: value.kind, text: value.text, complete: value.complete };
    case 'tool_activity':
      return {
        kind: value.kind,
        toolId: value.toolId,
        label: value.label,
        status: value.status,
        ...(value.summary === undefined ? {} : { summary: value.summary }),
      };
    case 'tool_result':
      return {
        kind: value.kind,
        toolId: value.toolId,
        label: value.label,
        ok: value.ok,
        stdout: value.stdout,
        stderr: value.stderr,
        ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
      };
    case 'error':
      return { kind: value.kind, code: value.code, text: value.text };
    case 'status':
      return {
        kind: value.kind,
        status: value.status,
        ...(value.text === undefined ? {} : { text: value.text }),
      };
  }
}

function isObjectWithKind(input: unknown): input is JsonObject & { readonly kind: unknown } {
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    Object.hasOwn(input, 'kind')
  );
}

function displayText(value: unknown, label: string, maximum: number): string {
  const result = stringValue(value, label, { min: 1, max: maximum });
  if (
    [...result].some(
      (character) =>
        /\p{Cc}/u.test(character) && character !== '\n' && character !== '\r' && character !== '\t',
    )
  ) {
    invalid(`${label} contains a forbidden control character.`);
  }
  return result;
}

function outputText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 65_536) {
    invalid(`${label} must contain 0-65536 UTF-16 code units.`);
  }
  if (
    [...value].some(
      (character) =>
        /\p{Cc}/u.test(character) && character !== '\n' && character !== '\r' && character !== '\t',
    )
  ) {
    invalid(`${label} contains a forbidden control character.`);
  }
  return value;
}

function assertSchema(value: JsonObject, expected: string, label: string): void {
  if (value.schema !== expected) invalid(`${label}.schema must equal ${expected}.`);
}

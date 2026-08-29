import { z } from 'zod';
import { RUNTIME_PROTOCOL_MESSAGE_SCHEMA_ } from './codecs';
import { RUNTIME_PROTOCOL_SCHEMA } from './limits';

export interface RuntimeProtocolGeneratedArtifacts {
  readonly schema: typeof RUNTIME_PROTOCOL_SCHEMA;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly typeScript: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',') +
    '}'
  );
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Stable, browser-safe generation surface for checked-in or external tooling. */
export function generateRuntimeProtocolArtifacts(): RuntimeProtocolGeneratedArtifacts {
  return Object.freeze({
    schema: RUNTIME_PROTOCOL_SCHEMA,
    jsonSchema: Object.freeze(
      z.toJSONSchema(RUNTIME_PROTOCOL_MESSAGE_SCHEMA_) as Record<string, unknown>,
    ),
    typeScript: generateRuntimeProtocolTypeScript(),
  });
}

/** A canonical checked-in drift sentinel for generated schema and declarations. */
export function generateRuntimeProtocolArtifactDigest(): string {
  const artifacts = generateRuntimeProtocolArtifacts();
  return `${fingerprint(canonicalJson(artifacts.jsonSchema))}:${fingerprint(artifacts.typeScript)}`;
}

/**
 * A standalone, generated request declaration for schema consumers.  It is
 * intentionally a discriminated union: method and params must stay paired,
 * just as they are in the runtime codec.  Runtime validation remains the
 * authority for string, depth, and collection bounds that TypeScript cannot
 * express.
 */
export function generateRuntimeProtocolTypeScript(): string {
  return [
    'export type RuntimeProtocolIdentifier = string;',
    'export type RuntimeProtocolRevision = number;',
    "export type RuntimeProtocolToolPresentation = 'exploration' | 'standalone' | 'hidden';",
    'export type RuntimeProtocolToolResult = {',
    '  readonly ok: boolean;',
    '  readonly exitCode: number;',
    '  readonly stdout: string;',
    '  readonly stderr: string;',
    "  readonly status?: 'success' | 'error' | 'exhausted';",
    '  readonly totalLines?: RuntimeProtocolRevision;',
    '  readonly toolTokenCount?: RuntimeProtocolRevision;',
    "  readonly terminationReason?: 'timed_out' | 'cancelled' | 'sandbox_denied';",
    '};',
    'export type RuntimeProtocolJsonValue =',
    '  | string',
    '  | number',
    '  | boolean',
    '  | null',
    '  | readonly RuntimeProtocolJsonValue[]',
    '  | { readonly [key: string]: RuntimeProtocolJsonValue };',
    'export type RuntimeProtocolToolQueuedEvent = {',
    "  readonly type: 'tool.queued';",
    '  readonly toolId: RuntimeProtocolIdentifier;',
    '  readonly presentationGroupId?: RuntimeProtocolIdentifier;',
    '  readonly presentation: RuntimeProtocolToolPresentation;',
    '  readonly displayLabel?: string;',
    '  readonly arguments: { readonly [key: string]: RuntimeProtocolJsonValue };',
    '  readonly summary: string;',
    '};',
    'export type RuntimeProtocolToolFinishedEvent = {',
    "  readonly type: 'tool.finished';",
    '  readonly toolId: RuntimeProtocolIdentifier;',
    '  readonly presentation: RuntimeProtocolToolPresentation;',
    '  readonly displayLabel?: string;',
    '  readonly result: RuntimeProtocolToolResult;',
    '  readonly summary: string;',
    '};',
    'export type RuntimeProtocolReasoningActivity = {',
    "  readonly type: 'reasoning.activity';",
    '  readonly requestId: RuntimeProtocolIdentifier;',
    "  readonly state: 'streaming' | 'completed';",
    '  readonly segmentId: RuntimeProtocolIdentifier;',
    '  readonly text: string;',
    '};',
    'export type RuntimeProtocolModelTextDeltaEvent = {',
    "  readonly type: 'model.text_delta';",
    '  readonly requestId: RuntimeProtocolIdentifier;',
    '  readonly text: string;',
    '};',
    'export type RuntimeProtocolModelRespondedEvent = {',
    "  readonly type: 'model.responded';",
    '  readonly requestId: RuntimeProtocolIdentifier;',
    '  readonly messageId: RuntimeProtocolIdentifier;',
    '  readonly toolCallCount: RuntimeProtocolRevision;',
    '  readonly durationMs?: RuntimeProtocolRevision;',
    '  readonly summary?: string;',
    '};',
    'export type RuntimeProtocolSubagentStepEvent = {',
    "  readonly type: 'subagent.step';",
    '  readonly subagentId: RuntimeProtocolIdentifier;',
    '  readonly toolName: string;',
    "  readonly status: 'started' | 'completed' | 'failed';",
    '  readonly displayLabel?: string;',
    '  readonly arguments?: { readonly [key: string]: RuntimeProtocolJsonValue };',
    '  readonly result?: { readonly ok: boolean };',
    '  readonly totalLines?: RuntimeProtocolRevision;',
    '  readonly durationMs?: RuntimeProtocolRevision;',
    '  readonly summary?: string;',
    '};',
    '',
    'export type RuntimeProtocolApprovalInteraction = {',
    "  readonly kind: 'approval';",
    '  readonly interactionId: RuntimeProtocolIdentifier;',
    '  readonly sessionRevision: RuntimeProtocolRevision;',
    '  readonly title?: string;',
    '  readonly summary?: string;',
    '  readonly generation: RuntimeProtocolRevision;',
    "  readonly grants: readonly ('approve_once' | 'same_command')[];",
    '  readonly command?: string;',
    '};',
    'export type RuntimeProtocolInputInteraction = {',
    "  readonly kind: 'input';",
    '  readonly interactionId: RuntimeProtocolIdentifier;',
    '  readonly sessionRevision: RuntimeProtocolRevision;',
    '  readonly title?: string;',
    '  readonly summary?: string;',
    '  readonly question: string;',
    '  readonly allowFreeText: boolean;',
    '  readonly options?: readonly {',
    '    readonly id: RuntimeProtocolIdentifier;',
    '    readonly label: string;',
    '    readonly description?: string;',
    '  }[];',
    '};',
    'export type RuntimeProtocolPlanReviewInteraction = {',
    "  readonly kind: 'plan_review';",
    '  readonly interactionId: RuntimeProtocolIdentifier;',
    '  readonly sessionRevision: RuntimeProtocolRevision;',
    '  readonly title?: string;',
    '  readonly summary?: string;',
    '  readonly plan: {',
    '    readonly planId: RuntimeProtocolIdentifier;',
    '    readonly version: RuntimeProtocolRevision;',
    '    readonly structuralDigest: RuntimeProtocolIdentifier;',
    '  };',
    '};',
    'export type RuntimeProtocolProviderActionInteraction = {',
    "  readonly kind: 'provider_action';",
    '  readonly interactionId: RuntimeProtocolIdentifier;',
    '  readonly sessionRevision: RuntimeProtocolRevision;',
    '  readonly title?: string;',
    '  readonly summary?: string;',
    '  readonly provider: {',
    '    readonly providerId: RuntimeProtocolIdentifier;',
    '    readonly directoryRevision?: RuntimeProtocolIdentifier;',
    '  };',
    "  readonly action: 'login' | 'approve' | 'retry';",
    '};',
    'export type RuntimeProtocolVerificationInteraction = {',
    "  readonly kind: 'verification';",
    '  readonly interactionId: RuntimeProtocolIdentifier;',
    '  readonly sessionRevision: RuntimeProtocolRevision;',
    '  readonly title?: string;',
    '  readonly summary?: string;',
    '  readonly verification: {',
    '    readonly verificationId: RuntimeProtocolIdentifier;',
    '    readonly revision: RuntimeProtocolIdentifier;',
    '  };',
    '};',
    '',
    'export type RuntimeProtocolCommand =',
    "  | { readonly schema: 'kite.runtime-command.v1'; readonly commandId: RuntimeProtocolIdentifier; readonly type: 'create_session'; readonly bootstrapSessionId?: RuntimeProtocolIdentifier }",
    "  | { readonly schema: 'kite.runtime-command.v1'; readonly commandId: RuntimeProtocolIdentifier; readonly type: 'resume_session'; readonly sessionId: RuntimeProtocolIdentifier; readonly afterRevision?: RuntimeProtocolRevision }",
    "  | { readonly schema: 'kite.runtime-command.v1'; readonly commandId: RuntimeProtocolIdentifier; readonly type: 'start_turn'; readonly sessionId: RuntimeProtocolIdentifier; readonly expectedRevision: RuntimeProtocolRevision; readonly input: string; readonly phase?: 'planning' | 'building'; readonly initialSkills?: readonly { readonly skillId: RuntimeProtocolIdentifier; readonly input: { readonly [key: string]: RuntimeProtocolJsonValue } }[] }",
    "  | { readonly schema: 'kite.runtime-command.v1'; readonly commandId: RuntimeProtocolIdentifier; readonly type: 'cancel_turn'; readonly sessionId: RuntimeProtocolIdentifier; readonly expectedRevision: RuntimeProtocolRevision; readonly turnId: RuntimeProtocolIdentifier; readonly runId?: RuntimeProtocolIdentifier }",
    "  | { readonly schema: 'kite.runtime-command.v1'; readonly commandId: RuntimeProtocolIdentifier; readonly type: 'respond_interaction'; readonly sessionId: RuntimeProtocolIdentifier; readonly expectedRevision: RuntimeProtocolRevision; readonly interaction: RuntimeProtocolInputInteraction; readonly response: { readonly kind: 'text'; readonly value: string } | { readonly kind: 'input_cancel' } }",
    "  | { readonly schema: 'kite.runtime-command.v1'; readonly commandId: RuntimeProtocolIdentifier; readonly type: 'respond_interaction'; readonly sessionId: RuntimeProtocolIdentifier; readonly expectedRevision: RuntimeProtocolRevision; readonly interaction: RuntimeProtocolApprovalInteraction; readonly response: { readonly kind: 'approval'; readonly decision: 'approve_once' | 'same_command' | 'reject' } }",
    "  | { readonly schema: 'kite.runtime-command.v1'; readonly commandId: RuntimeProtocolIdentifier; readonly type: 'respond_interaction'; readonly sessionId: RuntimeProtocolIdentifier; readonly expectedRevision: RuntimeProtocolRevision; readonly interaction: RuntimeProtocolPlanReviewInteraction; readonly response: { readonly kind: 'plan_review'; readonly decision: 'auto' | 'accept_edits' | 'feedback' | 'cancel'; readonly feedback?: string } }",
    "  | { readonly schema: 'kite.runtime-command.v1'; readonly commandId: RuntimeProtocolIdentifier; readonly type: 'respond_interaction'; readonly sessionId: RuntimeProtocolIdentifier; readonly expectedRevision: RuntimeProtocolRevision; readonly interaction: RuntimeProtocolProviderActionInteraction; readonly response: { readonly kind: 'provider_action'; readonly outcome: 'completed' | 'deferred' | 'cancelled'; readonly detail?: string } }",
    "  | { readonly schema: 'kite.runtime-command.v1'; readonly commandId: RuntimeProtocolIdentifier; readonly type: 'respond_interaction'; readonly sessionId: RuntimeProtocolIdentifier; readonly expectedRevision: RuntimeProtocolRevision; readonly interaction: RuntimeProtocolVerificationInteraction; readonly response: { readonly kind: 'verification'; readonly decision: 'replan' | 'waive' | 'compensate'; readonly detail: string } }",
    "  | { readonly schema: 'kite.runtime-command.v1'; readonly commandId: RuntimeProtocolIdentifier; readonly type: 'set_interaction_mode'; readonly sessionId: RuntimeProtocolIdentifier; readonly expectedRevision: RuntimeProtocolRevision; readonly mode: 'accept_edits' | 'auto' | 'full' }",
    "  | { readonly schema: 'kite.runtime-command.v1'; readonly commandId: RuntimeProtocolIdentifier; readonly type: 'compact_session'; readonly sessionId: RuntimeProtocolIdentifier; readonly expectedRevision: RuntimeProtocolRevision; readonly mode: 'manual' | 'reset'; readonly instructions?: string }",
    "  | { readonly schema: 'kite.runtime-command.v1'; readonly commandId: RuntimeProtocolIdentifier; readonly type: 'rewind_session'; readonly sessionId: RuntimeProtocolIdentifier; readonly expectedRevision: RuntimeProtocolRevision; readonly checkpointId: RuntimeProtocolIdentifier; readonly scope: 'conversation_only' | 'conversation_and_workspace' | 'code_only' }",
    "  | { readonly schema: 'kite.runtime-command.v1'; readonly commandId: RuntimeProtocolIdentifier; readonly type: 'fork_session'; readonly sourceSessionId: RuntimeProtocolIdentifier; readonly sourceRevision: RuntimeProtocolRevision; readonly checkpointId?: RuntimeProtocolIdentifier }",
    "  | { readonly schema: 'kite.runtime-command.v1'; readonly commandId: RuntimeProtocolIdentifier; readonly type: 'close_session'; readonly sessionId: RuntimeProtocolIdentifier; readonly expectedRevision: RuntimeProtocolRevision }",
    "  | { readonly schema: 'kite.runtime-command.v1'; readonly commandId: RuntimeProtocolIdentifier; readonly type: 'clear_session_command_grants'; readonly sessionId: RuntimeProtocolIdentifier; readonly expectedRevision: RuntimeProtocolRevision }",
    "  | { readonly schema: 'kite.runtime-command.v1'; readonly commandId: RuntimeProtocolIdentifier; readonly type: 'delete_session'; readonly sessionId: RuntimeProtocolIdentifier; readonly expectedRevision: RuntimeProtocolRevision };",
    '',
    'export type RuntimeProtocolQuery =',
    "  | { readonly schema: 'kite.runtime-query.v1'; readonly type: 'list_sessions' }",
    "  | { readonly schema: 'kite.runtime-query.v1'; readonly type: 'get_session_projection'; readonly sessionId: RuntimeProtocolIdentifier }",
    "  | { readonly schema: 'kite.runtime-query.v1'; readonly type: 'get_context_status'; readonly sessionId: RuntimeProtocolIdentifier }",
    "  | { readonly schema: 'kite.runtime-query.v1'; readonly type: 'list_checkpoints'; readonly sessionId: RuntimeProtocolIdentifier }",
    "  | { readonly schema: 'kite.runtime-query.v1'; readonly type: 'get_rewind_preview'; readonly sessionId: RuntimeProtocolIdentifier; readonly checkpointId: RuntimeProtocolIdentifier }",
    "  | { readonly schema: 'kite.runtime-query.v1'; readonly type: 'get_run'; readonly sessionId: RuntimeProtocolIdentifier; readonly runId: RuntimeProtocolIdentifier }",
    "  | { readonly schema: 'kite.runtime-query.v1'; readonly type: 'list_runs'; readonly sessionId: RuntimeProtocolIdentifier; readonly status?: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown'; readonly phase?: 'planning' | 'building'; readonly cursor?: { readonly createdRevision: RuntimeProtocolRevision; readonly runId: RuntimeProtocolIdentifier }; readonly limit: RuntimeProtocolRevision };",
    '',
    'export type RuntimeProtocolSubscriptionSpec =',
    "  | { readonly scope: 'session'; readonly sessionId: RuntimeProtocolIdentifier; readonly afterRevision?: RuntimeProtocolRevision; readonly includeEphemeral?: boolean }",
    "  | { readonly scope: 'sessions' };",
    '',
    'export type RuntimeProtocolRequest =',
    "  | { readonly jsonrpc: '2.0'; readonly id: string; readonly method: 'initialize'; readonly params: { readonly protocolVersion: 1; readonly clientInfo: { readonly name: string; readonly version: string; readonly instanceId: RuntimeProtocolIdentifier } } }",
    "  | { readonly jsonrpc: '2.0'; readonly id: string; readonly method: 'runtime/command'; readonly params: { readonly command: RuntimeProtocolCommand } }",
    "  | { readonly jsonrpc: '2.0'; readonly id: string; readonly method: 'runtime/query'; readonly params: { readonly query: RuntimeProtocolQuery } }",
    "  | { readonly jsonrpc: '2.0'; readonly id: string; readonly method: 'runtime/subscribe'; readonly params: { readonly subscription: RuntimeProtocolSubscriptionSpec } }",
    "  | { readonly jsonrpc: '2.0'; readonly id: string; readonly method: 'runtime/unsubscribe'; readonly params: { readonly subscriptionId: RuntimeProtocolIdentifier } }",
    "  | { readonly jsonrpc: '2.0'; readonly id: string; readonly method: 'server/ping'; readonly params: Readonly<Record<string, never>> };",
    "export type RuntimeProtocolSchema = 'kite.runtime-protocol.v1';",
    '',
  ].join('\n');
}

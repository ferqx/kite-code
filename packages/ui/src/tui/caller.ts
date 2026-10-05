import type { Command, canonicalCallerCommandRequest } from '@kite-ai/client';
import type { TuiDraftScope } from './drafts';
export type TuiCallerRequest = Parameters<typeof canonicalCallerCommandRequest>[0];
export type TuiCallerIntent = Readonly<{
  scope: TuiDraftScope;
  request: TuiCallerRequest;
  subjectId: string;
  bodyDigest: string;
  target: Readonly<{
    kind: 'session' | 'run' | 'after_run' | 'command' | 'execution';
    id: string | null;
    contextSelectionId?: string;
  }>;
  requestDigest: string;
  draft?: Readonly<{ id: string; revision: string; textDigest: string }>;
}>;
export type TuiCallerRecord = Readonly<{
  intent: TuiCallerIntent;
  phase: 'submitting' | 'unknown' | 'accepted' | 'applied' | 'rejected';
}>;
/** Host owns bytes, profile lease, durable publication and original HTTP request.
 * applied confirms the Command only; it does not confirm an authentication effect. */
export type TuiCallerOutcome = TuiCallerRecord & Readonly<{ command?: Command; error?: string }>;
export interface TuiCallerPort {
  list(): Promise<readonly TuiCallerRecord[]>;
  prepare(scope: TuiDraftScope, request: TuiCallerRequest): Promise<TuiCallerIntent>;
  submit(intent: TuiCallerIntent): Promise<TuiCallerOutcome>;
  lookup(intent: TuiCallerIntent, signal: AbortSignal): Promise<TuiCallerOutcome>;
  clear(intent: TuiCallerIntent): Promise<void>;
}
export function callerTarget(
  scope: TuiDraftScope,
  request: TuiCallerRequest,
): TuiCallerIntent['target'] {
  switch (request.kind) {
    case 'extension.invoke':
    case 'run.start':
      return { kind: 'session', id: scope.sessionId };
    case 'input.steer':
      return {
        kind: 'run',
        id: request.targetRunId,
        contextSelectionId: request.contextSelectionId,
      };
    case 'input.follow_up':
      return {
        kind: 'after_run',
        id: request.afterRunId,
        contextSelectionId: request.contextSelectionId,
      };
    case 'command.cancel':
      return { kind: 'command', id: request.targetCommandId };
    case 'execution.cancel':
      return { kind: 'execution', id: request.executionId };
  }
}
export function callerKey(intent: TuiCallerIntent) {
  return JSON.stringify([intent.scope.storeId, intent.scope.sessionId, intent.request.commandId]);
}

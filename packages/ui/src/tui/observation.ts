import type { Change, SessionView } from '@kite-ai/client';
import type { TuiSnapshot } from './controller';
import { permissionChangeAffectsSession } from './permissions';

export const tuiReadDomains = [
  'execution',
  'history',
  'admission',
  'display',
  'models',
  'progress',
  'live',
  'jobs',
  'labels',
  'metadata',
] as const;
export type TuiReadDomain = (typeof tuiReadDomains)[number];
export type TuiDomainState = {
  readonly phase: 'fresh' | 'refreshing' | 'unavailable';
  readonly cursor?: string;
  readonly error?: string;
};
type Environment = NonNullable<TuiSnapshot['environment']>;
export type TuiDomainUpdate =
  | {
      domain: 'execution';
      facts: Pick<TuiSnapshot, 'view' | 'connectionInstanceId' | 'activityOwner'>;
    }
  | { domain: 'history'; messages: TuiSnapshot['messages']; cursor: string }
  | {
      domain: 'admission';
      source: SessionView;
      facts: Pick<
        TuiSnapshot,
        'interactions' | 'activeCommand' | 'pendingInputs' | 'pendingInputsUnavailable'
      >;
      permissionMode?: Environment['permissionMode'];
    }
  | {
      domain: 'display';
      facts: Pick<TuiSnapshot, 'executionTimings'>;
      environment: Pick<Environment, 'runtimeModel' | 'context' | 'nextContext' | 'usage'>;
    }
  | { domain: 'models'; environment: Pick<Environment, 'modelId' | 'modelName' | 'effort'> }
  | { domain: 'progress'; facts: Pick<TuiSnapshot, 'planProgress' | 'compactionPhase'> }
  | { domain: 'live'; facts: Pick<TuiSnapshot, 'liveModelOutput'> }
  | { domain: 'jobs'; facts: Pick<TuiSnapshot, 'jobTails' | 'childViews'> }
  | { domain: 'labels'; facts: Pick<TuiSnapshot, 'toolLabels'> }
  | { domain: 'metadata'; sessionId: string; title: string };

/** These are dependencies of write targets, not a global event watermark. */
export function tuiAdmissionTarget(view: SessionView): string {
  return JSON.stringify([
    view.storeId,
    view.session.id,
    view.session.workspaceId,
    view.session.controlRevision,
    view.session.contextSelectionId,
    view.runs.filter((run) => run.isActive),
  ]);
}

/** Only exact current/child/control scopes invalidate the selected observation. */
export function tuiChangeDomains(
  change: Change,
  snapshot: TuiSnapshot,
  messageChanges: boolean,
): readonly TuiReadDomain[] {
  if (permissionChangeAffectsSession(change, snapshot.view, snapshot.storeId)) return ['admission'];
  if (change.type.endsWith('.history_collected')) return tuiReadDomains;
  if (change.type === 'host_control.changed') {
    const payload = change.payload;
    if (
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      ['permission.mode', 'workspace.trust'].includes(String(payload.kind))
    )
      return [];
    return change.sessionId === null || change.sessionId === snapshot.view.session.id
      ? tuiReadDomains
      : [];
  }
  if (snapshot.childViews?.some((child) => child.view.session.id === change.sessionId))
    return ['jobs'];
  if (change.sessionId !== snapshot.view.session.id) {
    return change.sessionId === null ? tuiReadDomains : [];
  }
  switch (change.type) {
    case 'message.updated':
      return ['history', 'live', 'display'];
    case 'session.renamed':
      return ['metadata'];
    case 'execution.planned':
    case 'execution.dispatching':
    case 'execution.running':
    case 'execution.finished':
      return [
        'execution',
        ...(messageChanges ? ['history' as const] : []),
        'display',
        'progress',
        'live',
        'jobs',
        'labels',
      ];
    case 'run.started':
    case 'run.finished':
      return ['execution', 'history', 'admission', 'display', 'progress', 'live', 'jobs'];
    case 'interaction.requested':
    case 'interaction.answered':
    case 'interaction.accepted':
    case 'interaction.cancelled':
    case 'command.accepted':
    case 'command.settled':
    case 'input.applied':
      return ['execution', 'admission', 'history'];
    case 'context.selected':
    case 'context.result_included':
      return ['execution', 'admission', 'history', 'display'];
    default:
      return tuiReadDomains;
  }
}

/** Apply only the domain's owned fields; a slow reader cannot roll back another domain. */
export function mergeTuiDomain(base: TuiSnapshot, update: TuiDomainUpdate): TuiSnapshot {
  switch (update.domain) {
    case 'metadata':
      return {
        ...base,
        view: { ...base.view, session: { ...base.view.session, title: update.title } },
      };
    case 'history':
      return { ...base, messages: update.messages };
    case 'admission':
      return {
        ...base,
        ...update.facts,
        ...(base.environment
          ? { environment: { ...base.environment, permissionMode: update.permissionMode } }
          : {}),
      };
    case 'models':
    case 'display':
      return {
        ...base,
        ...(update.domain === 'display' ? update.facts : {}),
        ...(base.environment
          ? { environment: { ...base.environment, ...update.environment } }
          : {}),
      };
    default:
      return { ...base, ...update.facts };
  }
}

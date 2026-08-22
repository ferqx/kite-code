import type { AgentPlan, PlanArtifactRef, PlanDocument } from '@kite/runtime-contract';
import {
  runtimeHostState25ActivePlanningV1 as getActivePlanning,
  restoreRuntimeHostState25SessionV1,
} from '@kite/runtime-host';
import type { RuntimeSessionInfoV1 as RuntimeSessionInfo } from '@kite/runtime-host/storage';
import type { RuntimeEvent, RuntimeState, State25SessionStorageV1 } from './state25-runtime';

export type OpenState25SessionStorageV1 = (threadId?: string) => State25SessionStorageV1;

/** Project the durable PlanDocument into the App-facing review shape. */
function planDocumentToAgentPlan(doc: PlanDocument): AgentPlan {
  return {
    name: doc.title,
    description: doc.bodyMarkdown,
    status: 'in_progress',
    steps: doc.steps.map((s) => ({
      step: s.title,
      status: s.status as 'pending' | 'in_progress' | 'completed',
    })),
  };
}

export interface SessionInfo {
  threadId: string;
  name: string;
  updatedAt: string;
  needsSmartName: boolean;
}

export interface ReplayInterrupt {
  kind: 'approval' | 'input' | 'plan_review';
  callId?: string;
  plan?: AgentPlan;
  artifact?: PlanArtifactRef;
}

export interface SessionData {
  threadId: string;
  messages: unknown[];
  runtimeEvents: RuntimeEvent[];
  interrupt: ReplayInterrupt | null;
  modelProvider: string;
  modelName: string;
  thinkingLevel: string | null;
  plan: AgentPlan | null;
  planAuthMode: string | null;
}

export function formatLocalDateTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return '(unknown)';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function mapSession(info: RuntimeSessionInfo): SessionInfo {
  return {
    threadId: info.threadId,
    name: info.name,
    updatedAt: formatLocalDateTime(info.updatedAt),
    needsSmartName: info.needsSmartName,
  };
}

export async function listSessions(
  openState25SessionStorage: OpenState25SessionStorageV1,
): Promise<SessionInfo[]> {
  const store = openState25SessionStorage();
  try {
    return store.listSessions().map(mapSession);
  } finally {
    store.close();
  }
}

export async function searchSessions(
  openState25SessionStorage: OpenState25SessionStorageV1,
  query: string,
): Promise<SessionInfo[]> {
  const store = openState25SessionStorage();
  try {
    return store.listSessions(query).map(mapSession);
  } finally {
    store.close();
  }
}

export async function loadSession(
  openState25SessionStorage: OpenState25SessionStorageV1,
  threadId: string,
  recoveryIdentityKey: string,
): Promise<SessionData | null> {
  const store = openState25SessionStorage(threadId);
  try {
    const snapshot = store.loadSnapshotRecord<RuntimeState>(threadId);
    const lastEventPosition = store.getLastEventPosition(threadId);
    if (!snapshot && lastEventPosition === 0) return null;
    const restored = restoreRuntimeHostState25SessionV1({
      sessions: store,
      sessionId: threadId,
      userId: 'tui',
      workspace: snapshot?.state.session.workspace ?? '.',
      turnId: snapshot?.state.turn.turnId ?? 'session-load',
      recoveryIdentityKey,
    });
    const { state } = restored;
    if (state.recoveryState.kind !== 'normal') {
      throw new Error(`Runtime session ${threadId} is unavailable: ${state.recoveryState.kind}.`);
    }
    const events = store
      .loadEventsStrict(threadId)
      .filter((entry) => entry.id <= restored.restoreBoundary.lastEventPosition)
      .map((entry) => entry.event);
    const interaction = state?.interactions;
    const interrupt: ReplayInterrupt | null =
      interaction?.kind === 'awaiting_tool_approval'
        ? { kind: 'approval', callId: interaction.toolCallId }
        : interaction?.kind === 'awaiting_user_input'
          ? { kind: 'input', callId: interaction.toolCallId }
          : interaction?.kind === 'awaiting_review'
            ? {
                kind: 'plan_review',
                plan: interaction.plan,
                ...(interaction.artifact ? { artifact: interaction.artifact } : {}),
              }
            : null;
    const planState = state ? getActivePlanning(state) : undefined;
    const plan =
      planState?.kind === 'executing' || planState?.kind === 'completed'
        ? planDocumentToAgentPlan(planState.document)
        : null;
    const modelRoute = store.getSessionModelRoute(threadId);
    return {
      threadId,
      messages: [],
      runtimeEvents: events,
      interrupt,
      modelProvider: modelRoute?.provider ?? '',
      modelName: modelRoute?.name ?? '',
      thinkingLevel: null,
      plan,
      planAuthMode: state.authorization.mode,
    };
  } finally {
    store.close();
  }
}

export async function persistSessionName(
  openState25SessionStorage: OpenState25SessionStorageV1,
  threadId: string,
  name: string,
): Promise<void> {
  const store = openState25SessionStorage(threadId);
  try {
    store.setSessionName(threadId, name);
  } finally {
    store.close();
  }
}

export async function deleteSession(
  openState25SessionStorage: OpenState25SessionStorageV1,
  threadId: string,
): Promise<void> {
  const store = openState25SessionStorage(threadId);
  try {
    store.deleteSession(threadId);
  } finally {
    store.close();
  }
}

export async function enrichSessionNames(
  openState25SessionStorage: OpenState25SessionStorageV1,
  sessions: SessionInfo[],
  resolveRecoveryIdentity: (threadId: string) => string,
  onNamed: (threadId: string, name: string) => void,
): Promise<void> {
  for (const session of sessions.filter((entry) => entry.needsSmartName)) {
    const data = await loadSession(
      openState25SessionStorage,
      session.threadId,
      resolveRecoveryIdentity(session.threadId),
    );
    const first = data?.runtimeEvents.find((event) => event.type === 'user.message_appended');
    if (first?.type !== 'user.message_appended') continue;
    const name = await generateSessionName(first.content);
    if (!name) continue;
    await persistSessionName(openState25SessionStorage, session.threadId, name);
    onNamed(session.threadId, name);
  }
}

export async function generateSessionName(firstMessage: string): Promise<string> {
  return firstMessage
    .replace(/^User:\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
}

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
      .join('');
  }
  return String(content ?? '');
}

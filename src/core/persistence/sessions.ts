import type { AgentPlan, PlanArtifactRef, PlanDocument } from '../../protocol/events.js';
import type { RuntimeEvent } from '../runtime/events.js';
import { restoreRuntimeStateFromStore } from '../runtime/kernel.js';
import type { RuntimeState } from '../runtime/state.js';
import { getActivePlanning } from '../runtime/state.js';
import {
  createRuntimeStore,
  type RuntimeSessionInfo,
  runtimeStorePathFor,
} from '../runtime/store.js';

/** Convert PlanDocument back to legacy AgentPlan for consumers that still use it. */
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

export async function listSessions(checkpointPath: string): Promise<SessionInfo[]> {
  const store = createRuntimeStore(runtimeStorePathFor(checkpointPath));
  try {
    return store.listSessions().map(mapSession);
  } finally {
    store.close();
  }
}

export async function searchSessions(
  checkpointPath: string,
  query: string,
): Promise<SessionInfo[]> {
  const store = createRuntimeStore(runtimeStorePathFor(checkpointPath));
  try {
    return store.listSessions(query).map(mapSession);
  } finally {
    store.close();
  }
}

export async function loadSession(
  checkpointPath: string,
  threadId: string,
): Promise<SessionData | null> {
  const store = createRuntimeStore(runtimeStorePathFor(checkpointPath));
  try {
    const storedEvents = store.loadEvents(threadId);
    const events = storedEvents.map((entry) => entry.event);
    if (events.length === 0 && !store.loadSnapshotRecord<RuntimeState>(threadId)) return null;
    const state = restoreRuntimeStateFromStore({
      store,
      threadId,
      userId: 'tui',
      workspace: '',
    }).state;
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
    return {
      threadId,
      messages: [],
      runtimeEvents: events,
      interrupt,
      modelProvider: '',
      modelName: '',
      thinkingLevel: null,
      plan,
      planAuthMode: state?.authorization.mode ?? null,
    };
  } finally {
    store.close();
  }
}

export async function persistSessionName(
  checkpointPath: string,
  threadId: string,
  name: string,
): Promise<void> {
  const store = createRuntimeStore(runtimeStorePathFor(checkpointPath));
  try {
    store.setSessionName(threadId, name);
  } finally {
    store.close();
  }
}

export async function deleteSession(checkpointPath: string, threadId: string): Promise<void> {
  const store = createRuntimeStore(runtimeStorePathFor(checkpointPath));
  try {
    store.deleteSession(threadId);
  } finally {
    store.close();
  }
}

export async function enrichSessionNames(
  checkpointPath: string,
  sessions: SessionInfo[],
  onNamed: (threadId: string, name: string) => void,
): Promise<void> {
  for (const session of sessions.filter((entry) => entry.needsSmartName)) {
    const data = await loadSession(checkpointPath, session.threadId);
    const first = data?.runtimeEvents.find((event) => event.type === 'user.message_appended');
    if (!first || first.type !== 'user.message_appended') continue;
    const name = await generateSessionName(first.content);
    if (!name) continue;
    await persistSessionName(checkpointPath, session.threadId, name);
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

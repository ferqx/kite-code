import { randomUUID } from 'node:crypto';
import { type AgentClient, ClientError, type Workspace } from '@kite-ai/client';
import type { NativeWorkspaceRemoval } from '../src/native-bridge';

export type WorkspaceRemovalIntent = {
  request: { expectedStoreId: string; commandId: string };
  workspaceId: string;
  subjectId: string;
  label: string;
  phase: 'submitting' | 'unknown';
};
export interface WorkspaceRemovalData {
  workspaceRemovals(): WorkspaceRemovalIntent[];
  saveWorkspaceRemoval(input: WorkspaceRemovalIntent): void;
  clearWorkspaceRemoval(commandId: string): void;
}
export function parseWorkspaceRemovalIntent(raw: unknown): WorkspaceRemovalIntent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ClientError('workspace_storage_unavailable');
  const r = raw as WorkspaceRemovalIntent;
  if (
    Object.keys(r).sort().join(',') !== 'label,phase,request,subjectId,workspaceId' ||
    !r.request ||
    Object.keys(r.request).sort().join(',') !== 'commandId,expectedStoreId' ||
    ![r.request.expectedStoreId, r.request.commandId, r.workspaceId].every(
      (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v),
    ) ||
    typeof r.subjectId !== 'string' ||
    !r.subjectId ||
    r.subjectId.length > 256 ||
    typeof r.label !== 'string' ||
    r.label.length > 512 ||
    !['submitting', 'unknown'].includes(r.phase)
  )
    throw new ClientError('workspace_storage_unavailable');
  return structuredClone(r);
}
type Scope = { generation: number; storeId: string; subjectId: string };
export class NativeWorkspaceRemovalPort {
  private readonly states = new Map<string, NativeWorkspaceRemoval>();
  private readonly active = new Set<string>();
  private readonly client: AgentClient;
  private readonly data: () => WorkspaceRemovalData | undefined;
  private readonly current: () => Scope | undefined;
  private readonly observed: (id: string) => Workspace | undefined;
  private readonly notify: () => void;
  constructor(
    client: AgentClient,
    data: () => WorkspaceRemovalData | undefined,
    current: () => Scope | undefined,
    observed: (id: string) => Workspace | undefined,
    notify: () => void,
  ) {
    this.client = client;
    this.data = data;
    this.current = current;
    this.observed = observed;
    this.notify = notify;
  }
  storageUnavailable = false;
  private journal() {
    const data = this.data();
    if (!data) throw new ClientError('workspace_storage_unavailable');
    return data;
  }
  get submissions(): NativeWorkspaceRemoval[] {
    let pending: WorkspaceRemovalIntent[] = [];
    try {
      pending = this.data()?.workspaceRemovals() ?? [];
      this.storageUnavailable = false;
    } catch {
      this.storageUnavailable = true;
    }

    for (const r of pending)
      if (!this.states.has(r.request.commandId))
        this.states.set(r.request.commandId, {
          kind: 'workspace.removal',
          commandId: r.request.commandId,
          storeId: r.request.expectedStoreId,
          workspaceId: r.workspaceId,
          label: r.label,
          phase: 'unknown',
        });
    return [...this.states.values()].map((v) => structuredClone(v));
  }
  private same(scope: Scope) {
    const now = this.current();
    return (
      now?.generation === scope.generation &&
      now.storeId === scope.storeId &&
      now.subjectId === scope.subjectId
    );
  }
  async remove(
    workspaceId: string,
    confirm: (label: string) => Promise<boolean>,
  ): Promise<NativeWorkspaceRemoval> {
    const scope = this.current(),
      workspace = this.observed(workspaceId);
    if (!scope || !workspace) throw new ClientError('directory_observation_changed');
    const prior = this.journal()
      .workspaceRemovals()
      .find((r) => r.request.expectedStoreId === scope.storeId && r.workspaceId === workspaceId);
    if (prior) return this.lookup(prior.request.commandId);
    if (this.active.has(workspaceId)) throw new ClientError('workspace_removal_pending');
    this.active.add(workspaceId);
    try {
      if (!(await confirm(workspace.name)))
        return {
          kind: 'workspace.removal',
          storeId: scope.storeId,
          workspaceId,
          label: workspace.name,
          phase: 'cancelled',
        };
      const fresh = await this.client.getWorkspace(workspaceId);
      if (
        !this.same(scope) ||
        fresh.id !== workspace.id ||
        fresh.rootUri !== workspace.rootUri ||
        fresh.name !== workspace.name
      )
        throw new ClientError('directory_observation_changed');
      const intent: WorkspaceRemovalIntent = {
        request: { expectedStoreId: scope.storeId, commandId: randomUUID() },
        workspaceId,
        subjectId: scope.subjectId,
        label: workspace.name,
        phase: 'submitting',
      };
      this.journal().saveWorkspaceRemoval(intent); // FULL transaction precedes the sole POST.
      const state: NativeWorkspaceRemoval = {
        kind: 'workspace.removal',
        commandId: intent.request.commandId,
        storeId: scope.storeId,
        workspaceId,
        label: workspace.name,
        phase: 'submitting',
      };
      this.states.set(intent.request.commandId, state);
      this.notify();
      try {
        state.receipt = await this.client.removeWorkspace(workspaceId, intent.request);
        state.phase = 'applied';
        this.journal().clearWorkspaceRemoval(intent.request.commandId);
      } catch (error) {
        state.error = error instanceof ClientError ? error.code : 'workspace_removal_unknown';
        if (
          error instanceof ClientError &&
          error.status !== undefined &&
          error.status >= 400 &&
          error.status < 500
        ) {
          state.phase = 'failed';
          this.journal().clearWorkspaceRemoval(intent.request.commandId);
        } else {
          state.phase = 'unknown';
          intent.phase = 'unknown';
          this.journal().saveWorkspaceRemoval(intent);
        }
      }
      for (const [id, r] of this.states)
        if (this.states.size > 128 && ['applied', 'failed'].includes(r.phase))
          this.states.delete(id);
      this.notify();
      return structuredClone(state);
    } finally {
      this.active.delete(workspaceId);
    }
  }
  async lookup(commandId: string): Promise<NativeWorkspaceRemoval> {
    const intent = this.journal()
      .workspaceRemovals()
      .find((r) => r.request.commandId === commandId);
    if (!intent) {
      const state = this.states.get(commandId);
      if (state) return structuredClone(state);
      throw new ClientError('workspace_removal_unavailable');
    }
    const state: NativeWorkspaceRemoval = {
      kind: 'workspace.removal',
      commandId,
      storeId: intent.request.expectedStoreId,
      workspaceId: intent.workspaceId,
      label: intent.label,
      phase: 'unknown',
    };
    const scope = this.current();
    // Saved data is GET-only; a restored Store never retags or submits this identity.
    if (
      !scope ||
      scope.storeId !== intent.request.expectedStoreId ||
      scope.subjectId !== intent.subjectId
    ) {
      state.error = 'workspace_origin_unavailable';
      return state;
    }
    try {
      state.receipt = await this.client.getWorkspaceRemoval(intent.workspaceId, commandId, {
        storeId: intent.request.expectedStoreId,
      });
      state.phase = 'applied';
      this.journal().clearWorkspaceRemoval(commandId);
    } catch (error) {
      state.error = error instanceof ClientError ? error.code : 'workspace_removal_unknown';
    }
    this.states.set(commandId, state);
    this.notify();
    return structuredClone(state);
  }
}

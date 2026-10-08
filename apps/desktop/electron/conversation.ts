import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AgentClient, ClientError, type Workspace } from '@kite-ai/client';
import { createDesktopController, type DesktopController } from '../src/controller';
import { type DesktopInput, inputMetadata } from '../src/input';
import type {
  NativeBranchFacts,
  NativeConversationResult,
  NativeCreation,
  NativeRequest,
} from '../src/native-bridge';
import { callerDigest, callerTextDigest, type NativeCallerJournal } from './caller-journal';
import { queryBranch, switchBranch } from './git';
import type { PrivateData } from './private-data';

type Send = Extract<NativeRequest, { method: 'conversation.send' }>;
type Scope = { generation: number; storeId: string };
type Entry = {
  request: Send;
  result: NativeConversationResult;
  promise?: Promise<NativeConversationResult>;
};
const failureCode = (error: unknown) => {
  const value = (error as { code?: string })?.code ?? (error as Error)?.message;
  return /^[a-z][a-z0-9_]{0,80}$/.test(value ?? '')
    ? value!
    : 'conversation_environment_unavailable';
};

/** Reuses original creation, permission and input callers without changing the reading selection. */
export class NativeConversation {
  private readonly entries = new Map<string, Entry>();
  private readonly controller: DesktopController;
  private sending?: Promise<NativeConversationResult>;
  private readonly client: AgentClient;
  private readonly current: () => Scope | undefined;
  private readonly workspace: (id: string) => Workspace | undefined;
  private readonly data: () => PrivateData;
  private readonly create: (
    input: NativeCreation['input'],
    onFirst: () => void,
  ) => Promise<NativeCreation>;
  private readonly lookupCreation: (commandId: string) => Promise<NativeCreation>;
  private readonly journal: () => NativeCallerJournal;
  private readonly input: DesktopInput;
  private readonly hasActiveWork: () => Promise<boolean>;
  private readonly notify: () => void;
  private readonly protectedRoots: readonly string[];
  constructor(
    client: AgentClient,
    current: () => Scope | undefined,
    workspace: (id: string) => Workspace | undefined,
    data: () => PrivateData,
    create: (input: NativeCreation['input'], onFirst: () => void) => Promise<NativeCreation>,
    lookupCreation: (commandId: string) => Promise<NativeCreation>,
    journal: () => NativeCallerJournal,
    input: DesktopInput,
    hasActiveWork: () => Promise<boolean>,
    notify: () => void,
    protectedRoots: readonly string[] = [],
  ) {
    this.client = client;
    this.current = current;
    this.workspace = workspace;
    this.data = data;
    this.create = create;
    this.lookupCreation = lookupCreation;
    this.journal = journal;
    this.input = input;
    this.hasActiveWork = hasActiveWork;
    this.notify = notify;
    this.protectedRoots = protectedRoots.map((root) => realpathSync.native(root));
    this.controller = createDesktopController({
      admittedClient: client,
      readContextOnSelect: false,
      onSnapshot: () => {},
      onPermissionSubmission: notify,
    });
  }
  get permissionSubmissions() {
    return this.controller.permissionSubmissions;
  }
  lookupPermission(commandId: string) {
    return this.controller.lookupPermissionMutation(commandId);
  }
  private check(scope: Scope) {
    const now = this.current();
    if (!now || now.generation !== scope.generation || now.storeId !== scope.storeId)
      throw new ClientError('native_generation_changed');
  }
  private path(workspaceId: string) {
    const workspace = this.workspace(workspaceId);
    if (!workspace) throw new ClientError('workspace_observation_unavailable');
    try {
      const uri = new URL(workspace.rootUri);
      if (uri.protocol !== 'file:' || (uri.hostname && uri.hostname !== 'localhost')) throw Error();
      const path = fileURLToPath(uri);
      if (realpathSync.native(path) !== path || !statSync(path).isDirectory()) throw Error();
      return path;
    } catch {
      throw new ClientError('workspace_directory_unavailable');
    }
  }
  async branch(workspaceId: string): Promise<NativeBranchFacts> {
    const scope = this.current();
    if (!scope) throw new ClientError('native_generation_changed');
    const path = this.path(workspaceId);
    // Git is optional. A failed probe must not prevent an ordinary directory conversation.
    const branch = await queryBranch(path).catch(() => undefined);
    this.check(scope);
    return {
      kind: 'conversation.branch',
      storeId: scope.storeId,
      workspaceId,
      repository: branch?.repository === true,
      ...(branch?.current ? { current: branch.current } : {}),
      branches: branch?.branches ?? [],
      label: branch?.repository
        ? (branch.current ?? (branch.head ? '分离 HEAD' : '尚无提交'))
        : '本地目录',
    };
  }
  send(request: Send): Promise<NativeConversationResult> {
    const previous = this.entries.get(request.intent.commandId);
    if (previous) {
      if (callerDigest(previous.request) !== callerDigest(request))
        throw new ClientError('caller_intent_conflict');
      return previous.promise ?? Promise.resolve(structuredClone(previous.result));
    }
    if (this.sending) throw new ClientError('conversation_submission_pending');
    const prior = [...this.entries.values()].find(
      (entry) => entry.request.creation.commandId === request.creation.commandId,
    );
    if (
      prior &&
      (callerDigest(prior.request.creation) !== callerDigest(request.creation) ||
        [...this.entries.values()].some(
          (entry) =>
            entry.request.creation.commandId === request.creation.commandId &&
            entry.result.phase !== 'failed',
        ))
    )
      throw new ClientError('conversation_original_unresolved');
    if (this.entries.size >= 128) throw new ClientError('caller_intent_limit');
    const scope = this.current();
    if (!scope || request.generation !== scope.generation)
      throw new ClientError('native_generation_changed');
    if (
      request.creation.expectedStoreId !== scope.storeId ||
      request.intent.expectedStoreId !== scope.storeId ||
      request.intent.commandId === request.creation.commandId
    )
      throw new ClientError('store_identity_mismatch');
    const entry: Entry = {
      request: structuredClone(request),
      result: {
        kind: 'conversation',
        commandId: request.intent.commandId,
        phase: 'sending',
        stage: 'create',
      },
    };
    this.entries.set(request.intent.commandId, entry);
    const work = this.perform(entry, scope, prior).finally(() => {
      entry.promise = undefined;
      if (this.sending === work) this.sending = undefined;
      this.notify();
    });
    entry.promise = work;
    this.sending = work;
    return work;
  }
  private async perform(entry: Entry, scope: Scope, prior?: Entry) {
    const request = entry.request;
    try {
      const path = this.path(request.creation.workspaceId);
      const savedCreation = this.data()
        .creations()
        .find((item) => item.input.commandId === request.creation.commandId);
      if (savedCreation && !prior) {
        if (callerDigest(savedCreation.input) !== callerDigest(request.creation))
          throw new ClientError('creation_intent_conflict');
        // Cold/existing creation is evidence to inspect, never permission to continue its writes.
        entry.result = {
          ...entry.result,
          creation: savedCreation,
          phase: 'unknown',
          code: 'conversation_original_saved',
        };
        return structuredClone(entry.result);
      }
      if (!savedCreation && request.targetBranch) {
        const branch = await queryBranch(path);
        this.check(scope);
        if (!branch.repository) throw new ClientError('git_branch_unavailable');
        if (branch.current !== request.targetBranch) {
          const contains = (root: string, target: string) => {
            const path = relative(root, target);
            return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
          };
          if (this.protectedRoots.some((root) => contains(root, path) || contains(path, root)))
            throw new ClientError('git_protected_root');
          if (!branch.canSwitch) throw new ClientError('git_root_required');
          if (branch.dirty) throw new ClientError('git_workspace_dirty');
          if (!branch.branches.includes(request.targetBranch))
            throw new ClientError('git_branch_unavailable');
          if (await this.hasActiveWork()) throw new ClientError('git_active_work');
          this.check(scope);
          await switchBranch(path, request.targetBranch, branch);
          this.check(scope);
        }
      }
      const models = await this.client.getModelSettings('workspace', {
        storeId: scope.storeId,
        workspaceId: request.creation.workspaceId,
      });
      this.check(scope);
      if (models.storeId !== scope.storeId || models.workspaceId !== request.creation.workspaceId)
        throw new ClientError('configuration_scope_mismatch');
      const model = models.models.find(
        (model) => model.id === (request.intent.modelId ?? models.defaultModelId),
      );
      if (!model?.enabled || !model.configured)
        throw new ClientError('model_selection_unavailable');
      if (
        request.intent.reasoningEffort !== undefined &&
        !model.reasoningEffortChoices?.includes(request.intent.reasoningEffort)
      )
        throw new ClientError('model_reasoning_effort_unsupported');
      const draftScope = {
        storeId: scope.storeId,
        workspaceId: request.creation.workspaceId,
        rootSessionId: request.creation.sessionId,
      };
      const original = this.data().read(draftScope);
      const draft = this.data().save(draftScope, original.revision, request.intent.content);
      let first = false;
      const creation =
        savedCreation ??
        (await this.create(request.creation, () => {
          first = true;
        }));
      entry.result = { ...entry.result, creation };
      if (creation.phase !== 'created' || (!first && !prior)) {
        entry.result = {
          ...entry.result,
          phase: creation.phase === 'rejected' ? 'failed' : 'unknown',
          code: creation.code,
        };
        return structuredClone(entry.result);
      }
      this.check(scope);
      entry.result = { ...entry.result, stage: 'permission' };
      this.notify();
      await this.controller.selectSession(creation.input.sessionId);
      this.check(scope);
      const snapshot = this.controller.snapshot;
      if (
        snapshot?.view.storeId !== scope.storeId ||
        snapshot.view.session.id !== creation.input.sessionId ||
        snapshot.view.session.workspaceId !== creation.input.workspaceId ||
        snapshot.view.session.parentSessionId !== null ||
        snapshot.view.session.deletedAt !== null ||
        snapshot.view.runs.some((run) => run.isActive) ||
        snapshot.interactions.some((card) => card.state === 'pending')
      )
        throw new ClientError('conversation_session_unavailable');
      let facts = snapshot.permissions;
      if (!facts) throw new ClientError('permission_facts_unavailable');
      if (!facts.trust.trusted) {
        // A project choice authorizes its root. Additional host read scopes retain explicit confirmation.
        if (facts.trust.readScopes.some((item) => item.kind !== 'workspace'))
          throw new ClientError('workspace_trust_required');
        const before = this.controller.permissionSubmissions.length;
        try {
          const mutation = await this.controller.setWorkspaceTrust(true, facts.observationId);
          entry.result = { ...entry.result, permissionCommandId: mutation.commandId };
          if (mutation.state !== 'applied') throw new ClientError('permission_outcome_unknown');
        } finally {
          const submission = this.controller.permissionSubmissions[before];
          if (submission)
            entry.result = { ...entry.result, permissionCommandId: submission.intent.commandId };
        }
        await this.controller.refreshPermissions();
        facts = this.controller.snapshot?.permissions;
      }
      if (!facts?.trust.trusted) throw new ClientError('workspace_trust_required');
      if (request.permissionMode !== undefined && facts.mode.mode !== request.permissionMode) {
        const before = this.controller.permissionSubmissions.length;
        try {
          const mutation = await this.controller.setPermissionMode(
            request.permissionMode,
            false,
            facts.observationId,
          );
          entry.result = { ...entry.result, permissionCommandId: mutation.commandId };
          if (mutation.state !== 'applied') throw new ClientError('permission_outcome_unknown');
        } finally {
          const submission = this.controller.permissionSubmissions[before];
          if (submission)
            entry.result = { ...entry.result, permissionCommandId: submission.intent.commandId };
        }
      }
      this.check(scope);
      entry.result = { ...entry.result, stage: 'input' };
      const prepared = await this.journal().prepare(creation.input.sessionId, request.intent, {
        id: draft.id,
        revision: String(draft.revision),
        textDigest: callerTextDigest(draft.content),
      });
      this.check(scope);
      if (request.intent.modelId)
        this.data().rememberModelRoute(
          scope.storeId,
          creation.input.sessionId,
          request.intent.modelId,
        );
      const result = inputMetadata(
        await this.input.start(creation.input.sessionId, request.intent),
      );
      entry.result = {
        ...entry.result,
        input: { ...result, draft: prepared.intent.draft },
        phase: ['unknown', 'submitting'].includes(result.phase)
          ? 'unknown'
          : ['failed', 'rejected'].includes(result.phase)
            ? 'failed'
            : 'accepted',
        code: result.error,
      };
    } catch (error) {
      const submission =
        entry.result.permissionCommandId &&
        this.controller.permissionSubmissions.find(
          (item) => item.intent.commandId === entry.result.permissionCommandId,
        );
      entry.result = {
        ...entry.result,
        phase:
          submission && ['saved', 'submitting', 'unknown'].includes(submission.phase)
            ? 'unknown'
            : 'failed',
        code: failureCode(error),
      };
    }
    return structuredClone(entry.result);
  }
  async lookup(commandId: string) {
    const entry = this.entries.get(commandId);
    if (!entry) throw new ClientError('caller_intent_missing');
    if (entry.promise) return entry.promise;
    if (entry.result.stage === 'input' && entry.result.input) {
      const input = inputMetadata(await this.input.lookup(commandId));
      entry.result = {
        ...entry.result,
        input,
        phase: ['unknown', 'submitting'].includes(input.phase)
          ? 'unknown'
          : ['failed', 'rejected'].includes(input.phase)
            ? 'failed'
            : 'accepted',
        code: input.error,
      };
    } else if (entry.result.permissionCommandId) {
      const mutation = await this.controller.lookupPermissionMutation(
        entry.result.permissionCommandId,
      );
      entry.result = {
        ...entry.result,
        phase: mutation.state === 'outcome_unknown' ? 'unknown' : 'failed',
        code:
          mutation.state === 'applied' ? 'conversation_continue_explicit' : mutation.receipt.code,
      };
    } else if (entry.result.creation) {
      const creation = await this.lookupCreation(entry.result.creation.input.commandId);
      entry.result = {
        ...entry.result,
        creation,
        phase: ['pending', 'unknown'].includes(creation.phase) ? 'unknown' : 'failed',
        code: creation.phase === 'created' ? 'conversation_continue_explicit' : creation.code,
      };
    }
    this.notify();
    return structuredClone(entry.result);
  }
  async close() {
    await this.sending;
    this.controller.disposeNetwork();
  }
}

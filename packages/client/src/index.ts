import { verifyContextCompression } from './context';
import {
  ClientError,
  decodeResponse,
  type Responses,
  validateQueryInput,
  validateRequest,
} from './decode';
import { collectDirectory, collectSnapshotDirectory, validateDirectoryPage } from './directory';
import {
  validateFileCheckpointTarget,
  verifyFileCheckpointDetail,
  verifyFileCheckpointObservation,
  verifyFileCheckpointPage,
  verifyFileCheckpointRecoveryBoundary,
  verifyFileRestoreStatus,
} from './file-checkpoints';
import type {
  AnswerInteractionRequest,
  BeginSessionExportQuery,
  CancelCommandRequest,
  CancelExecutionRequest,
  CancelRunRequest,
  CancelSessionRequest,
  Change,
  ClearPermissionGrantsRequest,
  Command,
  CompressContextRequest,
  ConfigurationPatchRequest,
  ConfigurationRepairRequest,
  ContextQuery,
  CreateSessionRequest,
  CreateWorkspaceRequest,
  CredentialPutRequest,
  CredentialRevokeRequest,
  DeleteSessionRequest,
  ExtensionCommandRequest,
  FollowUpCommandRequest,
  ForkSessionRequest,
  HostMutation,
  HostStatus,
  IncludeResultRequest,
  InputListQuery,
  Interaction,
  InteractionListQuery,
  JobReconcileCommand,
  ModelSettingsRequest,
  PermissionMutation,
  ProviderSettingsRequest,
  ReconcileJobRequest,
  RecoverSessionRequest,
  RecoverSessionResponse,
  RemoveWorkspaceRequest,
  RenameSessionRequest,
  ResetCompressionRequest,
  ResumeJobReportRequest,
  ResumeJobReportResponse,
  ResumeRunRequest,
  ResumeRunResponse,
  SelectContextRequest,
  ServerInfo,
  SessionExportManifest,
  SessionExportPageQuery,
  SessionExportTextQuery,
  SetPermissionModeRequest,
  SetWorkspaceTrustRequest,
  SkillCataloguePage,
  StartCommandRequest,
  SteerCommandRequest,
  StreamCheckpoint,
  StreamReady,
  VerifySessionExportQuery,
  WorkspaceRemoval,
} from './generated/api';
import {
  canonicalModelBody,
  digestModelBody,
  readModelInputResponse,
  verifyModelInputPage,
} from './model-input';
import { readModelOutputResponse } from './model-output';
import {
  sessionExportParameters,
  streamSessionExport,
  verifySessionExportCompletion,
  verifySessionExportManifest,
  verifySessionExportPage,
  verifySessionExportTextPage,
} from './session-export';
import {
  validateSessionLogBounds,
  validateSessionLogTarget,
  verifySessionLogPage,
} from './session-logs';
import { verifySkillCataloguePage } from './skill-catalogue';
import {
  parseCursorSequence,
  readSSE,
  type SSEEvent,
  SSEParseError,
  validateCursorBounds,
} from './sse';

export { type CallerCommandRequest, canonicalCallerCommandRequest } from './command-request';
/** Closed, non-secret configuration intent for a Native original-operation journal. */
export function canonicalConfigurationRequest(
  kind: 'model' | 'provider',
  input: ModelSettingsRequest | Omit<ProviderSettingsRequest, 'secret'>,
): string {
  if ('secret' in input) throw new ClientError('invalid_request');
  validateRequest(kind === 'model' ? 'ModelSettingsRequest' : 'ProviderSettingsRequest', input);
  return canonicalModelBody(input);
}
export { ClientError, validateRequest } from './decode';
export { ExecutionOutputPages } from './execution-output';
export type * from './generated/api';
export {
  createServiceLifecycleClient,
  ServiceLifecycleClient,
  type ServiceLifecycleClientOptions,
} from './lifecycle';
export {
  decodeMcpToolsPage,
  decodeMcpToolsSnapshots,
  type McpToolMetadata,
  type McpToolsBinding,
  type McpToolsContentRef,
  type McpToolsEntry,
  type McpToolsOrigin,
  type McpToolsPage,
  type McpToolsSnapshot,
  type McpToolsSnapshots,
  readMcpToolDescriptor,
} from './mcp-tools';
export { canonicalModelBody, verifyModelInputSnapshot } from './model-input';
export { verifyModelOutputSnapshot } from './model-output';
export {
  type SkillCatalogueVerificationOptions,
  verifySkillCataloguePage,
} from './skill-catalogue';
export type Json = ExtensionCommandRequest['input'];
export type { SessionExportFrame, SessionExportSection } from './session-export';
export { parseCursorSequence, validateCursorBounds } from './sse';

export interface ConnectionExpectation {
  readonly profile: ServerInfo['profile'];
  readonly apiMajor: number;
  readonly requiredCapabilities: readonly string[];
  readonly instanceId?: string;
  readonly buildId?: string;
}
export interface ClientOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly expected: ConnectionExpectation;
  readonly bootstrap?: ServerInfo;
  readonly maxResponseBytes?: number;
}
export interface AppliedCursor {
  readonly storeId: string;
  readonly sequence: string;
}
export interface ObserveOptions {
  readonly cursor?: AppliedCursor;
  /** Explicit boundary after reloading snapshots; reads from it without acknowledging it. */
  readonly startAfter?: AppliedCursor;
  readonly sessionIds?: readonly string[];
  readonly signal?: AbortSignal;
  readonly reconnect?: boolean;
  readonly retryDelayMs?: number;
  readonly onChange: (change: Change) => void | Promise<void>;
  /** Confirms validated stream admission without acknowledging any change. */
  readonly onReady?: (ready: StreamReady) => void | Promise<void>;
  readonly onCheckpoint?: (checkpoint: StreamCheckpoint) => void | Promise<void>;
  readonly onReset?: (reason: string) => void | Promise<void>;
}

function sameProfile(left: ServerInfo['profile'], right: ServerInfo['profile']): boolean {
  return (
    left.dataRoot === right.dataRoot &&
    left.name === right.name &&
    left.accessKey === right.accessKey
  );
}

function admit(info: ServerInfo, expected: ConnectionExpectation): void {
  if (!sameProfile(info.profile, expected.profile))
    throw new ClientError('profile_identity_mismatch');
  if (info.apiMajor !== expected.apiMajor) throw new ClientError('api_major_incompatible');
  if (expected.instanceId !== undefined && expected.instanceId !== info.instanceId)
    throw new ClientError('instance_identity_mismatch');
  if (expected.buildId !== undefined && expected.buildId !== info.buildId)
    throw new ClientError('build_identity_mismatch');
  if (expected.requiredCapabilities.some((capability) => !info.capabilities.includes(capability)))
    throw new ClientError('required_capability_missing');
}

export class AgentClient {
  private readonly endpoint: string;
  private readonly expected: ConnectionExpectation;
  private readonly maximum: number;
  private readonly controllers = new Set<AbortController>();
  private token: string;
  private bootstrap: ServerInfo | undefined;
  private connected = false;
  private lastServer: ServerInfo | undefined;
  private connectionGeneration = 0;
  private observing = false;
  private observationScope: string | undefined;
  private applied: AppliedCursor | undefined;

  constructor(options: ClientOptions) {
    const endpoint = new URL(options.endpoint);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new ClientError('invalid_endpoint');
    this.endpoint = endpoint.href.replace(/\/$/, '');
    this.token = options.token;
    this.expected = structuredClone(options.expected);
    this.bootstrap = options.bootstrap ? structuredClone(options.bootstrap) : undefined;
    this.maximum = options.maxResponseBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1)
      throw new ClientError('invalid_response_limit');
  }

  get serverInfo(): ServerInfo | undefined {
    return this.lastServer ? structuredClone(this.lastServer) : undefined;
  }
  get lastAppliedCursor(): AppliedCursor | undefined {
    return this.applied ? { ...this.applied } : undefined;
  }

  /** Every fresh connection is checked against the choice made before startup, never against itself. */
  async connect(
    options: {
      readonly token?: string;
      readonly bootstrap?: ServerInfo;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<ServerInfo> {
    this.disposeNetwork();
    const generation = this.connectionGeneration;
    const token = options.token ?? this.token;
    const bootstrap = options.bootstrap ?? this.bootstrap;
    if (bootstrap) admit(decodeResponse('ServerInfo', bootstrap), this.expected);
    const info = await this.fetchJSON('/v1/server', 'ServerInfo', {
      token,
      signal: options.signal,
    });
    admit(info, this.expected);
    if (
      bootstrap &&
      (!sameProfile(bootstrap.profile, info.profile) ||
        bootstrap.instanceId !== info.instanceId ||
        bootstrap.buildId !== info.buildId ||
        bootstrap.apiMajor !== info.apiMajor)
    )
      throw new ClientError('bootstrap_identity_mismatch');
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    this.token = token;
    this.bootstrap = bootstrap ? structuredClone(bootstrap) : undefined;
    this.lastServer = structuredClone(info);
    this.connected = true;
    return structuredClone(info);
  }

  /** Recheck the admitted target without resetting concurrent reads or the observation stream. */
  async verifyConnection(options: { readonly signal?: AbortSignal } = {}): Promise<ServerInfo> {
    this.requireConnection(false);
    const original = this.lastServer!;
    const generation = this.connectionGeneration;
    const info = await this.fetchJSON('/v1/server', 'ServerInfo', { signal: options.signal });
    admit(info, this.expected);
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    if (
      !sameProfile(original.profile, info.profile) ||
      original.instanceId !== info.instanceId ||
      original.buildId !== info.buildId ||
      original.apiMajor !== info.apiMajor
    )
      throw new ClientError('connection_identity_mismatch');
    if (original.storeId !== info.storeId) throw new ClientError('store_identity_mismatch');
    return structuredClone(info);
  }

  private requireConnection(data = true): void {
    if (!this.connected) throw new ClientError('connection_not_admitted');
    if (data && this.lastServer?.dataAvailability !== 'available')
      throw new ClientError('data_unavailable');
  }

  private requireCapability(capability: string): void {
    this.requireConnection();
    if (!this.lastServer?.capabilities.includes(capability))
      throw new ClientError('capability_unavailable');
  }

  private async fetchJSON<K extends keyof Responses>(
    path: string,
    shape: K,
    options: { method?: string; body?: unknown; token?: string; signal?: AbortSignal } = {},
  ): Promise<Responses[K]> {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.throwIfAborted();
    options.signal?.addEventListener('abort', abort, { once: true });
    this.controllers.add(controller);
    try {
      const response = await fetch(`${this.endpoint}${path}`, {
        method: options.method ?? 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${options.token ?? this.token}`,
          accept: 'application/json',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      if (response.ok && shape === 'ModelInputSnapshot')
        return (await readModelInputResponse(response, controller.signal)) as Responses[K];
      if (response.ok && shape === 'ModelOutputSnapshot')
        return (await readModelOutputResponse(response, controller.signal)) as Responses[K];
      const value = await this.responseJSON(
        response,
        shape === 'SessionLogPage' ? Math.min(this.maximum, 512 * 1024) : this.maximum,
      );
      if (!response.ok) {
        const problem = decodeResponse('Problem', value);
        throw new ClientError(problem.code, problem.message, response.status, problem);
      }
      return decodeResponse(shape, value);
    } catch (error) {
      if (error instanceof ClientError || controller.signal.aborted) throw error;
      throw new ClientError(
        'network_outcome_unknown',
        'Request outcome is unknown; query the original command identity.',
      );
    } finally {
      this.controllers.delete(controller);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  private async responseJSON(response: Response, maximum = this.maximum): Promise<unknown> {
    if (!response.body) throw new ClientError('invalid_response');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maximum) throw new ClientError('response_too_large');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      try {
        return JSON.parse(text);
      } catch {
        throw new ClientError('invalid_response');
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private mutate<K extends keyof Responses>(
    path: string,
    requestShape: Parameters<typeof validateRequest>[0],
    responseShape: K,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<Responses[K]> {
    this.requireCapability(
      requestShape === 'SelectContextRequest' ||
        requestShape === 'IncludeResultRequest' ||
        requestShape === 'CompressContextRequest' ||
        requestShape === 'ResetCompressionRequest'
        ? 'context'
        : requestShape === 'AnswerInteractionRequest'
          ? 'interactions'
          : requestShape === 'SteerCommandRequest' || requestShape === 'FollowUpCommandRequest'
            ? 'inputs'
            : requestShape === 'ReconcileJobRequest' ||
                requestShape === 'ResumeJobReportRequest' ||
                requestShape === 'ResumeRunRequest' ||
                requestShape === 'RecoverSessionRequest' ||
                requestShape === 'StartCommandRequest' ||
                requestShape === 'CancelCommandRequest' ||
                requestShape === 'CancelRunRequest' ||
                requestShape === 'CancelExecutionRequest' ||
                requestShape === 'CancelSessionRequest' ||
                requestShape === 'ExtensionCommandRequest'
              ? 'commands'
              : 'sessions',
    );
    const intent = structuredClone(input);
    validateRequest(requestShape, intent);
    if (
      (requestShape === 'StartCommandRequest' || requestShape === 'FollowUpCommandRequest') &&
      Object.hasOwn(intent as object, 'selectedSkills')
    )
      this.requireCapability('run_skill_selection');
    if (
      (requestShape === 'StartCommandRequest' || requestShape === 'FollowUpCommandRequest') &&
      Object.hasOwn(intent as object, 'extensionInputs')
    )
      this.requireCapability('run_extension_inputs');

    if (
      requestShape === 'SelectContextRequest' &&
      (intent as SelectContextRequest).boundary !== null
    )
      parseCursorSequence((intent as SelectContextRequest).boundary!.seq);
    if (requestShape === 'IncludeResultRequest')
      parseCursorSequence((intent as IncludeResultRequest).resultRevision);
    if (requestShape === 'AnswerInteractionRequest')
      parseCursorSequence((intent as AnswerInteractionRequest).expectedRevision);
    if (requestShape === 'SteerCommandRequest' || requestShape === 'FollowUpCommandRequest') {
      const content = (intent as SteerCommandRequest | FollowUpCommandRequest).content;
      if (!content.trim() || new TextEncoder().encode(content).byteLength > 1048576)
        throw new ClientError('invalid_request', 'Invalid input content.');
    }
    // No mutation retry, no ID regeneration and no expectedStoreId rebinding.
    return this.fetchJSON(path, responseShape, { method: 'POST', body: intent, signal });
  }

  private managementStore(storeId?: string, diagnostic = false): void {
    this.requireConnection(!diagnostic);
    if (!this.lastServer!.capabilities.includes('configuration_management'))
      throw new ClientError('capability_unavailable');
    if (this.lastServer!.dataAvailability === 'available') {
      validateRequest('HostMutationQuery', { storeId });
      if (storeId !== this.lastServer!.storeId) throw new ClientError('store_identity_mismatch');
    } else if (!diagnostic || storeId !== undefined) throw new ClientError('data_unavailable');
  }
  private configurationScope(scope: 'user' | 'workspace', workspaceId?: string): void {
    if (
      (scope !== 'user' && scope !== 'workspace') ||
      (scope === 'user' ? workspaceId !== undefined : workspaceId === undefined)
    )
      throw new ClientError('invalid_request');
  }
  async getConfiguration(
    scope: 'user' | 'workspace',
    options: { storeId?: string; workspaceId?: string; signal?: AbortSignal },
  ) {
    const { signal, ...parameters } = options;
    const query = structuredClone(parameters);
    validateRequest('ConfigurationReadQuery', query);
    this.configurationScope(scope, query.workspaceId);
    this.managementStore(query.storeId, scope === 'user');
    const generation = this.connectionGeneration;
    await this.verifyConnection({ signal });
    const result = await this.fetchJSON(
      `/v1/config/${scope}?${new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined) as [string, string][])}`,
      'ConfigurationView',
      { signal },
    );
    if (
      generation !== this.connectionGeneration ||
      result.storeId !== query.storeId ||
      result.scope !== scope ||
      result.workspaceId !== query.workspaceId
    )
      throw new ClientError('configuration_scope_mismatch');
    await this.verifyConnection({ signal });
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    return result;
  }
  private verifyHostMutation(result: HostMutation, storeId: string, commandId: string): void {
    if (result.originStoreId !== storeId || result.commandId !== commandId)
      throw new ClientError('host_mutation_scope_mismatch');
    this.configurationScope(result.scope, result.workspaceId);
    const configuration =
      result.kind.startsWith('config.') ||
      result.kind === 'model_settings.update' ||
      result.kind === 'provider_settings.update';
    if ((result.kind === 'model_settings.update') !== (result.modelSettings !== undefined))
      throw new ClientError('invalid_response');
    if ((result.kind === 'provider_settings.update') !== (result.providerSettings !== undefined))
      throw new ClientError('invalid_response');
    if (configuration !== (typeof result.ifMatch === 'string'))
      throw new ClientError('invalid_response');
    if (!configuration && result.scope !== 'user') throw new ClientError('invalid_response');
    const receipt = result.receipt as Record<string, unknown>;
    const keys = Object.keys(receipt).sort().join(',');
    if (result.state === 'pending') {
      if (keys !== '') throw new ClientError('invalid_response');
    } else if (result.state === 'applied') {
      const provider = result.kind === 'provider_settings.update';
      if (
        receipt.status !== 'applied' ||
        keys !==
          (provider
            ? `configurationState,credentialState,etag,${receipt.opaqueRef === undefined ? '' : 'opaqueRef,'}status`
            : configuration
              ? 'etag,status'
              : 'opaqueRef,persistence,status')
      )
        throw new ClientError('invalid_response');
      if (configuration && typeof receipt.etag !== 'string')
        throw new ClientError('invalid_response');
    } else if (
      receipt.status !== result.state ||
      keys !==
        (result.kind === 'provider_settings.update'
          ? `code,configurationState,credentialState,${receipt.opaqueRef === undefined ? '' : 'opaqueRef,'}status`
          : 'code,status')
    )
      throw new ClientError('invalid_response');
    if (result.kind === 'provider_settings.update' && result.state !== 'pending') {
      if (
        (receipt.credentialState === 'stored') !== (typeof receipt.opaqueRef === 'string') ||
        (result.state === 'failed' &&
          (receipt.credentialState === 'outcome_unknown' ||
            receipt.configurationState === 'outcome_unknown')) ||
        (result.state === 'outcome_unknown' &&
          receipt.credentialState !== 'outcome_unknown' &&
          receipt.configurationState !== 'outcome_unknown')
      )
        throw new ClientError('invalid_response');
    }
  }
  async getHostMutation(commandId: string, options: { storeId: string; signal?: AbortSignal }) {
    const storeId = options.storeId;
    this.managementStore(storeId);
    validateRequest('CredentialRevokeRequest', { commandId, expectedStoreId: storeId });
    const { signal, ...query } = options;
    validateRequest('HostMutationQuery', query);
    const generation = this.connectionGeneration;
    await this.verifyConnection({ signal });
    const result = await this.fetchJSON(
      `/v1/host-mutations/${encodeURIComponent(commandId)}?${new URLSearchParams({ storeId })}`,
      'HostMutation',
      { signal },
    );
    this.verifyHostMutation(result, storeId, commandId);
    await this.verifyConnection({ signal });
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    return result;
  }
  private async writeManagement(
    path: string,
    shape:
      | 'ModelSettingsRequest'
      | 'ProviderSettingsRequest'
      | 'ConfigurationPatchRequest'
      | 'ConfigurationRepairRequest'
      | 'CredentialPutRequest'
      | 'CredentialRevokeRequest',
    kind: HostMutation['kind'],
    input:
      | ModelSettingsRequest
      | ProviderSettingsRequest
      | ConfigurationPatchRequest
      | ConfigurationRepairRequest
      | CredentialPutRequest
      | CredentialRevokeRequest,
    scope: 'user' | 'workspace',
    method: 'PATCH' | 'POST',
    signal?: AbortSignal,
    opaqueRef?: string,
  ) {
    const intent = structuredClone(input);
    validateRequest(shape, intent);
    if (
      'expectedReadSet' in intent &&
      (scope === 'user'
        ? intent.expectedReadSet.workspaceEtag !== null
        : intent.expectedReadSet.workspaceEtag === null)
    )
      throw new ClientError('invalid_request');
    this.configurationScope(scope, 'workspaceId' in intent ? intent.workspaceId : undefined);
    this.managementStore(intent.expectedStoreId);
    const generation = this.connectionGeneration;
    await this.verifyConnection({ signal });
    const result = await this.fetchJSON(path, 'HostMutation', {
      method,
      body: intent,
      signal,
    }).catch((error: unknown) => {
      if (!(error instanceof ClientError) || error.status === undefined)
        throw new ClientError('network_outcome_unknown');
      throw error;
    });
    try {
      this.verifyHostMutation(result, intent.expectedStoreId, intent.commandId);
      if (
        result.kind !== kind ||
        result.scope !== scope ||
        result.workspaceId !== ('workspaceId' in intent ? intent.workspaceId : undefined) ||
        result.ifMatch !==
          ('expectedReadSet' in intent
            ? scope === 'user'
              ? intent.expectedReadSet.userEtag
              : intent.expectedReadSet.workspaceEtag
            : 'ifMatch' in intent
              ? intent.ifMatch
              : undefined) ||
        ('expectedReadSet' in intent &&
          canonicalModelBody(
            kind === 'provider_settings.update' ? result.providerSettings : result.modelSettings,
          ) !==
            canonicalModelBody({
              expectedReadSet: intent.expectedReadSet,
              operation: intent.operation,
            }))
      )
        throw new ClientError('host_mutation_scope_mismatch');
      if (
        opaqueRef &&
        result.state === 'applied' &&
        (result.receipt as Record<string, unknown>).opaqueRef !== opaqueRef
      )
        throw new ClientError('host_mutation_scope_mismatch');
      if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
      await this.verifyConnection({ signal });
      if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    } catch {
      throw new ClientError('network_outcome_unknown');
    }
    return result;
  }
  async getModelSettings(
    scope: 'user' | 'workspace',
    options: { storeId: string; workspaceId?: string; signal?: AbortSignal },
  ) {
    const { signal, ...parameters } = options;
    const query = structuredClone(parameters);
    validateRequest('ConfigurationReadQuery', query);
    this.configurationScope(scope, query.workspaceId);
    this.managementStore(query.storeId);
    const generation = this.connectionGeneration;
    await this.verifyConnection({ signal });
    const result = await this.fetchJSON(
      `/v1/config/${scope}/models?${new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined) as [string, string][])}`,
      'ModelSettingsView',
      { signal },
    );
    if (
      result.storeId !== query.storeId ||
      result.scope !== scope ||
      result.workspaceId !== query.workspaceId
    )
      throw new ClientError('configuration_scope_mismatch');
    if (
      result.readSet &&
      (scope === 'user'
        ? result.readSet.workspaceEtag !== null
        : result.readSet.workspaceEtag === null)
    )
      throw new ClientError('invalid_response');
    if (
      result.models.some(
        (model, index) =>
          result.models.findIndex((other) => other.id === model.id) !== index ||
          model.configured !== (model.diagnostics.length === 0),
      )
    )
      throw new ClientError('invalid_response');
    await this.verifyConnection({ signal });
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    return result;
  }
  updateModelSettings(
    scope: 'user' | 'workspace',
    input: ModelSettingsRequest,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.writeManagement(
      `/v1/config/${scope}/models`,
      'ModelSettingsRequest',
      'model_settings.update',
      input,
      scope,
      'POST',
      options.signal,
    );
  }
  async getProviderSettings(options: { storeId: string; signal?: AbortSignal }) {
    const { signal, storeId } = options;
    this.managementStore(storeId);
    const generation = this.connectionGeneration;
    await this.verifyConnection({ signal });
    const result = await this.fetchJSON(
      `/v1/config/user/providers?${new URLSearchParams({ storeId })}`,
      'ProviderSettingsView',
      { signal },
    );
    if (result.storeId !== storeId) throw new ClientError('configuration_scope_mismatch');
    if (
      new Set(result.providers.map((provider) => provider.id)).size !== 4 ||
      result.readSet?.workspaceEtag != null ||
      result.providers.some(
        (provider) =>
          new Set(provider.connections.map((connection) => connection.id)).size !==
          provider.connections.length,
      )
    )
      throw new ClientError('invalid_response');
    await this.verifyConnection({ signal });
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    return result;
  }
  updateProviderSettings(input: ProviderSettingsRequest, options: { signal?: AbortSignal } = {}) {
    return this.writeManagement(
      '/v1/config/user/providers',
      'ProviderSettingsRequest',
      'provider_settings.update',
      input,
      'user',
      'POST',
      options.signal,
    );
  }
  patchConfiguration(
    scope: 'user' | 'workspace',
    input: ConfigurationPatchRequest,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.writeManagement(
      `/v1/config/${scope}`,
      'ConfigurationPatchRequest',
      'config.patch',
      input,
      scope,
      'PATCH',
      options.signal,
    );
  }
  repairConfiguration(
    scope: 'user' | 'workspace',
    input: ConfigurationRepairRequest,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.writeManagement(
      `/v1/config/${scope}/repair`,
      'ConfigurationRepairRequest',
      'config.repair',
      input,
      scope,
      'POST',
      options.signal,
    );
  }
  putCredential(input: CredentialPutRequest, options: { signal?: AbortSignal } = {}) {
    return this.writeManagement(
      '/v1/credentials',
      'CredentialPutRequest',
      'credential.put',
      input,
      'user',
      'POST',
      options.signal,
    );
  }
  revokeCredential(
    opaqueRef: string,
    input: CredentialRevokeRequest,
    options: { signal?: AbortSignal } = {},
  ) {
    if (!/^credential:[0-9a-f-]{36}$/.test(opaqueRef)) throw new ClientError('invalid_request');
    return this.writeManagement(
      `/v1/credentials/${encodeURIComponent(opaqueRef)}/revoke`,
      'CredentialRevokeRequest',
      'credential.revoke',
      input,
      'user',
      'POST',
      options.signal,
      opaqueRef,
    );
  }

  private permissionStore(
    storeId: string,
    capability: 'permission_controls' | 'sessions' = 'permission_controls',
  ): void {
    this.requireCapability(capability);
    validateRequest('PermissionControlQuery', { storeId });
    if (storeId !== this.lastServer!.storeId) throw new ClientError('store_identity_mismatch');
  }

  private permissionRevision(value: string, code: 'invalid_request' | 'invalid_response'): void {
    try {
      parseCursorSequence(value);
    } catch {
      throw new ClientError(code);
    }
  }

  private async readPermission<
    K extends
      | 'PermissionModeState'
      | 'WorkspaceTrustState'
      | 'PermissionMutation'
      | 'WorkspaceRemoval',
  >(
    path: string,
    shape: K,
    storeId: string,
    verify: (result: Responses[K]) => void | Promise<void>,
    signal?: AbortSignal,
    capability: 'permission_controls' | 'sessions' = 'permission_controls',
  ): Promise<Responses[K]> {
    this.permissionStore(storeId, capability);
    const generation = this.connectionGeneration;
    await this.verifyConnection({ signal });
    const result = await this.fetchJSON(`${path}?${new URLSearchParams({ storeId })}`, shape, {
      signal,
    });
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    await verify(result);
    await this.verifyConnection({ signal });
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    return result;
  }

  getPermissionMode(sessionId: string, options: { storeId: string; signal?: AbortSignal }) {
    return this.readPermission(
      `/v1/sessions/${encodeURIComponent(sessionId)}/permission-mode`,
      'PermissionModeState',
      options.storeId,
      (result) => {
        if (result.storeId !== options.storeId || result.sessionId !== sessionId)
          throw new ClientError('permission_scope_mismatch');
        this.permissionRevision(result.revision, 'invalid_response');
        this.permissionRevision(result.defaultRevision, 'invalid_response');
      },
      options.signal,
    );
  }

  getWorkspaceTrust(workspaceId: string, options: { storeId: string; signal?: AbortSignal }) {
    return this.readPermission(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/trust`,
      'WorkspaceTrustState',
      options.storeId,
      (result) => {
        if (result.storeId !== options.storeId || result.workspaceId !== workspaceId)
          throw new ClientError('permission_scope_mismatch');
        if (result.trusted !== (result.status === 'trusted'))
          throw new ClientError('invalid_response');
        this.permissionRevision(result.revision, 'invalid_response');
      },
      options.signal,
    );
  }

  private verifyPermissionMutation(
    result: PermissionMutation,
    commandId: string,
    kind?: PermissionMutation['kind'],
  ): void {
    if (result.commandId !== commandId || (kind !== undefined && result.kind !== kind))
      throw new ClientError('permission_scope_mismatch');
    if (result.state === 'applied') {
      this.permissionRevision(result.receipt.revision, 'invalid_response');
      if (result.kind === 'permission.mode') {
        this.permissionRevision(result.receipt.defaultRevision, 'invalid_response');
        if (
          result.receipt.makeDefault &&
          result.receipt.defaultRevision !== result.receipt.revision
        )
          throw new ClientError('invalid_response');
      }
    }
  }

  private async setPermission(
    path: string,
    shape: 'SetPermissionModeRequest' | 'SetWorkspaceTrustRequest' | 'ClearPermissionGrantsRequest',
    kind: PermissionMutation['kind'],
    input: SetPermissionModeRequest | SetWorkspaceTrustRequest | ClearPermissionGrantsRequest,
    signal?: AbortSignal,
  ) {
    this.permissionStore(input.expectedStoreId);
    const intent = structuredClone(input);
    validateRequest(shape, intent);
    this.permissionRevision(intent.ifRevision, 'invalid_request');
    if ('ifDefaultRevision' in intent)
      this.permissionRevision(intent.ifDefaultRevision, 'invalid_request');
    const generation = this.connectionGeneration;
    await this.verifyConnection({ signal });
    // Send this user choice once, with its original Store, command ID and observed revisions.
    const result = await this.fetchJSON(path, 'PermissionMutation', {
      method: 'POST',
      body: intent,
      signal,
    }).catch((error: unknown) => {
      if (error instanceof ClientError && error.code === 'invalid_response')
        throw new ClientError(
          'network_outcome_unknown',
          'No valid mutation receipt was received; query the original command identity.',
        );
      throw error;
    });
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    this.verifyPermissionMutation(result, intent.commandId, kind);
    if (result.state === 'applied') {
      if (
        (result.kind === 'permission.mode' &&
          (!('mode' in intent) ||
            result.receipt.mode !== intent.mode ||
            result.receipt.makeDefault !== intent.makeDefault)) ||
        (result.kind === 'workspace.trust' &&
          (!('trusted' in intent) ||
            result.receipt.trusted !== intent.trusted ||
            result.receipt.canonicalIdentity !== intent.canonicalIdentity ||
            result.receipt.externalReadScopeDigest !== intent.externalReadScopeDigest)) ||
        BigInt(result.receipt.revision) <= BigInt(intent.ifRevision)
      )
        throw new ClientError('permission_scope_mismatch');
    }
    await this.verifyConnection({ signal });
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    return result;
  }

  setPermissionMode(
    sessionId: string,
    input: SetPermissionModeRequest,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.setPermission(
      `/v1/sessions/${encodeURIComponent(sessionId)}/permission-mode`,
      'SetPermissionModeRequest',
      'permission.mode',
      input,
      options.signal,
    );
  }

  setWorkspaceTrust(
    workspaceId: string,
    input: SetWorkspaceTrustRequest,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.setPermission(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/trust`,
      'SetWorkspaceTrustRequest',
      'workspace.trust',
      input,
      options.signal,
    );
  }

  async listPermissionGrants(
    sessionId: string,
    input: import('./generated/api').PermissionGrantQuery,
    options: { signal?: AbortSignal } = {},
  ) {
    this.requireCapability('permission_grants');
    this.permissionStore(input.storeId);
    const frozen = structuredClone(input),
      generation = this.connectionGeneration;
    validateRequest('PermissionGrantQuery', frozen);
    options.signal?.throwIfAborted();
    for (const value of [frozen.afterSeq, frozen.upperSeq])
      if (value !== undefined) this.permissionRevision(value, 'invalid_request');
    await this.verifyConnection(options);
    const query = new URLSearchParams(
      Object.entries(frozen)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );
    const page = await this.fetchJSON(
      `/v1/sessions/${encodeURIComponent(sessionId)}/permission-grants?${query}`,
      'PermissionGrantPage',
      options,
    );
    options.signal?.throwIfAborted();
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    this.permissionRevision(page.revision, 'invalid_response');
    this.permissionRevision(page.snapshotCursor, 'invalid_response');
    if (
      page.sessionId !== sessionId ||
      page.items.some(
        ({ grant }) =>
          grant.originStoreId !== frozen.storeId ||
          grant.sessionId !== sessionId ||
          grant.id !== grant.interactionId,
      )
    )
      throw new ClientError('permission_scope_mismatch');
    for (const { grant } of page.items)
      this.permissionRevision(grant.decisionRevision, 'invalid_response');
    validateDirectoryPage(page, frozen.storeId, frozen);
    await this.verifyConnection(options);
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    return page;
  }

  async listAllPermissionGrants(
    sessionId: string,
    input: { storeId: string },
    options: { signal?: AbortSignal } = {},
  ) {
    const frozen = structuredClone(input);
    this.permissionStore(frozen.storeId);
    validateRequest('PermissionControlQuery', frozen);
    let revision: string | undefined;
    return collectDirectory(
      async (page) => {
        const result = await this.listPermissionGrants(
          sessionId,
          {
            storeId: frozen.storeId,
            limit: page.limit,
            ...(page.afterSeq !== undefined ? { afterSeq: page.afterSeq } : {}),
            ...(page.upperSeq !== undefined ? { upperSeq: page.upperSeq } : {}),
          },
          options,
        );
        revision ??= result.revision;
        if (result.revision !== revision) throw new ClientError('directory_snapshot_changed');
        return result;
      },
      options.signal,
      (item) => item.grant.id,
    );
  }

  async clearPermissionGrants(
    sessionId: string,
    input: ClearPermissionGrantsRequest,
    options: { signal?: AbortSignal } = {},
  ) {
    this.requireCapability('permission_grants');
    const result = await this.setPermission(
      `/v1/sessions/${encodeURIComponent(sessionId)}/permission-grants`,
      'ClearPermissionGrantsRequest',
      'permission.grants.clear',
      input,
      options.signal,
    );
    if (
      result.state === 'applied' &&
      result.kind === 'permission.grants.clear' &&
      result.receipt.sessionId !== sessionId
    )
      throw new ClientError('permission_scope_mismatch');
    return result;
  }

  getPermissionMutation(commandId: string, options: { storeId: string; signal?: AbortSignal }) {
    return this.readPermission(
      `/v1/permissions/mutations/${encodeURIComponent(commandId)}`,
      'PermissionMutation',
      options.storeId,
      (result) => this.verifyPermissionMutation(result, commandId),
      options.signal,
    );
  }

  getWorkspace(workspaceId: string, options: { signal?: AbortSignal } = {}) {
    this.requireConnection();
    return this.fetchJSON(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}`,
      'Workspace',
      options,
    );
  }
  createWorkspace(input: CreateWorkspaceRequest, options: { signal?: AbortSignal } = {}) {
    return this.mutate(
      '/v1/workspaces',
      'CreateWorkspaceRequest',
      'Workspace',
      input,
      options.signal,
    );
  }
  private async verifyWorkspaceRemoval(
    result: WorkspaceRemoval,
    workspaceId: string,
    commandId: string,
    storeId: string,
  ) {
    const digest = await digestModelBody(
      new TextEncoder().encode(canonicalModelBody({ kind: 'workspace.remove', workspaceId })),
    );
    if (
      result.requestDigest !== digest ||
      result.workspaceId !== workspaceId ||
      result.commandId !== commandId ||
      result.originStoreId !== storeId ||
      result.subjectId !== this.lastServer?.subjectId ||
      result.deletedSessions < result.deletedRoots
    )
      throw new ClientError('workspace_scope_mismatch');
  }
  async removeWorkspace(
    workspaceId: string,
    input: RemoveWorkspaceRequest,
    options: { signal?: AbortSignal } = {},
  ) {
    this.requireCapability('sessions');
    const intent = structuredClone(input);
    const result = await this.mutate(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/remove`,
      'RemoveWorkspaceRequest',
      'WorkspaceRemoval',
      intent,
      options.signal,
    );
    await this.verifyWorkspaceRemoval(
      result,
      workspaceId,
      intent.commandId,
      intent.expectedStoreId,
    );
    return result;
  }
  getWorkspaceRemoval(
    workspaceId: string,
    commandId: string,
    options: { storeId: string; signal?: AbortSignal },
  ) {
    const { storeId, signal } = options;
    return this.readPermission(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/removals/${encodeURIComponent(commandId)}`,
      'WorkspaceRemoval',
      storeId,
      (result) => this.verifyWorkspaceRemoval(result, workspaceId, commandId, storeId),
      signal,
      'sessions',
    );
  }
  createSession(input: CreateSessionRequest, options: { signal?: AbortSignal } = {}) {
    return this.mutate('/v1/sessions', 'CreateSessionRequest', 'Session', input, options.signal);
  }
  async resumeRun(
    sessionId: string,
    input: ResumeRunRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ResumeRunResponse> {
    this.requireCapability('run_resume');
    const target = structuredClone({ sessionId }),
      intent = structuredClone(input);
    validateRequest('ResumeRunTarget', target);
    validateRequest('ResumeRunRequest', intent);
    if (intent.expectedStoreId !== this.serverInfo!.storeId)
      throw new ClientError('store_identity_mismatch');
    const generation = this.connectionGeneration;
    const result = await this.mutate(
      `/v1/sessions/${encodeURIComponent(target.sessionId)}/commands`,
      'ResumeRunRequest',
      'ResumeRunResponse',
      intent,
      options.signal,
    ).catch((error: unknown) => {
      if (
        error instanceof ClientError &&
        ['invalid_response', 'response_too_large'].includes(error.code)
      )
        throw new ClientError(
          'network_outcome_unknown',
          'Query the original Run resume command identity.',
        );
      throw error;
    });
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    if (
      result.id !== intent.commandId ||
      result.sessionId !== target.sessionId ||
      result.originStoreId !== intent.expectedStoreId ||
      (result.status === 'applied' && result.receipt.runId !== intent.runId)
    )
      throw new ClientError(
        'network_outcome_unknown',
        'The original Run resume receipt did not verify.',
      );
    return result;
  }
  async recoverSession(
    sessionId: string,
    input: RecoverSessionRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<RecoverSessionResponse> {
    this.requireCapability('session_recovery');
    const target = structuredClone({ sessionId }),
      intent = structuredClone(input);
    validateRequest('RecoverSessionTarget', target);
    validateRequest('RecoverSessionRequest', intent);
    if (intent.expectedStoreId !== this.serverInfo!.storeId)
      throw new ClientError('store_identity_mismatch');
    const generation = this.connectionGeneration;
    const result = await this.mutate(
      `/v1/sessions/${encodeURIComponent(target.sessionId)}/commands`,
      'RecoverSessionRequest',
      'RecoverSessionResponse',
      intent,
      options.signal,
    )
      .then(decodeSessionRecoveryCommand)
      .catch((error: unknown) => {
        if (
          error instanceof ClientError &&
          ['invalid_response', 'response_too_large'].includes(error.code)
        )
          throw new ClientError(
            'network_outcome_unknown',
            'Query the original Session recovery command identity.',
          );
        throw error;
      });
    if (
      generation !== this.connectionGeneration ||
      result.id !== intent.commandId ||
      result.sessionId !== target.sessionId ||
      result.originStoreId !== intent.expectedStoreId ||
      result.receipt.sessionId !== target.sessionId ||
      result.receipt.storeId !== intent.expectedStoreId
    )
      throw new ClientError(
        'network_outcome_unknown',
        'The original Session recovery receipt did not verify.',
      );
    return result;
  }
  async reconcileJob(
    sessionId: string,
    input: ReconcileJobRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<JobReconcileCommand> {
    this.requireCapability('job_reconcile');
    const target = structuredClone({ sessionId }),
      intent = structuredClone(input);
    validateRequest('ReconcileJobTarget', target);
    validateRequest('ReconcileJobRequest', intent);
    if (intent.expectedStoreId !== this.serverInfo!.storeId)
      throw new ClientError('store_identity_mismatch');
    const generation = this.connectionGeneration;
    const result = await this.mutate(
      `/v1/sessions/${encodeURIComponent(target.sessionId)}/commands`,
      'ReconcileJobRequest',
      'JobReconcileCommand',
      intent,
      options.signal,
    ).catch((error: unknown) => {
      if (
        error instanceof ClientError &&
        ['invalid_response', 'response_too_large'].includes(error.code)
      )
        throw new ClientError(
          'network_outcome_unknown',
          'Query the original Job reconcile command identity.',
        );
      throw error;
    });
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    if (
      result.id !== intent.commandId ||
      result.sessionId !== target.sessionId ||
      result.originStoreId !== intent.expectedStoreId ||
      (result.status === 'applied' &&
        (result.receipt.executionId !== intent.executionId ||
          result.receipt.resultRevision !== intent.expectedResultRevision))
    )
      throw new ClientError(
        'network_outcome_unknown',
        'The original Job reconcile receipt did not verify.',
      );
    return result;
  }
  async resumeJobReport(
    sessionId: string,
    reportCommandId: string,
    input: ResumeJobReportRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ResumeJobReportResponse> {
    this.requireCapability('job_report_resume');
    const target = structuredClone({ sessionId, reportCommandId }),
      intent = structuredClone(input);
    validateRequest('ResumeJobReportTarget', target);
    validateRequest('ResumeJobReportRequest', intent);
    if (intent.expectedStoreId !== this.serverInfo!.storeId)
      throw new ClientError('store_identity_mismatch');
    const generation = this.connectionGeneration;
    const result = await this.mutate(
      `/v1/sessions/${encodeURIComponent(target.sessionId)}/job-reports/${encodeURIComponent(target.reportCommandId)}/resume`,
      'ResumeJobReportRequest',
      'ResumeJobReportResponse',
      intent,
      options.signal,
    ).catch((error: unknown) => {
      if (
        error instanceof ClientError &&
        ['invalid_response', 'response_too_large'].includes(error.code)
      )
        throw new ClientError(
          'network_outcome_unknown',
          'Query the original Job report resume command identity.',
        );
      throw error;
    });
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    if (
      result.id !== intent.commandId ||
      result.sessionId !== target.sessionId ||
      result.originStoreId !== intent.expectedStoreId ||
      result.receipt.reportCommandId !== target.reportCommandId
    )
      throw new ClientError(
        'network_outcome_unknown',
        'The original Job report resume receipt did not verify.',
      );
    return result;
  }
  startRun(
    sessionId: string,
    input: StartCommandRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<Command> {
    return this.mutate(
      `/v1/sessions/${encodeURIComponent(sessionId)}/commands`,
      'StartCommandRequest',
      'Command',
      input,
      options.signal,
    );
  }
  cancelCommand(
    sessionId: string,
    input: CancelCommandRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<Command> {
    return this.mutate(
      `/v1/sessions/${encodeURIComponent(sessionId)}/commands`,
      'CancelCommandRequest',
      'Command',
      input,
      options.signal,
    );
  }
  cancelRun(
    sessionId: string,
    input: CancelRunRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<Command> {
    return this.mutate(
      `/v1/sessions/${encodeURIComponent(sessionId)}/commands`,
      'CancelRunRequest',
      'Command',
      input,
      options.signal,
    );
  }
  cancelExecution(
    sessionId: string,
    input: CancelExecutionRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<Command> {
    return this.mutate(
      `/v1/sessions/${encodeURIComponent(sessionId)}/commands`,
      'CancelExecutionRequest',
      'Command',
      input,
      options.signal,
    );
  }
  cancelSession(
    sessionId: string,
    input: CancelSessionRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<Command> {
    return this.mutate(
      `/v1/sessions/${encodeURIComponent(sessionId)}/commands`,
      'CancelSessionRequest',
      'Command',
      input,
      options.signal,
    );
  }
  getView(sessionId: string, options: { signal?: AbortSignal } = {}) {
    this.requireConnection();
    return this.fetchJSON(
      `/v1/sessions/${encodeURIComponent(sessionId)}/view`,
      'SessionView',
      options,
    );
  }
  /** Read knowledge and optional manual Workflow metadata; never activates or authorizes a Skill. */
  async listSkills(
    workspaceId: string,
    options: {
      storeId: string;
      workflow?: 'manual';
      afterId?: string;
      revision?: string;
      limit?: number;
      byteLimit?: number;
      signal?: AbortSignal;
    },
  ): Promise<SkillCataloguePage> {
    this.requireCapability('skill_catalogue');
    const { signal, ...input } = options;
    const frozen = structuredClone(input);
    validateRequest('SkillCatalogueQuery', frozen);
    if (frozen.workflow) this.requireCapability('skill_workflow_catalogue');
    validateRequest('HostStatusQuery', { workspaceId });
    if (frozen.afterId && !frozen.revision) throw new ClientError('invalid_skill_catalogue_query');
    if (this.lastServer!.storeId !== frozen.storeId)
      throw new ClientError('store_identity_mismatch');
    const generation = this.connectionGeneration;
    signal?.throwIfAborted();
    await this.verifyConnection({ signal });
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    const query = new URLSearchParams(
      Object.entries(frozen)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );
    const page = await this.fetchJSON(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/skills?${query}`,
      'SkillCataloguePage',
      { signal },
    );
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    if (page.storeId !== frozen.storeId || page.workspaceId !== workspaceId)
      throw new ClientError('skill_catalogue_identity_mismatch');
    if (frozen.revision && page.revision !== frozen.revision)
      throw new ClientError('skill_catalogue_changed');
    signal?.throwIfAborted();
    this.requireConnection();
    const verified = verifySkillCataloguePage(page, { ...frozen, workspaceId });
    await this.verifyConnection({ signal });
    signal?.throwIfAborted();
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    return verified;
  }
  async listAllSkills(
    workspaceId: string,
    options: { storeId: string; workflow?: 'manual'; signal?: AbortSignal },
  ): Promise<SkillCataloguePage> {
    const frozen = {
      storeId: options.storeId,
      ...(options.workflow ? { workflow: options.workflow } : {}),
      signal: options.signal,
    };
    const generation = this.connectionGeneration;
    frozen.signal?.throwIfAborted();
    let page = await this.listSkills(workspaceId, frozen);
    frozen.signal?.throwIfAborted();
    const first = page;
    const entries = [...page.entries];
    while (!page.complete) {
      frozen.signal?.throwIfAborted();
      if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
      page = await this.listSkills(workspaceId, {
        ...frozen,
        afterId: page.nextAfterId!,
        revision: first.revision,
      });
      frozen.signal?.throwIfAborted();
      if (page.availability !== first.availability || page.reason !== first.reason)
        throw new ClientError('skill_catalogue_changed');
      entries.push(...page.entries);
    }
    frozen.signal?.throwIfAborted();
    this.requireConnection();
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    return { ...first, entries, complete: true, nextAfterId: null };
  }
  /** Read actual host composition without creating work or changing the observation stream. */
  async getHostStatus(
    options: { workspaceId?: string; sessionId?: string; signal?: AbortSignal } = {},
  ): Promise<HostStatus> {
    this.requireConnection(false);
    if (!this.lastServer!.capabilities.includes('host_status'))
      throw new ClientError('capability_unavailable');
    const { signal, ...scope } = options;
    const target = structuredClone(scope);
    validateRequest('HostStatusQuery', target);
    const admitted = structuredClone(this.lastServer!);
    const generation = this.connectionGeneration;
    const query = new URLSearchParams();
    if (target.workspaceId !== undefined) query.set('workspaceId', target.workspaceId);
    if (target.sessionId !== undefined) query.set('sessionId', target.sessionId);
    const status = await this.fetchJSON(
      `/v1/diagnostics/host-status${query.size ? `?${query}` : ''}`,
      'HostStatus',
      { signal },
    );
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    if (
      status.identity.instanceId !== admitted.instanceId ||
      status.identity.buildId !== admitted.buildId ||
      status.identity.apiMajor !== admitted.apiMajor ||
      status.identity.profileAccessKey !== admitted.profile.accessKey
    )
      throw new ClientError('connection_identity_mismatch');
    if (
      status.identity.storeId !== (admitted.storeId ?? null) ||
      status.identity.dataAvailability !== admitted.dataAvailability
    )
      throw new ClientError('store_identity_mismatch');
    if (
      status.scope.workspaceId !== (target.workspaceId ?? null) ||
      status.scope.sessionId !== (target.sessionId ?? null)
    )
      throw new ClientError('diagnostic_scope_mismatch');
    return status;
  }
  private async readExport<K extends keyof Responses>(
    sessionId: string,
    operation: 'manifest' | 'records' | 'text' | 'verify',
    requestShape: Parameters<typeof validateRequest>[0],
    responseShape: K,
    input: BeginSessionExportQuery & { manifest?: SessionExportManifest },
    options: { signal?: AbortSignal },
  ): Promise<Responses[K]> {
    this.requireCapability('session_exports');
    const query = structuredClone(input),
      generation = this.connectionGeneration;
    validateRequest(requestShape, query);
    if (query.storeId !== this.lastServer!.storeId)
      throw new ClientError('store_identity_mismatch');
    if (query.manifest) verifySessionExportManifest(query.manifest, query.storeId, sessionId);
    const response = await this.fetchJSON(
      `/v1/sessions/${encodeURIComponent(sessionId)}/export/${operation}?${sessionExportParameters(query)}`,
      responseShape,
      options,
    );
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    return response;
  }
  async beginSessionExport(
    sessionId: string,
    input: BeginSessionExportQuery,
    options: { signal?: AbortSignal } = {},
  ) {
    const query = structuredClone(input);
    return verifySessionExportManifest(
      await this.readExport(
        sessionId,
        'manifest',
        'BeginSessionExportQuery',
        'SessionExportManifest',
        query,
        options,
      ),
      query.storeId,
      sessionId,
    );
  }
  async readSessionExportPage(
    sessionId: string,
    input: SessionExportPageQuery,
    options: { signal?: AbortSignal } = {},
  ) {
    const query = structuredClone(input);
    return verifySessionExportPage(
      await this.readExport(
        sessionId,
        'records',
        'SessionExportPageQuery',
        'SessionExportPage',
        query,
        options,
      ),
      query,
    );
  }
  async readSessionExportText(
    sessionId: string,
    input: SessionExportTextQuery,
    options: { signal?: AbortSignal } = {},
  ) {
    const query = structuredClone(input);
    return verifySessionExportTextPage(
      await this.readExport(
        sessionId,
        'text',
        'SessionExportTextQuery',
        'SessionExportTextPage',
        query,
        options,
      ),
      query,
    );
  }
  async verifySessionExport(
    sessionId: string,
    input: VerifySessionExportQuery,
    options: { signal?: AbortSignal } = {},
  ) {
    const query = structuredClone(input);
    return verifySessionExportCompletion(
      await this.readExport(
        sessionId,
        'verify',
        'VerifySessionExportQuery',
        'SessionExportCompletion',
        query,
        options,
      ),
      query.manifest,
    );
  }
  /** Explicit raw-record stream; media are original-scope references, never a backup claim. */
  exportSession(
    sessionId: string,
    input: BeginSessionExportQuery,
    options: { signal?: AbortSignal } = {},
  ) {
    this.requireCapability('session_exports');
    const query = structuredClone(input),
      generation = this.connectionGeneration,
      signal = options.signal;
    validateRequest('BeginSessionExportQuery', query);
    if (query.storeId !== this.lastServer!.storeId)
      throw new ClientError('store_identity_mismatch');
    const check = () => {
      this.requireCapability('session_exports');
      if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    };
    return streamSessionExport(
      {
        check,
        begin: () => this.beginSessionExport(sessionId, query, { signal }),
        page: (page) =>
          this.readSessionExportPage(sessionId, { ...page, storeId: query.storeId }, { signal }),
        text: (text) =>
          this.readSessionExportText(sessionId, { ...text, storeId: query.storeId }, { signal }),
        verify: (manifest) =>
          this.verifySessionExport(sessionId, { manifest, storeId: query.storeId }, { signal }),
      },
      { signal },
    );
  }
  getContext(sessionId: string, input: ContextQuery, options: { signal?: AbortSignal } = {}) {
    this.requireCapability('context');
    const query = structuredClone(input);
    validateRequest('ContextQuery', query);
    for (const cursor of [query.afterSeq, query.upperSeq])
      if (cursor !== undefined) parseCursorSequence(cursor);
    const params = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    );
    return this.fetchJSON(
      `/v1/sessions/${encodeURIComponent(sessionId)}/context?${params}`,
      'SelectedContextPage',
      options,
    ).then((page) => verifyContextCompression(page, sessionId));
  }
  rewind(sessionId: string, input: SelectContextRequest, options: { signal?: AbortSignal } = {}) {
    return this.mutate(
      `/v1/sessions/${encodeURIComponent(sessionId)}/context/select`,
      'SelectContextRequest',
      'SelectContextResponse',
      input,
      options.signal,
    );
  }
  compressContext(
    sessionId: string,
    input: CompressContextRequest,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.maintainContext('compress', sessionId, input, options.signal);
  }
  resetCompressionContext(
    sessionId: string,
    input: ResetCompressionRequest,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.maintainContext('reset', sessionId, input, options.signal);
  }
  private async maintainContext(
    operation: 'compress' | 'reset',
    sessionId: string,
    input: CompressContextRequest | ResetCompressionRequest,
    signal?: AbortSignal,
  ) {
    this.requireCapability('context');
    this.requireCapability('commands');
    const intent = structuredClone(input);
    const shape = operation === 'compress' ? 'CompressContextRequest' : 'ResetCompressionRequest';
    validateRequest(shape, intent);
    if (intent.expectedStoreId !== this.serverInfo!.storeId)
      throw new ClientError('store_identity_mismatch');
    const generation = this.connectionGeneration;
    const result = await this.mutate(
      `/v1/sessions/${encodeURIComponent(sessionId)}/context/${operation === 'compress' ? 'compress' : 'compression/reset'}`,
      shape,
      'Command',
      intent,
      signal,
    ).catch((error: unknown) => {
      if (error instanceof ClientError && error.code === 'invalid_response')
        throw new ClientError(
          'network_outcome_unknown',
          'Query the original Context command identity.',
        );
      throw error;
    });
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    if (
      result.id !== intent.commandId ||
      result.sessionId !== sessionId ||
      result.originStoreId !== intent.expectedStoreId ||
      result.kind !== (operation === 'compress' ? 'context.compress' : 'context.compression.reset')
    )
      throw new ClientError(
        'network_outcome_unknown',
        'The original Context receipt did not verify.',
      );
    return result;
  }
  async forkSession(
    sourceSessionId: string,
    input: ForkSessionRequest,
    options: { signal?: AbortSignal } = {},
  ) {
    this.requireCapability('context');
    this.requireCapability('sessions');
    const intent = structuredClone(input);
    validateRequest('ForkSessionRequest', intent);
    if (intent.boundary) parseCursorSequence(intent.boundary.seq);
    if (intent.expectedStoreId !== this.serverInfo!.storeId)
      throw new ClientError('store_identity_mismatch');
    const generation = this.connectionGeneration;
    const result = await this.mutate(
      `/v1/sessions/${encodeURIComponent(sourceSessionId)}/fork`,
      'ForkSessionRequest',
      'ForkSessionResponse',
      intent,
      options.signal,
    ).catch((error: unknown) => {
      if (error instanceof ClientError && error.code === 'invalid_response')
        throw new ClientError(
          'network_outcome_unknown',
          'Query the original fork command identity.',
        );
      throw error;
    });
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    const receipt = result.command.receipt;
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      Array.isArray(receipt) ||
      result.command.id !== intent.commandId ||
      result.command.originStoreId !== intent.expectedStoreId ||
      result.command.sessionId !== intent.newSessionId ||
      result.command.kind !== 'session.create' ||
      result.command.status !== 'applied' ||
      result.session.id !== intent.newSessionId ||
      result.session.title !== intent.title ||
      result.session.rootSessionId !== intent.newSessionId ||
      result.session.parentSessionId !== null ||
      result.session.deletedAt !== null ||
      result.selection.sessionId !== intent.newSessionId ||
      result.selection.id !== result.session.contextSelectionId ||
      result.selection.previousSelectionId !== null ||
      receipt.sessionId !== intent.newSessionId ||
      receipt.selectionId !== result.selection.id ||
      receipt.sourceSessionId !== sourceSessionId ||
      receipt.sourceSelectionId !== intent.expectedContextSelectionId ||
      receipt.sourceUpperSeq !== result.selection.boundarySeq ||
      (intent.boundary !== undefined && receipt.sourceUpperSeq !== (intent.boundary?.seq ?? '0')) ||
      receipt.omittedExtensionState !== result.omittedExtensionState ||
      canonicalModelBody(receipt.namespaceReport ?? null) !==
        canonicalModelBody(result.namespaceReport ?? null)
    )
      throw new ClientError('network_outcome_unknown', 'The original fork receipt did not verify.');
    let invalidBoundary: boolean;
    try {
      invalidBoundary =
        parseCursorSequence(result.session.nextSeq) <
        parseCursorSequence(result.selection.boundarySeq);
    } catch {
      invalidBoundary = true;
    }
    if (invalidBoundary)
      throw new ClientError(
        'network_outcome_unknown',
        'The original fork boundary did not verify.',
      );
    return result;
  }
  renameSession(
    sessionId: string,
    input: RenameSessionRequest,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.manageSession('rename', sessionId, input, options.signal);
  }
  deleteSession(
    sessionId: string,
    input: DeleteSessionRequest,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.manageSession('delete', sessionId, input, options.signal);
  }
  private async manageSession(
    operation: 'rename' | 'delete',
    sessionId: string,
    input: RenameSessionRequest | DeleteSessionRequest,
    signal?: AbortSignal,
  ) {
    this.requireCapability('sessions');
    const intent = structuredClone(input);
    const shape = operation === 'rename' ? 'RenameSessionRequest' : 'DeleteSessionRequest';
    validateRequest(shape, intent);
    const expectedRevision = parseCursorSequence(intent.ifRevision);
    if (operation === 'rename' && !(intent as RenameSessionRequest).title.trim())
      throw new ClientError('invalid_request');
    if (intent.expectedStoreId !== this.serverInfo!.storeId)
      throw new ClientError('store_identity_mismatch');
    const generation = this.connectionGeneration;
    const result = await this.mutate(
      `/v1/sessions/${encodeURIComponent(sessionId)}/${operation}`,
      shape,
      'SessionMutationResponse',
      intent,
      signal,
    ).catch((error: unknown) => {
      if (error instanceof ClientError && error.code === 'invalid_response')
        throw new ClientError(
          'network_outcome_unknown',
          'Query the original Session command identity.',
        );
      throw error;
    });
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    const receipt = result.command.receipt;
    try {
      parseCursorSequence(result.session.controlRevision);
      parseCursorSequence(result.session.nextSeq);
    } catch {
      throw new ClientError(
        'network_outcome_unknown',
        'The original Session revision did not verify.',
      );
    }
    const saved =
      receipt && typeof receipt === 'object' && !Array.isArray(receipt)
        ? receipt.session
        : undefined;
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      Array.isArray(receipt) ||
      !saved ||
      typeof saved !== 'object' ||
      Array.isArray(saved) ||
      result.command.id !== intent.commandId ||
      result.command.originStoreId !== intent.expectedStoreId ||
      result.command.sessionId !== sessionId ||
      result.command.kind !== `session.${operation}` ||
      result.command.status !== 'applied' ||
      result.session.id !== sessionId ||
      result.session.rootSessionId !== sessionId ||
      result.session.parentSessionId !== null ||
      result.session.controlRevision !== String(expectedRevision + 1n) ||
      receipt.outcome !== (operation === 'rename' ? 'renamed' : 'delete_requested') ||
      (
        [
          'id',
          'workspaceId',
          'parentSessionId',
          'rootSessionId',
          'title',
          'controlRevision',
          'contextSelectionId',
          'nextSeq',
          'deletedAt',
        ] as const
      ).some((key) => !(key in saved) || saved[key] !== result.session[key]) ||
      (operation === 'rename'
        ? result.session.title !== (intent as RenameSessionRequest).title ||
          result.session.deletedAt !== null
        : receipt.stopConfirmed !== false ||
          result.session.deletedAt === null ||
          result.session.deletedAt <= 0)
    )
      throw new ClientError(
        'network_outcome_unknown',
        'The original Session receipt did not verify.',
      );
    return result;
  }
  includeResult(
    sessionId: string,
    executionId: string,
    input: IncludeResultRequest,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.mutate(
      `/v1/sessions/${encodeURIComponent(sessionId)}/results/${encodeURIComponent(executionId)}/include`,
      'IncludeResultRequest',
      'IncludeResultResponse',
      input,
      options.signal,
    );
  }
  steer(sessionId: string, input: SteerCommandRequest, options: { signal?: AbortSignal } = {}) {
    this.requireCapability('commands');
    return this.mutate(
      `/v1/sessions/${encodeURIComponent(sessionId)}/commands`,
      'SteerCommandRequest',
      'Command',
      input,
      options.signal,
    );
  }
  followUp(
    sessionId: string,
    input: FollowUpCommandRequest,
    options: { signal?: AbortSignal } = {},
  ) {
    this.requireCapability('commands');
    return this.mutate(
      `/v1/sessions/${encodeURIComponent(sessionId)}/commands`,
      'FollowUpCommandRequest',
      'Command',
      input,
      options.signal,
    );
  }
  listPendingInputs(
    sessionId: string,
    input: InputListQuery,
    options: { signal?: AbortSignal } = {},
  ) {
    this.requireCapability('inputs');
    const query = structuredClone(input);
    validateRequest('InputListQuery', query);
    if (query.afterSeq !== undefined) parseCursorSequence(query.afterSeq);
    const params = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    );
    return this.fetchJSON(
      `/v1/sessions/${encodeURIComponent(sessionId)}/inputs?${params}`,
      'PendingInputPage',
      options,
    );
  }
  listInteractions(
    sessionId: string,
    input: InteractionListQuery,
    options: { signal?: AbortSignal } = {},
  ) {
    this.requireCapability('interactions');
    const query = structuredClone(input);
    validateRequest('InteractionListQuery', query);
    const params = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    );
    return this.fetchJSON(
      `/v1/sessions/${encodeURIComponent(sessionId)}/interactions?${params}`,
      'InteractionPage',
      options,
    );
  }
  getInteraction(
    sessionId: string,
    interactionId: string,
    input: Pick<InteractionListQuery, 'storeId' | 'origin'>,
    options: { signal?: AbortSignal } = {},
  ) {
    this.requireCapability('interactions');
    validateRequest('InteractionListQuery', input);
    return this.fetchJSON(
      `/v1/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}?${new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]))}`,
      'Interaction',
      options,
    );
  }
  answerInteraction(
    presentationSessionId: string,
    interactionId: string,
    input: AnswerInteractionRequest,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.mutate(
      `/v1/sessions/${encodeURIComponent(presentationSessionId)}/interactions/${encodeURIComponent(interactionId)}/answer`,
      'AnswerInteractionRequest',
      'Command',
      input,
      options.signal,
    );
  }
  getCommand(commandId: string, options: { signal?: AbortSignal } = {}) {
    this.requireCapability('commands');
    return this.fetchJSON(`/v1/commands/${encodeURIComponent(commandId)}`, 'Command', options);
  }
  getRun(runId: string, options: { signal?: AbortSignal } = {}) {
    this.requireCapability('commands');
    return this.fetchJSON(`/v1/runs/${encodeURIComponent(runId)}`, 'Run', options);
  }
  getExecution(executionId: string, options: { signal?: AbortSignal } = {}) {
    this.requireConnection();
    return this.fetchJSON(
      `/v1/executions/${encodeURIComponent(executionId)}`,
      'Execution',
      options,
    );
  }
  listSessionLogs(
    sessionId: string,
    options: {
      expectedStoreId?: string;
      afterCursor: string;
      upperCursor?: string;
      limit?: number;
      signal?: AbortSignal;
    },
  ) {
    this.requireCapability('session_logs');
    validateSessionLogTarget(sessionId);
    const { signal, expectedStoreId = this.lastServer!.storeId!, ...pagination } = options;
    const query = { storeId: expectedStoreId, ...pagination };
    validateRequest('SessionLogQuery', query);
    validateSessionLogBounds(pagination);
    if (expectedStoreId !== this.lastServer!.storeId)
      throw new ClientError('store_identity_mismatch');
    const generation = this.connectionGeneration;
    return this.fetchJSON(
      `/v1/sessions/${encodeURIComponent(sessionId)}/logs?${new URLSearchParams(
        Object.entries(query)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      )}`,
      'SessionLogPage',
      { signal },
    ).then((page) => {
      if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
      return verifySessionLogPage(page, { storeId: expectedStoreId, sessionId }, pagination);
    });
  }
  listModelInputs(
    sessionId: string,
    options: {
      expectedStoreId?: string;
      afterSeq?: string;
      upperSeq?: string;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ) {
    this.requireCapability('model_inputs');
    const { signal, expectedStoreId = this.lastServer!.storeId!, ...pagination } = options;
    const query = { storeId: expectedStoreId, ...pagination };
    validateRequest('ModelInputQuery', query);
    if (
      query.upperSeq !== undefined &&
      parseCursorSequence(query.afterSeq ?? '0') > parseCursorSequence(query.upperSeq)
    )
      throw new ClientError('invalid_page_bounds');
    const generation = this.connectionGeneration;
    return this.fetchJSON(
      `/v1/sessions/${encodeURIComponent(sessionId)}/model-inputs?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`,
      'ModelInputPage',
      { signal },
    ).then((page) => {
      if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
      return verifyModelInputPage(page, { storeId: expectedStoreId, sessionId }, pagination);
    });
  }
  async getModelInput(
    sessionId: string,
    executionId: string,
    options: { expectedStoreId?: string; signal?: AbortSignal } = {},
  ) {
    this.requireCapability('model_inputs');
    const storeId = options.expectedStoreId ?? this.lastServer!.storeId!;
    validateRequest('ModelInputQuery', { storeId });
    const generation = this.connectionGeneration;
    const snapshot = await this.fetchJSON(
      `/v1/sessions/${encodeURIComponent(sessionId)}/executions/${encodeURIComponent(executionId)}/model-input?${new URLSearchParams({ storeId })}`,
      'ModelInputSnapshot',
      { signal: options.signal },
    );
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    if (
      snapshot.storeId !== storeId ||
      snapshot.sessionId !== sessionId ||
      snapshot.executionId !== executionId
    )
      throw new ClientError('model_input_identity_mismatch');
    return snapshot;
  }
  async getModelOutput(
    sessionId: string,
    executionId: string,
    options: { expectedStoreId?: string; signal?: AbortSignal } = {},
  ) {
    this.requireCapability('model_outputs');
    const storeId = options.expectedStoreId ?? this.lastServer!.storeId!;
    validateRequest('ModelOutputQuery', { storeId });
    const generation = this.connectionGeneration;
    const snapshot = await this.fetchJSON(
      `/v1/sessions/${encodeURIComponent(sessionId)}/executions/${encodeURIComponent(executionId)}/model-output?${new URLSearchParams({ storeId })}`,
      'ModelOutputSnapshot',
      { signal: options.signal },
    );
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    if (
      snapshot.storeId !== storeId ||
      snapshot.sessionId !== sessionId ||
      snapshot.executionId !== executionId
    )
      throw new ClientError('model_output_identity_mismatch');
    return snapshot;
  }
  listExecutionOutput(
    executionId: string,
    options: { afterSeq?: string; upperSeq?: string; limit?: number; signal?: AbortSignal } = {},
  ) {
    this.requireConnection();
    const query = new URLSearchParams();
    const after = parseCursorSequence(options.afterSeq ?? '0');
    if (options.afterSeq !== undefined) query.set('afterSeq', options.afterSeq);
    if (options.upperSeq !== undefined) {
      if (parseCursorSequence(options.upperSeq) < after)
        throw new ClientError('invalid_page_bounds');
      query.set('upperSeq', options.upperSeq);
    }
    if (options.limit !== undefined) {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200)
        throw new ClientError('invalid_page_limit');
      query.set('limit', String(options.limit));
    }
    return this.fetchJSON(
      `/v1/executions/${encodeURIComponent(executionId)}/output?${query}`,
      'ExecutionOutputPage',
      { signal: options.signal },
    );
  }
  listMessages(
    sessionId: string,
    options: { afterSeq?: string; upperSeq?: string; limit?: number; signal?: AbortSignal } = {},
  ) {
    this.requireCapability('history');
    const query = new URLSearchParams();
    if (options.afterSeq !== undefined) {
      parseCursorSequence(options.afterSeq);
      query.set('afterSeq', options.afterSeq);
    }
    if (options.upperSeq !== undefined) {
      parseCursorSequence(options.upperSeq);
      query.set('upperSeq', options.upperSeq);
    }
    if (options.limit !== undefined) {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200)
        throw new ClientError('invalid_page_limit');
      query.set('limit', String(options.limit));
    }
    return this.fetchJSON(
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages?${query}`,
      'MessageList',
      { signal: options.signal },
    );
  }
  async listBackgroundExecutions(
    input: import('./generated/api').BackgroundExecutionQuery,
    options: { signal?: AbortSignal } = {},
  ) {
    this.requireCapability('sessions');
    const generation = this.connectionGeneration,
      frozen = structuredClone(input);
    validateRequest('BackgroundExecutionQuery', frozen);
    if (this.serverInfo?.storeId !== frozen.storeId)
      throw new ClientError('directory_identity_conflict');
    const query = new URLSearchParams(
      Object.entries(frozen)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );
    const page = await this.fetchJSON(
      `/v1/background-executions?${query}`,
      'BackgroundExecutionPage',
      options,
    );
    this.requireConnection();
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    validateDirectoryPage(page, frozen.storeId, frozen);
    if (frozen.snapshotCursor !== undefined && frozen.snapshotCursor !== page.snapshotCursor)
      throw new ClientError('directory_identity_conflict');
    const seen = new Set<string>();
    for (const item of page.items) {
      const { execution: e, session: s, rootSession: r, run, childRun, childSession: child } = item;
      if (
        seen.has(e.id) ||
        e.sessionId !== s.id ||
        e.rootSessionId !== r.id ||
        s.rootSessionId !== r.id ||
        r.rootSessionId !== r.id ||
        r.parentSessionId !== null ||
        r.deletedAt !== null ||
        s.workspaceId !== r.workspaceId ||
        (frozen.workspaceId !== undefined && r.workspaceId !== frozen.workspaceId) ||
        (frozen.rootSessionId !== undefined && r.id !== frozen.rootSessionId) ||
        (frozen.executionId !== undefined && e.id !== frozen.executionId) ||
        (e.runId !== null && run?.id !== e.runId) ||
        (run &&
          (run.sessionId !== s.id ||
            run.originStoreId !== e.originStoreId ||
            run.rootWorkCommandId !== e.rootWorkCommandId ||
            run.rootWorkSeq !== e.rootWorkSeq)) ||
        (e.childSessionId === null
          ? child !== null || childRun !== null
          : child?.id !== e.childSessionId) ||
        (child &&
          (child.parentSessionId !== s.id ||
            child.rootSessionId !== r.id ||
            child.workspaceId !== s.workspaceId)) ||
        (childRun &&
          (childRun.sessionId !== child?.id ||
            childRun.originCommandId !== `child-start-${e.id}` ||
            childRun.originStoreId !== e.originStoreId ||
            childRun.rootWorkCommandId !== e.rootWorkCommandId ||
            childRun.rootWorkSeq !== e.rootWorkSeq))
      )
        throw new ClientError('directory_identity_conflict');
      seen.add(e.id);
    }
    return page;
  }
  async listAllBackgroundExecutions(
    options: { workspaceId?: string; rootSessionId?: string; signal?: AbortSignal } = {},
  ) {
    this.requireCapability('sessions');
    const storeId = this.serverInfo!.storeId!,
      generation = this.connectionGeneration;
    const workspaceId = options.workspaceId,
      rootSessionId = options.rootSessionId,
      signal = options.signal;
    for (;;) {
      const items: import('./generated/api').BackgroundExecutionItem[] = [],
        seen = new Set<string>();
      let afterSeq: string | undefined,
        upperSeq: string | undefined,
        snapshotCursor: string | undefined;
      try {
        for (;;) {
          signal?.throwIfAborted();
          if (generation !== this.connectionGeneration || this.serverInfo?.storeId !== storeId)
            throw new ClientError('connection_superseded');
          const page = await this.listBackgroundExecutions(
            { storeId, workspaceId, rootSessionId, afterSeq, upperSeq, snapshotCursor, limit: 200 },
            { signal },
          );
          signal?.throwIfAborted();
          upperSeq ??= page.upperSeq;
          snapshotCursor ??= page.snapshotCursor;
          for (const item of page.items) {
            if (seen.has(item.execution.id)) throw new ClientError('directory_identity_conflict');
            seen.add(item.execution.id);
            items.push(item);
          }
          if (page.nextAfterSeq === null) return items;
          afterSeq = page.nextAfterSeq;
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof ClientError) || error.code !== 'directory_changed') throw error;
      }
    }
  }
  async listWorkspaceDirectory(
    input: import('./generated/api').WorkspaceDirectoryQuery,
    options: { signal?: AbortSignal } = {},
  ) {
    this.requireConnection();
    const generation = this.connectionGeneration;
    const frozen = structuredClone(input);
    validateRequest('WorkspaceDirectoryQuery', frozen);
    if (
      frozen.upperSeq !== undefined &&
      parseCursorSequence(frozen.afterSeq ?? '0') > parseCursorSequence(frozen.upperSeq)
    )
      throw new ClientError('invalid_cursor');
    const query = new URLSearchParams(
      Object.entries(frozen)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );
    const page = await this.fetchJSON(
      `/v1/workspace-directory?${query}`,
      'WorkspaceDirectoryPage',
      options,
    );
    this.requireConnection();
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    if (this.serverInfo?.storeId !== frozen.storeId)
      throw new ClientError('directory_identity_conflict');
    return validateDirectoryPage(page, frozen.storeId, frozen);
  }
  async listSessionDirectory(
    input: import('./generated/api').SessionDirectoryQuery,
    options: { signal?: AbortSignal } = {},
  ) {
    this.requireCapability('sessions');
    const generation = this.connectionGeneration;
    const frozen = structuredClone(input);
    validateRequest('SessionDirectoryQuery', frozen);
    if (frozen.snapshotCursor !== undefined) this.requireCapability('session_directory_activity');
    if (
      frozen.upperSeq !== undefined &&
      parseCursorSequence(frozen.afterSeq ?? '0') > parseCursorSequence(frozen.upperSeq)
    )
      throw new ClientError('invalid_cursor');
    const query = new URLSearchParams(
      Object.entries(frozen)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );
    const page = await this.fetchJSON(
      `/v1/session-directory?${query}`,
      'SessionDirectoryPage',
      options,
    );
    this.requireConnection();
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    if (
      this.serverInfo?.storeId !== frozen.storeId ||
      page.items.some(
        (item) =>
          item.session.parentSessionId !== null ||
          (frozen.workspaceId !== undefined && item.session.workspaceId !== frozen.workspaceId),
      )
    )
      throw new ClientError('directory_identity_conflict');
    if (
      this.serverInfo!.capabilities.includes('session_directory_activity') &&
      page.items.some((item) => !item.activity)
    )
      throw new ClientError('directory_activity_unavailable');
    return validateDirectoryPage(page, frozen.storeId, frozen);
  }
  async listAllWorkspaces(options: { signal?: AbortSignal } = {}) {
    this.requireConnection();
    const storeId = this.serverInfo!.storeId!,
      generation = this.connectionGeneration;
    const result = await collectDirectory(
      (page) => {
        if (generation !== this.connectionGeneration)
          throw new ClientError('connection_superseded');
        return this.listWorkspaceDirectory({ storeId, ...page }, options);
      },
      options.signal,
      (item) => item.workspace.id,
    );
    this.requireConnection();
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    return result.map((item) => item.workspace);
  }
  async listAllSessionDirectory(options: { workspaceId?: string; signal?: AbortSignal } = {}) {
    this.requireCapability('session_directory_activity');
    const storeId = this.serverInfo!.storeId!,
      workspaceId = options.workspaceId,
      generation = this.connectionGeneration;
    const result = await collectSnapshotDirectory(
      (page) => {
        if (generation !== this.connectionGeneration)
          throw new ClientError('connection_superseded');
        return this.listSessionDirectory({ storeId, workspaceId, ...page }, options);
      },
      options.signal,
      (item) => item.session.id,
    );
    this.requireConnection();
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    return result;
  }
  async listAllSessions(options: { workspaceId?: string; signal?: AbortSignal } = {}) {
    this.requireCapability('sessions');
    const storeId = this.serverInfo!.storeId!,
      workspaceId = options.workspaceId,
      generation = this.connectionGeneration;
    const result = await collectDirectory(
      (page) => {
        if (generation !== this.connectionGeneration)
          throw new ClientError('connection_superseded');
        return this.listSessionDirectory({ storeId, workspaceId, ...page }, options);
      },
      options.signal,
      (item) => item.session.id,
    );
    this.requireConnection();
    if (generation !== this.connectionGeneration) throw new ClientError('connection_superseded');
    return result.map((item) => item.session);
  }
  listWorkspaces(options: { signal?: AbortSignal } = {}) {
    this.requireConnection();
    return this.fetchJSON('/v1/workspaces', 'WorkspaceList', options);
  }
  listSessions(options: { signal?: AbortSignal } = {}) {
    this.requireConnection();
    return this.fetchJSON('/v1/sessions', 'SessionList', options);
  }

  /** Reads immutable scoped content; it never acknowledges or advances an event cursor. */
  async readArtifact(
    sessionId: string,
    input: {
      expectedStoreId: string;
      refId: string;
      scope: { kind: 'session' | 'execution' | 'message'; id: string };
    },
    options: {
      signal?: AbortSignal;
      /** Explicit public-ref admission for complete bodies beyond the JSON response budget. */
      expectedReference?: { size: string; mediaType: string; hash?: string; storeId?: string };
    } = {},
  ) {
    this.requireConnection();
    input = structuredClone(input);
    const expected = options.expectedReference ? { ...options.expectedReference } : undefined;
    if (
      !input.expectedStoreId ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.refId) ||
      !['session', 'execution', 'message'].includes(input.scope.kind) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.scope.id)
    )
      throw new ClientError('artifact_scope_invalid');
    if (
      expected &&
      (!/^(0|[1-9][0-9]*)$/.test(expected.size) ||
        !expected.mediaType ||
        (expected.hash !== undefined && !/^[a-f0-9]{64}$/.test(expected.hash)) ||
        (expected.storeId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(expected.storeId)))
    )
      throw new ClientError('artifact_metadata_mismatch');
    const query = new URLSearchParams({
      storeId: input.expectedStoreId,
      scopeKind: input.scope.kind,
      scopeId: input.scope.id,
    });
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.throwIfAborted();
    options.signal?.addEventListener('abort', abort, { once: true });
    this.controllers.add(controller);
    let response: Response | undefined;
    try {
      response = await fetch(
        `${this.endpoint}/v1/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(input.refId)}?${query}`,
        {
          redirect: 'error',
          signal: controller.signal,
          headers: { authorization: `Bearer ${this.token}`, accept: 'application/octet-stream' },
        },
      );
      if (!response.ok) {
        const problem = decodeResponse('Problem', await this.responseJSON(response));
        throw new ClientError(problem.code, problem.message, response.status, problem);
      }
      const originStoreId = response.headers.get('x-artifact-store-id');
      const hash = response.headers.get('x-artifact-hash');
      const size = response.headers.get('x-artifact-size');
      const mediaType = response.headers.get('content-type');
      if (
        response.headers.get('x-artifact-id') !== input.refId ||
        !originStoreId ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(originStoreId) ||
        !hash ||
        !/^[a-f0-9]{64}$/.test(hash) ||
        !size ||
        !/^(0|[1-9][0-9]*)$/.test(size) ||
        !mediaType ||
        response.headers.get('cache-control') !== 'no-store' ||
        !response.headers.get('content-disposition')?.startsWith('attachment;')
      )
        throw new ClientError('invalid_response');
      if (
        expected &&
        ((expected.storeId !== undefined && expected.storeId !== originStoreId) ||
          expected.size !== size ||
          expected.mediaType !== mediaType ||
          (expected.hash !== undefined && expected.hash !== hash))
      )
        throw new ClientError('artifact_metadata_mismatch');
      if (!expected && BigInt(size) > BigInt(this.maximum))
        throw new ClientError('response_too_large');
      if (BigInt(size) > BigInt(Number.MAX_SAFE_INTEGER))
        throw new ClientError('artifact_capacity');
      if (!response.body) throw new ClientError('invalid_response');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (
            (!expected && length > this.maximum) ||
            !Number.isSafeInteger(length) ||
            BigInt(length) > BigInt(size)
          ) {
            await reader.cancel();
            throw new ClientError('response_too_large');
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      if (BigInt(length) !== BigInt(size)) throw new ClientError('invalid_response');
      let content: Uint8Array<ArrayBuffer>;
      try {
        content = new Uint8Array(length);
      } catch {
        throw new ClientError('artifact_capacity');
      }
      let offset = 0;
      for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.length;
      }
      let digest: Uint8Array;
      try {
        digest = new Uint8Array(await crypto.subtle.digest('SHA-256', content));
      } catch {
        throw new ClientError('artifact_capacity');
      }
      controller.signal.throwIfAborted();
      if (Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('') !== hash)
        throw new ClientError('artifact_content_mismatch');
      return {
        reference: {
          id: input.refId,
          storeId: originStoreId,
          mediaType,
          size,
          hash,
          scope: { ...input.scope },
        },
        content,
      };
    } catch (error) {
      if (error instanceof ClientError || controller.signal.aborted) throw error;
      throw new ClientError('network_unavailable');
    } finally {
      controller.abort();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      this.controllers.delete(controller);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  async readInteractionAttachment(
    interaction: Interaction,
    options: { signal?: AbortSignal } = {},
  ) {
    this.requireConnection();
    const intent = interactionAttachment(structuredClone(interaction));
    if (!intent) throw new ClientError('attachment_missing');
    const result = await this.readArtifact(
      intent.sessionId,
      {
        expectedStoreId: this.serverInfo!.storeId!,
        refId: intent.reference.id,
        scope: intent.reference.scope,
      },
      {
        signal: options.signal,
        expectedReference: { ...intent.reference, storeId: intent.originStoreId },
      },
    );
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.content);
    } catch {
      throw new ClientError('attachment_encoding_invalid');
    }
    options.signal?.throwIfAborted();
    return { ...result, identity: intent.key, text };
  }

  async listFileCheckpoints(
    sessionId: string,
    options: { afterKey?: string; limit?: number; signal?: AbortSignal } = {},
  ) {
    this.requireCapability('file_recovery');
    validateFileCheckpointTarget(sessionId);
    const { signal, ...query } = options;
    validateRequest('FileCheckpointListQuery', query);
    const target = { storeId: this.lastServer!.storeId!, sessionId },
      generation = this.connectionGeneration;
    const page = await this.fetchJSON(
      `/v1/sessions/${encodeURIComponent(sessionId)}/file-checkpoints?${new URLSearchParams(
        Object.entries(query)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      )}`,
      'FileCheckpointPage',
      { signal },
    );
    if (generation !== this.connectionGeneration || target.storeId !== this.lastServer!.storeId)
      throw new ClientError('connection_superseded');
    return verifyFileCheckpointPage(verifyFileCheckpointObservation(page, target), query);
  }
  async getFileCheckpoint(
    sessionId: string,
    pointId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    this.requireCapability('file_recovery');
    validateFileCheckpointTarget(sessionId, pointId);
    const target = { storeId: this.lastServer!.storeId!, sessionId },
      generation = this.connectionGeneration;
    const detail = await this.fetchJSON(
      `/v1/sessions/${encodeURIComponent(sessionId)}/file-checkpoints/${encodeURIComponent(pointId)}`,
      'FileCheckpointDetail',
      options,
    );
    if (generation !== this.connectionGeneration || target.storeId !== this.lastServer!.storeId)
      throw new ClientError('connection_superseded');
    return verifyFileCheckpointDetail(verifyFileCheckpointObservation(detail, target), pointId);
  }
  async getFileRestoreStatus(
    sessionId: string,
    pointId: string,
    restoreId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    this.requireCapability('file_recovery');
    validateFileCheckpointTarget(sessionId, pointId, restoreId);
    const target = { storeId: this.lastServer!.storeId!, sessionId },
      generation = this.connectionGeneration;
    const status = await this.fetchJSON(
      `/v1/sessions/${encodeURIComponent(sessionId)}/file-checkpoints/${encodeURIComponent(pointId)}/restores/${encodeURIComponent(restoreId)}`,
      'FileRestoreStatus',
      options,
    );
    if (generation !== this.connectionGeneration || target.storeId !== this.lastServer!.storeId)
      throw new ClientError('connection_superseded');
    return verifyFileRestoreStatus(
      verifyFileCheckpointObservation(status, target),
      pointId,
      restoreId,
    );
  }

  async getFileCheckpointRecoveryBoundary(
    sessionId: string,
    pointId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    this.requireCapability('file_recovery');
    validateFileCheckpointTarget(sessionId, pointId);
    const target = { storeId: this.lastServer!.storeId!, sessionId },
      generation = this.connectionGeneration;
    const value = await this.fetchJSON(
      `/v1/sessions/${encodeURIComponent(sessionId)}/file-checkpoints/${pointId}/recovery-boundary`,
      'FileCheckpointRecoveryBoundary',
      options,
    );
    if (generation !== this.connectionGeneration || target.storeId !== this.lastServer!.storeId)
      throw new ClientError('connection_superseded');
    return verifyFileCheckpointRecoveryBoundary(
      verifyFileCheckpointObservation(value, target),
      pointId,
    );
  }

  listExtensions(options: { signal?: AbortSignal } = {}) {
    this.requireCapability('extension_queries');
    return this.fetchJSON('/v1/extensions', 'ExtensionList', options);
  }
  queryExtension(
    sessionId: string,
    extensionId: string,
    queryId: string,
    input: ExtensionCommandRequest['input'],
    options: { signal?: AbortSignal } = {},
  ) {
    this.requireCapability('extension_queries');
    validateQueryInput(input);
    let encoded: string;
    try {
      encoded = encodeURIComponent(JSON.stringify(input));
    } catch {
      throw new ClientError('invalid_query_arguments');
    }
    if (encoded.length > 8192 || encoded === undefined)
      throw new ClientError('invalid_query_arguments');
    return this.fetchJSON(
      `/v1/sessions/${encodeURIComponent(sessionId)}/extensions/${encodeURIComponent(extensionId)}/queries/${encodeURIComponent(queryId)}?input=${encoded}`,
      'QueryResponse',
      options,
    );
  }
  invokeExtension(
    sessionId: string,
    input: ExtensionCommandRequest,
    options: { signal?: AbortSignal } = {},
  ) {
    this.requireCapability('commands');
    this.requireCapability('extensions_actions');
    return this.mutate(
      `/v1/sessions/${encodeURIComponent(sessionId)}/commands`,
      'ExtensionCommandRequest',
      'Command',
      input,
      options.signal,
    );
  }

  /** One observation stream. A successful callback is the application acknowledgement. */
  async observe(options: ObserveOptions): Promise<void> {
    this.requireCapability('events');
    if (this.observing) throw new ClientError('observation_already_active');
    const sessions = [...new Set(options.sessionIds ?? [])].sort();
    if (sessions.length > 32) throw new ClientError('invalid_observation_scope');
    const scope = JSON.stringify(sessions);
    if (
      this.observationScope !== undefined &&
      this.observationScope !== scope &&
      !options.cursor &&
      !options.startAfter
    )
      throw new ClientError('scope_checkpoint_required');
    if (options.cursor && options.startAfter) throw new ClientError('invalid_observation_start');
    const previous = this.observationScope === scope ? this.applied : undefined;
    const initial = options.startAfter ??
      options.cursor ??
      previous ?? {
        storeId: this.lastServer!.storeId!,
        sequence: '0',
      };
    if (!initial.storeId || initial.storeId !== this.lastServer?.storeId)
      throw new ClientError('store_identity_mismatch');
    parseCursorSequence(initial.sequence);
    if (
      options.startAfter &&
      previous &&
      parseCursorSequence(initial.sequence) < parseCursorSequence(previous.sequence)
    )
      throw new ClientError('observation_start_regressed');
    const retryDelay = options.retryDelayMs ?? 250;
    if (!Number.isSafeInteger(retryDelay) || retryDelay < 0 || retryDelay > 60_000)
      throw new ClientError('invalid_retry_delay');
    this.observationScope = scope;
    this.applied = options.startAfter ? (previous ? { ...previous } : undefined) : { ...initial };
    let scanCursor = { ...initial };
    this.observing = true;
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    this.controllers.add(controller);
    try {
      let reconnect = false;
      while (true) {
        options.signal?.throwIfAborted();
        controller.signal.throwIfAborted();
        if (reconnect) {
          const info = await this.fetchJSON('/v1/server', 'ServerInfo', {
            signal: controller.signal,
          });
          this.connected = false;
          admit(info, this.expected);
          if (
            this.bootstrap &&
            (info.instanceId !== this.bootstrap.instanceId ||
              info.buildId !== this.bootstrap.buildId ||
              !sameProfile(info.profile, this.bootstrap.profile))
          )
            throw new ClientError('bootstrap_identity_mismatch');
          this.lastServer = structuredClone(info);
          this.connected = true;
          if (info.storeId !== scanCursor.storeId) {
            try {
              await options.onReset?.('store_changed');
            } catch {
              throw new ClientError('event_application_failed');
            }
            return;
          }
          if (info.dataAvailability !== 'available') throw new ClientError('data_unavailable');
        }
        const query: URLSearchParams = new URLSearchParams({
          storeId: scanCursor.storeId,
          after: scanCursor.sequence,
        });
        for (const sessionId of sessions) query.append('sessionId', sessionId);
        let ready = false;
        try {
          const response: Response = await fetch(`${this.endpoint}/v1/events?${query}`, {
            redirect: 'error',
            signal: controller.signal,
            headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
          });
          if (!response.ok) {
            const problem = decodeResponse('Problem', await this.responseJSON(response));
            if (response.status === 410) {
              try {
                await options.onReset?.(problem.code);
              } catch {
                throw new ClientError('event_application_failed');
              }
              return;
            }
            throw new ClientError(problem.code, problem.message, response.status, problem);
          }
          if (
            !response.body ||
            !response.headers.get('content-type')?.startsWith('text/event-stream')
          )
            throw new ClientError('invalid_sse_response');
          const stream: AsyncGenerator<SSEEvent> = readSSE(response.body, {
            signal: controller.signal,
          });
          for await (const event of stream) {
            if (event.event === 'heartbeat') continue;
            if (event.event === 'reset') {
              try {
                await options.onReset?.('server_reset');
              } catch {
                throw new ClientError('event_application_failed');
              }
              return;
            }
            let value: unknown;
            try {
              value = JSON.parse(event.data);
            } catch {
              throw new ClientError('invalid_sse_response');
            }
            if (event.event === 'ready') {
              const frame = decodeResponse('StreamReady', value);
              if (
                event.id !== undefined ||
                frame.storeId !== scanCursor.storeId ||
                validateCursorBounds({
                  sequence: scanCursor.sequence,
                  replayFloor: frame.replayFloor,
                  lastChangeCursor: frame.highWaterCursor,
                }) !== 'valid'
              )
                throw new ClientError('invalid_sse_ready');
              try {
                await options.onReady?.(frame);
              } catch {
                throw new ClientError('event_application_failed');
              }
              controller.signal.throwIfAborted();
              ready = true;
              continue;
            }
            if (!ready) throw new ClientError('sse_not_ready');
            if (event.event === 'change') {
              const change = decodeResponse('Change', value);
              if (event.id === undefined || event.id !== change.cursor)
                throw new ClientError('invalid_sse_cursor');
              const next = parseCursorSequence(event.id);
              if (next < parseCursorSequence(scanCursor.sequence))
                throw new ClientError('sse_cursor_regressed');
              try {
                await options.onChange(change);
              } catch {
                throw new ClientError('event_application_failed');
              }
              scanCursor = { storeId: scanCursor.storeId, sequence: event.id };
              this.applied = { ...scanCursor };
            } else if (event.event === 'checkpoint') {
              const checkpoint = decodeResponse('StreamCheckpoint', value);
              if (
                checkpoint.storeId !== scanCursor.storeId ||
                event.id !== checkpoint.cursor ||
                parseCursorSequence(checkpoint.cursor) < parseCursorSequence(scanCursor.sequence)
              )
                throw new ClientError('invalid_sse_cursor');
              try {
                await options.onCheckpoint?.(checkpoint);
              } catch {
                throw new ClientError('event_application_failed');
              }
              scanCursor = { storeId: checkpoint.storeId, sequence: checkpoint.cursor };
              this.applied = { ...scanCursor };
            } else throw new ClientError('sse_resync_required');
          }
        } catch (error) {
          if (error instanceof SSEParseError || error instanceof RangeError)
            throw new ClientError('invalid_sse_response');
          if (
            controller.signal.aborted ||
            error instanceof ClientError ||
            options.reconnect === false
          )
            throw error;
          // Transport failure alone never implies an execution cancellation or safe mutation retry.
        }
        if (options.reconnect === false) return;
        controller.signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const aborted = () => {
            clearTimeout(timer);
            reject(controller.signal.reason);
          };
          const timer = setTimeout(
            () => {
              controller.signal.removeEventListener('abort', aborted);
              resolve();
            },
            retryDelay + Math.floor(Math.random() * Math.max(1, retryDelay / 4)),
          );
          controller.signal.addEventListener('abort', aborted, { once: true });
        });
        reconnect = true;
      }
    } finally {
      this.observing = false;
      this.controllers.delete(controller);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  disposeNetwork(): void {
    this.connected = false;
    this.connectionGeneration++;
    for (const controller of this.controllers)
      controller.abort(new ClientError('network_disposed'));
    this.controllers.clear();
  }
}

export function createClient(options: ClientOptions): AgentClient {
  return new AgentClient(options);
}

export interface InteractionAttachment {
  readonly key: string;
  readonly originStoreId: string;
  readonly sessionId: string;
  readonly reference: {
    id: string;
    mediaType: string;
    size: string;
    scope: { kind: 'session' | 'execution' | 'message'; id: string };
  };
}
export type AttachmentReader = (
  attachment: InteractionAttachment,
  options: { signal: AbortSignal },
) => Promise<{
  reference: InteractionAttachment['reference'] & { hash: string };
  content: Uint8Array;
}>;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
/** Detect only the actual public complete attachment envelope, never guesses from text. */
export function interactionAttachment(interaction: Interaction): InteractionAttachment | null {
  const policy = object(object(interaction.request)?.policy);
  const review = object(policy?.review);
  if (review?.kind !== 'artifact') return null;
  const ref = object(review.reference),
    scope = object(ref?.scope);
  if (
    review.complete !== true ||
    !ref ||
    !scope ||
    typeof ref.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(ref.id) ||
    typeof ref.mediaType !== 'string' ||
    typeof ref.size !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(ref.size) ||
    !['session', 'execution', 'message'].includes(String(scope.kind)) ||
    typeof scope.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(scope.id)
  )
    throw new Error('attachment_invalid');
  const reference = {
    id: ref.id,
    mediaType: ref.mediaType,
    size: ref.size,
    scope: { kind: scope.kind as 'session' | 'execution' | 'message', id: scope.id },
  };
  return {
    key: JSON.stringify([
      interaction.originStoreId,
      interaction.sessionId,
      interaction.presentationSessionId,
      interaction.id,
      interaction.revision,
      interaction.executionId,
      interaction.attempt,
      interaction.inputDigest,
      interaction.policyRevision,
      reference,
    ]),
    originStoreId: interaction.originStoreId,
    sessionId: interaction.sessionId,
    reference,
  };
}
export function requiresInteractionAttachment(interaction: Interaction): boolean {
  try {
    return interactionAttachment(interaction) !== null;
  } catch {
    return true;
  }
}

/** Validate an original reconcile command read without granting recovery authority. */
export function decodeRunResumeCommand(value: unknown): ResumeRunResponse {
  return decodeResponse('ResumeRunResponse', value);
}

export function decodeJobReportResumeCommand(value: unknown): ResumeJobReportResponse {
  return decodeResponse('ResumeJobReportResponse', value);
}

export function decodeSessionRecoveryCommand(value: unknown): RecoverSessionResponse {
  const command = decodeResponse('RecoverSessionResponse', value);
  // Additive public fields stay compatible; private execution authority is never a public receipt.
  if (
    [
      'generation',
      'previousGeneration',
      'ownerGeneration',
      'expectedOwnerGeneration',
      'owner',
      'lease',
    ].some((key) => Object.hasOwn(command, key) || Object.hasOwn(command.receipt, key))
  )
    throw new ClientError('invalid_response', 'Invalid RecoverSessionResponse private authority.');
  return command;
}

export function decodeJobReconcileCommand(value: unknown): JobReconcileCommand {
  return decodeResponse('JobReconcileCommand', value);
}

export * from './mcp-management';

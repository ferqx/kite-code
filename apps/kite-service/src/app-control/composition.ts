import { realpathSync } from 'node:fs';
import type { McpCredentialStore, McpRuntimeProvider } from '@kite-ai/builtin-runtime/mcp';
import {
  EXECUTION_STATUS_RESPONSE_SCHEMA_,
  type KiteWorkspaceIdentity,
  RELEASE_STATUS_RESPONSE_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import type {
  NativeProviderCredentialClient,
  NativeProviderCredentialRequest,
} from '@kite-ai/kite-local-runtime/client';
import type { SkillManifest, SkillScanOptions } from '@kite-ai/runtime-contract';
import { resolveProjectIdentity } from '@kite-ai/runtime-host';
import {
  type AgentConfig,
  getFeatureFlags,
  loadAgentConfig,
  probeAgentConfig,
} from '#kite-service/config';
import { defaultCheckpointPath, skillDirs } from '#kite-service/config/paths';
import { composeObservability } from '#kite-service/observability/composition';
import { resolveTelemetryConsent } from '#kite-service/observability/consent';
import {
  type AppShellExecutor,
  composeAppSandboxExecutor,
} from '#kite-service/sandbox/composition';
import { createInProcessAppControlGateway, type InProcessAppControlGateway } from './gateway';
import { createMcpOwner } from './owners/mcp-owner';
import { createWorkspaceMcpSupervisor } from './owners/mcp-supervisor-owner';
import { createProviderCredentialOwner } from './owners/provider-credential-owner';
import { createProviderModelOwner } from './owners/provider-model-owner';
import { createSkillCatalogOwner } from './owners/skill-catalog-owner';
import { createWorkspaceTrustOwner } from './owners/workspace-trust-owner';
import { type AppControlOperationGate, createSerialAppControlOperationGate } from './ports';

export interface KiteInProcessAppControlComposition<
  TOperationGate extends AppControlOperationGate = AppControlOperationGate,
> {
  readonly gateway: InProcessAppControlGateway;
  readonly operationGate: TOperationGate;
  readonly credentialClient: NativeProviderCredentialClient;
  admitWorkspace(workspace: string): KiteWorkspaceIdentity;
  runtimeInputsFor(workspace: KiteWorkspaceIdentity): Readonly<{
    skillManifests: readonly SkillManifest[];
    skillOptions: SkillScanOptions;
    mcpManager: McpRuntimeProvider;
    /** Exact Workspace readiness; a rejected MCP start remains observable to Runtime execution. */
    workspaceReady: Promise<void>;
    config: AgentConfig;
    checkpointPath: string;
    shellExecutor: AppShellExecutor;
    observabilityBridge: ReturnType<typeof composeObservability>['bridge'];
  }>;
  bindRuntimeControl(
    workspace: KiteWorkspaceIdentity,
    control: Readonly<{ applySelectedConfig(config: AgentConfig): void }>,
  ): () => void;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface KiteInProcessAppControlCompositionOptions {
  /** Explicit Service-owned state root; never infer these paths from ambient env. */
  readonly checkpointPath?: string;
  readonly userConfigPath?: string;
  readonly workspaceTrustStorePath?: string;
  readonly userMcpConfigPath?: string;
  readonly mcpApprovalPath?: string;
  readonly userKiteCodeSkillsDir?: string;
  readonly userAgentsSkillsDir?: string;
  readonly shellExecutorForWorkspace?: (
    workspace: KiteWorkspaceIdentity,
    config: AgentConfig,
  ) => AppShellExecutor;
  readonly mcpCredentialStoreForWorkspace?: (
    workspace: KiteWorkspaceIdentity,
  ) => McpCredentialStore;
}

/** Neutral App Control boot; Provider credentials and Workspace execution are not required. */
export function createKiteInProcessAppControlComposition<
  TOperationGate extends AppControlOperationGate = AppControlOperationGate,
>(
  operationGate: TOperationGate = createSerialAppControlOperationGate() as TOperationGate,
  options: KiteInProcessAppControlCompositionOptions = {},
): KiteInProcessAppControlComposition<TOperationGate> {
  const credentialOwner = createProviderCredentialOwner({
    ...(options.userConfigPath === undefined ? {} : { configPath: options.userConfigPath }),
  });
  const credentialClient: NativeProviderCredentialClient = Object.freeze({
    writeProviderCredential: (
      request: NativeProviderCredentialRequest,
      context?: { readonly signal?: AbortSignal },
    ) => operationGate.runMutation(() => credentialOwner.writeProviderCredential(request, context)),
  });
  const owners = new Map<
    string,
    Readonly<{
      providerModel: ReturnType<typeof createProviderModelOwner>;
      mcp: ReturnType<typeof createMcpOwner>;
      skills: ReturnType<typeof createSkillCatalogOwner>;
      config?: AgentConfig;
      shellExecutor?: AppShellExecutor;
      observability?: ReturnType<typeof composeObservability>;
    }>
  >();
  const runtimeControls = new Map<
    string,
    Readonly<{ applySelectedConfig(config: AgentConfig): void }>
  >();
  const workspaceKey = (workspace: KiteWorkspaceIdentity) =>
    `${workspace.workspaceDigest}\0${workspace.projectId}\0${workspace.canonicalPath}`;
  const ownersFor = (workspace: KiteWorkspaceIdentity) => {
    const key = workspaceKey(workspace);
    const current = owners.get(key);
    if (current) {
      if (current.config) return current;
      const refreshed = probeAgentConfig({
        workspace: workspace.canonicalPath,
        ...(options.userConfigPath === undefined ? {} : { configPath: options.userConfigPath }),
      });
      if (refreshed.status !== 'ready') return current;
      owners.delete(key);
      void current.mcp.stop().catch(() => {
        // The replacement remains fail closed if the pre-configuration owner cannot stop cleanly.
      });
    }
    const configProbe = probeAgentConfig({
      workspace: workspace.canonicalPath,
      ...(options.userConfigPath === undefined ? {} : { configPath: options.userConfigPath }),
    });
    const config = configProbe.status === 'ready' ? configProbe.config : undefined;
    const shellExecutor = config
      ? (options.shellExecutorForWorkspace?.(workspace, config) ??
        composeAppSandboxExecutor({
          entrypoint: 'tui',
          workspace: workspace.canonicalPath,
          config,
          ...(options.workspaceTrustStorePath === undefined
            ? {}
            : { workspaceTrustStorePath: options.workspaceTrustStorePath }),
        }))
      : undefined;
    const observability = config
      ? composeObservability({
          artifactTelemetryAllowed: false,
          featureEnabled: getFeatureFlags(config).observabilityMetrics,
          consent: resolveTelemetryConsent({
            releaseChannel: 'development',
            user: config.telemetry?.user,
            project: config.telemetry?.project,
          }),
        })
      : undefined;
    const created = Object.freeze({
      providerModel: createProviderModelOwner({
        workspace,
        ...(options.userConfigPath === undefined ? {} : { userConfigPath: options.userConfigPath }),
        onSelected: (provider, name) => {
          const control = runtimeControls.get(key);
          if (!control) return;
          control.applySelectedConfig(
            loadAgentConfig({
              workspace: workspace.canonicalPath,
              providerName: provider,
              modelName: name,
              ...(options.userConfigPath === undefined
                ? {}
                : { configPath: options.userConfigPath }),
            }),
          );
        },
      }),
      mcp: createMcpOwner({
        workspace,
        supervisor: createWorkspaceMcpSupervisor(workspace.canonicalPath, config ?? {}, {
          ...(options.userMcpConfigPath === undefined
            ? {}
            : { userConfigPath: options.userMcpConfigPath }),
          ...(options.mcpApprovalPath === undefined
            ? {}
            : { approvalPath: options.mcpApprovalPath }),
          ...(options.mcpCredentialStoreForWorkspace === undefined
            ? {}
            : { credentialStore: options.mcpCredentialStoreForWorkspace(workspace) }),
        }),
        ...(options.mcpApprovalPath === undefined ? {} : { approvalPath: options.mcpApprovalPath }),
      }),
      skills: createSkillCatalogOwner({
        workspace,
        skillOptions: skillDirs(workspace.canonicalPath, {
          ...(options.userKiteCodeSkillsDir === undefined
            ? {}
            : { userKiteCodeSkillsDir: options.userKiteCodeSkillsDir }),
          ...(options.userAgentsSkillsDir === undefined
            ? {}
            : { userAgentsSkillsDir: options.userAgentsSkillsDir }),
        }),
      }),
      ...(config === undefined ? {} : { config }),
      ...(shellExecutor === undefined ? {} : { shellExecutor }),
      ...(observability === undefined ? {} : { observability }),
    });
    owners.set(key, created);
    return created;
  };
  const gateway = createInProcessAppControlGateway({
    operationGate,
    workspaceTrust: createWorkspaceTrustOwner(
      options.workspaceTrustStorePath === undefined
        ? {}
        : { storePath: options.workspaceTrustStorePath },
    ),
    release: {
      snapshot: async () => ({
        schema: RELEASE_STATUS_RESPONSE_SCHEMA_,
        revision: 'development-unadmitted-v1',
        active: false,
        production: false,
        inactiveReason: 'release_profile_not_admitted',
        capabilities: [],
        execution: { admitted: false },
      }),
    },
    createWorkspaceHandlers: (workspace: KiteWorkspaceIdentity) => {
      return {
        providerModel: {
          snapshot: (request) => ownersFor(workspace).providerModel.snapshot(request),
          select: (request) => ownersFor(workspace).providerModel.select(request),
        },
        skills: {
          snapshot: (request) => ownersFor(workspace).skills.snapshot(request),
        },
        mcp: {
          snapshot: (request) => ownersFor(workspace).mcp.snapshot(request),
          apply: (request) => ownersFor(workspace).mcp.apply(request),
        },
        execution: {
          snapshot: async () => {
            const workspaceOwners = ownersFor(workspace);
            const decision = await workspaceOwners.shellExecutor?.prepare();
            return {
              schema: EXECUTION_STATUS_RESPONSE_SCHEMA_,
              workspace,
              revision: `execution-${decision?.mode ?? 'unavailable'}-${decision?.backend ?? 'none'}`,
              admitted: decision !== undefined && decision.mode !== 'denied',
              sandboxBackend: decision?.backend ?? 'none',
              filesystemScope:
                decision?.mode === 'sandbox'
                  ? ('workspace_write' as const)
                  : decision?.mode === 'host_shell'
                    ? ('full_access' as const)
                    : ('none' as const),
              networkMode: 'unknown' as const,
              controllerWorktreeActive: false,
            };
          },
        },
      };
    },
  });
  let disposePromise: Promise<void> | undefined;
  return Object.freeze({
    gateway,
    operationGate,
    credentialClient,
    admitWorkspace(workspace: string): KiteWorkspaceIdentity {
      const canonicalPath = realpathSync.native(workspace);
      const project = resolveProjectIdentity(canonicalPath);
      return Object.freeze({
        canonicalPath,
        projectId: project.projectId,
        workspaceDigest: project.workspaceDigest,
      });
    },
    runtimeInputsFor(workspace: KiteWorkspaceIdentity) {
      const workspaceOwners = ownersFor(workspace);
      if (
        !workspaceOwners.config ||
        !workspaceOwners.shellExecutor ||
        !workspaceOwners.observability
      ) {
        throw new Error('Runtime Workspace requires configured Provider composition.');
      }
      const workspaceReady = workspaceOwners.mcp.start();
      // Observe early rejection without converting the readiness Promise into a silent fallback.
      void workspaceReady.catch(() => undefined);
      return Object.freeze({
        skillManifests: workspaceOwners.skills.getActualManifests(),
        skillOptions: skillDirs(workspace.canonicalPath, {
          ...(options.userKiteCodeSkillsDir === undefined
            ? {}
            : { userKiteCodeSkillsDir: options.userKiteCodeSkillsDir }),
          ...(options.userAgentsSkillsDir === undefined
            ? {}
            : { userAgentsSkillsDir: options.userAgentsSkillsDir }),
        }),
        mcpManager: workspaceOwners.mcp.getRuntimeProvider(),
        workspaceReady,
        config: workspaceOwners.config,
        checkpointPath: options.checkpointPath ?? defaultCheckpointPath(),
        shellExecutor: workspaceOwners.shellExecutor,
        observabilityBridge: workspaceOwners.observability.bridge,
      });
    },
    bindRuntimeControl(
      workspace: KiteWorkspaceIdentity,
      control: Readonly<{ applySelectedConfig(config: AgentConfig): void }>,
    ) {
      const key = workspaceKey(workspace);
      runtimeControls.set(key, control);
      return () => {
        if (runtimeControls.get(key) === control) runtimeControls.delete(key);
      };
    },
    [Symbol.asyncDispose](): Promise<void> {
      disposePromise ??= (async () => {
        const results = await Promise.allSettled(
          [...owners.values()].map((workspaceOwners) => workspaceOwners.mcp.stop()),
        );
        owners.clear();
        runtimeControls.clear();
        const failure = results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failure) throw failure.reason;
      })();
      return disposePromise;
    },
  });
}

import type { McpRuntimeProvider } from '@kite/builtin-runtime/mcp';
import type {
  NetworkBoundaryPolicy,
  NetworkDecisionRecorder,
  ProtectedPathEvaluator,
  ShellExecutor,
  ShellFilesystemMode,
  ShellNetworkMode,
} from '@kite/builtin-runtime/sandbox';
import type { SkillCatalogSnapshot } from '@kite/builtin-runtime/skills';
import type { BuiltinPlanningExecutionMechanism } from '@kite/builtin-runtime/subagent';
import type { RuntimeState } from '@kite/runtime-host/kernel-adapter';
import type { CapabilityAvailabilityContext, CapabilityKind } from '@kite/runtime-spi';
import type { FeatureFlags } from '#app/config/features';
import type { SubAgentResult } from './subagent/types';

export interface ToolAvailabilityContext extends CapabilityAvailabilityContext {}

export type ToolKind = Exclude<CapabilityKind, 'internal_runtime'>;

/** App composition DTO; it carries no schema, effects, availability, or executor authority. */
export interface ToolExecutionContext extends ToolAvailabilityContext {
  toolCallId?: string;
  signal?: AbortSignal;
  shellExecutor?: ShellExecutor;
  shellNetworkMode?: ShellNetworkMode;
  shellFilesystemMode?: ShellFilesystemMode;
  networkBoundaryPolicy?: NetworkBoundaryPolicy;
  recordNetworkDecision?: NetworkDecisionRecorder;
  onShellProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  mcpManager?: McpRuntimeProvider;
  runTask?: (input: {
    subagent_type: 'explore' | 'plan' | 'code' | 'review';
    task: string;
  }) => Promise<SubAgentResult>;
  skillRuntime?: {
    state: RuntimeState;
    catalog?: SkillCatalogSnapshot;
    verificationEnabled: boolean;
    flags?: Readonly<FeatureFlags>;
    runFork?: (input: {
      agent: string;
      capabilityCeiling: string[];
      instructions: string;
      workflowInput: Record<string, unknown>;
      outputSchema: Record<string, unknown>;
    }) => Promise<SubAgentResult | null>;
  };
  planRuntime?: BuiltinPlanningExecutionMechanism;
  workspaceFilesystem?: import('@kite/builtin-runtime/filesystem').BuiltinWorkspaceFilesystemInvocationDispatcher;
  allowExternalPaths?: boolean;
  writeTarget?: {
    path: string;
    readState?: 'fresh' | 'stale' | 'not_read';
    previousContent?: string;
    existed?: boolean;
  };
  invocationInput?: unknown;
  beforeExecute?: () => void | Promise<void>;
  protectedPathEvaluator?: ProtectedPathEvaluator;
  gitBroker?: import('@kite/builtin-runtime/git').GitBroker;
}

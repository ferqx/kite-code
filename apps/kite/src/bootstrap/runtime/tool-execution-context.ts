import type {
  BuiltinPlanningExecutionMechanismV1,
  SkillCatalogSnapshot,
} from '@kite/builtin-runtime';
import type { McpRuntimeProvider } from '@kite/builtin-runtime/mcp';
import type {
  NetworkBoundaryPolicyV1,
  NetworkDecisionRecorderV1,
  ProtectedPathEvaluatorV1,
  ShellExecutor,
  ShellFilesystemMode,
  ShellNetworkMode,
} from '@kite/builtin-runtime/sandbox';
import type { RuntimeState } from '@kite/runtime-host';
import type { CapabilityAvailabilityContextV1, CapabilityKindV1 } from '@kite/runtime-spi';
import type { FeatureFlags } from '#app/config/features';
import type { SubAgentResult } from './subagent/types';

export interface ToolAvailabilityContext extends CapabilityAvailabilityContextV1 {}

export type ToolKind = Exclude<CapabilityKindV1, 'internal_runtime'>;

/** App composition DTO; it carries no schema, effects, availability, or executor authority. */
export interface ToolExecutionContext extends ToolAvailabilityContext {
  toolCallId?: string;
  signal?: AbortSignal;
  shellExecutor?: ShellExecutor;
  shellNetworkMode?: ShellNetworkMode;
  shellFilesystemMode?: ShellFilesystemMode;
  networkBoundaryPolicy?: NetworkBoundaryPolicyV1;
  recordNetworkDecision?: NetworkDecisionRecorderV1;
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
  planRuntime?: BuiltinPlanningExecutionMechanismV1;
  workspaceFilesystem?: import('@kite/builtin-runtime/filesystem').BuiltinWorkspaceFilesystemInvocationDispatcherV1;
  allowExternalPaths?: boolean;
  writeTarget?: {
    path: string;
    readState?: 'fresh' | 'stale' | 'not_read';
    previousContent?: string;
    existed?: boolean;
  };
  invocationInput?: unknown;
  beforeExecute?: () => void | Promise<void>;
  protectedPathEvaluator?: ProtectedPathEvaluatorV1;
  gitBroker?: import('@kite/builtin-runtime/git').GitBrokerV1;
}

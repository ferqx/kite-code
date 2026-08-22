// Builtin Runtime MCP domain types.
import type { Tool as SdkTool } from '@modelcontextprotocol/sdk/types.js';
import type { CapabilityApproval, EffectProfile } from './capability-domain';
import type { McpDiagnostic } from './diagnostics';

/** MCP transport type */
export type McpTransportType = 'stdio' | 'http';

/** Connection health consumed by Runtime callers and the UI. */
export type McpHealthState =
  | 'disconnected'
  | 'connecting'
  | 'discovering'
  | 'ready'
  | 'degraded'
  | 'half_open'
  | 'circuit_open'
  | 'quarantined';

/** Explicit local decision that permits only read-only server annotations. */
export interface McpTrustedProvenance {
  provenance: 'admin' | 'user' | 'project';
  allowAnnotations: 'read_only';
}

export type McpToolRetryPolicy = 'never' | 'safe_read' | 'idempotency_key';

export interface McpToolPolicyConfig {
  enabled?: boolean;
  effects?: Partial<EffectProfile>;
  minimumApproval?: CapabilityApproval;
  retry?: McpToolRetryPolicy;
  idempotencyKeyArgument?: string;
}

/** MCP Server configuration */
export interface McpServerConfig {
  type: McpTransportType;
  enabled?: boolean;
  required?: boolean;
  cwd?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  auth?: McpAuthConfig;
  /** Internal vault identity attached by the Supervisor; never serialized to config. */
  credentialKey?: import('./credential-store').McpCredentialKey;
  /** Server annotations are ignored unless this explicit local trust decision is present. */
  trust?: 'untrusted' | 'trusted' | McpTrustedProvenance;
  /** Optional allowlist applied before disabledTools and exact per-tool overrides. */
  enabledTools?: string[];
  /** Optional denylist applied after enabledTools and before exact per-tool overrides. */
  disabledTools?: string[];
  /** Local policy overrides are keyed by the exact server tool name. */
  tools?: Record<string, McpToolPolicyConfig>;
  /** 单次工具调用/资源读取超时（毫秒），覆盖默认值 / Per-operation timeout in ms, overrides defaults */
  timeout?: number;
  /** Internal digest that makes descriptors change when provider config/source changes. */
  providerVersion?: string;
  /** Internal model-description admission; derived from config source, never serialized. */
  modelDescriptionTrust?: 'trusted_remote' | 'generated_only';
  /** Internal source identity for model-visible descriptions. */
  modelDescriptionProvenance?: 'user_config' | 'approved_project' | 'remote_untrusted';
}

export type McpAuthConfig =
  | { type: 'none' }
  | { type: 'environment'; header: string; env: string; scheme?: string }
  | { type: 'credential'; header: string; credentialRef: string; scheme?: string }
  | {
      type: 'oauth';
      credentialRef?: string;
      scopes?: string[];
      clientId?: string;
      clientSecretRef?: string;
    };

/** MCP Prompt */
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: readonly Readonly<{
    name: string;
    description?: string;
    required?: boolean;
  }>[];
}

/** MCP Resource */
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** MCP Resource Content */
export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/** MCP Server runtime state */
export interface McpServerState {
  config: McpServerConfig;
  client: unknown; // Client from SDK
  tools: SdkTool[];
  prompts: McpPrompt[];
  resources: McpResource[];
  health: McpHealthState;
  generation: number;
  lastAttemptAt: string;
  diagnostic?: McpDiagnostic;
  consecutiveCallFailures: number;
  retryAt?: number;
  /** Sealed transport identity fixed when this client generation was admitted. */
  transportBoundary?: {
    identityDigest: string;
    endpointRevision: string;
  };
}

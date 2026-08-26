import type {
  McpProviderDirectoryStatus,
  McpProviderRecoveryAction,
} from '@kite-ai/builtin-runtime/mcp';
import type {
  AgentPhase,
  AgentPlan,
  ContextCompactionProgressPhase,
  PlanArtifactRef,
  RuntimeClientEvent,
  ShellApprovalGrant,
  ToolApprovalPayload,
  UserInputPayload,
  WorkspaceAccess,
} from '@kite-ai/runtime-contract';
import { InteractionMode } from '@kite-ai/runtime-contract';
import type { SandboxBackend } from '#app/sandbox/types';

export type SessionUserAction =
  | { type: 'approve'; interactionId: string; generation: number; grant: ShellApprovalGrant }
  | { type: 'reject'; interactionId: string; generation: number }
  | { type: 'input'; interactionId: string; text: string; answers?: Record<string, string> }
  | { type: 'cancel'; interactionId: string }
  | {
      type: 'plan_review_decision';
      interactionId: string;
      decision:
        | { kind: 'approve'; nextMode: 'accept_edits' | 'auto' }
        | { kind: 'revise'; feedback: string }
        | { kind: 'cancel'; reason?: string };
    };

export type SessionInterruptPayload =
  | {
      kind: 'approval';
      interactionId: string;
      generation: number;
      approval: ToolApprovalPayload;
    }
  | { kind: 'input'; interactionId: string; question: UserInputPayload }
  | {
      kind: 'plan_review';
      interactionId: string;
      plan: AgentPlan;
      artifact?: PlanArtifactRef;
    };

export interface SessionUserInputProvider {
  requestAction(payload: SessionInterruptPayload): Promise<SessionUserAction>;
  submitAction(action: SessionUserAction): void;
  /** Bridge exact live UI actions when no local requestAction waiter exists. */
  setActionSink?(sink: ((action: SessionUserAction) => void) | null): void;
  getPendingInterrupt(): SessionInterruptPayload | null;
  teardown(): Promise<void>;
  reset(): void;
}

export type SessionPresentationAction =
  | { type: 'RUNTIME_EVENT'; event: RuntimeClientEvent }
  | { type: 'LOCAL_TEXT'; text: string; isError?: boolean }
  | { type: 'SET_EXITED' }
  | { type: 'SET_INTERACTION_MODE'; mode: 'accept_edits' | 'auto' | 'full' }
  | {
      type: 'SET_COMPACTION_PROGRESS';
      phase: ContextCompactionProgressPhase;
      source: 'manual' | 'automatic';
    }
  | { type: 'SET_COMPACTION_PROGRESS'; phase?: undefined; source?: never };

export interface SessionStatusProjection {
  phase: AgentPhase;
  plan: AgentPlan | null;
  pendingPlan: AgentPlan | null;
  workspaceAccess: WorkspaceAccess;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheHitRate: number;
  totalTokens: number;
  currentNode: string | null;
  modelProvider: string;
  modelName: string;
  thinkingMode: string;
  reasoningEnabled?: boolean;
  retryState: { attempt: number; maxAttempts: number; error: string; delayMs: number } | null;
  contextSnapshot?: import('@kite-ai/runtime-contract').ContextStatusSnapshot;
}

export interface SessionListProjection {
  threadId: string;
  name: string;
  workspace: string;
  active: boolean;
  running: boolean;
  pendingInterrupt: boolean;
  interrupt: null;
  plan: AgentPlan | null;
  interactionMode?: 'accept_edits' | 'auto' | 'full';
  status: SessionStatusProjection;
  turns: [];
  pendingToolCalls: Record<string, never>;
}

export interface McpRecoveryController {
  recover?(
    providerId: string,
    action: McpProviderRecoveryAction,
  ): Promise<{
    outcome: 'completed' | 'failed';
    providerDirectoryRevision: string;
    providerStatus?: McpProviderDirectoryStatus;
    diagnosticCode?: string;
  }>;
}

export type SessionInteractionMode =
  | typeof InteractionMode.AcceptEdits
  | typeof InteractionMode.Auto
  | typeof InteractionMode.Full;

export function fullModeUnavailableReason(
  _interactionMode: SessionInteractionMode,
  _sandboxBackend: SandboxBackend,
): string | null {
  return null;
}

export function resolveInteractionModeTarget(
  requested: string | undefined,
): SessionInteractionMode | null {
  const normalized = (requested ?? '').toLowerCase();
  if (normalized === 'a' || normalized === InteractionMode.AcceptEdits) {
    return InteractionMode.AcceptEdits;
  }
  if (normalized === 'au' || normalized === InteractionMode.Auto) return InteractionMode.Auto;
  if (normalized === 'f' || normalized === InteractionMode.Full) return InteractionMode.Full;
  return null;
}

export function admitInteractionModeTarget(
  target: SessionInteractionMode,
  sandboxBackend: SandboxBackend,
): { allowed: boolean; mode: SessionInteractionMode; reason: string | null } {
  const reason = fullModeUnavailableReason(target, sandboxBackend);
  return reason
    ? { allowed: false, mode: InteractionMode.AcceptEdits, reason }
    : { allowed: true, mode: target, reason: null };
}

export function shouldProjectRunExited(input: {
  aborted: boolean;
  signalAborted: boolean;
  foreground: boolean;
}): boolean {
  return input.foreground && !input.aborted && !input.signalAborted;
}

export function providerActionInput(
  providerId: string,
  action: McpProviderRecoveryAction,
): UserInputPayload {
  return {
    question: `MCP provider '${providerId}' requires ${action}.`,
    options: [
      {
        id: 'recover',
        label: `Run ${action}`,
        description: 'Perform the provider recovery action, then continue on a new turn.',
      },
      {
        id: 'defer',
        label: 'Later',
        description: 'Keep the failed Tool Call terminal and continue without recovery.',
      },
    ],
    allow_free_text: false,
    recommended: 'recover',
    context: `mcp-provider-action:${providerId}`,
  };
}

export function providerAdmissionInput(
  providerId: string,
  providerStatus: McpProviderDirectoryStatus,
  retryable: boolean,
): UserInputPayload {
  return {
    question: `Required MCP provider '${providerId}' is ${providerStatus}.`,
    options: [
      ...(retryable
        ? [
            {
              id: 'retry',
              label: 'Retry',
              description: 'Retry the provider connection before starting the model.',
            },
          ]
        : []),
      {
        id: 'waive',
        label: 'Session Waive',
        description: 'Continue this session while the provider capabilities remain hidden.',
      },
      {
        id: 'cancel',
        label: 'Cancel Run',
        description: 'Cancel this task without calling the model.',
      },
    ],
    allow_free_text: false,
    recommended: retryable ? 'retry' : 'waive',
    context: `mcp-provider-admission:${providerId}`,
  };
}

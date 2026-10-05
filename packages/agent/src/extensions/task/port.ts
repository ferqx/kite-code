import type {
  Json,
  OperationOptions,
  OperationRef,
  Operations,
  PublicExecution,
  PublicRun,
} from '../index';

/** Generic controlled Agent operation projections, implemented by the host rather than Task. */
export interface AgentOperationView {
  execution: PublicExecution;
  childSessionId: string;
  run: (PublicRun & { deadlineAt: number | null }) | null;
  contextSelectionId: string;
}
export interface AgentOperationOptions extends OperationOptions {
  admission?: 'fail_if_full';
}
export type AgentInput = { key: string; contextSelectionId: string; content: string } & (
  | { mode: 'steer'; targetRunId: string }
  | {
      mode: 'follow_up';
      afterRunId: string;
      resultRequirement?: import('../../storage/types').ResultRequirementDeclaration;
      continuation?: { kind: 'after_turn' };
    }
);
export interface AgentOperations extends Operations {
  ensure(options: AgentOperationOptions): Promise<OperationRef>;
  readAgent(ref: OperationRef): Promise<AgentOperationView>;
  sendAgentInput(
    ref: OperationRef,
    input: AgentInput,
  ): Promise<{ commandId: string; status: string; receipt: Json }>;
}

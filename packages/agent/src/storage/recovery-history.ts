import type { ModelOutputReference } from '../model-output';
import type { ToolCall } from './types';

/** Private Core observation; neither a recovery decision nor permission to dispatch. */
export interface RecoveryToolHistory {
  executionId: string;
  sessionId: string;
  runId: string;
  modelExecutionId: string;
  callId: string;
  definitionId: string;
  inputDigest: string;
  bindingDigest: string;
  modelOutput: ModelOutputReference | null;
}

/** Produced only after the trusted Runtime reads the complete original Model output. */
export interface RecoveryToolHistoryProof {
  executionId: string;
  bindingDigest: string;
}

/** The last committed assistant batch in an exact, durably stopped Run. */
export interface StoppedModelHistory {
  executionId: string;
  sessionId: string;
  runId: string;
  bindingDigest: string;
}

export interface StoppedModelProof extends StoppedModelHistory {
  calls: Pick<ToolCall, 'id' | 'name'>[];
}

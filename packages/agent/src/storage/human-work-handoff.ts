import type { OwnedWrite } from './port';
import type { RequirementEvaluation, RunRecord } from './types';

export interface HandoffHumanRunInput extends OwnedWrite {
  runId: string;
  inputCommandId: string;
  expectedControlRevision: string;
  requirements: RequirementEvaluation[];
}

export interface HandoffHumanRunResult {
  run: RunRecord;
  handedOff: boolean;
  reason: string | null;
}

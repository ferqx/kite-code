import type { AcceptCommandInput } from './port';
import type { CommandRecord, CommandRequest, Json } from './types';

export interface RegisterHumanCommand extends AcceptCommandInput {
  candidateWorkCommandIds?: readonly string[];
  clarifiesInputId?: string;
}

export interface HumanWorkIdentity {
  rootWorkCommandId: string;
  rootWorkSeq: string;
}
export interface HumanWorkScope {
  expectedStoreId: string;
  sessionId: string;
  subjectId: string;
}
export interface RegisterHumanInput extends HumanWorkScope {
  commandId: string;
  content: string;
  contextSelectionId: string;
  observedRunId: string | null;
  /** Exact original public invocation, including its model/effort choices when present. */
  originalRequest?: CommandRequest;
  /** Host verified candidates; absent candidates mean only the observed/selected work. */
  candidateWorkCommandIds?: readonly string[];
  clarifiesInputId?: string;
}
export interface HumanInputProposal {
  relation: 'same_work' | 'independent_work' | 'unresolved';
  purpose: 'work' | 'progress' | 'clarify' | 'continue' | 'pause' | 'replace' | 'stop';
  targetRootWorkCommandId: string | null;
  selectionEffect: 'keep' | 'select_work';
  /** Original human instruction, never a child result or a quoted attachment. */
  basis: { kind: 'explicit_target' | 'explicit_text' | 'model_proposal'; instruction: string };
}
export interface DecideHumanInput extends HumanWorkScope {
  inputCommandId: string;
  inputDigest: string;
  decisionId: string;
  expectedControlRevision: string;
  proposal: HumanInputProposal;
  /** Exact succeeded ordinary Model that explained this input; never a control grant. */
  interpretation?: { executionId: string; answer: string | null; clarification: string | null };
  clarifiesInputId?: string;
}
export interface HumanInputDecision {
  input: CommandRecord;
  decision: CommandRecord;
  businessCommand: CommandRecord | null;
  controlRevision: string;
  requiresReadOnlyProcessing: boolean;
  /** Exact A configuration, independent of the Session's latest technical predecessor. */
  configuration: Json | null;
}
export interface HumanWorkState {
  latestInputCommandId: string | null;
  controlRevision: string;
  selectedWork: HumanWorkIdentity | null;
  pendingInputIds: string[];
}
export interface BeginHumanInputProcessing extends HumanWorkScope {
  inputCommandId: string;
  inputDigest: string;
  /** Only trusted definitions whose entire capability is read-only may be sealed here. */
  readOnlyTools?: readonly { id: string; version: string }[];
}
export interface HumanWorkEligibility extends HumanWorkState {
  state: 'eligible' | 'deferred' | 'revoked';
  reason: string | null;
  decisionCommandId: string | null;
}
export interface ReadHumanWorkEligibility extends HumanWorkScope, HumanWorkIdentity {
  contextSelectionId?: string;
}

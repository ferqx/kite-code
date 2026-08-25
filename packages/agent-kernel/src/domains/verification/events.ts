import type {
  AgentVerificationCheckResult,
  AgentVerificationMode,
  AgentVerificationOutcome,
  AgentVerificationSpec,
} from './state';

type VerificationMode = AgentVerificationMode;
type VerificationOutcome = AgentVerificationOutcome;
type VerificationSpec = AgentVerificationSpec;
type VerificationCheckResult = AgentVerificationCheckResult;

export type VerificationEventMap = {
  'verification.requested': {
    type: 'verification.requested';
    verificationId: string;
    taskId?: string;
    mode: VerificationMode;
    spec: VerificationSpec;
    requestedAt: string;
  };
  'verification.started': {
    type: 'verification.started';
    verificationId: string;
    attempt: number;
    startedAt: string;
  };
  'verification.check_completed': {
    type: 'verification.check_completed';
    verificationId: string;
    result: VerificationCheckResult;
  };
  'verification.completed': {
    type: 'verification.completed';
    verificationId: string;
    outcome: VerificationOutcome;
    completedAt: string;
  };
  'verification.repair_requested': {
    type: 'verification.repair_requested';
    verificationId: string;
    repairAttempt: number;
    instruction: string;
    requestedAt: string;
  };
  'verification.replan_requested': {
    type: 'verification.replan_requested';
    verificationId: string;
    instruction: string;
    requestedAt: string;
  };
  'verification.waived': {
    type: 'verification.waived';
    verificationId: string;
    actor: 'user';
    reason: string;
    waivedAt: string;
  };
  'verification.compensation_requested': {
    type: 'verification.compensation_requested';
    verificationId: string;
    requestedAt: string;
  };
  'verification.compensation_completed': {
    type: 'verification.compensation_completed';
    verificationId: string;
    outcome: VerificationOutcome;
    summary: string;
    completedAt: string;
  };
};

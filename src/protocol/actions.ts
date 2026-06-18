import type {
  AuthorizationMode,
  ShellGrantUsed,
  ToolApprovalPayload,
  UserInputPayload,
} from './events';

export type UserAction =
  | { type: 'approve'; grant: ShellGrantUsed }
  | { type: 'reject' }
  | { type: 'input'; text: string }
  | { type: 'cancel' }
  | { type: 'switch_auth'; mode: AuthorizationMode };

export type InterruptPayload =
  | { kind: 'approval'; approval: ToolApprovalPayload }
  | { kind: 'input'; question: UserInputPayload };

import type { BuiltinShellIntent } from '@kite/builtin-runtime';
import type { RuntimeHostToolExecutionResult } from '@kite/runtime-host';
import type { AppApprovalBinding } from './approval-binding';
import type { SubAgentResult } from './subagent/types';

/** App-narrowed result; Host owns the generic structural transport shape. */
export type ToolExecutionResult = RuntimeHostToolExecutionResult<
  SubAgentResult,
  BuiltinShellIntent
> & {
  readonly approvalBinding?: AppApprovalBinding;
};

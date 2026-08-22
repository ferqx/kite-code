import type { BuiltinShellIntentV1 } from '@kite/builtin-runtime';
import type { RuntimeHostToolExecutionResultV1 } from '@kite/runtime-host';
import type { AppApprovalBindingV1 } from './approval-binding';
import type { SubAgentResult } from './subagent/types';

/** App-narrowed result; Host owns the generic structural transport shape. */
export type ToolExecutionResult = RuntimeHostToolExecutionResultV1<
  SubAgentResult,
  BuiltinShellIntentV1
> & {
  readonly approvalBinding?: AppApprovalBindingV1;
};

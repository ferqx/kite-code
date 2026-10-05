import { validateRequest } from './decode';
import type {
  CancelCommandRequest,
  CancelExecutionRequest,
  FollowUpCommandRequest,
  StartCommandRequest,
  SteerCommandRequest,
} from './generated/api';
import { canonicalModelBody } from './model-input';

export type CallerCommandRequest =
  | StartCommandRequest
  | SteerCommandRequest
  | FollowUpCommandRequest
  | CancelCommandRequest
  | CancelExecutionRequest;

/** Exact persisted Command request bytes, without its HTTP identity envelope. */
export function canonicalCallerCommandRequest(input: CallerCommandRequest): string {
  const names = {
    'run.start': 'StartCommandRequest',
    'input.steer': 'SteerCommandRequest',
    'input.follow_up': 'FollowUpCommandRequest',
    'command.cancel': 'CancelCommandRequest',
    'execution.cancel': 'CancelExecutionRequest',
  } as const;
  validateRequest(names[input.kind], input);
  const request = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  delete request.expectedStoreId;
  delete request.commandId;
  return canonicalModelBody(request);
}

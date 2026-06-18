import type { InterruptPayload, UserAction } from './actions';
import type { AgentEvent } from './events';

export interface UserInputProvider {
  onEvent(event: AgentEvent): void;
  requestAction(payload: InterruptPayload): Promise<UserAction>;
  setup?(): Promise<void>;
  teardown?(): Promise<void>;
}
